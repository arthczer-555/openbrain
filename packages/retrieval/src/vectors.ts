import type { SerializedIndex } from "./bm25.ts";
import { scorePassages } from "./bm25.ts";

// Optional vector side of the hybrid search: one embedding per passage, unit-normalized
// and quantized to int8 (4x smaller than float32, enough for ranking), fused with BM25F by Reciprocal Rank
// Fusion. RRF only uses ranks, so the two scores never need to be calibrated against each other.

export interface VectorIndex {
  version: 1;
  /** "provider:model" of the embeddings; the query must be embedded with the same model. */
  model: string;
  dimensions: number;
  /** Passage ids, in the order of the vectors. */
  chunkIds: string[];
  /** Base64 of the int8 vectors, concatenated (count x dimensions bytes). */
  data: string;
}

function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function quantize(model: string, chunkIds: readonly string[], vectors: readonly number[][]): VectorIndex {
  const dimensions = vectors[0]?.length ?? 0;
  if (vectors.length !== chunkIds.length) throw new Error("one vector per passage expected");
  const bytes = new Int8Array(vectors.length * dimensions);
  vectors.forEach((vector, i) => {
    if (vector.length !== dimensions) throw new Error(`vector ${i} has ${vector.length} dimensions, expected ${dimensions}`);
    normalize(vector).forEach((v, j) => {
      bytes[i * dimensions + j] = Math.max(-127, Math.min(127, Math.round(v * 127)));
    });
  });
  return { version: 1, model, dimensions, chunkIds: [...chunkIds], data: Buffer.from(bytes.buffer).toString("base64") };
}

const decoded = new WeakMap<VectorIndex, Int8Array>();

function bytesOf(index: VectorIndex): Int8Array {
  let bytes = decoded.get(index);
  if (!bytes) {
    const buffer = Buffer.from(index.data, "base64");
    bytes = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    decoded.set(index, bytes);
  }
  return bytes;
}

/** Passages ranked by cosine similarity to the query (chunk ids, best first). */
export function nearestPassages(index: VectorIndex, query: readonly number[], limit = 50): Array<{ chunkId: string; similarity: number }> {
  if (query.length !== index.dimensions) throw new Error(`query has ${query.length} dimensions, the index ${index.dimensions}`);
  const q = normalize(query);
  const bytes = bytesOf(index);
  const scored: Array<{ chunkId: string; similarity: number }> = [];
  for (let i = 0; i < index.chunkIds.length; i++) {
    let dot = 0;
    const offset = i * index.dimensions;
    for (let j = 0; j < index.dimensions; j++) dot += (bytes[offset + j] ?? 0) * (q[j] ?? 0);
    scored.push({ chunkId: index.chunkIds[i] ?? "", similarity: dot / 127 });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/** Reciprocal Rank Fusion: sum over rankings of 1 / (k + rank). k = 60 is the usual constant. */
export function reciprocalRankFusion(rankings: ReadonlyArray<readonly number[]>, k = 60): Map<number, number> {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => fused.set(item, (fused.get(item) ?? 0) + 1 / (k + rank + 1)));
  }
  return fused;
}

/** Hybrid relevance of every passage for `search(..., { scores })`: BM25F ranks fused with vector ranks. */
export function hybridScores(index: SerializedIndex, vectors: VectorIndex, query: string, queryVector: readonly number[], vectorLimit = 50): Map<number, number> {
  const position = new Map(index.chunks.map((c, i) => [c.id, i]));
  const lexical = [...scorePassages(index, query).entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const semantic = nearestPassages(vectors, queryVector, vectorLimit)
    .map((n) => position.get(n.chunkId))
    .filter((i): i is number => i !== undefined);
  return reciprocalRankFusion([lexical, semantic]);
}
