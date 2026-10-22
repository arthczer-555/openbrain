import { cp, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createFilesConnector, isSkip, SkipItemError, type DocumentsConnector } from "../../src/index.ts";
import { buildDocx, buildPptx, collectAll, slideXml, wPara } from "./helpers.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/inputs/files/", import.meta.url));
const OLD = new Date("2026-09-01T00:00:00Z");
const RECENT = new Date("2026-10-20T09:00:00Z");

let root: string;

async function setRecent(relative: string): Promise<void> {
  await utimes(path.join(root, relative), RECENT, RECENT);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openbrain-files-"));
  await cp(FIXTURES, root, { recursive: true });
  await writeFile(path.join(root, "docs-export/onboarding.docx"), buildDocx(wPara("Onboarding", "Heading1") + wPara("Invite the team.")));
  await writeFile(path.join(root, "docs-export/roadmap.pptx"), buildPptx([slideXml("Roadmap", ["Q1: SSO"])]));
  await mkdir(path.join(root, "docs-export/node_modules/pkg"), { recursive: true });
  await writeFile(path.join(root, "docs-export/node_modules/pkg/README.md"), "# not collected");
  await writeFile(path.join(root, "outside.md"), "# outside of the configured paths");
  const all = ["guide.md", "notes.txt", "pricing.csv", "faq.html", "settings.json", "report.pdf", "logo.png", "sub/deep.md", "onboarding.docx", "roadmap.pptx"];
  for (const file of all) await utimes(path.join(root, "docs-export", file), OLD, OLD);
});

function connector(extra: Partial<Parameters<typeof createFilesConnector>[0]> = {}): DocumentsConnector {
  return createFilesConnector({ baseDir: root, paths: ["./docs-export"], ...extra });
}

describe("files connector", () => {
  it("lists supported files (and PDFs, to report them) with ids relative to the instance root", async () => {
    const refs = await collectAll(connector().list({}));
    expect(refs.map((r) => r.id)).toEqual([
      "docs-export/faq.html",
      "docs-export/guide.md",
      "docs-export/notes.txt",
      "docs-export/onboarding.docx",
      "docs-export/pricing.csv",
      "docs-export/report.pdf",
      "docs-export/roadmap.pptx",
      "docs-export/settings.json",
      "docs-export/sub/deep.md",
    ]);
    const deep = refs.find((r) => r.id.endsWith("deep.md"));
    expect(deep).toMatchObject({ title: "deep", path: ["docs-export", "sub"], modifiedAt: OLD.toISOString() });
  });

  it("converts every supported format to Markdown", async () => {
    const files = connector();
    const refs = await collectAll(files.list({}));
    const byName = async (name: string): Promise<string> => {
      const ref = refs.find((r) => r.id === `docs-export/${name}`);
      if (!ref) throw new Error(`missing ${name}`);
      return (await files.fetch(ref)).markdown;
    };
    expect(await byName("guide.md")).toBe("# Acme guide\n\nAcme helps teams plan their week. Contact support at help@acme.example.");
    expect(await byName("notes.txt")).toContain("export feature ships in November");
    expect(await byName("pricing.csv")).toBe("| plan | price | seats |\n|---|---|---|\n| Starter | 10 | 5 |\n| Business | 25,50 | 50 |");
    expect(await byName("faq.html")).toBe("# FAQ\n\nCan I export my data? **Yes**, as CSV.");
    expect(await byName("settings.json")).toBe('```json\n{\n  "workspace": "acme",\n  "features": {\n    "sso": true\n  }\n}\n```');
    expect(await byName("onboarding.docx")).toBe("# Onboarding\n\nInvite the team.");
    expect(await byName("roadmap.pptx")).toBe("## Slide 1: Roadmap\n\n- Q1: SSO");
  });

  it("skips PDFs and oversized files with a reason", async () => {
    const files = connector({ maxFileMb: 0.00005 });
    const refs = await collectAll(files.list({}));
    const pdf = refs.find((r) => r.id.endsWith(".pdf"));
    const guide = refs.find((r) => r.id.endsWith("guide.md"));
    if (!pdf || !guide) throw new Error("fixtures missing");
    const pdfError = await files.fetch(pdf).catch((e: unknown) => e);
    expect(isSkip(pdfError) && pdfError.reason).toMatch(/PDF is not supported in v0\.1/);
    await expect(files.fetch(guide)).rejects.toBeInstanceOf(SkipItemError);
  });

  it("collects incrementally from the modification time", async () => {
    await setRecent("docs-export/guide.md");
    await setRecent("docs-export/sub/deep.md");
    const refs = await collectAll(connector().list({ since: "2026-10-15T00:00:00Z" }));
    expect(refs.map((r) => r.id)).toEqual(["docs-export/guide.md", "docs-export/sub/deep.md"]);
  });

  it("applies include and exclude globs relative to each configured folder", async () => {
    const refs = await collectAll(connector({ include: ["**/*.md"], exclude: ["sub/**"] }).list({}));
    expect(refs.map((r) => r.id)).toEqual(["docs-export/guide.md"]);
  });

  it("refuses to read outside of the configured paths", async () => {
    await expect(connector().fetch({ id: "outside.md", title: "outside", modifiedAt: OLD.toISOString() })).rejects.toThrow(/outside of the configured paths/);
    await expect(connector().fetch({ id: "docs-export/../outside.md", title: "x", modifiedAt: OLD.toISOString() })).rejects.toThrow(/outside/);
  });

  it("test() counts the files and flags missing folders", async () => {
    const ok = await connector().test();
    expect(ok).toMatchObject({ ok: true, writeScopesDetected: false, identity: "local folders: ./docs-export (9 files)" });
    expect(ok.sample).toHaveLength(3);
    const missing = await createFilesConnector({ baseDir: root, paths: ["./docs-export", "./nope"] }).test();
    expect(missing).toMatchObject({ ok: false, error: "not found: ./nope" });
  });
});
