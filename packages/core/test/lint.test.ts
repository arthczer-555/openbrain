import { describe, expect, it } from "vitest";
import { hasErrors, lintKnowledgeBase, loadKnowledgeBase, type LintIssue } from "../src/index.ts";
import { ACME_ROOT, makeInstance, mirrorDoc, registryYaml } from "./helpers.ts";

function rules(issues: LintIssue[]): string[] {
  return issues.map((i) => `${i.level}:${i.rule}`);
}

const PRODUCT = { product: { description: "How the app works." } };
const PRODUCT_INDEX = mirrorDoc("product/index", "# Product\n\n- [Ok](ok.md)", { title: "Product" });

describe("lintKnowledgeBase", () => {
  it("finds no error in the Acme example", async () => {
    const issues = lintKnowledgeBase(await loadKnowledgeBase(ACME_ROOT));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("flags id, length, date, number, duplicate title and broken link", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(PRODUCT, {
        "product/wrong-id": true,
        "product/b": { when_to_open: "x".repeat(230) },
        "product/c": { when_to_open: "Changes made in October 2026." },
        "product/d": { when_to_open: "The SCIM 2 setup." },
      }),
      "knowledge/product/index.md": PRODUCT_INDEX,
      "knowledge/product/a.md": mirrorDoc("product/a", "Body.", { id: "product/wrong-id", title: "Same title" }),
      "knowledge/product/b.md": mirrorDoc("product/b", "Body.", { title: "Same title" }),
      "knowledge/product/c.md": mirrorDoc("product/c", "Body."),
      "knowledge/product/d.md": mirrorDoc("product/d", "See [this](missing.md)."),
    });
    const issues = lintKnowledgeBase(await loadKnowledgeBase(root));
    const found = rules(issues);
    expect(found).toContain("error:id-matches-path");
    expect(found).toContain("warning:duplicate-title");
    expect(found).toContain("error:when-to-open-length");
    expect(found).toContain("error:when-to-open-date");
    expect(found).toContain("warning:when-to-open-number");
    expect(found).toContain("error:broken-link");
    expect(hasErrors(issues)).toBe(true);
  });

  it("requires a registry entry for every page that holds knowledge, and none for missing pages", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(
        { ...PRODUCT, ghost: { description: "A section that is gone." } },
        { "product/ok": true, "product/deleted-in-notion": true },
      ),
      "knowledge/product/index.md": PRODUCT_INDEX,
      "knowledge/product/ok.md": mirrorDoc("product/ok", "Body."),
      "knowledge/product/new-page.md": mirrorDoc("product/new-page", "Fresh knowledge from the last sync."),
      "knowledge/other/page.md": mirrorDoc("other/page", "Body."),
    });
    const found = rules(lintKnowledgeBase(await loadKnowledgeBase(root)));
    expect(found).toContain("error:missing-registry-entry");
    expect(found).toContain("error:orphan-registry-entry");
    expect(found).toContain("error:orphan-section-entry");
    expect(found).toContain("error:missing-section-entry");
    expect(found).toContain("warning:missing-section-index");
  });

  it("does not require an entry for structural pages (headings and links only)", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(PRODUCT, { "product/ok": true }),
      "knowledge/product/index.md": PRODUCT_INDEX,
      "knowledge/product/ok.md": mirrorDoc("product/ok", "Body."),
      "knowledge/product/hub.md": mirrorDoc("product/hub", "# Hub\n\n- [Ok](ok.md)"),
    });
    expect(hasErrors(lintKnowledgeBase(await loadKnowledgeBase(root)))).toBe(false);
  });

  it("errors without a routing registry", async () => {
    const root = await makeInstance({
      "knowledge/product/index.md": PRODUCT_INDEX,
      "knowledge/product/ok.md": mirrorDoc("product/ok", "Body."),
    });
    expect(rules(lintKnowledgeBase(await loadKnowledgeBase(root)))).toContain("error:missing-registry");
  });

  it("reports invalid files instead of crashing", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(PRODUCT, {}),
      "knowledge/product/broken.md": "# no frontmatter",
    });
    expect(rules(lintKnowledgeBase(await loadKnowledgeBase(root)))).toContain("error:invalid-file");
  });

  it("ignores folders starting with an underscore", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(PRODUCT, { "product/ok": true }),
      "knowledge/product/index.md": PRODUCT_INDEX,
      "knowledge/product/ok.md": mirrorDoc("product/ok", "Body."),
      "knowledge/_inbox/notion/raw.md": "# not structured yet",
    });
    const kb = await loadKnowledgeBase(root);
    expect(kb.docs.map((d) => d.pathId)).toEqual(["product/index", "product/ok"]);
    expect(hasErrors(lintKnowledgeBase(kb))).toBe(false);
  });
});
