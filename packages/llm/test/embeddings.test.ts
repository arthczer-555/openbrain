import { describe, expect, it } from "vitest";
import { createEmbedder, VOYAGE_URL } from "../src/index.ts";

describe("embeddings", () => {
  it("is off without a key, so search stays BM25 only", () => {
    expect(createEmbedder({ ref: { provider: "voyage", model: "voyage-4-lite" } }, { env: {} })).toBeNull();
    expect(createEmbedder({ ref: { provider: "openai", model: "text-embedding-3-small" } }, { env: {} })).toBeNull();
  });

  it("calls Voyage with the input type and the dimensions, in batches, in order", async () => {
    const calls: Array<{ url: string; body: { input: string[]; input_type: string; output_dimension?: number } }> = [];
    const embedder = createEmbedder(
      { ref: { provider: "voyage", model: "voyage-4-lite" }, dimensions: 4 },
      {
        env: { VOYAGE_API_KEY: "k" },
        fetch: async (url, init) => {
          const body = JSON.parse(String(init?.body)) as { input: string[]; input_type: string };
          calls.push({ url, body });
          // Out of order on purpose: the embedder sorts by index.
          const data = body.input.map((text, index) => ({ index, embedding: [text.length, 0, 0, 1] })).reverse();
          return new Response(JSON.stringify({ data }), { status: 200 });
        },
      },
    );
    expect(embedder).not.toBeNull();
    const texts = Array.from({ length: 130 }, (_, i) => "x".repeat(i + 1));
    const vectors = await embedder?.embed(texts, "document");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(VOYAGE_URL);
    expect(calls[0]?.body).toMatchObject({ input_type: "document", output_dimension: 4 });
    expect(vectors?.[0]?.[0]).toBe(1);
    expect(vectors?.[129]?.[0]).toBe(130);
  });
});
