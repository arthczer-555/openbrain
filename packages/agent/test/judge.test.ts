import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createLLM } from "@openbrain/llm";
import { judgeAnswer, judgePrompt, summarize, type Citation, type GoldenItem, type TurnRecord } from "../src/index.ts";

const item: GoldenItem = {
  id: "to-confirm-01",
  question: "What is the price of the Enterprise plan?",
  lang: "en",
  expect: { behavior: "answer", must_cite: ["sales/pricing"], must_not_cite: [], must_include: ["to be confirmed"], must_not_include: [] },
  tags: [],
};

const citation: Citation = {
  cite: 1,
  docId: "sales/pricing",
  title: "Pricing",
  section: "sales",
  headingPath: ["Enterprise"],
  text: "Enterprise is quoted per seat, from 49 USD per agent per month (to be confirmed).",
  url: "https://www.notion.so/acme/Pricing-0000",
  status: "to_confirm",
  updatedAt: "2026-10-01",
  warnings: [],
  chunkIds: ["sales/pricing#1"],
};

const record = {
  turnId: "t_1",
  conversationId: "c_1",
  createdAt: "2026-10-22T10:00:00Z",
  question: item.question,
  context: [],
  answer: "Enterprise starts at 49 USD per agent per month, to be confirmed [1]. It includes a dedicated CSM.",
  lang: "en",
  citations: [{ cite: 1, page: "sales/pricing", url: citation.url, heading_path: "Enterprise" }],
  searches: [],
  reads: [],
  gaps: [],
  model: { provider: "anthropic", model: "claude-opus-5-5", mode: "agent" },
  usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
  rounds: 1,
  done: "stop",
  latencyMs: 10,
} satisfies TurnRecord;

describe("LLM judge", () => {
  it("shows the judge only the cited passages", () => {
    const prompt = judgePrompt(item, record, [citation, { ...citation, cite: 2, text: "Unrelated passage" }]);
    expect(prompt).toContain("[1] Pricing > Enterprise");
    expect(prompt).not.toContain("Unrelated passage");
  });

  it("turns the verdict into citation precision and groundedness", async () => {
    const verdict = {
      claims: [
        { claim: "Enterprise starts at 49 USD per agent per month", cites: [1], supported: true },
        { claim: "It includes a dedicated CSM", cites: [], supported: false },
      ],
      verdict: "partial",
      explanation: "The CSM claim has no source.",
    };
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
        warnings: [],
      },
    });
    const judge = createLLM({ ref: { provider: "google", model: "gemini-3.8-flash" }, model }, { env: {}, maxRetries: 0 });
    const result = await judgeAnswer(judge, item, record, [citation]);
    expect(result.verdict).toBe("partial");
    expect(result.citationPrecision).toBe(1);
    expect(result.groundedness).toBe(0.5);
    expect(result.unsupported).toEqual(["It includes a dedicated CSM"]);

    const summary = summarize([item], [], [
      {
        id: item.id,
        question: item.question,
        ok: true,
        checks: [],
        answer: record.answer,
        cited: ["sales/pricing"],
        flagged: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 10,
        rounds: 1,
        judge: { verdict: result.verdict, citationPrecision: result.citationPrecision, groundedness: result.groundedness, unsupported: result.unsupported },
      },
    ]);
    expect(summary.groundedness).toBe(0.5);
    expect(summary.citationPrecision).toBe(1);
  });
});
