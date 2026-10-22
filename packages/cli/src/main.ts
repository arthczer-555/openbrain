import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkGuide,
  hasErrors,
  lintKnowledgeBase,
  loadKnowledgeBase,
  prepareGuide,
  writeGuide,
  type KnowledgeBase,
  type LintIssue,
} from "@openbrain/core";
import { buildIndex, INDEX_FILE, loadIndex, saveIndex, search, type SerializedIndex } from "@openbrain/retrieval";
import { boolFlag, firstPositional, intFlag, parseArgs, stringFlag, type ParsedArgs } from "./args.ts";
import { commands } from "./commands/index.ts";

function helpText(): string {
  const extra = commands.map((c) => `  ${c.help}`).join("\n");
  return `openbrain - compile company knowledge into a lean, cited chatbot

Usage: openbrain <command> [options]

Commands:
  lint                       Check the Notion mirror and brain/registry.yaml (entries, ids, links, when_to_open)
  guide build                Generate brain/catalog.md and brain/registry.json, check prompt budgets
  guide check                Fail if the committed guide does not match the knowledge base
  index                      Build the passage index into ${INDEX_FILE}
  search "<question>"        Search the knowledge base (no LLM): passages, warnings, section rules
${extra}

Options:
  --root <path>              Instance root containing knowledge/ and brain/ (default: current folder)
  --section <id>             search: only this section
  --k <n>                    search: number of passages (default 6, max 10)
  --full                     search: print full passages instead of a preview
  --json                     machine-readable output
  -h, --help                 show this help
`;
}

function rootOf(args: ParsedArgs): string {
  return path.resolve(stringFlag(args, "root") ?? process.cwd());
}

function printIssues(issues: LintIssue[]): void {
  for (const issue of issues) {
    console.log(`${issue.level === "error" ? "error  " : "warning"} ${issue.file}  [${issue.rule}] ${issue.message}`);
  }
}

async function loadValidBase(root: string): Promise<{ kb: KnowledgeBase; issues: LintIssue[] }> {
  const kb = await loadKnowledgeBase(root);
  return { kb, issues: lintKnowledgeBase(kb) };
}

async function cmdLint(args: ParsedArgs): Promise<number> {
  const { kb, issues } = await loadValidBase(rootOf(args));
  if (boolFlag(args, "json")) {
    console.log(JSON.stringify({ docs: kb.docs.length, sections: kb.sections.length, issues }, null, 2));
  } else {
    printIssues(issues);
    const errors = issues.filter((i) => i.level === "error").length;
    console.log(`\n${kb.docs.length} docs, ${kb.sections.length} sections: ${errors} error(s), ${issues.length - errors} warning(s)`);
  }
  return hasErrors(issues) ? 1 : 0;
}

async function cmdGuide(args: ParsedArgs, mode: "build" | "check"): Promise<number> {
  const root = rootOf(args);
  const { kb, issues } = await loadValidBase(root);
  if (hasErrors(issues)) {
    printIssues(issues.filter((i) => i.level === "error"));
    console.log("\nguide not generated: fix the lint errors first (openbrain lint)");
    return 1;
  }
  const { guide, budgets, problems } = await prepareGuide(kb);
  for (const b of budgets) {
    console.log(`budget ${b.name.padEnd(7)} ~${b.tokens} / ${b.limit} tokens ${b.ok ? "ok" : "OVER"}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.log(`error   ${p}`);
    return 1;
  }
  if (mode === "build") {
    const written = await writeGuide(root, guide);
    console.log(`wrote ${written.join(", ")} (${guide.registry.sections.length} sections, ${guide.registry.docs.length} docs)`);
    return 0;
  }
  const check = await checkGuide(root, guide);
  if (!check.upToDate) {
    console.log(`stale: ${check.stale.join(", ")} (run: openbrain guide build)`);
    return 1;
  }
  console.log("guide is up to date with the knowledge base");
  return 0;
}

async function cmdIndex(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const { kb, issues } = await loadValidBase(root);
  if (hasErrors(issues)) {
    printIssues(issues.filter((i) => i.level === "error"));
    console.log("\nindex not built: fix the lint errors first (openbrain lint)");
    return 1;
  }
  const index = buildIndex(kb);
  const file = await saveIndex(root, index);
  const terms = Object.keys(index.postings).length;
  console.log(`wrote ${path.relative(root, file)}: ${index.chunks.length} passages from ${Object.keys(index.docs).length} docs, ${terms} terms`);
  return 0;
}

/** Short passage for the terminal: without the heading trail (already printed) and the bold markers. */
function preview(text: string, full: boolean, where: string): string {
  if (full) return text;
  let flat = text.replace(/\s+/g, " ").trim();
  if (flat.startsWith(where)) flat = flat.slice(where.length).trim();
  flat = flat.replace(/\*\*(.+?)\*\*/g, "$1");
  return flat.length > 240 ? `${flat.slice(0, 240)}...` : flat;
}

async function cmdSearch(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const query = args.positionals.slice(1).join(" ").trim();
  if (!query) {
    console.log('usage: openbrain search "<question>" [--section <id>] [--k <n>]');
    return 1;
  }
  let index: SerializedIndex | null = await loadIndex(root);
  if (!index) {
    const kb = await loadKnowledgeBase(root);
    index = buildIndex(kb);
    if (!boolFlag(args, "json")) console.log(`(no ${INDEX_FILE}: index built in memory)\n`);
  }
  const section = stringFlag(args, "section");
  const k = intFlag(args, "k");
  const result = search(index, query, { ...(section ? { section } : {}), ...(k ? { k } : {}) });

  if (boolFlag(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.results.length === 0) {
    console.log(`no passage found for "${query}"`);
    return 0;
  }
  for (const r of result.results) {
    const where = [r.title, ...r.headingPath].join(" > ");
    const status = r.status === "validated" ? "" : `  [${r.status}]`;
    console.log(`[${r.rank}] ${r.score.toFixed(3)}  ${r.docId}  (${where})${status}`);
    console.log(`    ${preview(r.text, boolFlag(args, "full"), where).split("\n").join("\n    ")}`);
    for (const w of r.warnings ?? []) console.log(`    warning: ${w}`);
    console.log(`    source: ${r.url}\n`);
  }
  for (const [sectionId, rules] of Object.entries(result.sectionRules)) {
    if (rules.length === 0) continue;
    console.log(`section rules (${sectionId}):`);
    for (const rule of rules) console.log(`  - ${rule}`);
  }
  if (result.truncated) console.log("\n(some passages were dropped to respect the token budget)");
  return 0;
}

/**
 * Loads `.env` from the instance root, then from the current folder (the repo root when --root points to an
 * example). Variables already set in the environment win. Secrets stay on the operator's machine.
 */
export function loadDotEnv(args: ParsedArgs): string[] {
  const loaded: string[] = [];
  const candidates = [path.resolve(stringFlag(args, "root") ?? process.cwd(), ".env"), path.resolve(process.cwd(), ".env")];
  for (const file of [...new Set(candidates)]) {
    try {
      process.loadEnvFile(file);
      loaded.push(file);
    } catch {
      // No .env there: nothing to load.
    }
  }
  return loaded;
}

export async function main(argv: string[]): Promise<number> {
  let plugin = commands.find((c) => c.name === firstPositional(argv));
  let args = parseArgs(argv, plugin?.booleanFlags ?? []);
  if (!plugin) {
    // The command may come after a valued flag ("--root x sync notion"): look again once parsed.
    plugin = commands.find((c) => c.name === args.positionals[0]);
    if (plugin) args = parseArgs(argv, plugin.booleanFlags ?? []);
  }
  loadDotEnv(args);
  const [command, sub] = args.positionals;
  if (!command || boolFlag(args, "help") || command === "help") {
    console.log(helpText());
    return 0;
  }
  if (plugin) return plugin.run(args);
  switch (command) {
    case "lint":
      return cmdLint(args);
    case "guide":
      if (sub === "build" || sub === "check") return cmdGuide(args, sub);
      console.log("usage: openbrain guide build|check");
      return 1;
    case "index":
      return cmdIndex(args);
    case "search":
      return cmdSearch(args);
    default:
      console.log(`unknown command "${command}"\n`);
      console.log(helpText());
      return 1;
  }
}

const entry = process.argv[1];
const isEntry = entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
if (isEntry || process.env.OPENBRAIN_CLI === "1") {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
