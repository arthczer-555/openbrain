import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { hasErrors, lintKnowledgeBase, loadInstanceConfig, loadKnowledgeBase, type InstanceConfig } from "@openbrain/core";
import { knowledgeFromIndex, loadBrain, type Brain, type KnowledgePort } from "@openbrain/agent";
import { createEmbedder, createProviderRegistry, type CatalogModel, type Embedder, type Env } from "@openbrain/llm";
import { buildIndex, passageContent, quantize, type SerializedIndex, type VectorIndex } from "@openbrain/retrieval";
import { resolveSettings } from "./settings.ts";

// Everything the deployed chatbot needs, in one file built at deploy time (`openbrain bundle`) and shipped
// with the function (netlify.toml included_files). The function never reads knowledge/ nor calls Notion.

export const BUNDLE_FILE = ".openbrain/runtime/bundle.json";

export interface RuntimeBundle {
  version: 1;
  builtAt: string;
  /** Git commit of the deploy: a report says which version of the mirror answered. */
  commit: string | null;
  config: InstanceConfig;
  brain: Brain;
  index: SerializedIndex;
  /** Questions of evals/golden.yaml expected to be answered: the "test a model" button of the admin. */
  evalQuestions: string[];
  /** ISO date of the last weekly update (state/sync.json `last_weekly`), if any. */
  lastWeeklyUpdate: string | null;
  /** Sections of the catalog (title and description), for the knowledge browser. */
  sections: Array<{ id: string; title: string; description: string }>;
  /** Model catalog fetched by `openbrain models refresh` (.openbrain/models.json), when present. */
  models?: CatalogModel[];
  /** Passage embeddings for hybrid search, when models.embeddings is configured and its key is set. */
  vectors?: VectorIndex;
  /** What happened to the embeddings at build: "off", "built", or why they were skipped. */
  embeddings: string;
}

/** The embedder of the instance (models.embeddings), or null when off or without a key. */
export function embedderFor(config: InstanceConfig, env: Env): Embedder | null {
  const settings = resolveSettings(config, env);
  const e = settings.embeddings;
  if (!e) return null;
  return createEmbedder(
    { ref: { provider: e.provider, model: e.model }, dimensions: e.dimensions, apiKeyEnv: e.api_key_env, baseUrl: e.base_url },
    { env, registry: createProviderRegistry(settings.openaiCompatible) },
  );
}

/** Search port of a bundle: hybrid when the bundle has vectors and the embeddings key is set, BM25 otherwise. */
export function knowledgeFromBundle(bundle: RuntimeBundle, env: Env): KnowledgePort {
  return knowledgeFromIndex(bundle.index, bundle.vectors ?? null, bundle.vectors ? embedderFor(bundle.config, env) : null);
}

async function embedPassages(index: SerializedIndex, embedder: Embedder): Promise<VectorIndex> {
  // The passage content without its "Title > heading" prefix line, then the title once, like the BM25 fields.
  const texts = index.chunks.map((c) => `${[index.docs[c.docId]?.title ?? "", ...c.headingPath].join(" > ")}\n${passageContent(c)}`);
  const vectors = await embedder.embed(texts, "document");
  return quantize(`${embedder.ref.provider}:${embedder.ref.model}`, index.chunks.map((c) => c.id), vectors);
}

export const MODELS_FILE = ".openbrain/models.json";

async function refreshedModels(root: string): Promise<CatalogModel[] | undefined> {
  const text = await readOptional(path.join(root, MODELS_FILE));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { models?: unknown };
    return Array.isArray(parsed.models) ? (parsed.models as CatalogModel[]) : undefined;
  } catch {
    return undefined;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Answerable questions of the instance evals, in file order. */
export function evalQuestionsFrom(yamlText: string | null): string[] {
  if (!yamlText) return [];
  const data: unknown = parseYaml(yamlText);
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { question?: unknown; expect?: { behavior?: unknown } };
    if (typeof entry.question === "string" && (entry.expect?.behavior ?? "answer") === "answer") out.push(entry.question);
  }
  return out;
}

export async function lastWeeklyUpdate(root: string): Promise<string | null> {
  const text = await readOptional(path.join(root, "state", "sync.json"));
  if (!text) return null;
  try {
    const value = (JSON.parse(text) as { last_weekly?: unknown }).last_weekly;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function buildBundle(
  root: string,
  options: { commit?: string | null; now?: Date; env?: Env } = {},
): Promise<RuntimeBundle> {
  const kb = await loadKnowledgeBase(root);
  const issues = lintKnowledgeBase(kb);
  if (hasErrors(issues)) {
    const first = issues.filter((i) => i.level === "error").slice(0, 5);
    throw new Error(`the knowledge base has lint errors (run openbrain lint):\n${first.map((i) => `  ${i.file}: ${i.message}`).join("\n")}`);
  }
  const [config, brain, golden, weekly, models] = await Promise.all([
    loadInstanceConfig(root),
    loadBrain(root),
    readOptional(path.join(root, "evals", "golden.yaml")),
    lastWeeklyUpdate(root),
    refreshedModels(root),
  ]);
  const index = buildIndex(kb);
  let vectors: VectorIndex | undefined;
  let embeddings = "off";
  const env = options.env ?? {};
  const embedder = embedderFor(config, env);
  if (resolveSettings(config, env).embeddings) {
    if (!embedder) embeddings = "skipped: no key for the embeddings provider";
    else {
      try {
        vectors = await embedPassages(index, embedder);
        embeddings = `built (${vectors.chunkIds.length} passages, ${vectors.dimensions} dimensions)`;
      } catch (error) {
        embeddings = `skipped: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return {
    version: 1,
    builtAt: (options.now ?? new Date()).toISOString(),
    commit: options.commit ?? null,
    config,
    brain,
    index,
    embeddings,
    ...(vectors ? { vectors } : {}),
    evalQuestions: evalQuestionsFrom(golden),
    lastWeeklyUpdate: weekly,
    sections: kb.sections.map((s) => ({ id: s.id, title: s.title, description: s.description })),
    ...(models ? { models } : {}),
  };
}

export async function saveBundle(file: string, bundle: RuntimeBundle): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(bundle), "utf8");
}

export async function loadBundleFile(file: string): Promise<RuntimeBundle> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RuntimeBundle>;
  if (parsed.version !== 1 || !parsed.index || !parsed.brain) throw new Error(`${file} is not an OpenBrain runtime bundle`);
  return parsed as RuntimeBundle;
}
