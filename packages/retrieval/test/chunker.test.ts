import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/index.ts";

describe("chunkDocument", () => {
  it("prefixes passages with the doc title and the heading path", () => {
    const chunks = chunkDocument({
      docId: "product/booking",
      title: "Booking",
      body: "# Booking\n\nIntro.\n\n## Cancel\n\nHow to cancel.\n\n### Late cancel\n\nLess than a day before.",
    });
    expect(chunks.map((c) => c.headingPath)).toEqual([[], ["Cancel"], ["Cancel", "Late cancel"]]);
    expect(chunks[2]?.text.startsWith("Booking > Cancel > Late cancel\n\n")).toBe(true);
    expect(chunks.map((c) => c.id)).toEqual(["product/booking#0", "product/booking#1", "product/booking#2"]);
  });

  it("never cuts a table, even when it is larger than the target size", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| Plan ${i} | ${i} EUR | Some included features for this plan |`);
    const table = ["| Plan | Price | Included |", "|---|---|---|", ...rows].join("\n");
    const chunks = chunkDocument(
      { docId: "sales/pricing", title: "Pricing", body: `## Plans\n\nBefore the table.\n\n${table}\n\nAfter the table.` },
      { maxTokens: 300 },
    );
    const withTable = chunks.filter((c) => c.content.includes("| Plan 0 |"));
    expect(withTable).toHaveLength(1);
    expect(withTable[0]?.content).toContain("| Plan 119 |");
    expect(withTable[0]?.content).toContain("| Plan | Price | Included |");
  });

  it("keeps fenced code blocks whole, including blank lines and headings inside", () => {
    const code = "```bash\n# not a heading\n\necho one\n\necho two\n```";
    const chunks = chunkDocument({ docId: "x/y", title: "Y", body: `## Run\n\n${code}\n` });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(code);
    expect(chunks[0]?.headingPath).toEqual(["Run"]);
  });

  it("splits a long section into several passages under the same heading", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(40)}`);
    const chunks = chunkDocument(
      { docId: "x/long", title: "Long", body: `## Part\n\n${paragraphs.join("\n\n")}` },
      { maxTokens: 500 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.headingPath[0] === "Part")).toBe(true);
    expect(chunks.every((c) => c.tokens <= 650)).toBe(true);
  });
});
