import { randomUUID } from "node:crypto";
import type { Citation, ConversationState } from "./types.ts";

export function newConversation(id: string = `c_${randomUUID()}`, now: Date = new Date()): ConversationState {
  const at = now.toISOString();
  return {
    id,
    createdAt: at,
    updatedAt: at,
    messages: [],
    citations: [],
    servedChunks: [],
    warnedDocs: [],
    ruledSections: [],
    questions: [],
    turnCount: 0,
  };
}

function sameChunks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export interface CitationInput extends Omit<Citation, "cite"> {}

/**
 * Returns the stable citation id of a passage (or of a read page), creating it on first use.
 * `created` tells the caller whether the UI must be told about a new citation.
 */
export function registerCitation(state: ConversationState, input: CitationInput): { citation: Citation; created: boolean } {
  const existing = state.citations.find((c) => c.docId === input.docId && sameChunks(c.chunkIds, input.chunkIds));
  if (existing) return { citation: existing, created: false };
  const citation: Citation = { cite: state.citations.length + 1, ...input };
  state.citations.push(citation);
  return { citation, created: true };
}

/** Citation ids written in an answer, in order of first appearance, limited to known citations. */
export function citedIds(answer: string, state: ConversationState): number[] {
  const known = new Set(state.citations.map((c) => c.cite));
  const seen: number[] = [];
  // [1], [1][2] and [1, 2] are all accepted.
  for (const match of answer.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const id = Number(part.trim());
      if (known.has(id) && !seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}
