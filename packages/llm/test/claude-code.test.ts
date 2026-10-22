import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeCodeLanguageModel, createLLM, parseClaudeOutput, renderPrompt, type ChatEvent, type ClaudeRunner } from "../src/index.ts";

// The claude-code provider runs `claude -p` on the operator's subscription. Here the CLI is replaced by a
// recording runner: no process is started.

function fakeClaude(result: Record<string, unknown>): { run: ClaudeRunner; calls: Array<{ args: string[]; input: string }> } {
  const calls: Array<{ args: string[]; input: string }> = [];
  const run: ClaudeRunner = async (args, input) => {
    calls.push({ args, input });
    return JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 42 },
      ...result,
    });
  };
  return { run, calls };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("claude-code provider (Claude Code on the subscription)", () => {
  it("answers through an isolated `claude -p` call, priced at zero, without tools", async () => {
    const fake = fakeClaude({ result: "Go to Settings then Team [1]." });
    const model = new ClaudeCodeLanguageModel("sonnet", { run: fake.run });
    const llm = createLLM({ ref: { provider: "claude-code", model: "sonnet" }, model }, { env: {} });
    expect(llm.caps.tools).toBe(false);
    expect(llm.price).toEqual({ input: 0, output: 0 });

    const events: ChatEvent[] = [];
    for await (const event of llm.stream({ system: "You are Acme Brain.", messages: [{ role: "user", content: "How do I add a colleague?" }] })) {
      events.push(event);
    }
    const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(text).toBe("Go to Settings then Team [1].");

    const [call] = fake.calls;
    expect(call?.input).toBe("How do I add a colleague?");
    expect(argAfter(call?.args ?? [], "--model")).toBe("sonnet");
    expect(argAfter(call?.args ?? [], "--system-prompt")).toBe("You are Acme Brain.");
    expect(argAfter(call?.args ?? [], "--tools")).toBe("");
    expect(call?.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
  });

  it("passes a JSON schema for structured outputs (eval judge)", async () => {
    const fake = fakeClaude({ result: "{}", structured_output: { grounded: true } });
    const llm = createLLM({ ref: { provider: "claude-code", model: "opus" }, model: new ClaudeCodeLanguageModel("opus", { run: fake.run }) }, { env: {} });
    const { object } = await llm.generateObject({
      system: "Grade the answer.",
      prompt: "Answer: ...",
      schema: z.object({ grounded: z.boolean() }),
    });
    expect(object).toEqual({ grounded: true });
    expect(JSON.parse(argAfter(fake.calls[0]?.args ?? [], "--json-schema") ?? "{}")).toMatchObject({ type: "object" });
  });

  it("renders a conversation, and reports errors and usage", () => {
    const { system, input } = renderPrompt([
      { role: "system", content: "Rules." },
      { role: "user", content: [{ type: "text", text: "First question" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ]);
    expect(system).toBe("Rules.");
    expect(input).toBe("<user>\nFirst question\n</user>\n\n<assistant>\nFirst answer\n</assistant>\n\n<user>\nFollow-up\n</user>\n\nAnswer the last user message.");

    expect(() => parseClaudeOutput(JSON.stringify({ subtype: "success", is_error: true, result: "Not logged in" }))).toThrow(/Not logged in/);
    expect(() => parseClaudeOutput("oops")).toThrow(/unexpected output/);
    const parsed = parseClaudeOutput(
      JSON.stringify({ subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 5, cache_read_input_tokens: 95, output_tokens: 7 } }),
    );
    expect(parsed.usage.inputTokens).toEqual({ total: 100, noCache: 5, cacheRead: 95, cacheWrite: 0 });
  });
});
