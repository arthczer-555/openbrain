import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGuide,
  CATALOG_FILE,
  checkBudgets,
  checkGuide,
  estimateTokens,
  loadKnowledgeBase,
  prepareGuide,
  writeGuide,
} from "../src/index.ts";
import { ACME_ROOT, makeInstance, mirrorDoc, registryYaml } from "./helpers.ts";

const PEOPLE_INDEX = mirrorDoc("people/index", "# People\n\n- [Leave](leave.md)", { title: "People" });

describe("buildGuide", () => {
  it("is deterministic and lists every section once", async () => {
    const first = buildGuide(await loadKnowledgeBase(ACME_ROOT));
    const second = buildGuide(await loadKnowledgeBase(ACME_ROOT));
    expect(second.catalog).toBe(first.catalog);
    expect(second.registryJson).toBe(first.registryJson);
    for (const id of ["admin", "internal-tools", "people", "product", "sales"]) {
      expect(first.catalog.match(new RegExp(`^- ${id} `, "gm"))?.length).toBe(1);
    }
    expect(first.catalog).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("matches the committed guide of the Acme example", async () => {
    const check = await checkGuide(ACME_ROOT, buildGuide(await loadKnowledgeBase(ACME_ROOT)));
    expect(check.stale).toEqual([]);
  });

  it("merges mirror metadata with the routing registry", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml(
        { people: { description: "HR policies.", rules: ["No personal data."] } },
        { "people/leave": { when_to_open: "Leave rules.", aliases: ["congés"], warnings: ["Ask HR first."] } },
      ),
      "knowledge/people/index.md": PEOPLE_INDEX,
      "knowledge/people/leave.md": mirrorDoc("people/leave", "Leave policy.", { title: "Leave" }),
    });
    const guide = buildGuide(await loadKnowledgeBase(root));
    expect(guide.registry.docs).toHaveLength(1);
    const entry = guide.registry.docs[0];
    expect(entry?.when_to_open).toBe("Leave rules.");
    expect(entry?.aliases).toEqual(["congés"]);
    expect(entry?.url).toMatch(/^https:\/\/www\.notion\.so\//);
    expect(guide.registry.sections[0]).toMatchObject({ id: "people", title: "People", rules: ["No personal data."] });
  });

  it("serves only pages that hold knowledge and have a registry entry", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml({ people: { description: "HR policies." } }, { "people/leave": true }),
      "knowledge/people/index.md": PEOPLE_INDEX,
      "knowledge/people/leave.md": mirrorDoc("people/leave", "Leave policy."),
      "knowledge/people/salaries.md": mirrorDoc("people/salaries", "Not registered yet."),
    });
    const guide = buildGuide(await loadKnowledgeBase(root));
    expect(guide.registry.docs.map((d) => d.id)).toEqual(["people/leave"]);
    expect(guide.catalog).toContain("[1 page]");
  });

  it("detects a stale committed guide", async () => {
    const root = await makeInstance({
      "brain/core.md": "You are a test assistant.",
      "brain/registry.yaml": registryYaml({ people: { description: "HR policies." } }, { "people/leave": true }),
      "knowledge/people/index.md": PEOPLE_INDEX,
      "knowledge/people/leave.md": mirrorDoc("people/leave", "Leave policy."),
    });
    const kb = await loadKnowledgeBase(root);
    const { guide, problems } = await prepareGuide(kb);
    expect(problems).toEqual([]);
    await writeGuide(root, guide);
    expect((await checkGuide(root, guide)).upToDate).toBe(true);

    const catalogFile = path.join(root, CATALOG_FILE);
    await writeFile(catalogFile, `${await readFile(catalogFile, "utf8")}- hand edit\n`, "utf8");
    expect((await checkGuide(root, guide)).stale).toEqual([CATALOG_FILE]);
  });

  it("reports a missing core prompt", async () => {
    const root = await makeInstance({
      "brain/registry.yaml": registryYaml({ people: { description: "HR policies." } }, { "people/leave": true }),
      "knowledge/people/leave.md": mirrorDoc("people/leave", "Leave policy."),
    });
    const { problems } = await prepareGuide(await loadKnowledgeBase(root));
    expect(problems.join("\n")).toContain("brain/core.md");
  });
});

describe("budgets", () => {
  it("estimates tokens prudently (characters / 3.5 with a 15 % margin)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(350))).toBe(115);
  });

  it("flags a core prompt over budget", () => {
    const reports = checkBudgets({ core: "word ".repeat(1200), catalog: "short" });
    expect(reports.find((r) => r.name === "core")?.ok).toBe(false);
    expect(reports.find((r) => r.name === "catalog")?.ok).toBe(true);
  });

  it("keeps the Acme prefix within budget", async () => {
    const { budgets, problems } = await prepareGuide(await loadKnowledgeBase(ACME_ROOT));
    expect(problems).toEqual([]);
    expect(budgets.every((b) => b.ok)).toBe(true);
  });
});
