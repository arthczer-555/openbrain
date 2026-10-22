import path from "node:path";
import { lintKnowledgeBase, loadInstanceConfig, loadKnowledgeBase } from "@openbrain/core";
import { NotionClient, syncNotion } from "@openbrain/connectors";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain sync notion: mirrors the Notion tree into knowledge/, then lists what the routing registry
// (brain/registry.yaml) still has to cover. Read-only on Notion. The token comes from NOTION_TOKEN.

async function run(args: ParsedArgs): Promise<number> {
  const source = args.positionals[1];
  if (source !== "notion") {
    console.log("usage: openbrain sync notion [--root-page <id>] [--root <path>] [--full] [--dry-run] [--json]");
    return 1;
  }
  const root = path.resolve(stringFlag(args, "root") ?? process.cwd());
  const config = await loadInstanceConfig(root);
  const rootPageId = stringFlag(args, "root-page") ?? config.notion?.root_page;
  if (!rootPageId) {
    console.log("no Notion root page: pass --root-page <id> or set notion.root_page in openbrain.config.yaml");
    return 1;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.log("NOTION_TOKEN is not set: create an internal integration, share the root page with it, put the token in .env");
    return 1;
  }

  const client = new NotionClient({ token });
  const report = await syncNotion({
    root,
    rootPageId,
    client,
    full: boolFlag(args, "full"),
    dryRun: boolFlag(args, "dry-run"),
  });

  let missing: string[] = [];
  let orphans: string[] = [];
  if (!report.dryRun) {
    const kb = await loadKnowledgeBase(root);
    const issues = lintKnowledgeBase(kb);
    missing = issues.filter((i) => i.rule === "missing-registry-entry" || i.rule === "missing-section-entry").map((i) => i.file);
    orphans = issues.filter((i) => i.rule === "orphan-registry-entry" || i.rule === "orphan-section-entry").map((i) => i.file);
  }

  if (boolFlag(args, "json")) {
    console.log(JSON.stringify({ ...report, missingRegistryEntries: missing, orphanRegistryEntries: orphans }, null, 2));
    return 0;
  }
  const verb = report.dryRun ? "would write" : "wrote";
  console.log(`${report.pages} pages under ${report.rootPageId}: ${verb} ${report.written.length}, unchanged ${report.unchanged}, deleted ${report.deleted.length} (${report.requests} API requests)`);
  for (const p of report.written) console.log(`  ${verb} knowledge/${p}.md`);
  for (const p of report.deleted) console.log(`  deleted knowledge/${p}.md`);
  for (const m of report.moved) console.log(`  moved   knowledge/${m.from}.md -> knowledge/${m.to}.md`);
  for (const r of report.renamed) console.log(`  renamed "${r.from}" -> "${r.to}" (path kept: knowledge/${r.path}.md)`);
  for (const w of report.warnings) console.log(`  warning ${w}`);
  if (missing.length > 0) {
    console.log("\nto add to brain/registry.yaml (when_to_open, aliases), usually by the weekly update:");
    for (const m of missing) console.log(`  - ${m}`);
  }
  if (orphans.length > 0) {
    console.log("\nregistry entries without a page (renamed, moved or deleted in Notion):");
    for (const o of orphans) console.log(`  - ${o}`);
  }
  if (!report.dryRun) console.log("\nnext: openbrain guide build && openbrain index");
  return 0;
}

export const syncCommand: CommandDefinition = {
  name: "sync",
  help: 'sync notion                Mirror the Notion tree into knowledge/ (NOTION_TOKEN, read-only)',
  booleanFlags: ["full", "dry-run"],
  run,
};
