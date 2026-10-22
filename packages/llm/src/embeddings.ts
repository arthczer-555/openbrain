import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany, type EmbeddingModel } from "ai";
import { apiKeyFor, createProviderRegistry, type Env, type ProviderRegistry } from "./providers.ts";
import { LlmError, type ModelRef } from "./types.ts";

// Optional embeddings for hybrid search: any provider with an embeddings endpoint.
// Voyage (the advised default) through its HTTP API; OpenAI, Google, Mistral and OpenAI-compatible endpoints
// (Ollama, vLLM...) through the AI SDK. Without a key, search stays BM25 only.

export interface EmbeddingSpec {
  ref: ModelRef;
  dimensions?: number | undefined;
  apiKeyEnv?: string | undefined;
  baseUrl?: string | undefined;
}

export type EmbeddingKind = "document" | "query";

export interface Embedder {
  ref: ModelRef;
  dimensions: number | null;
  embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH = 128;

function voyageEmbedder(spec: EmbeddingSpec, apiKey: string, fetchImpl: FetchLike): Embedder {
  return {
    ref: spec.ref,
    dimensions: spec.dimensions ?? null,
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const response = await fetchImpl(spec.baseUrl ?? VOYAGE_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            input: texts.slice(i, i + BATCH),
            model: spec.ref.model,
            input_type: kind,
            ...(spec.dimensions ? { output_dimension: spec.dimensions } : {}),
          }),
        });
        if (!response.ok) {
          throw new LlmError(response.status === 429 || response.status >= 500 ? "retryable" : "fatal", `voyage embeddings: HTTP ${response.status}`, {
            status: response.status,
            ref: spec.ref,
          });
        }
        const body = (await response.json()) as { data?: Array<{ embedding: number[]; index: number }> };
        const batch = [...(body.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        out.push(...batch);
      }
      return out;
    },
  };
}

function sdkEmbedder(spec: EmbeddingSpec, model: EmbeddingModel, provider: string): Embedder {
  return {
    ref: spec.ref,
    dimensions: spec.dimensions ?? null,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const providerOptions =
        provider === "google" ? { google: { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" } } : undefined;
      const result = await embedMany({
        model,
        values: [...texts],
        ...(spec.dimensions ? { dimensions: spec.dimensions } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        maxRetries: 2,
      });
      return result.embeddings.map((e) => [...e]);
    },
  };
}

export interface EmbedderOptions {
  env: Env;
  registry?: ProviderRegistry;
  fetch?: FetchLike;
}

/** Null when the key of the provider is missing: the caller falls back to BM25 only. */
export function createEmbedder(spec: EmbeddingSpec, options: EmbedderOptions): Embedder | null {
  const { provider, model } = spec.ref;
  if (provider === "voyage") {
    const key = options.env[spec.apiKeyEnv ?? "VOYAGE_API_KEY"];
    return key ? voyageEmbedder(spec, key, options.fetch ?? ((input, init) => fetch(input, init))) : null;
  }
  const registry = options.registry ?? createProviderRegistry();
  const def = registry.get(provider);
  if (!def) throw new LlmError("config", `unknown embeddings provider "${provider}"`, { ref: spec.ref });
  const apiKey = apiKeyFor(def, options.env, spec.apiKeyEnv);
  if (!apiKey && !def.keyless) return null;
  const baseURL = spec.baseUrl ?? def.baseUrl;
  const auth = apiKey ? { apiKey } : {};
  switch (def.kind) {
    case "openai":
      return sdkEmbedder(spec, createOpenAI({ ...auth, ...(baseURL ? { baseURL } : {}) }).embedding(model), provider);
    case "google":
      return sdkEmbedder(spec, createGoogle({ ...auth, ...(baseURL ? { baseURL } : {}) }).embedding(model), provider);
    case "mistral":
      return sdkEmbedder(spec, createMistral({ ...auth, ...(baseURL ? { baseURL } : {}) }).embedding(model), provider);
    case "openai-compatible":
      if (!baseURL) throw new LlmError("config", `provider ${def.label} needs a base_url`, { ref: spec.ref });
      return sdkEmbedder(spec, createOpenAICompatible({ name: def.id, baseURL, ...auth }).embeddingModel(model), provider);
    default:
      throw new LlmError("config", `${def.label} has no embeddings endpoint`, { ref: spec.ref });
  }
}
