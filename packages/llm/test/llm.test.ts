import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  builtinCatalog,
  costUsd,
  createLanguageModel,
  createLLM,
  createLLMChain,
  createProviderRegistry,
  decide,
  findModel,
  LlmError,
  parseModelsDev,
  parsePassages,
  parseRef,
  providerOptionsFor,
  type ChatEvent,
  type LLM,
} from "../src/index.ts";

const usage = {
  inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

function streamOf(parts: LanguageModelV4StreamPart[]): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function textStream(text: string): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
  ]);
}

async function collect(llm: LLM, tools = true): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of llm.stream({
    system: "You are a test.",
    messages: [{ role: "user", content: "Hello" }],
    ...(tools
      ? {
          tools: {
            search_knowledge: { description: "search", inputSchema: z.object({ query: z.string() }) },
            report_gap: { description: "report", inputSchema: z.object({ question: z.string() }) },
          },
        }
      : {}),
  })) {
    events.push(event);
  }
  return events;
}

describe("refs and catalog", () => {
  it("parses provider:model on the first colon only", () => {
    expect(parseRef("anthropic:claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(parseRef("openrouter:minimax/minimax-m3.1-flash:free")).toEqual({
      provider: "openrouter",
      model: "minimax/minimax-m3.1-flash:free",
    });
    expect(() => parseRef("claude-opus-5-5")).toThrow(LlmError);
  });

  it("ships the default chat model with its price and effort levels", () => {
    const opus = findModel(builtinCatalog(), { provider: "anthropic", model: "claude-opus-5-5" });
    expect(opus?.price).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(opus?.caps.effort).toContain("low");
    expect(opus?.caps.promptCaching).toBe("explicit");
  });

  it("prices cache reads at the cache rate", () => {
    const price = { input: 4, output: 20, cacheRead: 0.2 };
    const cost = costUsd(
      { inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0 },
      price,
    );
    // 2000 * 4 + 8000 * 0.2 + 500 * 20 = 8000 + 1600 + 10000 = 19600 per million
    expect(cost).toBeCloseTo(0.0196, 6);
    expect(costUsd({ inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 }, null)).toBeNull();
  });

  it("reads the models.dev format, text models only", () => {
    const models = parseModelsDev(
      {
        acme: {
          models: {
            "chat-1": { id: "chat-1", name: "Chat 1", tool_call: true, limit: { context: 1000, output: 100 }, cost: { input: 1, output: 2 } },
            "img-1": { id: "img-1", modalities: { output: ["image"] } },
          },
        },
      },
      ["acme"],
    );
    expect(models.map((m) => m.id)).toEqual(["chat-1"]);
    expect(models[0]?.price).toEqual({ input: 1, output: 2 });
  });
});

describe("provider options", () => {
  const catalog = builtinCatalog();
  it("sends effort, cache and server-side fallbacks to Claude Opus 5.5", () => {
    const ref = { provider: "anthropic", model: "claude-opus-5-5" };
    const caps = findModel(catalog, ref)?.caps;
    expect(caps).toBeDefined();
    if (!caps) return;
    expect(providerOptionsFor(ref, caps, "low")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" }, effort: "low", fallbacks: "default" },
    });
  });

  it("never sends an effort the model does not accept", () => {
    const ref = { provider: "mistral", model: "mistral-small-latest" };
    const caps = findModel(catalog, ref)?.caps;
    if (!caps) throw new Error("missing catalog entry");
    expect(providerOptionsFor(ref, caps, "low")).toEqual({});
  });

  it("refuses to build a model without its key, with the variable to set", () => {
    const registry = createProviderRegistry();
    expect(() => createLanguageModel(registry, { provider: "openai", model: "gpt-6-sol" }, { env: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() => createLanguageModel(registry, { provider: "nope", model: "x" }, { env: {} })).toThrow(/unknown provider/);
  });
});

describe("streaming", () => {
  it("normalizes text, usage and cost, and returns the assistant turn to append", async () => {
    const model = new MockLanguageModelV4({ doStream: textStream("Hi there") });
    const llm = createLLM({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, effort: "low", model }, { env: {} });
    const events = await collect(llm, false);
    expect(events[0]).toEqual({ type: "text", delta: "Hi there" });
    const finish = events.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type !== "finish") return;
    expect(finish.usage).toMatchObject({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 50, reasoningTokens: 10 });
    expect(finish.usage.costUsd).toBeCloseTo((200 * 4 + 1000 * 0.2 + 50 * 20) / 1e6, 8);
    expect(finish.responseMessages[0]?.role).toBe("assistant");

    const call = model.doStreamCalls[0] as LanguageModelV4CallOptions;
    const system = call.prompt[0];
    expect(system?.role).toBe("system");
    expect(system?.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
  });

  it("emits tool calls and sends tools sorted by name", async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "c1", toolName: "search_knowledge", input: JSON.stringify({ query: "users" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
      ]),
    });
    const llm = createLLM({ ref: { provider: "openai", model: "gpt-6-sol" }, model }, { env: {} });
    const events = await collect(llm);
    expect(events[0]).toEqual({ type: "tool_call", call: { id: "c1", name: "search_knowledge", input: { query: "users" } } });
    const finish = events.at(-1);
    expect(finish?.type === "finish" && finish.reason).toBe("tool-calls");
    const call = model.doStreamCalls[0] as LanguageModelV4CallOptions;
    expect(call.tools?.map((t) => t.name)).toEqual(["report_gap", "search_knowledge"]);
  });
});

describe("fallback chain", () => {
  const down = (): never => {
    throw new APICallError({
      message: "overloaded",
      url: "https://api.example/v1",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
  };

  it("serves the request with the next model when the first one is down", async () => {
    const primary = new MockLanguageModelV4({ doStream: down });
    const backup = new MockLanguageModelV4({ doStream: textStream("From backup") });
    const llm = createLLMChain(
      [
        { ref: { provider: "anthropic", model: "claude-opus-5-5" }, model: primary },
        { ref: { provider: "openai", model: "gpt-6-sol" }, model: backup },
      ],
      { env: {}, maxRetries: 0 },
    );
    const events = await collect(llm, false);
    expect(events[0]).toEqual({ type: "text", delta: "From backup" });
    const finish = events.at(-1);
    expect(finish?.type === "finish" && finish.servedBy).toEqual({ provider: "openai", model: "gpt-6-sol" });
  });

  it("does not hide a fatal error behind a fallback", async () => {
    const bad = new MockLanguageModelV4({
      doStream: () => {
        throw new APICallError({ message: "bad request", url: "u", requestBodyValues: {}, statusCode: 400, isRetryable: false });
      },
    });
    const llm = createLLM({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, model: bad }, { env: {}, maxRetries: 0 });
    await expect(collect(llm)).rejects.toMatchObject({ kind: "fatal", status: 400 });
  });
});

describe("demo model", () => {
  const tools = [
    { type: "function" as const, name: "search_knowledge", inputSchema: {} },
    { type: "function" as const, name: "report_gap", inputSchema: {} },
  ];
  const userTurn = { role: "user" as const, content: [{ type: "text" as const, text: "How do I add a user in the internal tool?" }] };

  it("searches first", () => {
    expect(decide({ prompt: [userTurn], tools })).toEqual({
      kind: "tool",
      toolName: "search_knowledge",
      input: { query: "How do I add a user in the internal tool?" },
    });
  });

  it("answers by quoting cited passages", () => {
    const output = [
      'Results for "add user internal tool":',
      "",
      "[1] Acme Hub accounts > Add a colleague",
      "page: internal-tools/accounts | status: validated | updated: 2026-10-03",
      "Only a Hub admin can add an account. Go to Settings then Team, click Add teammate.",
      "",
      "[2] Pricing > Enterprise",
      "page: sales/pricing | status: to_confirm | updated: 2026-10-01",
      "Enterprise is quoted per seat.",
      "",
      "[3] Acme Hub roles > Admin",
      "page: internal-tools/roles | status: to_confirm | updated: 2026-10-01",
      "Admins also manage accounts.",
    ].join("\n");
    expect(parsePassages(output).map((p) => p.cite)).toEqual([1, 2, 3]);
    const decision = decide({
      prompt: [
        userTurn,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "search_knowledge", input: "{}" }] },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", toolName: "search_knowledge", output: { type: "text", value: output } }],
        },
      ],
      tools,
    });
    expect(decision.kind).toBe("text");
    if (decision.kind !== "text") return;
    expect(decision.text).toContain("[1]");
    // Scope beats keyword: the passage of another section is left out, the status is kept.
    expect(decision.text).not.toContain("[2]");
    expect(decision.text).toContain("(to be confirmed) [3]");
  });

  it("abstains when the search says the match is weak", () => {
    const weak = [
      'Results for "parking policy Lisbon office" (2 passages): Weak match: most key terms of the query are absent.',
      "",
      "[1] Remote work policy > The rule",
      "page: people/remote-work | status: validated | updated: 2026-10-01",
      "Employees can work remotely up to three days a week.",
    ].join("\n");
    const prompt = [
      userTurn,
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "search_knowledge", input: "{}" }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "search_knowledge", output: { type: "text" as const, value: weak } }] },
    ];
    expect(decide({ prompt, tools })).toMatchObject({ kind: "tool", toolName: "report_gap" });
  });

  it("reports the gap when nothing is found, then says it", () => {
    const empty = 'No passage found for "parental leave top-up".';
    const searched = [
      userTurn,
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "search_knowledge", input: "{}" }] },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "c1", toolName: "search_knowledge", output: { type: "text" as const, value: empty } },
        ],
      },
    ];
    expect(decide({ prompt: searched, tools })).toMatchObject({ kind: "tool", toolName: "report_gap" });
    const reported = [
      ...searched,
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c2", toolName: "report_gap", input: "{}" }] },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "c2", toolName: "report_gap", output: { type: "text" as const, value: "flagged" } },
        ],
      },
    ];
    const final = decide({ prompt: reported, tools });
    expect(final.kind === "text" && final.text).toMatch(/not documented yet/);
  });
});
