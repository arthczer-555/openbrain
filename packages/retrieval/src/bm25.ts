import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens, servableDocs, type DocStatus, type KnowledgeBase } from "@openbrain/core";
import { chunkDocument, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "./chunker.ts";
import { tokenize } from "./normalize.ts";

// Dependency-free BM25F index over passages (v0.1). Vectors and hybrid RRF come next.
// Built from the Notion mirror merged with the routing registry (see @openbrain/core loadKnowledgeBase).
// Document-level fields (title, aliases, when_to_open) ride along with every passage of the doc;
// the warnings of a doc and the routing rules of a section travel with the results.

export const FIELDS = ["title", "aliases", "when_to_open", "headings", "body"] as const;
export type Field = (typeof FIELDS)[number];

export interface Bm25Params {
  k1: number;
  weights: Record<Field, number>;
  b: Record<Field, number>;
  statusBoost: Record<DocStatus, number>;
}

export const DEFAULT_PARAMS: Bm25Params = {
  k1: 1.2,
  weights: { title: 3, aliases: 3, when_to_open: 2, headings: 2, body: 1 },
  b: { title: 0.3, aliases: 0.3, when_to_open: 0.3, headings: 0.3, body: 0.75 },
  statusBoost: { validated: 1.05, to_confirm: 1, stale: 0.8 },
};

export interface IndexedChunk {
  id: string;
  docId: string;
  section: string;
  headingPath: string[];
  text: string;
  tokens: number;
  /** Token count per field, in FIELDS order. */
  lens: number[];
}

export interface IndexedDoc {
  id: string;
  title: string;
  section: string;
  status: DocStatus;
  url: string;
  updatedAt: string;
  warnings: string[];
}

export interface IndexedSection {
  title: string;
  rules: string[];
}

export interface SerializedIndex {
  version: 1;
  params: Bm25Params;
  avgLens: number[];
  chunks: IndexedChunk[];
  docs: Record<string, IndexedDoc>;
  sections: Record<string, IndexedSection>;
  /** term -> flattened triples [chunkIndex, fieldIndex, termFrequency, ...]. */
  postings: Record<string, number[]>;
  /** term -> number of passages containing it in any field. */
  df: Record<string, number>;
}

export interface BuildOptions {
  chunk?: ChunkOptions;
  params?: Bm25Params;
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function buildIndex(kb: KnowledgeBase, options: BuildOptions = {}): SerializedIndex {
  const params = options.params ?? DEFAULT_PARAMS;
  const chunkOptions = options.chunk ?? DEFAULT_CHUNK_OPTIONS;
  const sectionTitles = new Map(kb.sections.map((s) => [s.id, s.title]));

  const chunks: IndexedChunk[] = [];
  const docs: Record<string, IndexedDoc> = {};
  const postingLists = new Map<string, number[]>();
  const df = new Map<string, number>();
  const lenTotals = FIELDS.map(() => 0);

  for (const doc of servableDocs(kb)) {
    const fm = doc.meta;
    docs[fm.id] = {
      id: fm.id,
      title: fm.title,
      section: fm.section,
      status: fm.status,
      url: fm.url,
      updatedAt: fm.updated_at,
      warnings: fm.warnings,
    };
    const docFields = {
      title: tokenize(fm.title),
      aliases: tokenize(fm.aliases.join(" ")),
      when_to_open: tokenize(fm.when_to_open),
    };
    for (const chunk of chunkDocument({ docId: fm.id, title: fm.title, body: doc.body }, chunkOptions)) {
      const fieldTokens: Record<Field, string[]> = {
        ...docFields,
        headings: tokenize([sectionTitles.get(fm.section) ?? fm.section, ...chunk.headingPath].join(" ")),
        body: tokenize(chunk.content),
      };
      const chunkIndex = chunks.length;
      const seen = new Set<string>();
      const lens = FIELDS.map((field, fieldIndex) => {
        const tokens = fieldTokens[field];
        lenTotals[fieldIndex] = (lenTotals[fieldIndex] ?? 0) + tokens.length;
        for (const [term, tf] of countTerms(tokens)) {
          let list = postingLists.get(term);
          if (!list) {
            list = [];
            postingLists.set(term, list);
          }
          list.push(chunkIndex, fieldIndex, tf);
          seen.add(term);
        }
        return tokens.length;
      });
      for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
      chunks.push({
        id: chunk.id,
        docId: fm.id,
        section: fm.section,
        headingPath: chunk.headingPath,
        text: chunk.text,
        tokens: chunk.tokens,
        lens,
      });
    }
  }

  const sections: Record<string, IndexedSection> = {};
  for (const s of kb.sections) {
    sections[s.id] = { title: s.title, rules: s.rules };
  }

  const sortedTerms = [...postingLists.keys()].sort();
  const postings: Record<string, number[]> = {};
  const dfRecord: Record<string, number> = {};
  for (const term of sortedTerms) {
    postings[term] = postingLists.get(term) ?? [];
    dfRecord[term] = df.get(term) ?? 0;
  }

  const n = Math.max(chunks.length, 1);
  return {
    version: 1,
    params,
    avgLens: lenTotals.map((total) => total / n),
    chunks,
    docs,
    sections,
    postings,
    df: dfRecord,
  };
}

export interface SearchOptions {
  section?: string;
  /** Number of passages returned (default 6, max 10). */
  k?: number;
  /** At most this many passages of the same document (default 2): favors coverage over repetition. */
  maxPerDoc?: number;
  /** Token budget of the whole result (default 4000, layer L2). */
  maxTokens?: number;
  /** Passage ids already served in the conversation. */
  exclude?: ReadonlySet<string>;
  /** Precomputed relevance per passage index (hybrid search, see vectors.ts); default: BM25F. */
  scores?: ReadonlyMap<number, number>;
}

export interface SearchResultItem {
  rank: number;
  chunkId: string;
  docId: string;
  title: string;
  section: string;
  headingPath: string[];
  text: string;
  url: string;
  status: DocStatus;
  updatedAt: string;
  score: number;
  /** Warnings of the document, given only on its first passage in the result. */
  warnings?: string[];
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
  /**
   * Share of the query's IDF weight found in the best passage (0 to 1), null with hybrid scores. Below
   * WEAK_MATCH the passages likely do not answer: the agent is told so.
   */
  coverage: number | null;
  /** Routing rules of the sections present in the results. */
  sectionRules: Record<string, string[]>;
  /** True when passages were dropped to respect the token budget. */
  truncated: boolean;
}

export function scorePassages(index: SerializedIndex, query: string): Map<number, number> {
  const { params } = index;
  const n = index.chunks.length;
  const scores = new Map<number, number>();
  for (const term of new Set(tokenize(query))) {
    const list = index.postings[term];
    if (!list) continue;
    const docFreq = index.df[term] ?? 0;
    const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
    const weighted = new Map<number, number>();
    for (let i = 0; i + 2 < list.length; i += 3) {
      const chunkIndex = list[i] ?? 0;
      const fieldIndex = list[i + 1] ?? 0;
      const tf = list[i + 2] ?? 0;
      const field = FIELDS[fieldIndex];
      const chunk = index.chunks[chunkIndex];
      if (!field || !chunk) continue;
      const avg = index.avgLens[fieldIndex] || 1;
      const b = params.b[field];
      const norm = 1 - b + (b * (chunk.lens[fieldIndex] ?? 0)) / avg;
      weighted.set(chunkIndex, (weighted.get(chunkIndex) ?? 0) + (params.weights[field] * tf) / norm);
    }
    for (const [chunkIndex, wtf] of weighted) {
      scores.set(chunkIndex, (scores.get(chunkIndex) ?? 0) + (idf * wtf) / (params.k1 + wtf));
    }
  }
  for (const [chunkIndex, score] of scores) {
    const chunk = index.chunks[chunkIndex];
    const status = chunk ? index.docs[chunk.docId]?.status : undefined;
    scores.set(chunkIndex, score * (status ? params.statusBoost[status] : 1));
  }
  return scores;
}

/** Below this coverage of the query by the best passage, a search result is a weak match. */
export const WEAK_MATCH = 0.35;

function idfOf(index: SerializedIndex, term: string): number {
  const n = index.chunks.length;
  const docFreq = index.df[term] ?? 0;
  return Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
}

/** Share of the query's IDF weight present in a passage (any field). Unknown terms weigh the most. */
export function queryCoverage(index: SerializedIndex, query: string, chunkIndex: number): number {
  const terms = [...new Set(tokenize(query))];
  let total = 0;
  let found = 0;
  for (const term of terms) {
    const weight = idfOf(index, term);
    total += weight;
    const list = index.postings[term];
    if (!list) continue;
    for (let i = 0; i + 2 < list.length; i += 3) {
      if (list[i] === chunkIndex) {
        found += weight;
        break;
      }
    }
  }
  return total === 0 ? 0 : found / total;
}

export function search(index: SerializedIndex, query: string, options: SearchOptions = {}): SearchResult {
  const k = Math.min(Math.max(options.k ?? 6, 1), 10);
  const maxPerDoc = options.maxPerDoc ?? 2;
  const maxTokens = options.maxTokens ?? 4000;

  const ranked = [...(options.scores ?? scorePassages(index, query)).entries()]
    .filter(([chunkIndex]) => {
      const chunk = index.chunks[chunkIndex];
      if (!chunk) return false;
      if (options.section && chunk.section !== options.section) return false;
      return !options.exclude?.has(chunk.id);
    })
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  const results: SearchResultItem[] = [];
  const perDoc = new Map<string, number>();
  const sectionRules: Record<string, string[]> = {};
  let usedTokens = 0;
  let truncated = false;

  for (const [chunkIndex, score] of ranked) {
    if (results.length >= k) break;
    const chunk = index.chunks[chunkIndex];
    const doc = chunk ? index.docs[chunk.docId] : undefined;
    if (!chunk || !doc) continue;
    const count = perDoc.get(doc.id) ?? 0;
    if (count >= maxPerDoc) continue;

    const warnings = count === 0 && doc.warnings.length > 0 ? doc.warnings : undefined;
    const newSection = !(chunk.section in sectionRules);
    const rules = index.sections[chunk.section]?.rules ?? [];
    const cost =
      chunk.tokens +
      (warnings ? estimateTokens(warnings.join("\n")) : 0) +
      (newSection ? estimateTokens(rules.join("\n")) : 0);
    if (usedTokens + cost > maxTokens) {
      truncated = true;
      continue;
    }
    usedTokens += cost;
    perDoc.set(doc.id, count + 1);
    if (newSection) sectionRules[chunk.section] = rules;
    results.push({
      rank: results.length + 1,
      chunkId: chunk.id,
      docId: doc.id,
      title: doc.title,
      section: chunk.section,
      headingPath: chunk.headingPath,
      text: chunk.text,
      url: doc.url,
      status: doc.status,
      updatedAt: doc.updatedAt,
      score: Math.round(score * 1000) / 1000,
      ...(warnings ? { warnings } : {}),
    });
  }

  const best = ranked[0];
  const coverage = options.scores ? null : best ? Math.round(queryCoverage(index, query, best[0]) * 100) / 100 : 0;
  return { query, results, sectionRules, truncated, coverage };
}

export const INDEX_FILE = ".openbrain/index.json";

export async function saveIndex(root: string, index: SerializedIndex): Promise<string> {
  const file = path.join(root, INDEX_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(index), "utf8");
  return file;
}

export async function loadIndex(root: string): Promise<SerializedIndex | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(root, INDEX_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === 1) {
      return parsed as SerializedIndex;
    }
    return null;
  } catch {
    return null;
  }
}
