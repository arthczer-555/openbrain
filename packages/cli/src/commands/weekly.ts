import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hasErrors,
  lintKnowledgeBase,
  loadInstanceConfig,
  loadKnowledgeBase,
  prepareGuide,
  writeGuide,
} from "@openbrain/core";
import { knowledgeFromIndex, parseGolden, scoreRetrieval, summarize, type KnowledgePort } from "@openbrain/agent";
import {
  collectInputs,
  NotionClient,
  resolveCollectWindow,
  resolveOutDir,
  syncNotion,
  type CollectManifest,
  type SyncReport,
} from "@openbrain/connectors";
import { buildIndex, saveIndex } from "@openbrain/retrieval";
import type { Report, ReportsResponse } from "@openbrain/server";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { loadInputEntries } from "./connectors.ts";
import { bold, dim, green, pink, red, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain weekly: the CLI does the mechanical part, without an LLM, before and after Claude Code.
//   weekly prepare  window, Notion mirror sync, inputs, flagged questions re-tested, pending decisions,
//                   pages missing from the registry -> .openbrain/weekly/<date>/packet.md (+ packet.json)
//   weekly finish   after the operator's go and the writes: guide, lint, re-test, reports marked done,
//                   state/sync.json advanced
//   weekly          opens Claude Code on the /weekly skill

const STATE_FILE = "state/sync.json";
const PENDING_FILE = "state/pending.json";
/** Beyond this, the update catches up week by week. */
const MAX_WINDOW_DAYS = 35;

interface RetestedReport {
  id: string;
  type: Report["type"];
  question: string;
  comment: string | null;
  cited: string[];
  searched: string[];
  /** Pages the search returns today, on the fresh mirror. */
  nowFinds: Array<{ page: string; score: number }>;
}

interface Packet {
  version: 1;
  date: string;
  window: { since: string; until: string; source: string; catchUp: boolean };
  notion: { status: "synced" | "skipped" | "error"; detail: string; written: string[]; deleted: string[] };
  inputs: { status: "collected" | "skipped" | "error"; detail: string; manifest: CollectManifest | null };
  /** Tools Claude reads through its MCP connectors (inputs.claude), with their whitelist scope. */
  viaClaude?: Array<{ id: string; scope: string }>;
  reports: { status: "pulled" | "skipped" | "error"; detail: string; items: RetestedReport[] };
  pending: unknown[];
  registry: { missing: string[]; orphans: string[] };
  quality: { recallAtK: number | null; questions: number };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function freshKnowledge(root: string): Promise<{ knowledge: KnowledgePort; missing: string[]; orphans: string[] }> {
  const kb = await loadKnowledgeBase(root);
  const issues = lintKnowledgeBase(kb);
  return {
    knowledge: knowledgeFromIndex(buildIndex(kb)),
    missing: issues.filter((i) => i.rule === "missing-registry-entry" || i.rule === "missing-section-entry").map((i) => i.file),
    orphans: issues.filter((i) => i.rule === "orphan-registry-entry" || i.rule === "orphan-section-entry").map((i) => i.file),
  };
}

async function pullReports(knowledge: KnowledgePort): Promise<Packet["reports"]> {
  const url = process.env.OPENBRAIN_URL?.replace(/\/+$/, "");
  const token = process.env.ADMIN_TOKEN;
  if (!url || !token) return { status: "skipped", detail: "OPENBRAIN_URL or ADMIN_TOKEN not set in .env", items: [] };
  try {
    const response = await fetch(`${url}/api/admin/reports?status=open`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return { status: "error", detail: `HTTP ${response.status} from ${url}`, items: [] };
    const body = (await response.json()) as ReportsResponse;
    const items = body.reports.map((r): RetestedReport => ({
      id: r.id,
      type: r.type,
      question: r.question,
      comment: r.comment ?? null,
      cited: [...new Set((r.citations ?? []).map((c) => c.page))],
      searched: r.searched ?? (r.searches ?? []).map((s) => s.query),
      nowFinds: knowledge.search(r.question, { k: 3, maxPerDoc: 1 }).results.map((x) => ({ page: x.docId, score: x.score })),
    }));
    const down = items.filter((i) => i.type === "thumbs_down").length;
    return { status: "pulled", detail: `${items.length - down} unanswered, ${down} thumbs down`, items };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error), items: [] };
  }
}

function packetMarkdown(p: Packet, root: string, dir: string): string {
  const rel = (file: string): string => path.relative(root, file) || ".";
  const lines: string[] = [
    `# Weekly update packet ${p.date}`,
    "",
    `Window: ${p.window.since} -> ${p.window.until} (${p.window.source})${p.window.catchUp ? ". Catch-up: this run covers one week, run the update again for the next one." : ""}`,
    "",
    "## Notion mirror",
    `${p.notion.status}: ${p.notion.detail}`,
    ...p.notion.written.map((x) => `- changed: knowledge/${x}.md`),
    ...p.notion.deleted.map((x) => `- removed: knowledge/${x}.md`),
    "",
    "## Inputs to read",
    `${p.inputs.status}: ${p.inputs.detail}`,
  ];
  for (const c of p.inputs.manifest?.connectors ?? []) {
    lines.push(`- ${c.id} (${c.status}): ${c.documents} documents, ${c.events} events, ~${c.tokens} tokens, folder ${rel(path.join(dir, "inputs", c.dir))}`);
    for (const f of c.files.slice(0, 40)) {
      const sensitive = f.sensitive.length > 0 ? ` SENSITIVE (${f.sensitive.map((s) => s.kind).join(", ")})` : "";
      lines.push(`  - ${f.path} (~${f.tokens} tokens) ${f.title}${sensitive}`);
    }
    if (c.files.length > 40) lines.push(`  - ... ${c.files.length - 40} more in manifest.json`);
    for (const e of c.errors) lines.push(`  - error: ${e}`);
  }
  lines.push("", "## Read through your MCP connectors (inputs.claude)");
  const viaClaude = p.viaClaude ?? [];
  if (viaClaude.length === 0) lines.push("none declared: read no other tool unless the operator asks, and then within a whitelist scope");
  for (const t of viaClaude) lines.push(`- ${t.id}: ${t.scope}. Query it on the window, within this scope only.`);
  lines.push("", "## Flagged questions (chatbot)", `${p.reports.status}: ${p.reports.detail}`);
  for (const r of p.reports.items) {
    lines.push(
      `- ${r.id} [${r.type === "thumbs_down" ? "thumbs down" : "no answer"}] ${r.question}`,
      ...(r.comment ? [`  comment: ${r.comment}`] : []),
      ...(r.cited.length > 0 ? [`  cited then: ${r.cited.join(", ")}`] : []),
      ...(r.searched.length > 0 ? [`  searched then: ${r.searched.join(" | ")}`] : []),
      `  search now finds: ${r.nowFinds.map((x) => `${x.page} (${x.score})`).join(", ") || "nothing"}`,
    );
  }
  lines.push("", "## Pending decisions (state/pending.json)", p.pending.length === 0 ? "none" : JSON.stringify(p.pending, null, 2));
  lines.push("", "## Registry (brain/registry.yaml)");
  lines.push(p.registry.missing.length === 0 ? "every mirrored page has an entry" : "pages to register:");
  for (const m of p.registry.missing) lines.push(`- ${m}`);
  for (const o of p.registry.orphans) lines.push(`- orphan entry: ${o}`);
  lines.push("", "## Quality", `Retrieval recall@k on evals/golden.yaml: ${p.quality.recallAtK === null ? "n/a" : `${Math.round(p.quality.recallAtK * 100)}%`} (${p.quality.questions} questions)`);
  lines.push("", "Next: read this packet, sort, write the briefing (.claude/skills/weekly/SKILL.md section 3), wait for the go.");
  return `${lines.join("\n")}\n`;
}

async function prepare(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const now = new Date();
  const json = boolFlag(args, "json");
  const log = (line: string): void => {
    if (!json) console.log(line);
  };
  const since = stringFlag(args, "since");
  const until = stringFlag(args, "until");
  let window = await resolveCollectWindow({ root, ...(since ? { since } : {}), ...(until ? { until } : {}), now });
  const days = (Date.parse(window.until) - Date.parse(window.since)) / 86_400_000;
  const catchUp = days > MAX_WINDOW_DAYS;
  if (catchUp) window = { ...window, until: new Date(Date.parse(window.since) + 7 * 86_400_000).toISOString() };
  const dir = resolveOutDir(root, undefined, now);
  await writeJson(path.join(dir, "progress.json"), { step: "preparing", started_at: now.toISOString() });

  const sinceDays = Math.round((now.getTime() - Date.parse(window.since)) / 86_400_000);
  log(`${pink(">")} openbrain weekly prepare`);
  log(`  ${green("ok")}  window: ${window.sinceSource.startsWith("state") ? `last update ${sinceDays} days ago` : window.sinceSource}${catchUp ? ", catching up one week at a time" : ""}`);

  // 1. Notion mirror.
  const config = await loadInstanceConfig(root);
  const rootPage = config.notion?.root_page;
  let notion: Packet["notion"] = { status: "skipped", detail: "", written: [], deleted: [] };
  if (boolFlag(args, "no-sync")) notion.detail = "--no-sync";
  else if (!rootPage) notion.detail = "no notion.root_page in openbrain.config.yaml";
  else if (!process.env.NOTION_TOKEN) notion.detail = "NOTION_TOKEN not set: sync from the Notion MCP connector, or add the token to .env";
  else {
    try {
      const report: SyncReport = await syncNotion({ root, rootPageId: rootPage, client: new NotionClient({ token: process.env.NOTION_TOKEN }) });
      notion = {
        status: "synced",
        detail: `${report.pages} pages, ${report.written.length} changed, ${report.deleted.length} removed`,
        written: report.written,
        deleted: report.deleted,
      };
    } catch (error) {
      notion = { status: "error", detail: error instanceof Error ? error.message : String(error), written: [], deleted: [] };
    }
  }
  log(`  ${notion.status === "synced" ? green("ok") : notion.status === "error" ? red("err") : dim("--")}  notion: ${notion.detail}`);

  // 2. Inputs with a token.
  let inputs: Packet["inputs"] = { status: "skipped", detail: "", manifest: null };
  const configured = await loadInputEntries(root);
  const viaClaude = (configured?.entries ?? []).filter((e) => e.enabled && e.via === "claude").map((e) => ({ id: e.id, scope: e.scope }));
  if (boolFlag(args, "no-collect")) inputs.detail = "--no-collect";
  else {
    const enabled = configured?.entries.filter((e) => e.enabled && e.supported) ?? [];
    if (enabled.length === 0) inputs.detail = "no input collected by the CLI in openbrain.config.yaml";
    else {
      try {
        const manifest = await collectInputs({ root, inputs: enabled, window, outDir: dir });
        inputs = { status: "collected", detail: `${manifest.totals.files} files, ~${manifest.totals.tokens} tokens to read`, manifest };
        for (const c of manifest.connectors) {
          log(`  ${c.status === "error" ? red("err") : green("ok")}  ${c.id}: ${c.documents} documents, ${c.events} events${c.errors[0] ? ` (${c.errors[0]})` : ""}`);
        }
      } catch (error) {
        inputs = { status: "error", detail: error instanceof Error ? error.message : String(error), manifest: null };
      }
    }
  }
  if (inputs.status !== "collected") log(`  ${inputs.status === "error" ? red("err") : dim("--")}  inputs: ${inputs.detail}`);

  // 3. Flagged questions, re-tested on the fresh mirror; registry gaps; quality.
  const fresh = await freshKnowledge(root);
  const reports = boolFlag(args, "no-reports") ? { status: "skipped" as const, detail: "--no-reports", items: [] } : await pullReports(fresh.knowledge);
  log(`  ${reports.status === "pulled" ? green("ok") : reports.status === "error" ? red("err") : dim("--")}  chatbot: ${reports.detail}`);
  const pending = (await readJson<unknown[]>(path.join(root, PENDING_FILE))) ?? [];
  let recall: number | null = null;
  let questions = 0;
  const golden = await readFile(path.join(root, "evals", "golden.yaml"), "utf8").catch(() => null);
  if (golden) {
    const items = parseGolden(golden);
    questions = items.length;
    recall = summarize(items, await scoreRetrieval(fresh.knowledge, items)).recallAtK;
  }

  const packet: Packet = {
    version: 1,
    date: now.toISOString().slice(0, 10),
    window: { since: window.since, until: window.until, source: window.sinceSource, catchUp },
    notion,
    inputs,
    viaClaude,
    reports,
    pending,
    registry: { missing: fresh.missing, orphans: fresh.orphans },
    quality: { recallAtK: recall, questions },
  };
  await writeJson(path.join(dir, "packet.json"), packet);
  await writeFile(path.join(dir, "packet.md"), packetMarkdown(packet, root, dir), "utf8");
  await writeJson(path.join(dir, "progress.json"), { step: "prepared", started_at: now.toISOString(), prepared_at: new Date().toISOString() });

  if (json) {
    console.log(JSON.stringify(packet, null, 2));
    return 0;
  }
  if (pending.length > 0) log(`  ${pink("!!")}  ${pending.length} decision(s) pending since earlier weeks`);
  if (fresh.missing.length > 0) log(`  ${pink("!!")}  ${fresh.missing.length} page(s) to add to brain/registry.yaml`);
  log(`\n${bold("Work packet")}: ${path.relative(process.cwd(), path.join(dir, "packet.md"))}`);
  return 0;
}

async function latestPacket(root: string): Promise<{ dir: string; packet: Packet } | null> {
  const dir = resolveOutDir(root, undefined, new Date());
  const packet = await readJson<Packet>(path.join(dir, "packet.json"));
  return packet ? { dir, packet } : null;
}

async function markReports(ids: string[]): Promise<string> {
  const url = process.env.OPENBRAIN_URL?.replace(/\/+$/, "");
  const token = process.env.ADMIN_TOKEN;
  if (ids.length === 0) return "no report to mark";
  if (!url || !token) return "OPENBRAIN_URL or ADMIN_TOKEN not set: reports not marked";
  const response = await fetch(`${url}/api/admin/reports/mark`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ids, status: "done" }),
  });
  if (!response.ok) return `could not mark the reports: HTTP ${response.status}`;
  const body = (await response.json()) as { changed: number };
  return `${body.changed} report(s) marked done on the chatbot`;
}

async function finish(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const kb = await loadKnowledgeBase(root);
  const issues = lintKnowledgeBase(kb);
  if (hasErrors(issues)) {
    for (const i of issues.filter((x) => x.level === "error")) console.log(`${red("error")} ${i.file}: ${i.message}`);
    console.log(red("\nfix the lint errors (usually brain/registry.yaml), then run weekly finish again"));
    return 1;
  }
  const { guide, problems, budgets } = await prepareGuide(kb);
  if (problems.length > 0) {
    for (const p of problems) console.log(`${red("error")} ${p}`);
    return 1;
  }
  await writeGuide(root, guide);
  await saveIndex(root, buildIndex(kb));
  console.log(`${green("ok")}  guide regenerated (${budgets.map((b) => `${b.name} ~${b.tokens}/${b.limit}`).join(", ")}), lint clean`);

  const knowledge = knowledgeFromIndex(buildIndex(kb));
  const golden = await readFile(path.join(root, "evals", "golden.yaml"), "utf8").catch(() => null);
  if (golden) {
    const items = parseGolden(golden);
    const summary = summarize(items, await scoreRetrieval(knowledge, items));
    console.log(`${green("ok")}  evals: retrieval recall@k ${summary.recallAtK === null ? "n/a" : `${Math.round(summary.recallAtK * 100)}%`} on ${items.length} questions`);
  }

  const latest = await latestPacket(root);
  const flag = stringFlag(args, "reports");
  const ids = flag === "all" ? (latest?.packet.reports.items.map((r) => r.id) ?? []) : (flag ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (latest && latest.packet.reports.items.length > 0) {
    console.log(bold("\nFlagged questions, re-tested on the updated mirror"));
    for (const r of latest.packet.reports.items) {
      const now = knowledge.search(r.question, { k: 3, maxPerDoc: 1 }).results.map((x) => x.docId);
      const handled = ids.includes(r.id) ? green("done") : dim("open");
      console.log(`  ${handled} ${r.question}\n       ${dim(`now finds: ${now.join(", ") || "nothing"}`)}`);
    }
  }
  console.log(`${green("ok")}  ${await markReports(ids)}`);

  const state = (await readJson<Record<string, unknown>>(path.join(root, STATE_FILE))) ?? {};
  const until = latest?.packet.window.until ?? new Date().toISOString();
  await writeJson(path.join(root, STATE_FILE), {
    ...state,
    last_weekly: until,
    last_window: latest ? { since: latest.packet.window.since, until } : null,
    updated_at: new Date().toISOString(),
  });
  if (latest) await writeJson(path.join(latest.dir, "progress.json"), { step: "finished", finished_at: new Date().toISOString() });
  console.log(`${green("ok")}  ${STATE_FILE}: last_weekly = ${until.slice(0, 10)}`);
  const briefing = latest ? path.relative(root, path.join(latest.dir, "briefing.md")) : ".openbrain/weekly/<date>/briefing.md";
  console.log(`\nPublish: git add -A && git commit -F ${briefing} && git push`);
  return 0;
}

function openClaude(): number {
  const which = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.log("Claude Code is not installed: open this repository in Claude Code and type /weekly (or run `weekly prepare` and follow .claude/skills/weekly/SKILL.md).");
    return 1;
  }
  const run = spawnSync("claude", ["/weekly"], { stdio: "inherit" });
  return run.status ?? 0;
}

export const weeklyCommand: CommandDefinition = {
  name: "weekly",
  help: "weekly [prepare|finish]    Weekly update: prepare the packet, finish after the go (or open /weekly)",
  booleanFlags: ["no-sync", "no-collect", "no-reports"],
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positionals[1];
    if (sub === "prepare") return prepare(args);
    if (sub === "finish") return finish(args);
    if (sub === undefined) return openClaude();
    console.log("usage: openbrain weekly [prepare [--since <iso>] | finish [--reports all|<id,id>]]");
    return 1;
  },
};
