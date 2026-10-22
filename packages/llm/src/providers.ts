import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { DemoLanguageModel } from "./demo.ts";
import { LlmError, type ModelRef } from "./types.ts";

// Every provider, every model. Native AI SDK providers for the four tested in CI, and the
// OpenAI-compatible protocol for the long tail: OpenRouter, DeepSeek, Groq, xAI, Ollama, vLLM, LiteLLM,
// and the OpenAI-compatible endpoints of Azure, Bedrock and Vertex. No model name is hard-coded here.

export type ProviderKind = "anthropic" | "openai" | "google" | "mistral" | "openai-compatible" | "demo";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Environment variables tried in order for the API key. */
  envKeys: string[];
  baseUrl?: string;
  /** Needs no key (local server or demo). */
  keyless?: boolean;
  /** Runs on the operator's machine: reachable from the CLI, never from Netlify. */
  local?: boolean;
  /** Tested in the upstream CI; the others are community-supported. */
  tested?: boolean;
}

export const BUILTIN_PROVIDERS: readonly ProviderDef[] = [
  { id: "anthropic", label: "Anthropic", kind: "anthropic", envKeys: ["ANTHROPIC_API_KEY"], tested: true },
  { id: "openai", label: "OpenAI", kind: "openai", envKeys: ["OPENAI_API_KEY"], tested: true },
  {
    id: "google",
    label: "Google",
    kind: "google",
    envKeys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
    tested: true,
  },
  { id: "mistral", label: "Mistral", kind: "mistral", envKeys: ["MISTRAL_API_KEY"], tested: true },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    envKeys: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    envKeys: ["DEEPSEEK_API_KEY"],
    baseUrl: "https://api.deepseek.com/v1",
  },
  { id: "groq", label: "Groq", kind: "openai-compatible", envKeys: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1" },
  { id: "xai", label: "xAI", kind: "openai-compatible", envKeys: ["XAI_API_KEY"], baseUrl: "https://api.x.ai/v1" },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    envKeys: ["OLLAMA_API_KEY"],
    baseUrl: "http://localhost:11434/v1",
    keyless: true,
    local: true,
    tested: true,
  },
  { id: "demo", label: "Demo (no LLM, extractive)", kind: "demo", envKeys: [], keyless: true },
];

/** An OpenAI-compatible endpoint declared by the instance (`providers.openai_compatible` in the config). */
export interface CustomEndpoint {
  name: string;
  base_url: string;
  api_key_env?: string | undefined;
}

export type Env = Record<string, string | undefined>;

export interface ProviderRegistry {
  providers: ProviderDef[];
  get(id: string): ProviderDef | undefined;
}

export function createProviderRegistry(custom: readonly CustomEndpoint[] = []): ProviderRegistry {
  const providers = [...BUILTIN_PROVIDERS];
  for (const endpoint of custom) {
    const existing = providers.findIndex((p) => p.id === endpoint.name);
    const def: ProviderDef = {
      id: endpoint.name,
      label: endpoint.name,
      kind: "openai-compatible",
      envKeys: endpoint.api_key_env ? [endpoint.api_key_env] : [],
      baseUrl: endpoint.base_url,
      keyless: !endpoint.api_key_env,
    };
    if (existing >= 0) providers[existing] = def;
    else providers.push(def);
  }
  return { providers, get: (id) => providers.find((p) => p.id === id) };
}

export function apiKeyFor(def: ProviderDef, env: Env, override?: string): string | undefined {
  if (override) {
    const value = env[override];
    if (value) return value;
  }
  for (const key of def.envKeys) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

/** A provider is usable when its key is set, or when it needs none. */
export function isConfigured(def: ProviderDef, env: Env): boolean {
  return def.keyless === true || apiKeyFor(def, env) !== undefined;
}

export interface CreateModelOptions {
  env: Env;
  /** Overrides the default endpoint (model config `base_url`). */
  baseUrl?: string | undefined;
  /** Name of the variable holding the key (model config `api_key_env`). */
  apiKeyEnv?: string | undefined;
}

export function createLanguageModel(registry: ProviderRegistry, ref: ModelRef, options: CreateModelOptions): LanguageModel {
  let def = registry.get(ref.provider);
  if (!def && options.baseUrl) {
    // Unknown provider with an explicit endpoint: treat it as OpenAI-compatible.
    def = { id: ref.provider, label: ref.provider, kind: "openai-compatible", envKeys: [], baseUrl: options.baseUrl };
  }
  if (!def) {
    throw new LlmError("config", `unknown provider "${ref.provider}": add it under providers.openai_compatible or set base_url`, {
      ref,
    });
  }
  const apiKey = apiKeyFor(def, options.env, options.apiKeyEnv);
  if (!apiKey && !def.keyless) {
    const names = options.apiKeyEnv ? [options.apiKeyEnv] : def.envKeys;
    throw new LlmError("config", `no API key for ${def.label}: set ${names.join(" or ")}`, { ref });
  }
  const baseURL = options.baseUrl ?? def.baseUrl;

  switch (def.kind) {
    case "anthropic":
      return createAnthropic({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) })(ref.model);
    case "openai":
      return createOpenAI({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) })(ref.model);
    case "google":
      return createGoogle({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) })(ref.model);
    case "mistral":
      return createMistral({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) })(ref.model);
    case "openai-compatible":
      if (!baseURL) throw new LlmError("config", `provider ${def.label} needs a base_url`, { ref });
      return createOpenAICompatible({
        name: def.id,
        baseURL,
        ...(apiKey ? { apiKey } : {}),
        includeUsage: true,
      }).chatModel(ref.model);
    case "demo": {
      const delayMs = Number(options.env.OPENBRAIN_DEMO_DELAY_MS ?? "0");
      return new DemoLanguageModel(ref.model, { delayMs: Number.isFinite(delayMs) ? delayMs : 0 });
    }
  }
}

/** A model the provider says is reachable with the current key. */
export interface ListedModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
}

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

const NON_CHAT = /embed|tts|whisper|dall-e|image|moderation|transcribe|audio|realtime|search|similarity|rerank|vision-exp/i;

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((v) => typeof v === "object" && v !== null) as Array<Record<string, unknown>>) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Lists the models a provider exposes to the current key: only what really works
 * is proposed in /admin/models. Returns [] for the demo provider.
 */
export async function listProviderModels(
  def: ProviderDef,
  env: Env,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<ListedModel[]> {
  const apiKey = apiKeyFor(def, env);
  if (!apiKey && !def.keyless) return [];
  const out: ListedModel[] = [];
  const push = (id: string | undefined, name?: string, contextWindow?: number): void => {
    if (!id || NON_CHAT.test(id)) return;
    out.push({ provider: def.id, id, ...(name ? { name } : {}), ...(contextWindow ? { contextWindow } : {}) });
  };

  switch (def.kind) {
    case "anthropic": {
      const data = await getJson(fetchImpl, `${def.baseUrl ?? "https://api.anthropic.com/v1"}/models?limit=1000`, {
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
      });
      for (const m of asArray((data as { data?: unknown }).data)) push(str(m.id), str(m.display_name), num(m.max_input_tokens));
      break;
    }
    case "google": {
      const data = await getJson(
        fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey ?? "")}`,
        {},
      );
      for (const m of asArray((data as { models?: unknown }).models)) {
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!methods.includes("generateContent")) continue;
        push(str(m.name)?.replace(/^models\//, ""), str(m.displayName), num(m.inputTokenLimit));
      }
      break;
    }
    case "openai":
    case "mistral":
    case "openai-compatible": {
      const base =
        def.baseUrl ?? (def.kind === "openai" ? "https://api.openai.com/v1" : def.kind === "mistral" ? "https://api.mistral.ai/v1" : "");
      const data = await getJson(fetchImpl, `${base}/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
      for (const m of asArray((data as { data?: unknown }).data)) {
        push(str(m.id), str(m.name), num(m.context_length) ?? num(m.max_context_length));
      }
      break;
    }
    case "demo":
      push("extractive", "Demo: quotes the best passages, no LLM");
      break;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
