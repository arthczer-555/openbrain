import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadKnowledgeBase } from "@openbrain/core";
import { buildIndex, hybridScores, nearestPassages, quantize, reciprocalRankFusion, search } from "../src/index.ts";

const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

describe("vectors", () => {
  it("quantizes to int8 and keeps the cosine ranking", () => {
    const index = quantize("test:model", ["a", "b", "c"], [
      [1, 0, 0],
      [0.7, 0.7, 0],
      [0, 0, 1],
    ]);
    expect(index.dimensions).toBe(3);
    expect(Buffer.from(index.data, "base64")).toHaveLength(9);
    const ranked = nearestPassages(index, [0.9, 0.1, 0]);
    expect(ranked.map((r) => r.chunkId)).toEqual(["a", "b", "c"]);
    expect(ranked[0]?.similarity).toBeGreaterThan(0.98);
  });

  it("fuses rankings with reciprocal ranks", () => {
    const fused = reciprocalRankFusion([
      [1, 2, 3],
      [3, 1],
    ]);
    // 1 is ranked well by both lists, 3 is first in one list only.
    expect([...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).toEqual([1, 3, 2]);
  });

  it("lets a semantic match surface a passage BM25 alone does not find", async () => {
    const index = buildIndex(await loadKnowledgeBase(ACME_ROOT));
    // Fake embeddings: one axis per passage, the query points at the remote work passage.
    const target = index.chunks.findIndex((c) => c.docId === "people/remote-work");
    expect(target).toBeGreaterThanOrEqual(0);
    const vectors = quantize(
      "test:model",
      index.chunks.map((c) => c.id),
      index.chunks.map((_, i) => index.chunks.map((__, j) => (i === j ? 1 : 0))),
    );
    const query = index.chunks.map((_, j) => (j === target ? 1 : 0));
    const lexical = search(index, "zzqx yyqw", { k: 3 });
    expect(lexical.results).toHaveLength(0);
    const hybrid = search(index, "zzqx yyqw", { k: 3, scores: hybridScores(index, vectors, "zzqx yyqw", query) });
    expect(hybrid.results.map((r) => r.docId)).toContain("people/remote-work");
  });
});

describe("query coverage", () => {
  it("flags a weak match when the key terms of the question are absent", async () => {
    const { WEAK_MATCH } = await import("../src/index.ts");
    const index = buildIndex(await loadKnowledgeBase(ACME_ROOT));
    const strong = search(index, "How do I add a user in the internal tool?");
    const weak = search(index, "What is the parking policy at the Lisbon office?");
    expect(strong.coverage).toBeGreaterThanOrEqual(WEAK_MATCH);
    expect(weak.coverage).toBeLessThan(WEAK_MATCH);
    expect(weak.results.length).toBeGreaterThan(0);
  });
});
