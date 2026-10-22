import { APICallError, generateText, Output, streamText, tool, type LanguageModel, type LanguageModelUsage, type SystemModelMessage, type ToolSet } from "ai";
import { builtinCatalog, costUsd, findModel, guessedCapabilities, resolvePrice, type CatalogModel, type PriceOverride } from "./catalog.ts";
import { createLanguageModel, createProviderRegistry, type Env, type ProviderRegistry } from "./providers.ts";
import {
  EMPTY_USAGE,
  formatRef,
  LlmError,
  type ChatEvent,
  type ChatRequest,
  type Effort,
  type FinishReason,
  type LLM,
  type ModelCapabilities,
  type ModelMessage,
  type ModelRef,
  type NormalizedUsage,
  type ObjectRequest,
  type Price,
} from "./types.ts";

// The normalized client: one stream format for every provider, effort translated per
// provider, explicit cache points only where the provider needs them, errors classified, fallback chain.

export interface ModelSpec {
  ref: ModelRef;
  effort?: Effort | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  maxOutputTokens?: number | undefined;
  /** Injected model (tests, custom AI SDK providers): skips the provider registry. */
  model?: LanguageModel | undefined;
}

export interface LlmOptions {
  env: Env;
  registry?: ProviderRegistry;
  catalog?: readonly CatalogModel[];
  pricing?: Record<string, PriceOverride>;
  /** Retries of the same model before giving up or falling back (default 2). */
  maxRetries?: number;
}

/** Claude models that accept the server-side refusal fallback in its "default" form. */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

/** Provider-specific options: effort, cache, server-side fallbacks. Unknown settings are never sent. */
export function providerOptionsFor(ref: ModelRef, caps: ModelCapabilities, effort: Effort | undefined): ProviderOptions {
  const supportsEffort = effort !== undefined && caps.effort.includes(effort);
  switch (ref.provider) {
    case "anthropic":
      return {
        anthropic: {
          // Top-level cache control: a sliding cache point on the last cacheable block (the system has its own).
          cacheControl: { type: "ephemeral" },
          ...(supportsEffort ? { effort } : {}),
          ...(SERVER_FALLBACK_MODELS.has(ref.model) ? { fallbacks: "default" } : {}),
        },
      };
    case "openai":
      return supportsEffort ? { openai: { reasoningEffort: effort } } : {};
    case "google":
      return supportsEffort ? { google: { thinkingConfig: { thinkingLevel: effort } } } : {};
    default:
      return {};
  }
}

export function normalizeUsage(usage: LanguageModelUsage | undefined, price: Price | null): NormalizedUsage {
  if (!usage) return { ...EMPTY_USAGE, costUsd: price ? 0 : null };
  const base = {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
  return { ...base, costUsd: costUsd(base, price) };
}

export function classifyError(error: unknown, ref: ModelRef): LlmError {
  if (error instanceof LlmError) return error;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const retryable = error.isRetryable || status === 429 || (status !== undefined && status >= 500);
    return new LlmError(retryable ? "retryable" : "fatal", `${formatRef(ref)}: ${error.message}`, {
      ...(status !== undefined ? { status } : {}),
      ref,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const network = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|network/i.test(message);
  return new LlmError(network ? "retryable" : "fatal", `${formatRef(ref)}: ${message}`, { ref, cause: error });
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
    case "tool-calls":
    case "length":
    case "error":
    case "other":
      return reason;
    case "content-filter":
      return "refusal";
    default:
      return "other";
  }
}

function toolSet(req: ChatRequest): ToolSet | undefined {
  if (!req.tools) return undefined;
  const set: ToolSet = {};
  // Sorted by name: the tool block must be byte-identical between calls for the prompt cache.
  for (const name of Object.keys(req.tools).sort()) {
    const spec = req.tools[name];
    if (spec) set[name] = tool({ description: spec.description, inputSchema: spec.inputSchema });
  }
  return set;
}

function systemMessage(text: string, caps: ModelCapabilities): SystemModelMessage {
  return caps.promptCaching === "explicit"
    ? { role: "system", content: text, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
    : { role: "system", content: text };
}

class SingleModelLLM implements LLM {
  readonly ref: ModelRef;
  readonly caps: ModelCapabilities;
  readonly price: Price | null;
  private readonly spec: ModelSpec;
  private readonly options: LlmOptions;
  private readonly registry: ProviderRegistry;
  private model: LanguageModel | undefined;

  constructor(spec: ModelSpec, options: LlmOptions) {
    this.spec = spec;
    this.ref = spec.ref;
    this.options = options;
    this.registry = options.registry ?? createProviderRegistry();
    const catalog = options.catalog ?? builtinCatalog();
    const entry = findModel(catalog, spec.ref);
    this.caps =
      spec.ref.provider === "demo"
        ? { ...guessedCapabilities("demo"), tools: true, verified: true }
        : (entry?.caps ?? guessedCapabilities(spec.ref.provider));
    this.price = spec.ref.provider === "demo" ? { input: 0, output: 0 } : resolvePrice(catalog, spec.ref, options.pricing);
  }

  private languageModel(): LanguageModel {
    this.model ??=
      this.spec.model ??
      createLanguageModel(this.registry, this.ref, {
        env: this.options.env,
        baseUrl: this.spec.baseUrl,
        apiKeyEnv: this.spec.apiKeyEnv,
      });
    return this.model;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const model = this.languageModel();
    const tools = toolSet(req);
    let failure: unknown;
    const result = streamText({
      model,
      system: systemMessage(req.system, this.caps),
      messages: req.messages,
      ...(tools ? { tools, toolChoice: req.toolChoice ?? "auto" } : {}),
      maxOutputTokens: req.maxOutputTokens ?? this.spec.maxOutputTokens ?? 4_000,
      providerOptions: providerOptionsFor(this.ref, this.caps, this.spec.effort),
      maxRetries: this.options.maxRetries ?? 2,
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      onError: ({ error }) => {
        failure = error;
      },
    });

    let finishReason: FinishReason = "other";
    let usage: LanguageModelUsage | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if (part.text) yield { type: "text", delta: part.text };
          break;
        case "tool-call":
          yield { type: "tool_call", call: { id: part.toolCallId, name: part.toolName, input: part.input } };
          break;
        case "error":
          throw classifyError(part.error, this.ref);
        case "finish":
          finishReason = mapFinish(part.finishReason);
          usage = part.totalUsage;
          break;
        default:
          break;
      }
    }
    if (failure !== undefined) throw classifyError(failure, this.ref);
    const responseMessages = (await result.responseMessages) as ModelMessage[];
    yield {
      type: "finish",
      reason: finishReason,
      usage: normalizeUsage(usage, this.price),
      responseMessages,
      servedBy: this.ref,
    };
  }

  async generateObject<T>(req: ObjectRequest<T>): Promise<{ object: T; usage: NormalizedUsage }> {
    const model = this.languageModel();
    try {
      const result = await generateText({
        model,
        ...(req.system ? { system: systemMessage(req.system, this.caps) } : {}),
        prompt: req.prompt,
        output: Output.object({ schema: req.schema }),
        maxOutputTokens: req.maxOutputTokens ?? this.spec.maxOutputTokens ?? 4_000,
        providerOptions: providerOptionsFor(this.ref, this.caps, this.spec.effort),
        maxRetries: this.options.maxRetries ?? 2,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      });
      return { object: result.output as T, usage: normalizeUsage(result.totalUsage, this.price) };
    } catch (error) {
      throw classifyError(error, this.ref);
    }
  }
}

/** Errors worth trying the next model of the chain for: provider down, rate limit, refusal, missing key. */
function shouldFallBack(error: LlmError): boolean {
  return error.kind === "retryable" || error.kind === "refusal" || error.kind === "config";
}

class FallbackLLM implements LLM {
  readonly ref: ModelRef;
  readonly caps: ModelCapabilities;
  readonly price: Price | null;
  private readonly chain: LLM[];

  constructor(chain: LLM[]) {
    const first = chain[0];
    if (!first) throw new LlmError("config", "empty model chain");
    this.chain = chain;
    this.ref = first.ref;
    this.caps = first.caps;
    this.price = first.price;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    let lastError: LlmError | undefined;
    for (const llm of this.chain) {
      let emitted = false;
      try {
        for await (const event of llm.stream(req)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const classified = classifyError(error, llm.ref);
        // Once text or a tool call has gone out, switching model would duplicate it: surface the error.
        if (emitted || !shouldFallBack(classified)) throw classified;
        lastError = classified;
      }
    }
    throw lastError ?? new LlmError("fatal", "no model answered");
  }

  async generateObject<T>(req: ObjectRequest<T>): Promise<{ object: T; usage: NormalizedUsage }> {
    let lastError: LlmError | undefined;
    for (const llm of this.chain) {
      try {
        return await llm.generateObject(req);
      } catch (error) {
        const classified = classifyError(error, llm.ref);
        if (!shouldFallBack(classified)) throw classified;
        lastError = classified;
      }
    }
    throw lastError ?? new LlmError("fatal", "no model answered");
  }
}

export function createLLM(spec: ModelSpec, options: LlmOptions): LLM {
  return new SingleModelLLM(spec, options);
}

/** Primary model first, then the fallbacks of the role, tried in order. */
export function createLLMChain(specs: readonly ModelSpec[], options: LlmOptions): LLM {
  const chain = specs.map((spec) => new SingleModelLLM(spec, options));
  return chain.length === 1 && chain[0] ? chain[0] : new FallbackLLM(chain);
}
