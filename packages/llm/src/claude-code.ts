import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

// The "claude-code" provider: answers through the operator's Claude Code (`claude -p`), on their Claude
// subscription, with no API key. For tests in the terminal (ask, eval, serve): it never runs on Netlify.
// It has no tools, so the agent uses its retrieval-first mode: passages are searched first, then the model
// writes one answer with its citations. Each call is isolated: no tool, no MCP server, no skill, no session
// saved, no settings or CLAUDE.md of the current folder, and no ANTHROPIC_API_KEY (the subscription pays).

/** Runs the CLI with these arguments and stdin, returns stdout. Injected in tests. */
export type ClaudeRunner = (args: string[], input: string) => Promise<string>;

export interface ClaudeCodeOptions {
  /** Command to run (default "claude", or OPENBRAIN_CLAUDE_BIN). */
  command?: string;
  /** Per call (default 180 s). */
  timeoutMs?: number;
  run?: ClaudeRunner;
}

export function defaultClaudeRunner(command: string, timeoutMs: number): ClaudeRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const child = spawn(command, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`claude -p did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error.code === "ENOENT"
            ? new Error("Claude Code is not installed (https://claude.com/claude-code): install it and sign in with `claude`, or set an API key")
            : error,
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdout.trim() === "" && code !== 0) reject(new Error(`claude -p failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
        else resolve(stdout);
      });
      child.stdin.end(input);
    });
}

function textOf(message: LanguageModelV4Message): string {
  if (message.role === "system") return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "tool-result") {
      const output = part.output;
      parts.push(output.type === "text" || output.type === "error-text" ? output.value : JSON.stringify(output));
    }
  }
  return parts.join("\n").trim();
}

/** System prompt, and the conversation as one text: the last user message alone when there is no history. */
export function renderPrompt(prompt: LanguageModelV4Message[]): { system: string; input: string } {
  const system = prompt
    .filter((m) => m.role === "system")
    .map(textOf)
    .join("\n\n");
  const turns = prompt.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: textOf(m) }));
  if (turns.length === 1) return { system, input: turns[0]?.text ?? "" };
  const input = turns
    .filter((t) => t.text !== "")
    .map((t) => `<${t.role === "assistant" ? "assistant" : "user"}>\n${t.text}\n</${t.role === "assistant" ? "assistant" : "user"}>`)
    .join("\n\n");
  return { system, input: `${input}\n\nAnswer the last user message.` };
}

interface ClaudeResult {
  text: string;
  usage: LanguageModelV4Usage;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseClaudeOutput(stdout: string): ClaudeResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`unexpected output from claude -p: ${stdout.trim().slice(0, 200)}`);
  }
  const result = typeof data.result === "string" ? data.result : "";
  if (data.is_error === true || data.subtype !== "success") {
    throw new Error(`claude -p: ${result || String(data.subtype ?? "error")} (signed in? run \`claude\` once)`);
  }
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const noCache = numberOf(usage.input_tokens);
  const cacheRead = numberOf(usage.cache_read_input_tokens);
  const cacheWrite = numberOf(usage.cache_creation_input_tokens);
  const output = numberOf(usage.output_tokens);
  const text = data.structured_output !== undefined && data.structured_output !== null ? JSON.stringify(data.structured_output) : result;
  return {
    text,
    usage: {
      inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
  };
}

export class ClaudeCodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "claude-code";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly run: ClaudeRunner;

  constructor(modelId = "sonnet", options: ClaudeCodeOptions = {}) {
    this.modelId = modelId;
    this.run = options.run ?? defaultClaudeRunner(options.command ?? process.env.OPENBRAIN_CLAUDE_BIN ?? "claude", options.timeoutMs ?? 180_000);
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { system, input } = renderPrompt(options.prompt);
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.modelId,
      "--system-prompt",
      system || "You are a helpful assistant.",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--setting-sources",
      "",
    ];
    if (options.responseFormat?.type === "json" && options.responseFormat.schema) {
      args.push("--json-schema", JSON.stringify(options.responseFormat.schema));
    }
    const { text, usage } = parseClaudeOutput(await this.run(args, input));
    return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const result = await this.doGenerate(options);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const id = "text_0";
    const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }, { type: "text-start", id }];
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) parts.push({ type: "text-delta", id, delta: piece });
    parts.push({ type: "text-end", id }, { type: "finish", finishReason: result.finishReason, usage: result.usage });
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    return { stream };
  }
}
