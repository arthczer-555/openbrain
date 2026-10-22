import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInstanceConfig } from "@openbrain/core";
import {
  judgeAnswer,
  newConversation,
  parseGolden,
  runTurn,
  scoreAnswer,
  scoreRetrieval,
  summarize,
  type AnswerScore,
  type EvalSummary,
  type GoldenItem,
} from "@openbrain/agent";
import { createLLMChain, createProviderRegistry, formatRef, parseRef, type LLM, type ModelSpec } from "@openbrain/llm";
import { buildBundle, knowledgeFromBundle, resolveSettings, type RuntimeBundle } from "@openbrain/server";
import { boolFlag, intFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, chatSpecs, dim, green, red, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain eval: evals/golden.yaml against the instance. Retrieval is always scored (no LLM);
// answers are scored with the chat model, or several with --matrix. Thresholds decide
// the exit code, so the command can gate a CI. Results are saved under .openbrain/evals/.

const THRESHOLDS = { recallAtK: 0.9, abstention: 1, language: 1, citationPrecision: 0.9, groundedness: 0.95 };

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function mark(ok: boolean): string {
  return ok ? green("ok  ") : red("FAIL");
}

async function runAnswers(
  items: readonly GoldenItem[],
  spec: ModelSpec[],
  root: string,
  bundle: RuntimeBundle,
  concurrency: number,
  judge: LLM | null,
): Promise<AnswerScore[]> {
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  const llm = createLLMChain(spec, { env: process.env, registry: createProviderRegistry(settings.openaiCompatible), pricing: settings.pricing });
  const knowledge = knowledgeFromBundle(bundle, process.env);
  const scores: AnswerScore[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (!item) return;
      const state = newConversation();
      const record = await runTurn({
        llm,
        knowledge,
        brain: bundle.brain,
        state,
        question: item.question,
        deadline: Date.now() + 120_000,
      });
      const score = scoreAnswer(item, record);
      if (judge) {
        const verdict = await judgeAnswer(judge, item, record, state.citations);
        score.judge = {
          verdict: verdict.verdict,
          citationPrecision: verdict.citationPrecision,
          groundedness: verdict.groundedness,
          unsupported: verdict.unsupported,
        };
      }
      scores[i] = score;
      process.stdout.write(dim("."));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  process.stdout.write("\n");
  return scores;
}

function printSummary(label: string, summary: EvalSummary): void {
  console.log(bold(`\n${label}`));
  const rows: Array<[string, string]> = [
    ["recall@k (pages to cite in the top passages)", pct(summary.recallAtK)],
    ["answers passing every check", pct(summary.passRate)],
    ["abstention (not documented when it is not)", pct(summary.abstention)],
    ["language of the answer", pct(summary.language)],
    ["citation precision (judge)", pct(summary.citationPrecision)],
    ["groundedness (judge)", pct(summary.groundedness)],
    ["input tokens per question, median / p95", `${summary.medianInputTokens ?? "n/a"} / ${summary.p95InputTokens ?? "n/a"}`],
    ["cache read rate", pct(summary.cacheReadRate)],
    ["total cost", summary.totalCostUsd === null ? "n/a" : `$${summary.totalCostUsd.toFixed(4)}`],
    ["latency p50 / p95", summary.p50LatencyMs === null ? "n/a" : `${(summary.p50LatencyMs / 1000).toFixed(1)} s / ${((summary.p95LatencyMs ?? 0) / 1000).toFixed(1)} s`],
  ];
  for (const [name, value] of rows) console.log(`  ${name.padEnd(48)} ${value}`);
}

function failures(summary: EvalSummary): string[] {
  const out: string[] = [];
  if (summary.recallAtK !== null && summary.recallAtK < THRESHOLDS.recallAtK) out.push(`recall@k ${pct(summary.recallAtK)} < 90%`);
  if (summary.abstention !== null && summary.abstention < THRESHOLDS.abstention) out.push(`abstention ${pct(summary.abstention)} < 100%`);
  if (summary.language !== null && summary.language < THRESHOLDS.language) out.push(`language ${pct(summary.language)} < 100%`);
  if (summary.citationPrecision !== null && summary.citationPrecision < THRESHOLDS.citationPrecision) {
    out.push(`citation precision ${pct(summary.citationPrecision)} < 90%`);
  }
  if (summary.groundedness !== null && summary.groundedness < THRESHOLDS.groundedness) out.push(`groundedness ${pct(summary.groundedness)} < 95%`);
  return out;
}

export const evalCommand: CommandDefinition = {
  name: "eval",
  help: "eval [--no-llm] [--matrix] Score evals/golden.yaml: retrieval, answers, tokens, cost, latency (--judge provider:model)",
  booleanFlags: ["no-llm"],
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const json = boolFlag(args, "json");
    let items = parseGolden(await readFile(path.join(root, "evals", "golden.yaml"), "utf8"));
    const only = stringFlag(args, "only");
    if (only) {
      const ids = new Set(only.split(","));
      items = items.filter((i) => ids.has(i.id));
    }
    const k = intFlag(args, "k") ?? 6;
    const bundle = await buildBundle(root, { env: process.env });
    const retrieval = await scoreRetrieval(knowledgeFromBundle(bundle, process.env), items, k);

    const runs: Array<{ model: string; answers: AnswerScore[]; summary: EvalSummary }> = [];
    if (!boolFlag(args, "no-llm")) {
      const matrix = stringFlag(args, "matrix");
      const judgeFlag = stringFlag(args, "judge");
      let judge: LLM | null = null;
      if (judgeFlag) {
        const settings = resolveSettings(await loadInstanceConfig(root), process.env);
        const ref = parseRef(judgeFlag);
        judge = createLLMChain([{ ref, effort: "low" }], { env: process.env, registry: createProviderRegistry(settings.openaiCompatible), pricing: settings.pricing });
      }
      const effortFlag = stringFlag(args, "effort");
      if (effortFlag && !["low", "medium", "high"].includes(effortFlag)) {
        console.log("--effort expects low, medium or high");
        return 1;
      }
      const effort = effortFlag as "low" | "medium" | "high" | undefined;
      const base: ModelSpec[][] = matrix
        ? matrix.split(",").map((id) => [{ ref: parseRef(id.trim()), effort: "low" as const }])
        : [await chatSpecs(root, stringFlag(args, "model"), { subscriptionFallback: true })];
      // --effort overrides the effort of the model under test (compare a model at low, medium and high).
      const chains = effort ? base.map((chain) => chain.map((spec) => ({ ...spec, effort }))) : base;
      for (const chain of chains) {
        const label = `${formatRef(chain[0]?.ref ?? { provider: "?", model: "?" })}${effort ? ` (effort ${effort})` : ""}`;
        if (!json) process.stdout.write(dim(`${label}: ${items.length} questions `));
        if (judge && chain[0] && judge.ref.provider === chain[0].ref.provider && !json) {
          console.log(dim(`(the judge ${formatRef(judge.ref)} is from the same provider as the model under test: prefer another provider)`));
        }
        const answers = await runAnswers(items, chain, root, bundle, intFlag(args, "concurrency") ?? 3, judge);
        runs.push({ model: label, answers, summary: summarize(items, retrieval, answers) });
      }
    }
    const retrievalSummary = summarize(items, retrieval);

    const out = path.join(root, ".openbrain", "evals", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify({ k, retrieval, retrievalSummary, runs }, null, 2), "utf8");

    if (json) {
      console.log(JSON.stringify({ k, retrieval, retrievalSummary, runs }, null, 2));
    } else {
      console.log(bold(`Retrieval (top ${k}, no LLM)`));
      for (const r of retrieval) {
        const ok = (r.recall === null || r.recall === 1) && r.trapsAbove.length === 0;
        const detail = [
          r.recall === null ? "no page expected" : `recall ${pct(r.recall)}`,
          ...(r.missing.length > 0 ? [`missing ${r.missing.join(", ")}`] : []),
          ...(r.trapsAbove.length > 0 ? [`trap ranked first: ${r.trapsAbove.join(", ")}`] : []),
        ].join("; ");
        console.log(`  ${mark(ok)} ${r.id.padEnd(30)} ${dim(detail)}`);
      }
      for (const run of runs) {
        console.log(bold(`\nAnswers: ${run.model}`));
        for (const a of run.answers) {
          const failed = a.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
          if (a.judge && a.judge.unsupported.length > 0) failed.push(`unsupported: ${a.judge.unsupported.slice(0, 2).join(" | ")}`);
          console.log(`  ${mark(a.ok)} ${a.id.padEnd(30)} ${dim(failed.join("; ") || `${a.cited.length} page(s) cited, ${a.inputTokens} tokens in`)}`);
        }
        printSummary(`Summary: ${run.model}`, run.summary);
      }
      if (runs.length === 0) printSummary("Summary (retrieval only)", retrievalSummary);
      console.log(dim(`\nsaved ${path.relative(process.cwd(), out)}`));
    }

    const problems = [...failures(retrievalSummary), ...runs.flatMap((r) => failures(r.summary).map((f) => `${r.model}: ${f}`))];
    if (problems.length > 0 && !json) for (const p of problems) console.log(red(`below threshold: ${p}`));
    return problems.length > 0 ? 1 : 0;
  },
};
