import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadKnowledgeBase } from "@openbrain/core";
import { buildIndex, search, tokenize, type SerializedIndex } from "../src/index.ts";

const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

let index: SerializedIndex;

beforeAll(async () => {
  index = buildIndex(await loadKnowledgeBase(ACME_ROOT));
});

function rankOf(query: string, docId: string): number {
  const position = search(index, query, { k: 10 }).results.findIndex((r) => r.docId === docId);
  return position === -1 ? Number.POSITIVE_INFINITY : position;
}

function docIds(query: string, k = 6): string[] {
  return search(index, query, { k }).results.map((r) => r.docId);
}

describe("tokenize", () => {
  it("lowercases, removes accents and stopwords, folds plurals", () => {
    expect(tokenize("Comment ajouter des Utilisateurs dans l'outil interne ?")).toEqual([
      "ajouter",
      "utilisateur",
      "outil",
      "interne",
    ]);
    expect(tokenize("Politique de télétravail")).toEqual(["politique", "teletravail"]);
  });
});

describe("search on the Acme example", () => {
  it("routes 'add a user in the internal tool' to the employee accounts doc, not to client users", () => {
    const query = "How do I add a user in the internal tool?";
    expect(docIds(query, 1)).toEqual(["internal-tools/accounts"]);
    expect(rankOf(query, "internal-tools/accounts")).toBeLessThan(rankOf(query, "admin/users"));
  });

  it("finds an English doc from a French question through its aliases", () => {
    expect(docIds("Comment ajouter un utilisateur dans l'outil interne ?", 1)).toEqual(["internal-tools/accounts"]);
    expect(docIds("Quelle est la politique de télétravail ?", 1)).toEqual(["people/remote-work"]);
  });

  it("brings the group screen and the parent company settings together", () => {
    const ids = docIds("Why can't I enable live chat on a client group?");
    expect(ids).toContain("admin/groups");
    expect(ids).toContain("admin/companies");
  });

  it("answers retention from the single reference page, with no contradiction left in the base", () => {
    const result = search(index, "How long do we keep ticket data?", { k: 6 });
    expect(result.results[0]?.docId).toBe("product/data-retention");
    const texts = result.results.map((r) => r.text).join("\n");
    expect(texts).toContain("24 months");
    expect(texts).not.toContain("12 months");
    expect(result.results.flatMap((r) => r.warnings ?? []).join(" ")).not.toMatch(/contradict/i);
  });

  it("carries the Notion page url of every passage", () => {
    const top = search(index, "How do I add a user in the internal tool?", { k: 1 }).results[0];
    expect(top?.url).toMatch(/^https:\/\/www\.notion\.so\//);
  });

  it("exposes the to_confirm status of a price", () => {
    const top = search(index, "What is the price of the Enterprise plan?", { k: 1 }).results[0];
    expect(top?.docId).toBe("sales/pricing");
    expect(top?.status).toBe("to_confirm");
    expect(top?.warnings?.[0]).toMatch(/not confirmed/);
  });

  it("serves warnings once per document and section rules once per section", () => {
    const result = search(index, "add a user", { k: 10, maxPerDoc: 3 });
    const usersPassages = result.results.filter((r) => r.docId === "admin/users");
    expect(usersPassages.length).toBeGreaterThan(1);
    expect(usersPassages.filter((r) => r.warnings).length).toBe(1);
    expect(Object.keys(result.sectionRules)).toContain("admin");
  });

  it("filters by section and caps passages per document", () => {
    const result = search(index, "user", { section: "admin", k: 10, maxPerDoc: 1 });
    expect(result.results.every((r) => r.section === "admin")).toBe(true);
    const perDoc = new Set(result.results.map((r) => r.docId));
    expect(perDoc.size).toBe(result.results.length);
  });

  it("respects the token budget and says so", () => {
    const result = search(index, "client company group user channel", { k: 10, maxTokens: 150 });
    expect(result.truncated).toBe(true);
    expect(result.results.length).toBeLessThan(10);
  });

  it("returns nothing for an unknown topic and survives JSON serialization", () => {
    expect(search(index, "zzqv xxyzt").results).toEqual([]);
    const roundTrip = JSON.parse(JSON.stringify(index)) as SerializedIndex;
    expect(search(roundTrip, "How do I add a user in the internal tool?").results[0]?.docId).toBe(
      "internal-tools/accounts",
    );
  });
});
