import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { beforeAll, describe, expect, it } from "vitest";
import { loadKnowledgeBase } from "@openbrain/core";
import { createLLM } from "@openbrain/llm";
import { buildIndex } from "@openbrain/retrieval";
import { knowledgeFromIndex, loadBrain, newConversation, runTurn, type Brain, type KnowledgePort } from "../src/index.ts";

// The real Anthropic provider of the AI SDK, on a fake fetch that replays Messages API streams. It checks
// what goes on the wire with the default model of the template (Claude Opus 5.5): effort, server-side
// fallbacks and their beta header, cache points, sorted tools, and above all an append-only history where
// signed thinking blocks come back unchanged (preserved thinking: an edited history is refused).

const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

let knowledge: KnowledgePort;
let brain: Brain;

beforeAll(async () => {
  knowledge = knowledgeFromIndex(buildIndex(await loadKnowledgeBase(ACME_ROOT)));
  brain = await loadBrain(ACME_ROOT);
});

type Event = Record<string, unknown>;

function sse(events: Event[]): Response {
  const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const start = (id: string): Event => ({
  type: "message_start",
  message: {
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 },
  },
});

function thinkingThenSearch(signature: string, query: string): Event[] {
  return [
    start("msg_1"),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];
}

function answer(id: string, text: string): Event[] {
  return [
    start(id),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ];
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    system: Array<{ type: string; text: string; cache_control?: unknown }>;
    messages: Array<{ role: string; content: unknown }>;
    tools: Array<{ name: string }>;
    tool_choice?: { type: string };
    [key: string]: unknown;
  };
}

function fakeAnthropic(responses: Event[][]): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const queue = [...responses];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as Captured["body"] });
    const next = queue.shift();
    if (!next) throw new Error("no more fake responses");
    return sse(next);
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}

describe("Claude Opus 5.5 on the wire", () => {
  it("sends effort, fallbacks, cache points and keeps the history append-only across turns", async () => {
    const { fetch, requests } = fakeAnthropic([
      thinkingThenSearch("sig-turn-1", "add a user in the internal tool"),
      answer("msg_2", "Go to Settings then Team and click Add teammate [1]."),
      thinkingThenSearch("sig-turn-2", "deactivate an account"),
      answer("msg_4", "Deactivate it from Settings then Team [3]."),
    ]);
    const model = createAnthropic({ apiKey: "test-key", fetch })("claude-opus-5-5");
    const llm = createLLM({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, effort: "low", model }, { env: {}, maxRetries: 0 });
    const state = newConversation();

    const first = await runTurn({ llm, knowledge, brain, state, question: "How do I add a user in the internal tool?" });
    const second = await runTurn({ llm, knowledge, brain, state, question: "And how do I deactivate one?" });

    expect(requests).toHaveLength(4);
    const [r1, r2, r3, r4] = requests;
    if (!r1 || !r2 || !r3 || !r4) throw new Error("missing requests");

    // Request shape of the default chat model.
    expect(r1.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r1.body.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(r1.body)).toContain('"effort":"low"');
    expect(r1.body.fallbacks).toBe("default");
    expect(r1.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(r1.body.thinking).toBeUndefined();
    expect(r1.body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(r1.body.system)).not.toContain(new Date().toISOString().slice(0, 10));
    expect(r1.body.tools.map((t) => t.name)).toEqual(["read_document", "report_gap", "search_knowledge"]);
    expect(r1.body.tool_choice?.type ?? "auto").toBe("auto");

    // The signed thinking block goes back unchanged, before the tool call it led to.
    const assistant = r2.body.messages[1];
    expect(assistant?.role).toBe("assistant");
    const blocks = assistant?.content as Array<{ type: string; signature?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(blocks[0]?.signature).toBe("sig-turn-1");
    expect(JSON.stringify(r2.body.messages[2])).toContain("tool_result");

    // Append-only: every request starts with the exact messages of the previous one (a cache hit, and no
    // edited history for preserved thinking).
    const prefixOf = (a: Captured, b: Captured): boolean =>
      JSON.stringify(b.body.messages.slice(0, a.body.messages.length)) === JSON.stringify(a.body.messages);
    expect(prefixOf(r1, r2)).toBe(true);
    expect(prefixOf(r2, r3)).toBe(true);
    expect(prefixOf(r3, r4)).toBe(true);
    // Same stable prefix (tools + system) on every call.
    expect(JSON.stringify([r4.body.tools, r4.body.system])).toBe(JSON.stringify([r1.body.tools, r1.body.system]));

    expect(first.citations[0]?.page).toBe("internal-tools/accounts");
    expect(first.usage.cachedInputTokens).toBe(4800);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(second.answer).toContain("Deactivate");
  });

  it("closes with tool_choice none after the tool budget, still sending the tools", async () => {
    const { fetch, requests } = fakeAnthropic([
      thinkingThenSearch("s1", "one"),
      thinkingThenSearch("s2", "two"),
      answer("msg_3", "Here is what I found [1]."),
    ]);
    const model = createAnthropic({ apiKey: "test-key", fetch })("claude-opus-5-5");
    const llm = createLLM({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, effort: "low", model }, { env: {}, maxRetries: 0 });
    await runTurn({ llm, knowledge, brain, state: newConversation(), question: "Tell me everything", limits: { maxToolRounds: 2 } });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.body.tool_choice).toEqual({ type: "none" });
    expect(requests[2]?.body.tools).toHaveLength(3);
  });
});
