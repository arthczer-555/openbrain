import path from "node:path";
import {
  collectInputs,
  resolveCollectWindow,
  resolveOutDir,
  summarizeFindings,
  type CollectManifest,
  type ConnectorCollectReport,
  type InputEntry,
} from "@openbrain/connectors";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { findEntry, loadInputEntries } from "./connectors.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain collect: reads the enabled inputs (read-only, no LLM) into .openbrain/weekly/<date>/inputs/
// for the weekly update, or another folder under .openbrain/ with --out (.openbrain/init for the
// initialization, with --full). Documents changed since the window start, stream events of the window.

const USAGE =
  "usage: openbrain collect [--since <iso>] [--until <iso>] [--only <id,id>] [--out <dir>] [--full] [--dry-run] [--json] [--root <path>]";

function selectInputs(entries: InputEntry[], only: string | undefined): InputEntry[] | string {
  if (!only) return entries.filter((e) => e.enabled && e.supported);
  const selected: InputEntry[] = [];
  for (const id of only.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (id === "notion") return "notion is the knowledge store, mirrored by `openbrain sync notion`, not collected";
    const entry = findEntry(entries, id);
    if (!entry) return `no input "${id}" in openbrain.config.yaml (configured: ${entries.map((e) => e.id).join(", ") || "none"})`;
    if (entry.via === "claude") return `${entry.id} is read by Claude through its MCP connector during /init and /weekly, not collected by the CLI`;
    if (!entry.supported) return `input "${id}" has no built-in connector: declare it under inputs.claude, inputs.mcp or inputs.api`;
    selected.push(entry);
  }
  return selected;
}

function formatTokens(tokens: number): string {
  return `~${tokens.toLocaleString("en-US")} tokens`;
}

function printSummary(manifest: CollectManifest, collected: ReadonlySet<string>, root: string, outDir: string): void {
  const w = manifest.window;
  console.log(`\nwindow ${w.since} -> ${w.until} (${w.since_source})${w.full ? ", documents: full collection" : ""}`);
  // The manifest also keeps the connectors of earlier runs in the same folder: only this run is printed.
  const reports = manifest.connectors.filter((report) => collected.has(report.id));
  for (const c of reports) {
    const counts = manifest.dry_run
      ? `${c.documents} documents to fetch, ${c.events} events${c.events > 0 ? ` (${formatTokens(c.tokens)} for the events)` : ""}`
      : `${c.documents} documents, ${c.events} events, ${c.files.length} files, ${formatTokens(c.tokens)}`;
    console.log(`${c.id.padEnd(14)}${c.status === "ok" ? "" : `[${c.status}] `}${counts}${c.skipped.length > 0 ? `, ${c.skipped.length} skipped` : ""}`);
    for (const s of c.skipped.slice(0, 10)) console.log(`  skipped   ${s.title}: ${s.reason}`);
    if (c.skipped.length > 10) console.log(`  skipped   ... and ${c.skipped.length - 10} more (manifest.json)`);
    for (const e of c.errors.slice(0, 5)) console.log(`  error     ${e}`);
    for (const f of c.files.filter((file) => file.sensitive.length > 0)) {
      const lines = [...new Set(f.sensitive.flatMap((s) => s.lines))].sort((a, b) => a - b).slice(0, 8);
      console.log(`  sensitive ${f.path}: ${summarizeFindings(f.sensitive)} (line${lines.length === 1 ? "" : "s"} ${lines.join(", ")})`);
    }
  }
  const sum = (pick: (c: ConnectorCollectReport) => number): number => reports.reduce((total, c) => total + pick(c), 0);
  if (manifest.dry_run) {
    console.log(`\ndry run: ${sum((c) => c.documents)} documents and ${sum((c) => c.events)} events would be collected, nothing written`);
    return;
  }
  const where = path.relative(root, path.join(outDir, "inputs")) || ".";
  const files = sum((c) => c.files.length);
  console.log(`\nwrote ${files} files (${formatTokens(sum((c) => c.tokens))}) under ${where}/, summary in ${where}/manifest.json`);
  const sensitive = reports.flatMap((c) => c.files).filter((f) => f.sensitive.length > 0).length;
  if (sensitive > 0) console.log(`sensitive data in ${sensitive} file(s): flag it in the briefing, never copy it to Notion`);
}

async function run(args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 1) {
    console.log(USAGE);
    return 1;
  }
  const root = path.resolve(stringFlag(args, "root") ?? process.cwd());
  const json = boolFlag(args, "json");
  const loaded = await loadInputEntries(root);
  if (!loaded) return 1;
  const selected = selectInputs(loaded.entries, stringFlag(args, "only"));
  if (typeof selected === "string") {
    console.log(selected);
    return 1;
  }
  if (selected.length === 0) {
    console.log("no enabled input in openbrain.config.yaml: add an `inputs:` section (see openbrain connectors list)");
    return 1;
  }
  const since = stringFlag(args, "since");
  const until = stringFlag(args, "until");
  const window = await resolveCollectWindow({ root, ...(since ? { since } : {}), ...(until ? { until } : {}) });
  const outDir = resolveOutDir(root, stringFlag(args, "out"));
  const manifest = await collectInputs({
    root,
    inputs: selected,
    window,
    outDir,
    full: boolFlag(args, "full"),
    dryRun: boolFlag(args, "dry-run"),
    ...(json ? {} : { onProgress: (line: string) => console.log(line) }),
  });
  const collected = new Set(selected.map((e) => e.id));
  if (json) console.log(JSON.stringify(manifest, null, 2));
  else printSummary(manifest, collected, root, outDir);
  // Failure only when every input of this run failed: a partial collection is still useful.
  return manifest.connectors.filter((c) => collected.has(c.id)).every((c) => c.status === "error") ? 1 : 0;
}

export const collectCommand: CommandDefinition = {
  name: "collect",
  help: "collect                    Collect the enabled inputs (read-only) into .openbrain/weekly/<date>/inputs/",
  booleanFlags: ["dry-run", "full"],
  run,
};
