import { knowledgeFromIndex } from "@openbrain/agent";
import { buildBundle, type Report, type ReportsResponse } from "@openbrain/server";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, dim, green, pink, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain reports: the flagged questions of the deployed chatbot (no answer, thumbs down), pulled with
// ADMIN_TOKEN for the weekly update, each re-tested against the local mirror without
// an LLM: does the right page come up now? `reports mark done <id...>` closes them after publication.

function baseUrl(args: ParsedArgs): string | null {
  const url = stringFlag(args, "url") ?? process.env.OPENBRAIN_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ""}`, "content-type": "application/json" };
}

async function pull(args: ParsedArgs, url: string): Promise<number> {
  const status = stringFlag(args, "status") ?? "open";
  const type = stringFlag(args, "type");
  const query = new URLSearchParams({ status, ...(type ? { type } : {}) });
  const response = await fetch(`${url}/api/admin/reports?${query.toString()}`, { headers: headers() });
  if (!response.ok) {
    console.log(`GET ${url}/api/admin/reports: HTTP ${response.status} (check OPENBRAIN_URL and ADMIN_TOKEN in .env)`);
    return 1;
  }
  const body = (await response.json()) as ReportsResponse;
  if (boolFlag(args, "json")) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  const bundle = await buildBundle(rootOf(args));
  const knowledge = knowledgeFromIndex(bundle.index);
  console.log(bold(`${body.reports.length} ${status} report(s)`) + dim(body.lastWeeklyUpdate ? `, last weekly update ${body.lastWeeklyUpdate.slice(0, 10)}` : ""));
  for (const report of body.reports) {
    printReport(report, knowledge.search(report.question, { k: 3, maxPerDoc: 1 }).results.map((r) => `${r.docId} (${r.score})`));
  }
  return 0;
}

function printReport(report: Report, now: string[]): void {
  const kind = report.type === "no_answer" ? `no answer (${report.reason ?? "?"})` : "thumbs down";
  console.log(`\n${pink(report.id)} ${dim(report.created_at.slice(0, 16).replace("T", " "))} ${bold(kind)}`);
  console.log(`  ${report.question}`);
  if (report.comment) console.log(`  comment: ${report.comment}`);
  if (report.citations && report.citations.length > 0) console.log(dim(`  cited: ${report.citations.map((c) => c.page).join(", ")}`));
  if (report.searched && report.searched.length > 0) console.log(dim(`  searched: ${report.searched.join(" | ")}`));
  console.log(dim(`  answered by ${report.model.provider}:${report.model.model}${report.deploy.commit ? ` at ${report.deploy.commit.slice(0, 7)}` : ""}`));
  console.log(`  ${green("now finds")} ${now.join(", ") || "nothing"}`);
}

async function mark(args: ParsedArgs, url: string): Promise<number> {
  const status = args.positionals[2];
  const ids = args.positionals.slice(3);
  if ((status !== "done" && status !== "open") || ids.length === 0) {
    console.log("usage: openbrain reports mark done|open <id> [<id>...]");
    return 1;
  }
  const response = await fetch(`${url}/api/admin/reports/mark`, { method: "POST", headers: headers(), body: JSON.stringify({ ids, status }) });
  if (!response.ok) {
    console.log(`POST ${url}/api/admin/reports/mark: HTTP ${response.status}`);
    return 1;
  }
  const body = (await response.json()) as { changed: number };
  console.log(`${body.changed} report(s) marked ${status}`);
  return 0;
}

export const reportsCommand: CommandDefinition = {
  name: "reports",
  help: "reports [mark done <ids>]  Flagged questions of the deployed chatbot, re-tested on the mirror",
  async run(args: ParsedArgs): Promise<number> {
    const url = baseUrl(args);
    if (!url || !process.env.ADMIN_TOKEN) {
      console.log("set OPENBRAIN_URL (the chatbot URL) and ADMIN_TOKEN in .env: `openbrain deploy` writes both");
      return 1;
    }
    return args.positionals[1] === "mark" ? mark(args, url) : pull(args, url);
  },
};
