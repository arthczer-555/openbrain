import type { ModelMessage } from "ai";
import type { z } from "zod";

// The model layer seen by the rest of the engine.
// The agent and the server only know these types: adding a provider never touches them.

export type { ModelMessage };

/** "anthropic:claude-opus-5-5", "openrouter:minimax/minimax-m3.1-flash:free" (split on the first colon). */
export interface ModelRef {
  provider: string;
  model: string;
}

/** Normalized reasoning effort, translated by each adapter (ignored when the model has no such setting). */
export type Effort = "low" | "medium" | "high";

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  /** "explicit": cache points must be placed (Anthropic); "automatic": prefix caching by the provider. */
  promptCaching: "explicit" | "automatic" | "none";
  reasoning: boolean;
  /** Effort values the model accepts, in the provider's vocabulary. */
  effort: string[];
  contextWindow: number;
  maxOutput: number;
  /** True when the capabilities come from a catalog, false when they are guessed. */
  verified: boolean;
}

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface NormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Null when the price of the model is unknown ("not priced"). */
  costUsd: number | null;
}

export const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
};

export interface ToolSpec {
  description: string;
  inputSchema: z.ZodType;
}

export interface ChatRequest {
  /** Stable prefix (core.md + catalog.md): never put a date or a user name here, it breaks the cache. */
  system: string;
  messages: ModelMessage[];
  /** Tools are sent sorted by name so the prefix stays byte-identical between calls. */
  tools?: Record<string, ToolSpec>;
  /** "none" keeps the tool definitions (cache) but forbids calling them. Forced choices are not used. */
  toolChoice?: "auto" | "none";
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "content-filter" | "refusal" | "error" | "other";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "finish";
      reason: FinishReason;
      usage: NormalizedUsage;
      /** Assistant turn exactly as the provider returned it (reasoning blocks included): append it as is. */
      responseMessages: ModelMessage[];
      /** The model that actually answered (a fallback may have served the request). */
      servedBy: ModelRef;
    };

export type LlmErrorKind = "retryable" | "fatal" | "refusal" | "config";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  readonly ref: ModelRef | undefined;

  constructor(kind: LlmErrorKind, message: string, options: { status?: number; ref?: ModelRef; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.kind = kind;
    this.status = options.status;
    this.ref = options.ref;
  }
}

export interface ObjectRequest<T> {
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface LLM {
  ref: ModelRef;
  caps: ModelCapabilities;
  price: Price | null;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  generateObject<T>(req: ObjectRequest<T>): Promise<{ object: T; usage: NormalizedUsage }>;
}

export function formatRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export function parseRef(text: string): ModelRef {
  const index = text.indexOf(":");
  if (index <= 0 || index === text.length - 1) {
    throw new LlmError("config", `invalid model reference "${text}" (expected provider:model)`);
  }
  return { provider: text.slice(0, index).trim(), model: text.slice(index + 1).trim() };
}
