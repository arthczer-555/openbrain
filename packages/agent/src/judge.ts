import type { LLM, NormalizedUsage } from "@openbrain/llm";
import { z } from "zod";
import type { GoldenItem } from "./evals.ts";
import type { Citation, TurnRecord } from "./types.ts";

// LLM judge of the evals: citation precision and groundedness. On demand only, never in
// the background, and on a provider different from the chat model's so a model does not
// grade itself. The judge sees the question, the answer and the exact passages cited, nothing else.

export const JudgeVerdictSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string(),
        cites: z.array(z.number().int()),
        supported: z.boolean(),
      }),
    )
    .describe("Every statement about the company in the answer, with the citation ids it carries"),
  verdict: z.enum(["answered", "partial", "missing_info", "wrong", "off_scope"]),
  explanation: z.string().describe("One or two sentences"),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface JudgeResult {
  verdict: JudgeVerdict["verdict"];
  /** Share of cited claims whose citations support them. Null when nothing is cited. */
  citationPrecision: number | null;
  /** Share of company claims supported by a cited passage. Null when the answer makes no claim. */
  groundedness: number | null;
  unsupported: string[];
  explanation: string;
  usage: NormalizedUsage;
}

const SYSTEM = [
  "You grade answers of a company knowledge assistant. You only judge whether the answer is supported by the",
  "passages it cites; you never use your own knowledge of the company. List every statement about the company",
  "(facts, procedures, numbers, rules). For each, give the citation ids attached to it in the answer and whether",
  "those passages support it. General advice and phrases like 'this is not documented' are not company claims.",
].join(" ");

export function judgePrompt(item: GoldenItem, record: TurnRecord, citations: readonly Citation[]): string {
  const cited = new Set(record.citations.map((c) => c.cite));
  const passages = citations
    .filter((c) => cited.has(c.cite))
    .map((c) => `[${c.cite}] ${[c.title, ...c.headingPath].join(" > ")}\n${c.text}`)
    .join("\n\n");
  return [
    `Question: ${item.question}`,
    `Expected behavior: ${item.expect.behavior}${item.expect.must_include.length > 0 ? `; expected facts: ${item.expect.must_include.join("; ")}` : ""}`,
    `Answer:\n${record.answer}`,
    `Cited passages:\n${passages || "(none)"}`,
  ].join("\n\n");
}

export async function judgeAnswer(judge: LLM, item: GoldenItem, record: TurnRecord, citations: readonly Citation[]): Promise<JudgeResult> {
  const { object, usage } = await judge.generateObject({
    system: SYSTEM,
    prompt: judgePrompt(item, record, citations),
    schema: JudgeVerdictSchema,
    maxOutputTokens: 2_000,
  });
  const claims = object.claims;
  const withCites = claims.filter((c) => c.cites.length > 0);
  return {
    verdict: object.verdict,
    citationPrecision: withCites.length === 0 ? null : withCites.filter((c) => c.supported).length / withCites.length,
    groundedness: claims.length === 0 ? null : claims.filter((c) => c.supported && c.cites.length > 0).length / claims.length,
    unsupported: claims.filter((c) => !c.supported || c.cites.length === 0).map((c) => c.claim),
    explanation: object.explanation,
    usage,
  };
}
