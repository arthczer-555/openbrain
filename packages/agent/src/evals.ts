import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { KnowledgePort } from "./brain.ts";
import { detectLanguage } from "./language.ts";
import type { TurnRecord } from "./types.ts";

// Evals of an instance: evals/golden.yaml, scored without an LLM judge in v0.1.
// - retrieval (no LLM at all): are the pages that must be cited in the top k passages?
// - answers: behavior (answer, not documented, refusal), pages cited, pages that must not be cited,
//   facts expected or forbidden (substring checks), language of the answer, tokens, cost, latency.

export const GoldenItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    lang: z.string().optional(),
    expect: z
      .object({
        behavior: z.enum(["answer", "not_documented", "clarify", "refuse"]),
        must_cite: z.array(z.string()).default([]),
        must_not_cite: z.array(z.string()).default([]),
        must_include: z.array(z.string()).default([]),
        must_not_include: z.array(z.string()).default([]),
      })
      .passthrough(),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

export type GoldenItem = z.infer<typeof GoldenItemSchema>;

export function parseGolden(text: string): GoldenItem[] {
  const data: unknown = parseYaml(text);
  if (!Array.isArray(data)) throw new Error("evals/golden.yaml must be a list of questions");
  return data.map((item, i) => {
    const parsed = GoldenItemSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`evals/golden.yaml item ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    return parsed.data;
  });
}

export interface RetrievalScore {
  id: string;
  question: string;
  /** Share of must_cite pages found in the top k; null when the question has none. */
  recall: number | null;
  missing: string[];
  /** must_not_cite pages ranked above every must_cite page (the trap won). */
  trapsAbove: string[];
  topPages: string[];
}

export async function scoreRetrieval(knowledge: KnowledgePort, items: readonly GoldenItem[], k = 6): Promise<RetrievalScore[]> {
  const scores: RetrievalScore[] = [];
  for (const item of items) {
    const queryVector = knowledge.embedQuery ? await knowledge.embedQuery(item.question) : null;
    const result = knowledge.search(item.question, { k, maxTokens: Number.MAX_SAFE_INTEGER, maxPerDoc: 1, queryVector });
    const pages = result.results.map((r) => r.docId);
    const mustCite = item.expect.must_cite;
    const missing = mustCite.filter((p) => !pages.includes(p));
    const firstWanted = Math.min(...mustCite.map((p) => (pages.includes(p) ? pages.indexOf(p) : Number.POSITIVE_INFINITY)));
    const trapsAbove = item.expect.must_not_cite.filter((p) => pages.includes(p) && pages.indexOf(p) < firstWanted);
    scores.push({
      id: item.id,
      question: item.question,
      recall: mustCite.length === 0 ? null : (mustCite.length - missing.length) / mustCite.length,
      missing,
      trapsAbove,
      topPages: pages,
    });
  }
  return scores;
}

export interface Check {
  name: "behavior" | "must_cite" | "must_not_cite" | "must_include" | "must_not_include" | "language";
  ok: boolean;
  detail: string;
}

export interface AnswerScore {
  id: string;
  question: string;
  ok: boolean;
  checks: Check[];
  answer: string;
  cited: string[];
  flagged: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  rounds: number;
  /** Set when the evals ran with a judge (--judge). */
  judge?: {
    verdict: string;
    citationPrecision: number | null;
    groundedness: number | null;
    unsupported: string[];
  };
}

const NOT_DOCUMENTED_TEXT = /not (yet )?documented|pas (encore )?document[ée]|n'est pas document[ée]|aucune information/i;

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
}

export function scoreAnswer(item: GoldenItem, record: TurnRecord): AnswerScore {
  const cited = [...new Set(record.citations.map((c) => c.page))];
  const answer = normalize(record.answer);
  const flagged = record.gaps.length > 0;
  const checks: Check[] = [];
  const expect = item.expect;

  switch (expect.behavior) {
    case "answer":
      checks.push({ name: "behavior", ok: cited.length > 0 && !flagged, detail: cited.length > 0 ? (flagged ? "answered but also flagged" : "answered with citations") : "no citation" });
      break;
    case "not_documented": {
      const ok = flagged || NOT_DOCUMENTED_TEXT.test(record.answer);
      checks.push({ name: "behavior", ok, detail: ok ? "said not documented" : "did not say it is not documented" });
      break;
    }
    case "refuse": {
      const ok = cited.length === 0 && (flagged || record.answer.length > 0);
      checks.push({ name: "behavior", ok, detail: ok ? "declined without company facts" : "answered with company sources" });
      break;
    }
    case "clarify": {
      const ok = record.answer.includes("?");
      checks.push({ name: "behavior", ok, detail: ok ? "asked a question back" : "no clarifying question" });
      break;
    }
  }
  if (expect.must_cite.length > 0) {
    const missing = expect.must_cite.filter((p) => !cited.includes(p));
    checks.push({ name: "must_cite", ok: missing.length === 0, detail: missing.length === 0 ? "all cited" : `missing ${missing.join(", ")}` });
  }
  if (expect.must_not_cite.length > 0) {
    const wrong = expect.must_not_cite.filter((p) => cited.includes(p));
    checks.push({ name: "must_not_cite", ok: wrong.length === 0, detail: wrong.length === 0 ? "trap avoided" : `cited ${wrong.join(", ")}` });
  }
  if (expect.must_include.length > 0) {
    const absent = expect.must_include.filter((f) => !answer.includes(normalize(f)));
    checks.push({ name: "must_include", ok: absent.length === 0, detail: absent.length === 0 ? "facts present" : `missing "${absent.join('", "')}"` });
  }
  if (expect.must_not_include.length > 0) {
    const present = expect.must_not_include.filter((f) => answer.includes(normalize(f)));
    checks.push({ name: "must_not_include", ok: present.length === 0, detail: present.length === 0 ? "no forbidden claim" : `says "${present.join('", "')}"` });
  }
  if (item.lang === "fr" || item.lang === "en") {
    const lang = detectLanguage(record.answer);
    checks.push({ name: "language", ok: lang === item.lang, detail: `answered in ${lang}` });
  }

  return {
    id: item.id,
    question: item.question,
    ok: checks.every((c) => c.ok),
    checks,
    answer: record.answer,
    cited,
    flagged,
    inputTokens: record.usage.inputTokens,
    cachedInputTokens: record.usage.cachedInputTokens,
    outputTokens: record.usage.outputTokens,
    costUsd: record.usage.costUsd,
    latencyMs: record.latencyMs,
    rounds: record.rounds,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface EvalSummary {
  questions: number;
  /** Mean recall@k of must_cite pages over the questions that have some (retrieval only). */
  recallAtK: number | null;
  /** Questions passing every check (answers run only). */
  passRate: number | null;
  /** not_documented questions correctly said not documented (target 1.0). */
  abstention: number | null;
  /** Answers in the language of the question (target 1.0). */
  language: number | null;
  /** Judge only: cited claims supported by their citations (target 0.9). */
  citationPrecision: number | null;
  /** Judge only: company claims supported by a cited passage (target 0.95). */
  groundedness: number | null;
  medianInputTokens: number | null;
  p95InputTokens: number | null;
  cacheReadRate: number | null;
  totalCostUsd: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

function rate(checks: boolean[]): number | null {
  return checks.length === 0 ? null : checks.filter(Boolean).length / checks.length;
}

export function summarize(items: readonly GoldenItem[], retrieval: readonly RetrievalScore[], answers: readonly AnswerScore[] = []): EvalSummary {
  const recalls = retrieval.map((r) => r.recall).filter((r): r is number => r !== null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const abstention = answers.filter((a) => byId.get(a.id)?.expect.behavior === "not_documented").map((a) => a.ok);
  const language = answers.flatMap((a) => a.checks.filter((c) => c.name === "language").map((c) => c.ok));
  const inputs = answers.map((a) => a.inputTokens);
  const cached = answers.reduce((sum, a) => sum + a.cachedInputTokens, 0);
  const totalInput = answers.reduce((sum, a) => sum + a.inputTokens, 0);
  const costs = answers.map((a) => a.costUsd);
  const latencies = answers.map((a) => a.latencyMs);
  const mean = (values: Array<number | null | undefined>): number | null => {
    const kept = values.filter((v): v is number => typeof v === "number");
    return kept.length === 0 ? null : kept.reduce((a, b) => a + b, 0) / kept.length;
  };
  return {
    questions: items.length,
    recallAtK: recalls.length === 0 ? null : recalls.reduce((a, b) => a + b, 0) / recalls.length,
    passRate: rate(answers.map((a) => a.ok)),
    abstention: rate(abstention),
    language: rate(language),
    citationPrecision: mean(answers.map((a) => a.judge?.citationPrecision)),
    groundedness: mean(answers.map((a) => a.judge?.groundedness)),
    medianInputTokens: percentile(inputs, 50),
    p95InputTokens: percentile(inputs, 95),
    cacheReadRate: totalInput === 0 ? null : cached / totalInput,
    totalCostUsd: answers.length === 0 || costs.some((c) => c === null) ? null : costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}
