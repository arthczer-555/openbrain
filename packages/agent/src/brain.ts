import { readFile } from "node:fs/promises";
import path from "node:path";
import { CATALOG_FILE, CORE_FILE } from "@openbrain/core";
import type { Embedder } from "@openbrain/llm";
import {
  hybridScores,
  readDocument,
  search,
  type ReadOptions,
  type ReadResult,
  type SearchOptions,
  type SearchResult,
  type SerializedIndex,
  type VectorIndex,
} from "@openbrain/retrieval";

// The stable prefix (layer L0): brain/core.md then brain/catalog.md, nothing variable.
// No date, no user name, no conversation id here: one changed byte invalidates the prompt cache.

export interface Brain {
  core: string;
  catalog: string;
}

export function systemPrompt(brain: Brain): string {
  return `${brain.core.trim()}\n\n${brain.catalog.trim()}\n`;
}

export async function loadBrain(root: string): Promise<Brain> {
  const [core, catalog] = await Promise.all([
    readFile(path.join(root, CORE_FILE), "utf8"),
    readFile(path.join(root, CATALOG_FILE), "utf8"),
  ]);
  return { core, catalog };
}

export interface KnowledgeSearchOptions extends Omit<SearchOptions, "scores"> {
  /** Embedding of the query: turns the search hybrid when the index has vectors. */
  queryVector?: readonly number[] | null | undefined;
}

/** What the agent needs from the knowledge base: search passages, read a page. */
export interface KnowledgePort {
  search(query: string, options: KnowledgeSearchOptions): SearchResult;
  /** Present when hybrid search is available (vectors in the index and an embeddings key). */
  embedQuery?: (query: string) => Promise<number[] | null>;
  read(docId: string, options: ReadOptions): ReadResult | null;
  /** Section ids of the catalog (valid values of the section filter). */
  sections(): string[];
  /** Resolves a page id given loosely by the model ("accounts", "Internal tools / accounts"). */
  resolveDocId(candidate: string): string | null;
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, "-");
}

export function knowledgeFromIndex(index: SerializedIndex, vectors?: VectorIndex | null, embedder?: Embedder | null): KnowledgePort {
  const docIds = Object.keys(index.docs);
  const hybrid = vectors && embedder && `${embedder.ref.provider}:${embedder.ref.model}` === vectors.model;
  return {
    search: (query, { queryVector, ...options }) =>
      hybrid && vectors && queryVector && queryVector.length === vectors.dimensions
        ? search(index, query, { ...options, scores: hybridScores(index, vectors, query, queryVector) })
        : search(index, query, options),
    ...(hybrid && embedder
      ? {
          embedQuery: async (query: string): Promise<number[] | null> => {
            try {
              return (await embedder.embed([query], "query"))[0] ?? null;
            } catch {
              // The embeddings provider is down: BM25 alone still answers.
              return null;
            }
          },
        }
      : {}),
    read: (docId, options) => readDocument(index, docId, options),
    sections: () => Object.keys(index.sections).filter((id) => docIds.some((d) => index.docs[d]?.section === id)),
    resolveDocId: (candidate) => {
      if (index.docs[candidate]) return candidate;
      const wanted = normalizeId(candidate);
      const exact = docIds.find((id) => normalizeId(id) === wanted);
      if (exact) return exact;
      const bySuffix = docIds.filter((id) => id.endsWith(`/${wanted}`));
      if (bySuffix.length === 1) return bySuffix[0] ?? null;
      const byTitle = docIds.filter((id) => normalizeId(index.docs[id]?.title ?? "") === wanted);
      return byTitle.length === 1 ? (byTitle[0] ?? null) : null;
    },
  };
}
