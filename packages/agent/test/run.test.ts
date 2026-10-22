import { fileURLToPath } from "node:url";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadKnowledgeBase } from "@openbrain/core";
import { createLLM, type LLM } from "@openbrain/llm";
import { buildIndex } from "@openbrain/retrieval";
import {
  knowledgeFromIndex,
  loadBrain,
  newConversation,
  runTurn,
  type AgentEvent,
  type Brain,
  type KnowledgePort,
} from "../src/index.ts";

const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

let knowledge: KnowledgePort;
let brain: Brain;

beforeAll(async () => {
  knowledge = knowledgeFromIndex(buildIndex(await loadKnowledgeBase(ACME_ROOT)));
  brain = await loadBrain(ACME_ROOT);
});

const demo = (): LLM => createLLM({ ref: { provider: "demo", model: "extractive" } }, { env: {} });

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function stream(parts: LanguageModelV4StreamPart[]): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function say(text: string): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return stream([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
  ]);
}

function callTool(name: string, input: unknown, id: string): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return stream([
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ]);
}

function mockLLM(model: MockLanguageModelV4, tools = true): LLM {
  const llm = createLLM({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, model }, { env: {}, maxRetries: 0 });
  return tools ? llm : { ...llm, caps: { ...llm.caps, tools: false }, stream: llm.stream.bind(llm), generateObject: llm.generateObject.bind(llm) };
}

describe("agent mode with the demo model on Acme", () => {
  it("searches, cites the internal tool page, and records the turn", async () => {
    const state = newConversation("c_test");
    const events: AgentEvent[] = [];
    const record = await runTurn({
      llm: demo(),
      knowledge,
      brain,
      state,
      question: "How do I add a user in the internal tool?",
      onEvent: (e) => events.push(e),
    });

    expect(events[0]).toMatchObject({ type: "step", step: { kind: "search" } });
    expect(events.some((e) => e.type === "citation" && e.citation.docId === "internal-tools/accounts")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(record.answer).toMatch(/\[\d+\]/);
    expect(record.citations[0]?.page).toBe("internal-tools/accounts");
    expect(record.citations[0]?.url).toMatch(/^https:\/\/www\.notion\.so\//);
    expect(record.searches[0]?.results[0]?.page).toBe("internal-tools/accounts");
    expect(record.model).toEqual({ provider: "demo", model: "extractive", mode: "agent" });
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(state.turnCount).toBe(1);
  });

  it("serves a passage once per conversation and keeps citation ids stable", async () => {
    const state = newConversation();
    const first: AgentEvent[] = [];
    await runTurn({ llm: demo(), knowledge, brain, state, question: "How do I add a user in the internal tool?", onEvent: (e) => first.push(e) });
    const citationsAfterFirst = state.citations.length;
    const second: AgentEvent[] = [];
    const record = await runTurn({
      llm: demo(),
      knowledge,
      brain,
      state,
      question: "How do I add a user in the internal tool?",
      onEvent: (e) => second.push(e),
    });
    expect(second.some((e) => e.type === "citation")).toBe(false);
    expect(state.citations.length).toBe(citationsAfterFirst);
    const lastTool = state.messages.filter((m) => m.role === "tool").at(-1);
    expect(JSON.stringify(lastTool)).toContain("already provided above");
    expect(record.context).toEqual([{ role: "user", text: "How do I add a user in the internal tool?" }]);
  });

  it("flags a question the base cannot answer", async () => {
    const events: AgentEvent[] = [];
    const record = await runTurn({
      llm: demo(),
      knowledge,
      brain,
      state: newConversation(),
      question: "zorblax quantum flux capacitor?",
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === "report")).toBe(true);
    expect(record.gaps[0]).toMatchObject({ reason: "not_found", searched: ["zorblax quantum flux capacitor?"] });
    expect(record.answer).toMatch(/not documented yet/);
  });
});

describe("budgets and safety", () => {
  it("stops calling tools after 4 rounds and forces a final answer", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options: LanguageModelV4CallOptions) => {
        calls++;
        if (options.toolChoice?.type === "none") return say("Final answer from what I found [1].");
        return callTool("search_knowledge", { query: `users ${calls}` }, `c${calls}`);
      },
    });
    const record = await runTurn({ llm: mockLLM(model), knowledge, brain, state: newConversation(), question: "Tell me everything" });
    expect(record.rounds).toBe(4);
    expect(model.doStreamCalls).toHaveLength(5);
    expect(model.doStreamCalls[4]?.toolChoice).toEqual({ type: "none" });
    // Tool definitions stay in every call (stable prefix for the cache).
    expect(model.doStreamCalls[4]?.tools?.map((t) => t.name)).toEqual(["read_document", "report_gap", "search_knowledge"]);
    expect(record.answer).toContain("Final answer");
  });

  it("caps the tokens of tool results per question", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options: LanguageModelV4CallOptions) => {
        calls++;
        if (options.toolChoice?.type === "none" || calls > 3) return say("Done.");
        return callTool("search_knowledge", { query: calls === 1 ? "users groups companies" : "client onboarding" }, `c${calls}`);
      },
    });
    const state = newConversation();
    await runTurn({ llm: mockLLM(model), knowledge, brain, state, question: "Big question", limits: { questionBudget: 600 } });
    const toolTexts = state.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m));
    expect(toolTexts.at(-1)).toContain("Context budget for this question is reached");
  });

  it("rolls the turn back when the model fails", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) return callTool("search_knowledge", { query: "users" }, "c1");
        throw new Error("boom");
      },
    });
    const state = newConversation();
    await expect(runTurn({ llm: mockLLM(model), knowledge, brain, state, question: "Who manages users?" })).rejects.toThrow(/boom/);
    expect(state.messages).toHaveLength(0);
    expect(state.citations).toHaveLength(0);
    expect(state.turnCount).toBe(0);
  });

  it("keeps the date out of the system prompt", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => say("ok") });
    await runTurn({ llm: mockLLM(model), knowledge, brain, state: newConversation(), question: "hi", now: new Date("2026-10-22T10:00:00Z") });
    const call = model.doStreamCalls[0];
    const system = call?.prompt[0];
    expect(system?.role === "system" && system.content).not.toContain("2026-10-22");
    expect(JSON.stringify(call?.prompt.at(-1))).toContain("Today is 2026-10-22");
  });
});

describe("retrieval-first mode", () => {
  it("answers in one call with the passages in the prompt", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => say("Go to Settings then Team [1].") });
    const events: AgentEvent[] = [];
    const record = await runTurn({
      llm: mockLLM(model, false),
      knowledge,
      brain,
      state: newConversation(),
      question: "How do I add a user in the internal tool?",
      onEvent: (e) => events.push(e),
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt.at(-1))).toContain("Knowledge base passages");
    expect(record.model.mode).toBe("retrieval_first");
    expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : "")).join("")).toBe(
      "Go to Settings then Team [1].",
    );
  });

  it("turns the NOT_DOCUMENTED marker into a flagged question and hides it", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        stream([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "NOT_DOC" },
          { type: "text-delta", id: "t", delta: "UMENTED: nothing about parental leave top-ups." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
        ]),
    });
    const events: AgentEvent[] = [];
    const record = await runTurn({
      llm: mockLLM(model, false),
      knowledge,
      brain,
      state: newConversation(),
      question: "What is our parental leave top-up policy?",
      onEvent: (e) => events.push(e),
    });
    const shown = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(shown).toBe("nothing about parental leave top-ups.");
    expect(record.gaps).toHaveLength(1);
    expect(events.some((e) => e.type === "report")).toBe(true);
  });
});

describe("prompt budget", () => {
  it("keeps the three tool definitions under 600 tokens (layer L0)", async () => {
    const { z } = await import("zod");
    const { estimateTokens } = await import("@openbrain/core");
    const { TOOL_SPECS } = await import("../src/index.ts");
    const json = Object.entries(TOOL_SPECS).map(([name, spec]) =>
      JSON.stringify({ name, description: spec.description, input_schema: z.toJSONSchema(spec.inputSchema) }),
    );
    expect(estimateTokens(json.join(""))).toBeLessThanOrEqual(600);
  });
});

describe("history stays valid", () => {
  it("answers a tool call made after the tool budget, so the next turn is accepted", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        // Ignores tool_choice none and calls a tool anyway on its final call.
        return calls <= 2 ? callTool("search_knowledge", { query: `q${calls}` }, `c${calls}`) : callTool("search_knowledge", { query: "again" }, "c3");
      },
    });
    const state = newConversation();
    await runTurn({ llm: mockLLM(model), knowledge, brain, state, question: "Loop", limits: { maxToolRounds: 2 } });
    const lastTool = state.messages.filter((m) => m.role === "tool").at(-1);
    expect(JSON.stringify(lastTool)).toContain("Not executed");
    // Every tool call id has its result.
    const callIds = state.messages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content) ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolCallId] : [])) : [],
    );
    const resultIds = state.messages.flatMap((m) => (m.role === "tool" ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.toolCallId] : [])) : []));
    expect(resultIds).toEqual(callIds);
  });
});
