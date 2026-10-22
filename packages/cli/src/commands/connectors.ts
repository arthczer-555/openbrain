import path from "node:path";
import { loadInstanceConfig, type HealthReport, type InstanceConfig } from "@openbrain/core";
import {
  checkNotion,
  describeInputs,
  isEnvSet,
  loadDotEnv,
  NotionClient,
  parseInputsConfig,
  type InputEntry,
} from "@openbrain/connectors";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain connectors list | test <id>: what is configured (openbrain.config.yaml `inputs:` + Notion),
// whether the credentials are set (values are never printed), and a live read-only health check.

const USAGE = "usage: openbrain connectors list|test <id> [--root <path>] [--json]";

export interface ConnectorRow {
  id: string;
  role: "knowledge store" | "input";
  kinds: string[];
  transport: string;
  enabled: boolean;
  supported: boolean;
  via: "cli" | "claude";
  env: Array<{ name: string; set: boolean }>;
  scope: string;
  setup?: string;
}

function notionRow(config: InstanceConfig): ConnectorRow {
  const rootPage = config.notion?.root_page;
  return {
    id: "notion",
    role: "knowledge store",
    kinds: ["documents"],
    transport: "rest",
    enabled: Boolean(rootPage),
    supported: true,
    via: "cli",
    env: [{ name: "NOTION_TOKEN", set: isEnvSet(process.env, "NOTION_TOKEN") }],
    scope: rootPage ? `root page ${rootPage}` : "notion.root_page is not set",
  };
}

function inputRow(entry: InputEntry): ConnectorRow {
  return {
    id: entry.id,
    role: "input",
    kinds: [...entry.kinds],
    transport: entry.transport,
    enabled: entry.enabled,
    supported: entry.supported,
    via: entry.via,
    env: entry.env,
    scope: entry.scope,
    ...(entry.manifest.setup ? { setup: `packages/connectors/src/${entry.manifest.setup}` } : {}),
  };
}

/** Configured inputs, or a printed error (invalid `inputs:`) and undefined. */
export async function loadInputEntries(root: string): Promise<{ config: InstanceConfig; entries: InputEntry[] } | undefined> {
  loadDotEnv(root);
  const config = await loadInstanceConfig(root);
  try {
    const inputs = parseInputsConfig((config as Record<string, unknown>).inputs);
    return { config, entries: describeInputs(inputs, { root }) };
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** "linear" finds "mcp:linear" (or "api:linear", "claude:linear"). */
export function findEntry(entries: InputEntry[], id: string): InputEntry | undefined {
  return entries.find((e) => e.id === id) ?? ["mcp", "api", "claude"].map((prefix) => entries.find((e) => e.id === `${prefix}:${id}`)).find(Boolean);
}

function envText(row: ConnectorRow): string {
  if (row.env.length === 0) return "-";
  return row.env.map((e) => `${e.name} ${e.set ? "set" : "MISSING"}`).join(", ");
}

async function list(root: string, json: boolean): Promise<number> {
  const loaded = await loadInputEntries(root);
  if (!loaded) return 1;
  const rows = [notionRow(loaded.config), ...loaded.entries.map(inputRow)];
  if (json) {
    console.log(JSON.stringify({ root, connectors: rows }, null, 2));
    return 0;
  }
  const status = (r: ConnectorRow): string =>
    !r.enabled ? "disabled" : r.via === "claude" ? "via Claude" : !r.supported ? "no connector" : "enabled";
  const idWidth = Math.max(8, ...rows.map((r) => r.id.length)) + 2;
  const envWidth = Math.max(12, ...rows.map((r) => envText(r).length)) + 2;
  console.log(`${"id".padEnd(idWidth)}${"role".padEnd(17)}${"kind".padEnd(19)}${"status".padEnd(14)}${"credentials".padEnd(envWidth)}scope`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(idWidth)}${r.role.padEnd(17)}${(r.kinds.join("+") || "-").padEnd(19)}${status(r).padEnd(14)}${envText(r).padEnd(envWidth)}${r.scope}`,
    );
  }
  if (loaded.entries.length === 0) console.log("\nno input configured: add an `inputs:` section to openbrain.config.yaml (see packages/connectors/src/<input>/SETUP.md)");
  console.log("\ntest one: openbrain connectors test <id>   (credentials are read from the environment or .env, never printed)");
  return 0;
}

function printReport(id: string, role: string, enabled: boolean, report: HealthReport): void {
  console.log(`${id} (${role})${enabled ? "" : "  [disabled in openbrain.config.yaml]"}`);
  console.log(`  status    ${report.ok ? "ok" : "FAILED"}`);
  if (report.identity) console.log(`  identity  ${report.identity}`);
  if (report.scopes.length > 0) {
    report.scopes.forEach((scope, i) => console.log(`  ${i === 0 ? "scopes   " : "         "} - ${scope}`));
  }
  if (role === "input" && (report.ok || report.writeScopesDetected)) {
    console.log(
      report.writeScopesDetected
        ? "  WARNING   write access detected: an input must be read-only, reduce the token or share to read-only (see SETUP.md)"
        : "  write     none detected",
    );
  }
  for (const [i, ref] of (report.sample ?? []).entries()) {
    console.log(`  ${i === 0 ? "sample   " : "         "} - ${ref.title}${ref.url ? `  ${ref.url}` : ""}  (${ref.modifiedAt})`);
  }
  for (const warning of report.warnings ?? []) console.log(`  WARNING   ${warning}`);
  if (report.error) console.log(`  error     ${report.error}`);
}

async function testNotion(config: InstanceConfig, json: boolean): Promise<number> {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.log("NOTION_TOKEN is not set: create an internal integration, share the root page with it, put the token in .env");
    return 1;
  }
  const report = await checkNotion(new NotionClient({ token }), config.notion?.root_page);
  if (json) console.log(JSON.stringify({ id: "notion", role: "knowledge store", report }, null, 2));
  else printReport("notion", "knowledge store", Boolean(config.notion?.root_page), report);
  return report.ok ? 0 : 1;
}

async function test(root: string, id: string | undefined, json: boolean): Promise<number> {
  if (!id) {
    console.log(USAGE);
    return 1;
  }
  const loaded = await loadInputEntries(root);
  if (!loaded) return 1;
  if (id === "notion") return testNotion(loaded.config, json);
  const entry = findEntry(loaded.entries, id);
  if (!entry) {
    const known = ["notion", ...loaded.entries.map((e) => e.id)].join(", ");
    console.log(`no connector "${id}" in openbrain.config.yaml (configured: ${known})`);
    return 1;
  }
  if (entry.via === "claude") {
    const message = `${entry.id} is read by Claude during /init and /weekly, not by the CLI. Scope: ${entry.scope}. Check the connector with /mcp in Claude Code.`;
    console.log(json ? JSON.stringify({ id: entry.id, role: "input", via: "claude", enabled: entry.enabled, message }, null, 2) : message);
    return 0;
  }
  let report: HealthReport;
  try {
    const connector = await entry.create();
    try {
      report = await connector.test();
    } finally {
      await connector.close?.().catch(() => undefined);
    }
  } catch (error) {
    report = { ok: false, scopes: [], writeScopesDetected: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (json) console.log(JSON.stringify({ id: entry.id, role: "input", enabled: entry.enabled, report }, null, 2));
  else printReport(entry.id, "input", entry.enabled, report);
  return report.ok ? 0 : 1;
}

async function run(args: ParsedArgs): Promise<number> {
  const root = path.resolve(stringFlag(args, "root") ?? process.cwd());
  const json = boolFlag(args, "json");
  const sub = args.positionals[1];
  if (sub === "list") return list(root, json);
  if (sub === "test") return test(root, args.positionals[2], json);
  console.log(USAGE);
  return 1;
}

export const connectorsCommand: CommandDefinition = {
  name: "connectors",
  help: "connectors list|test <id>  List the configured inputs and Notion, or run a read-only health check",
  run,
};
