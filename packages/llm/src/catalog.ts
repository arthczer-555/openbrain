import snapshot from "./catalog-snapshot.json" with { type: "json" };
import type { ModelCapabilities, ModelRef, NormalizedUsage, Price } from "./types.ts";

// Capabilities and prices of models. Three layers, last wins:
// 1. a small snapshot shipped with the engine (models.dev, tested providers only),
// 2. the full models.dev catalog fetched by `openbrain models refresh` into .openbrain/models.json,
// 3. instance overrides (pricing in openbrain.config.yaml), for internal models or negotiated prices.
// A model missing everywhere still works: it is shown as "capabilities not verified" and "not priced".

export type CatalogSource = "snapshot" | "models.dev" | "provider" | "override";

export interface CatalogModel {
  provider: string;
  id: string;
  name: string;
  released?: string;
  caps: ModelCapabilities;
  price: Price | null;
  source: CatalogSource;
}

interface SnapshotModel {
  provider: string;
  id: string;
  name: string;
  released?: string;
  tools: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  effort?: string[];
  context: number;
  maxOutput: number;
  cost: Price | null;
}

/** Providers whose prompt cache needs explicit cache points; the others cache prefixes on their own or not at all. */
const EXPLICIT_CACHE = new Set(["anthropic"]);
const AUTOMATIC_CACHE = new Set(["openai", "google", "deepseek", "openrouter"]);

export function cacheModeOf(provider: string): ModelCapabilities["promptCaching"] {
  if (EXPLICIT_CACHE.has(provider)) return "explicit";
  if (AUTOMATIC_CACHE.has(provider)) return "automatic";
  return "none";
}

function fromSnapshot(m: SnapshotModel, source: CatalogSource): CatalogModel {
  return {
    provider: m.provider,
    id: m.id,
    name: m.name,
    ...(m.released ? { released: m.released } : {}),
    caps: {
      tools: m.tools,
      streaming: true,
      structuredOutput: m.structuredOutput,
      promptCaching: cacheModeOf(m.provider),
      reasoning: m.reasoning,
      effort: m.effort ?? [],
      contextWindow: m.context,
      maxOutput: m.maxOutput,
      verified: true,
    },
    price: m.cost,
    source,
  };
}

export function builtinCatalog(): CatalogModel[] {
  return (snapshot.models as SnapshotModel[]).map((m) => fromSnapshot(m, "snapshot"));
}

export const SNAPSHOT_DATE = snapshot.fetched_at;

/** Capabilities assumed for a model no catalog knows: tools on (the agent falls back to retrieval-first if calls fail). */
export function guessedCapabilities(provider: string): ModelCapabilities {
  return {
    tools: provider !== "ollama",
    streaming: true,
    structuredOutput: false,
    promptCaching: cacheModeOf(provider),
    reasoning: false,
    effort: [],
    contextWindow: 32_000,
    maxOutput: 4_096,
    verified: false,
  };
}

interface ModelsDevModel {
  id: string;
  name?: string;
  release_date?: string;
  tool_call?: boolean;
  structured_output?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  limit?: { context?: number; output?: number };
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

/** Converts the models.dev catalog (https://models.dev/api.json) for the given providers, text models only. */
export function parseModelsDev(data: unknown, providers: readonly string[]): CatalogModel[] {
  if (typeof data !== "object" || data === null) return [];
  const root = data as Record<string, { models?: Record<string, ModelsDevModel> }>;
  const out: CatalogModel[] = [];
  for (const provider of providers) {
    for (const m of Object.values(root[provider]?.models ?? {})) {
      if (m.modalities?.output && !m.modalities.output.includes("text")) continue;
      const cost = m.cost;
      const price: Price | null =
        cost && typeof cost.input === "number" && typeof cost.output === "number"
          ? {
              input: cost.input,
              output: cost.output,
              ...(typeof cost.cache_read === "number" ? { cacheRead: cost.cache_read } : {}),
              ...(typeof cost.cache_write === "number" ? { cacheWrite: cost.cache_write } : {}),
            }
          : null;
      out.push(
        fromSnapshot(
          {
            provider,
            id: m.id,
            name: m.name ?? m.id,
            ...(m.release_date ? { released: m.release_date } : {}),
            tools: m.tool_call === true,
            structuredOutput: m.structured_output === true,
            reasoning: m.reasoning === true,
            effort: m.reasoning_options?.find((o) => o.type === "effort")?.values ?? [],
            context: m.limit?.context ?? 0,
            maxOutput: m.limit?.output ?? 0,
            cost: price,
          },
          "models.dev",
        ),
      );
    }
  }
  return out;
}

/** Merges catalog layers: later layers replace earlier entries with the same provider and id. */
export function mergeCatalogs(...layers: CatalogModel[][]): CatalogModel[] {
  const byKey = new Map<string, CatalogModel>();
  for (const layer of layers) {
    for (const m of layer) byKey.set(`${m.provider}:${m.id}`, m);
  }
  return [...byKey.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || (b.released ?? "").localeCompare(a.released ?? "") || a.id.localeCompare(b.id),
  );
}

export function findModel(catalog: readonly CatalogModel[], ref: ModelRef): CatalogModel | undefined {
  const exact = catalog.find((m) => m.provider === ref.provider && m.id === ref.model);
  if (exact) return exact;
  // Dated snapshots ("claude-haiku-4-5-20251001") share the capabilities of their alias.
  const undated = ref.model.replace(/-\d{8}$/, "");
  return catalog.find((m) => m.provider === ref.provider && m.id === undated);
}

/** Price overrides from openbrain.config.yaml (`pricing: { "provider/model": {...} }`). */
export interface PriceOverride {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok?: number | undefined;
  cache_write_per_mtok?: number | undefined;
}

export function priceFromOverride(o: PriceOverride): Price {
  return {
    input: o.input_per_mtok,
    output: o.output_per_mtok,
    ...(o.cache_read_per_mtok !== undefined ? { cacheRead: o.cache_read_per_mtok } : {}),
    ...(o.cache_write_per_mtok !== undefined ? { cacheWrite: o.cache_write_per_mtok } : {}),
  };
}

export function resolvePrice(
  catalog: readonly CatalogModel[],
  ref: ModelRef,
  overrides: Record<string, PriceOverride> = {},
): Price | null {
  const override = overrides[`${ref.provider}/${ref.model}`];
  if (override) return priceFromOverride(override);
  return findModel(catalog, ref)?.price ?? null;
}

/** Cost of a call. Cache reads and writes fall back to the input price when the catalog has no cache price. */
export function costUsd(usage: Omit<NormalizedUsage, "costUsd">, price: Price | null): number | null {
  if (!price) return null;
  const uncached = Math.max(usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens, 0);
  const total =
    uncached * price.input +
    usage.cachedInputTokens * (price.cacheRead ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return Math.round((total / 1_000_000) * 1e6) / 1e6;
}

export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}
