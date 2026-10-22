import { estimateTokens } from "@openbrain/core";
import { WEAK_MATCH } from "@openbrain/retrieval";
import type { ToolSpec } from "@openbrain/llm";
import { z } from "zod";
import type { KnowledgePort } from "./brain.ts";
import { registerCitation } from "./state.ts";
import type { AgentEvent, AgentLimits, Citation, ConversationState, GapSignal, ReportReason, SearchTrace } from "./types.ts";

// The 3 tools of the chatbot. Results are compact text, not JSON: fewer tokens, and the
// model reads "[n] Title > heading" blocks well. Each passage carries a stable citation id; a passage, the
// warnings of a page and the routing rules of a section are served once per conversation.

export const TOOL_NAMES = ["read_document", "report_gap", "search_knowledge"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const searchInput = z.object({
  query: z.string().min(1),
  section: z.string().optional(),
  k: z.number().int().min(1).max(10).optional(),
});

const readInput = z.object({
  doc_id: z.string().min(1),
  heading: z.string().optional(),
  page: z.number().int().min(1).optional(),
});

const reportInput = z.object({
  question: z.string().min(1),
  searched: z.array(z.string()),
  reason: z.enum(["not_found", "partial", "contradiction", "out_of_scope"]),
});

// Definitions are part of the cached prefix: budget 600 tokens for the three (checked by a test).
export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  search_knowledge: {
    description:
      "Search the company knowledge base (a mirror of its Notion). Returns passages with a citation id [n], the page " +
      "status, warnings and section rules. Query in the language of the base, with the key terms; several calls in " +
      "parallel for a question with several parts. section: a section id of the catalog. k: passages (default 6).",
    inputSchema: searchInput,
  },
  read_document: {
    description:
      "Read a page when passages are not enough. doc_id: a page id from search results. heading: only that part. " +
      "page: the next page of a long document.",
    inputSchema: readInput,
  },
  report_gap: {
    description:
      "Flag a question the base cannot answer, for the weekly update. reason: not_found, partial (only part found), " +
      "contradiction (passages disagree) or out_of_scope. searched: the queries you ran.",
    inputSchema: reportInput,
  },
};

/** Mutable bookkeeping of one question, shared by the tools and the loop. */
export interface TurnContext {
  state: ConversationState;
  knowledge: KnowledgePort;
  limits: AgentLimits;
  /** Tokens of tool results already given for this question (layer L2 total). */
  usedTokens: number;
  searches: SearchTrace[];
  reads: Array<{ page: string; heading: string | null; page_number: number }>;
  gaps: GapSignal[];
  emit(event: AgentEvent): void;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

function remainingBudget(ctx: TurnContext): number {
  return ctx.limits.questionBudget - ctx.usedTokens;
}

const BUDGET_REACHED =
  "Context budget for this question is reached: answer now with the passages already found, and say what is missing.";

function noteCitation(ctx: TurnContext, input: Omit<Citation, "cite">): Citation {
  const { citation, created } = registerCitation(ctx.state, input);
  if (created) ctx.emit({ type: "citation", citation });
  return citation;
}

function statusLine(page: string, status: string, updatedAt: string): string {
  const confirm = status === "to_confirm" ? " (say it is to be confirmed)" : status === "stale" ? " (may be outdated, say so)" : "";
  return `page: ${page} | status: ${status}${confirm} | updated: ${updatedAt.slice(0, 10)}`;
}

function passageContent(text: string): string {
  const cut = text.indexOf("\n\n");
  return cut === -1 ? text : text.slice(cut + 2);
}

export async function runSearch(ctx: TurnContext, raw: unknown): Promise<ToolResult> {
  const parsed = searchInput.safeParse(raw);
  if (!parsed.success) return { text: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  const { query } = parsed.data;
  const sections = ctx.knowledge.sections();
  const section = parsed.data.section && sections.includes(parsed.data.section) ? parsed.data.section : null;
  const sectionNote =
    parsed.data.section && !section ? `\nUnknown section "${parsed.data.section}", searched everywhere. Sections: ${sections.join(", ")}.` : "";

  const budget = Math.min(ctx.limits.searchBudget, remainingBudget(ctx));
  if (budget <= 200) {
    ctx.searches.push({ query, section, results: [] });
    ctx.emit({ type: "step", step: { kind: "search", query, section, hits: 0 } });
    return { text: BUDGET_REACHED, isError: false };
  }

  const queryVector = ctx.knowledge.embedQuery ? await ctx.knowledge.embedQuery(query) : null;
  const result = ctx.knowledge.search(query, {
    k: parsed.data.k ?? ctx.limits.defaultK,
    maxTokens: budget,
    queryVector,
    ...(section ? { section } : {}),
  });
  ctx.searches.push({ query, section, results: result.results.map((r) => ({ page: r.docId, score: r.score })) });
  ctx.emit({ type: "step", step: { kind: "search", query, section, hits: result.results.length } });

  const where = section ? ` in section ${section}` : "";
  if (result.results.length === 0) {
    const text = `No passage found for "${query}"${where}.${sectionNote}`;
    ctx.usedTokens += estimateTokens(text);
    return { text, isError: false };
  }

  const blocks: string[] = [];
  for (const r of result.results) {
    const content = passageContent(r.text);
    const citation = noteCitation(ctx, {
      docId: r.docId,
      title: r.title,
      section: r.section,
      headingPath: r.headingPath,
      text: content,
      url: r.url,
      status: r.status,
      updatedAt: r.updatedAt,
      warnings: r.warnings ?? [],
      chunkIds: [r.chunkId],
    });
    const heading = [r.title, ...r.headingPath].join(" > ");
    if (ctx.state.servedChunks.includes(r.chunkId)) {
      blocks.push(`[${citation.cite}] ${heading} (already provided above)`);
      continue;
    }
    ctx.state.servedChunks.push(r.chunkId);
    const lines = [`[${citation.cite}] ${heading}`, statusLine(r.docId, r.status, r.updatedAt), content];
    if (r.warnings && r.warnings.length > 0 && !ctx.state.warnedDocs.includes(r.docId)) {
      ctx.state.warnedDocs.push(r.docId);
      for (const w of r.warnings) lines.push(`warning: ${w}`);
    }
    blocks.push(lines.join("\n"));
  }

  const rules: string[] = [];
  for (const [sectionId, sectionRules] of Object.entries(result.sectionRules)) {
    if (sectionRules.length === 0 || ctx.state.ruledSections.includes(sectionId)) continue;
    ctx.state.ruledSections.push(sectionId);
    rules.push(`Section rules (${sectionId}):\n${sectionRules.map((rule) => `- ${rule}`).join("\n")}`);
  }

  const weak =
    result.coverage !== null && result.coverage < WEAK_MATCH
      ? " Weak match: most key terms of the query are absent, so unless a passage clearly answers, say it is not documented and call report_gap."
      : "";
  const header = `Results for "${query}"${where} (${result.results.length} passages):${weak}${sectionNote}`;
  const footer = result.truncated ? "\n(Some passages were left out to respect the budget.)" : "";
  const text = [header, ...blocks, ...rules].join("\n\n") + footer;
  ctx.usedTokens += estimateTokens(text);
  return { text, isError: false };
}

export function runRead(ctx: TurnContext, raw: unknown): ToolResult {
  const parsed = readInput.safeParse(raw);
  if (!parsed.success) return { text: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  const docId = ctx.knowledge.resolveDocId(parsed.data.doc_id);
  if (!docId) {
    return { text: `Unknown page "${parsed.data.doc_id}": use a page id from the search results.`, isError: true };
  }
  const budget = Math.min(ctx.limits.readBudget, remainingBudget(ctx));
  if (budget <= 200) return { text: BUDGET_REACHED, isError: false };

  const read = ctx.knowledge.read(docId, {
    maxTokens: budget,
    ...(parsed.data.heading ? { heading: parsed.data.heading } : {}),
    ...(parsed.data.page ? { page: parsed.data.page } : {}),
  });
  if (!read) return { text: `Unknown page "${docId}".`, isError: true };
  ctx.reads.push({ page: docId, heading: parsed.data.heading ?? null, page_number: read.page });
  ctx.emit({ type: "step", step: { kind: "read", docId, title: read.title } });

  const citation = noteCitation(ctx, {
    docId,
    title: read.title,
    section: read.section,
    headingPath: parsed.data.heading && !read.headingNotFound ? [parsed.data.heading] : [],
    text: read.text,
    url: read.url,
    status: read.status,
    updatedAt: read.updatedAt,
    warnings: read.warnings,
    chunkIds: read.chunkIds,
  });
  for (const id of read.chunkIds) if (!ctx.state.servedChunks.includes(id)) ctx.state.servedChunks.push(id);

  const lines = [
    `[${citation.cite}] ${read.title}${read.pages > 1 ? ` (page ${read.page}/${read.pages})` : ""}`,
    statusLine(docId, read.status, read.updatedAt),
  ];
  if (read.headingNotFound) lines.push(`(No heading matches "${parsed.data.heading ?? ""}": showing the page from the start.)`);
  lines.push(read.text);
  if (read.warnings.length > 0 && !ctx.state.warnedDocs.includes(docId)) {
    ctx.state.warnedDocs.push(docId);
    for (const w of read.warnings) lines.push(`warning: ${w}`);
  }
  if (read.page < read.pages) lines.push(`(More: read_document with page ${read.page + 1}.)`);
  const text = lines.join("\n");
  ctx.usedTokens += estimateTokens(text);
  return { text, isError: false };
}

export function runReport(ctx: TurnContext, raw: unknown): ToolResult {
  const parsed = reportInput.safeParse(raw);
  if (!parsed.success) return { text: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  const reason: ReportReason = parsed.data.reason;
  // Keep the real queries and their best scores: they tell "missing page" from "page not found by search".
  const searched = parsed.data.searched.length > 0 ? parsed.data.searched : ctx.searches.map((s) => s.query);
  const topResults = ctx.searches
    .flatMap((s) => s.results)
    .sort((a, b) => b.score - a.score)
    .filter((r, i, all) => all.findIndex((x) => x.page === r.page) === i)
    .slice(0, 5);
  const gap: GapSignal = { question: parsed.data.question, reason, searched, topResults };
  if (!ctx.gaps.some((g) => g.reason === gap.reason)) {
    ctx.gaps.push(gap);
    ctx.emit({ type: "step", step: { kind: "report", reason } });
    ctx.emit({ type: "report", gap });
  }
  return { text: "Flagged for the next weekly update. Tell the user what you searched and that the question is flagged.", isError: false };
}

export async function runTool(ctx: TurnContext, name: string, input: unknown): Promise<ToolResult> {
  switch (name) {
    case "search_knowledge":
      return runSearch(ctx, input);
    case "read_document":
      return runRead(ctx, input);
    case "report_gap":
      return runReport(ctx, input);
    default:
      return { text: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}.`, isError: true };
  }
}
