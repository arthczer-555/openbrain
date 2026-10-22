import { estimateTokens, type DocStatus } from "@openbrain/core";
import type { IndexedChunk, SerializedIndex } from "./bm25.ts";

// read_document works from the index alone (the deployed chatbot ships index.json, not knowledge/):
// a document is the ordered list of its passages, optionally narrowed to one heading, paginated by budget.

export interface ReadOptions {
  /** Keep only the passages under this heading (case-insensitive match on the heading path). */
  heading?: string;
  /** 1-based page number. */
  page?: number;
  /** Token budget of one page (default 3000, layer L3). */
  maxTokens?: number;
}

export interface ReadResult {
  docId: string;
  title: string;
  section: string;
  url: string;
  status: DocStatus;
  updatedAt: string;
  warnings: string[];
  /** Passage ids included in this page. */
  chunkIds: string[];
  text: string;
  page: number;
  pages: number;
  /** True when the heading filter matched nothing and the whole document was used instead. */
  headingNotFound: boolean;
}

/** Content of a passage without its "Title > heading path" prefix. */
export function passageContent(chunk: IndexedChunk): string {
  const cut = chunk.text.indexOf("\n\n");
  return cut === -1 ? chunk.text : chunk.text.slice(cut + 2);
}

function renderPassage(chunk: IndexedChunk, previousPath: string[]): string {
  const content = passageContent(chunk);
  const samePath =
    chunk.headingPath.length === previousPath.length && chunk.headingPath.every((h, i) => h === previousPath[i]);
  if (samePath || chunk.headingPath.length === 0) return content;
  const level = Math.min(chunk.headingPath.length + 1, 3);
  return `${"#".repeat(level)} ${chunk.headingPath[chunk.headingPath.length - 1]}\n\n${content}`;
}

export function readDocument(index: SerializedIndex, docId: string, options: ReadOptions = {}): ReadResult | null {
  const doc = index.docs[docId];
  if (!doc) return null;
  const all = index.chunks.filter((c) => c.docId === docId);
  const wanted = options.heading?.trim().toLowerCase();
  const filtered = wanted
    ? all.filter((c) => c.headingPath.some((h) => h.toLowerCase().includes(wanted)))
    : all;
  const headingNotFound = Boolean(wanted) && filtered.length === 0;
  const chunks = filtered.length > 0 ? filtered : all;

  const maxTokens = options.maxTokens ?? 3000;
  const pages: IndexedChunk[][] = [];
  let current: IndexedChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && used + chunk.tokens > maxTokens) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(chunk);
    used += chunk.tokens;
  }
  if (current.length > 0) pages.push(current);

  const pageCount = Math.max(pages.length, 1);
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);
  const selected = pages[page - 1] ?? [];
  let previousPath: string[] = [];
  const parts: string[] = [];
  for (const chunk of selected) {
    parts.push(renderPassage(chunk, previousPath));
    previousPath = chunk.headingPath;
  }
  const text = parts.join("\n\n");
  return {
    docId,
    title: doc.title,
    section: doc.section,
    url: doc.url,
    status: doc.status,
    updatedAt: doc.updatedAt,
    warnings: doc.warnings,
    chunkIds: selected.map((c) => c.id),
    text,
    page,
    pages: pageCount,
    headingNotFound,
  };
}

/** Estimated cost of a read result in the context. */
export function readCost(result: ReadResult): number {
  return estimateTokens(result.text) + estimateTokens(result.warnings.join("\n"));
}
