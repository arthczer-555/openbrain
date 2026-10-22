import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTokens, type SourceDocument, type SourceRef, type StreamEvent } from "@openbrain/core";
import {
  collectInputs,
  createFilesConnector,
  describeInputs,
  parseInputsConfig,
  resolveCollectWindow,
  resolveOutDir,
  SkipItemError,
  type CollectInput,
  type CollectManifest,
  type InputConnector,
} from "../../src/index.ts";

const NOW = new Date("2026-10-22T10:00:00Z");
const WINDOW = { since: "2026-10-15T00:00:00Z", until: "2026-10-22T10:00:00Z", sinceSource: "test" };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openbrain-collect-"));
  await mkdir(path.join(root, "exports"), { recursive: true });
  await writeFile(path.join(root, "exports", "faq.md"), "# FAQ\n\nWrite to billing@acme.example for invoices.\n");
  await writeFile(path.join(root, "exports", "contract.pdf"), "%PDF-1.4");
  await writeFile(path.join(root, "exports", "old.md"), "# Old\n\nUnchanged.");
  const recent = new Date("2026-10-20T08:00:00Z");
  await utimes(path.join(root, "exports", "faq.md"), recent, recent);
  await utimes(path.join(root, "exports", "contract.pdf"), recent, recent);
  const old = new Date("2026-09-01T08:00:00Z");
  await utimes(path.join(root, "exports", "old.md"), old, old);
});

function event(id: string, occurredAt: string, text: string, author?: string): StreamEvent {
  return {
    ref: { id, title: `Change ${id}`, url: `https://tracker.acme.example/${id}`, modifiedAt: occurredAt },
    kind: "ticket",
    occurredAt,
    ...(author ? { author } : {}),
    text,
  };
}

/** A stream input and a documents input that fails on one item, both in memory. */
function fakeInputs(): CollectInput[] {
  const stream: InputConnector = {
    id: "mcp:tracker",
    kind: "stream",
    test: async () => ({ ok: true, scopes: [], writeScopesDetected: false }),
    async *changes() {
      yield event("ACME-12", "2026-10-21T10:00:00Z", "SSO login loop fixed.", "Dev A");
      yield event("ACME-11", "2026-10-18T09:00:00Z", "CSV export shipped.", "Dev B");
      yield event("ACME-13", "2026-10-21T08:00:00Z", "   ", "Dev C");
    },
  };
  const refs: SourceRef[] = [
    { id: "doc-1", title: "Pricing", url: "https://docs.acme.example/pricing", modifiedAt: "2026-10-19T08:00:00Z", path: ["Handbook", "Sales"] },
    { id: "doc-2", title: "Broken", modifiedAt: "2026-10-19T08:00:00Z" },
    { id: "doc-3", title: "Stale", modifiedAt: "2026-10-19T08:00:00Z" },
  ];
  const docs: InputConnector = {
    id: "gdrive",
    kind: "documents",
    test: async () => ({ ok: true, scopes: [], writeScopesDetected: false }),
    async *list() {
      yield* refs;
    },
    async fetch(ref: SourceRef): Promise<SourceDocument> {
      if (ref.id === "doc-2") throw new Error("HTTP 500 on export");
      // The source says it changed, the document says otherwise: the post-check skips it.
      const modifiedAt = ref.id === "doc-3" ? "2026-10-01T00:00:00Z" : ref.modifiedAt;
      return { ...ref, modifiedAt, markdown: "Business plan: 25 EUR per seat.", mimeType: "text/markdown", metadata: { rows: 2 } };
    },
  };
  return [
    { id: "mcp:tracker", dir: "mcp-tracker", create: async () => stream },
    { id: "gdrive", dir: "gdrive", create: async () => docs },
    {
      id: "github",
      dir: "github",
      create: async () => {
        throw new Error("GITHUB_TOKEN is not set: put it in .env");
      },
    },
    { id: "files", dir: "files", create: async () => createFilesConnector({ baseDir: root, paths: ["exports"] }) },
  ];
}

async function readManifest(outDir: string): Promise<CollectManifest> {
  return JSON.parse(await readFile(path.join(outDir, "inputs", "manifest.json"), "utf8")) as CollectManifest;
}

describe("collect window and output folder", () => {
  it("takes --since first, then state/sync.json last_weekly, then 7 days", async () => {
    expect(await resolveCollectWindow({ root, now: NOW })).toEqual({ since: "2026-10-15T10:00:00.000Z", until: NOW.toISOString(), sinceSource: "default: 7 days" });
    await mkdir(path.join(root, "state"));
    await writeFile(path.join(root, "state", "sync.json"), JSON.stringify({ last_weekly: "2026-10-14T18:00:00Z" }));
    expect(await resolveCollectWindow({ root, now: NOW })).toMatchObject({ since: "2026-10-14T18:00:00.000Z", sinceSource: "state/sync.json last_weekly" });
    expect(await resolveCollectWindow({ root, since: "2026-10-01", until: "2026-10-08", now: NOW })).toEqual({
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
      sinceSource: "--since",
    });
    await expect(resolveCollectWindow({ root, since: "last week" })).rejects.toThrow(/--since is not a date/);
  });

  it("writes under .openbrain/ only", () => {
    expect(resolveOutDir(root, undefined, NOW)).toBe(path.join(root, ".openbrain", "weekly", "2026-10-22"));
    expect(resolveOutDir(root, ".openbrain/init")).toBe(path.join(root, ".openbrain", "init"));
    for (const bad of ["knowledge", ".openbrain", ".openbrain/../knowledge", "/tmp/elsewhere", "../outside"]) {
      expect(() => resolveOutDir(root, bad)).toThrow(/must be a folder inside \.openbrain/);
    }
  });
});

describe("collectInputs", () => {
  it("writes documents and daily event files with provenance, and a manifest without sensitive values", async () => {
    const outDir = resolveOutDir(root, undefined, NOW);
    const manifest = await collectInputs({ root, inputs: fakeInputs(), window: WINDOW, outDir, now: () => NOW });

    const tracker = manifest.connectors.find((c) => c.id === "mcp:tracker");
    expect(tracker).toMatchObject({ status: "ok", events: 2, documents: 0, skipped: [{ id: "ACME-13", reason: "empty event" }] });
    expect(tracker?.files.map((f) => [f.path, f.events])).toEqual([
      ["inputs/mcp-tracker/events-2026-10-18.md", 1],
      ["inputs/mcp-tracker/events-2026-10-21.md", 1],
    ]);
    const events = await readFile(path.join(outDir, "inputs/mcp-tracker/events-2026-10-21.md"), "utf8");
    expect(events).toBe(
      "---\nconnector: mcp:tracker\nkind: stream\ndate: 2026-10-21\nevents: 1\n---\n\n## Change ACME-12\n\n- ref: ACME-12\n- kind: ticket\n- occurred_at: 2026-10-21T10:00:00Z\n- url: https://tracker.acme.example/ACME-12\n\nSSO login loop fixed.\n",
    );
    const allEvents = (await readdir(path.join(outDir, "inputs/mcp-tracker"))).map((f) => path.join(outDir, "inputs/mcp-tracker", f));
    for (const file of allEvents) expect(await readFile(file, "utf8")).not.toMatch(/Dev [ABC]/);

    const drive = manifest.connectors.find((c) => c.id === "gdrive");
    expect(drive).toMatchObject({ status: "partial", documents: 1, errors: ["doc-2: HTTP 500 on export"] });
    expect(drive?.skipped).toEqual([{ id: "doc-3", title: "Stale", reason: `not modified since ${WINDOW.since}` }]);
    const pricingPath = "inputs/gdrive/handbook/sales/pricing.md";
    const pricing = await readFile(path.join(outDir, pricingPath), "utf8");
    expect(pricing).toBe(
      "---\nconnector: gdrive\nref: doc-1\ntitle: Pricing\nurl: https://docs.acme.example/pricing\nmodified_at: 2026-10-19T08:00:00Z\npath: Handbook / Sales\nmime_type: text/markdown\nmetadata:\n  rows: 2\n---\n\n# Pricing\n\nBusiness plan: 25 EUR per seat.\n",
    );
    expect(drive?.files[0]).toMatchObject({ path: pricingPath, kind: "document", ref_id: "doc-1", tokens: estimateTokens(pricing), sensitive: [] });

    expect(manifest.connectors.find((c) => c.id === "github")).toMatchObject({ status: "error", errors: ["GITHUB_TOKEN is not set: put it in .env"] });

    const files = manifest.connectors.find((c) => c.id === "files");
    expect(files).toMatchObject({ status: "ok", documents: 1 });
    expect(files?.skipped).toEqual([{ id: "exports/contract.pdf", title: "contract", reason: expect.stringMatching(/PDF is not supported/) }]);
    expect(files?.files[0]?.sensitive).toEqual([{ kind: "email", category: "pii", count: 1, lines: [15] }]);

    const onDisk = await readManifest(outDir);
    expect(onDisk.totals).toMatchObject({ documents: 2, events: 2, files: 4, skipped: 3, errors: 2, files_with_sensitive_data: 1, sensitive: { email: 1 } });
    expect(onDisk.window).toEqual({ since: WINDOW.since, until: WINDOW.until, since_source: "test", full: false });
    expect(JSON.stringify(onDisk)).not.toContain("billing@acme.example");
    expect(onDisk.totals.tokens).toBe(onDisk.connectors.reduce((sum, c) => sum + c.tokens, 0));
  });

  it("only counts in dry-run mode and writes nothing", async () => {
    const outDir = resolveOutDir(root, undefined, NOW);
    const manifest = await collectInputs({ root, inputs: fakeInputs(), window: WINDOW, outDir, dryRun: true });
    expect(manifest.dry_run).toBe(true);
    expect(manifest.totals).toMatchObject({ documents: 5, events: 2, files: 0 });
    expect(existsSync(path.join(root, ".openbrain"))).toBe(false);
  });

  it("collects every document with --full and keeps earlier connectors in the manifest on a partial re-run", async () => {
    const outDir = resolveOutDir(root, ".openbrain/init");
    const inputs = fakeInputs();
    await collectInputs({ root, inputs, window: WINDOW, outDir });
    const filesOnly = inputs.filter((i) => i.id === "files");
    const manifest = await collectInputs({ root, inputs: filesOnly, window: WINDOW, outDir, full: true });
    expect(manifest.connectors.map((c) => c.id)).toEqual(["mcp:tracker", "gdrive", "github", "files"]);
    expect(manifest.connectors.find((c) => c.id === "files")).toMatchObject({ documents: 2, window: { full: true } });
    expect(existsSync(path.join(outDir, "inputs/files/exports/old.md"))).toBe(true);
  });

  it("skip errors never abort a connector", async () => {
    const flaky: InputConnector = {
      id: "web",
      kind: "documents",
      test: async () => ({ ok: true, scopes: [], writeScopesDetected: false }),
      async *list() {
        yield { id: "a", title: "A", modifiedAt: "2026-10-20T00:00:00Z" };
        yield { id: "b", title: "B", modifiedAt: "2026-10-20T00:00:00Z" };
      },
      async fetch(ref) {
        if (ref.id === "a") throw new SkipItemError("disallowed by robots.txt");
        return { ...ref, markdown: "B content", metadata: {} };
      },
    };
    const manifest = await collectInputs({ root, inputs: [{ id: "web", dir: "web", create: async () => flaky }], window: WINDOW, outDir: resolveOutDir(root, undefined, NOW) });
    expect(manifest.connectors[0]).toMatchObject({ status: "ok", documents: 1, skipped: [{ id: "a", reason: "disallowed by robots.txt" }] });
  });
});

describe("inputs config", () => {
  it("parses both the flat shape and the plan's scope: shape, with defaults", () => {
    const inputs = parseInputsConfig({
      files: { enabled: true, paths: "./exports" },
      github: { enabled: false, scope: { repos: ["acme/app"], commits: false } },
      web: { sitemap: "https://acme.example/sitemap.xml", include: ["/docs/"] },
      gdrive: { folders: ["fold-root"], mime: ["doc", "pdf"] },
      mcp: { tracker: { enabled: false, transport: "http", url: "https://tracker.acme.example/mcp", auth_env: "ACME_TRACKER_TOKEN", mapping: "./connectors/tracker.mapping.yaml" } },
      slack: { enabled: true, scope: { channels: ["#product"] } },
    });
    expect(inputs.files).toMatchObject({ paths: ["./exports"], max_file_mb: 20 });
    expect(inputs.github).toMatchObject({ enabled: false, repos: ["acme/app"], commits: false, docs_globs: ["README.md", "docs/**/*.md"], token_env: "GITHUB_TOKEN" });
    expect(inputs.web).toMatchObject({ sitemap: ["https://acme.example/sitemap.xml"], max_pages: 200, delay_ms: 1000 });
    expect(inputs.gdrive).toMatchObject({ mime: ["doc", "pdf"], credentials_env: "GDRIVE_SA_JSON" });

    const entries = describeInputs(inputs, { root, env: { ACME_TRACKER_TOKEN: "x" } });
    expect(entries.map((e) => [e.id, e.enabled, e.supported, e.env])).toEqual([
      ["files", true, true, []],
      ["web", true, true, []],
      ["github", false, true, [{ name: "GITHUB_TOKEN", set: false }]],
      ["gdrive", true, true, [{ name: "GDRIVE_SA_JSON", set: false }]],
      ["mcp:tracker", false, true, [{ name: "ACME_TRACKER_TOKEN", set: true }]],
      ["slack", true, false, []],
    ]);
  });

  it("rejects typos and incomplete inputs with the path of the problem", () => {
    expect(() => parseInputsConfig({ github: { repos: ["acme/app"], comits: true } })).toThrow(/inputs\.github/);
    expect(() => parseInputsConfig({ web: { include: ["/docs/"] } })).toThrow(/inputs\.web\.sitemap: set sitemap or urls/);
    expect(() => parseInputsConfig({ mcp: { tracker: { transport: "stdio", mapping: "x.yaml" } } })).toThrow(/stdio needs command/);
  });

  it("refuses to build an input whose credentials are missing", async () => {
    const [github] = describeInputs(parseInputsConfig({ github: { repos: ["acme/app"] } }), { root, env: {} });
    await expect(github?.create()).rejects.toThrow(/GITHUB_TOKEN is not set: put it in \.env \(see packages\/connectors\/src\/github\/SETUP\.md\)/);
  });
});
