import type { ModelMessage, ModelRef, NormalizedUsage } from "@openbrain/llm";

// What the agent produces. Kept serializable: the conversation state is stored for
// 24 hours between turns, and a turn record is what a thumbs down copies into the reports store.

export type DocStatus = "validated" | "to_confirm" | "stale";

export interface Citation {
  /** Stable id within the conversation: the model writes [cite], the UI turns it into a link. */
  cite: number;
  docId: string;
  title: string;
  section: string;
  headingPath: string[];
  /** The exact passage the model read (without the "Title > heading" prefix). */
  text: string;
  /** Notion page. */
  url: string;
  status: DocStatus;
  updatedAt: string;
  warnings: string[];
  /** Passage ids behind this citation (one for a search hit, several for a read page). */
  chunkIds: string[];
}

export interface SearchTrace {
  query: string;
  section: string | null;
  results: Array<{ page: string; score: number }>;
}

export type ReportReason = "not_found" | "partial" | "contradiction" | "out_of_scope";

/** A "no answer" signal raised by the model through report_gap. */
export interface GapSignal {
  question: string;
  reason: ReportReason;
  searched: string[];
  topResults: Array<{ page: string; score: number }>;
}

export type AgentStep =
  | { kind: "search"; query: string; section: string | null; hits: number }
  | { kind: "read"; docId: string; title: string }
  | { kind: "report"; reason: ReportReason };

export type DoneReason = "stop" | "deadline" | "length" | "refusal" | "aborted" | "error";

export type AgentEvent =
  | { type: "step"; step: AgentStep }
  | { type: "text"; delta: string }
  | { type: "citation"; citation: Citation }
  | { type: "report"; gap: GapSignal }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "done"; reason: DoneReason };

export interface TurnRecord {
  turnId: string;
  conversationId: string;
  createdAt: string;
  question: string;
  /** Up to two previous user messages, truncated: enough to understand "and in the internal tool?". */
  context: Array<{ role: "user"; text: string }>;
  answer: string;
  lang: "fr" | "en" | "other";
  citations: Array<{ cite: number; page: string; url: string; heading_path: string }>;
  searches: SearchTrace[];
  reads: Array<{ page: string; heading: string | null; page_number: number }>;
  gaps: GapSignal[];
  model: ModelRef & { mode: AgentMode };
  usage: NormalizedUsage;
  rounds: number;
  done: DoneReason;
  latencyMs: number;
}

export type AgentMode = "agent" | "retrieval_first";

export interface ConversationState {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Provider-level history, append-only: past turns are never rewritten (preserved thinking, cache). */
  messages: ModelMessage[];
  citations: Citation[];
  /** Passages already given to the model: served again only as their citation id. */
  servedChunks: string[];
  /** Pages whose warnings were already given (warnings travel once per page and conversation). */
  warnedDocs: string[];
  /** Sections whose routing rules were already given. */
  ruledSections: string[];
  /** One line per past turn, for the context of a report. */
  questions: string[];
  turnCount: number;
}

export interface AgentLimits {
  /** Tool rounds per question; the next call goes out without tools. */
  maxToolRounds: number;
  /** Tokens of tool results per question (layer L2 total). */
  questionBudget: number;
  /** Tokens per search_knowledge call (layer L2). */
  searchBudget: number;
  /** Tokens per read_document page (layer L3). */
  readBudget: number;
  /** Passages per search (default 6, max 10). */
  defaultK: number;
  /** Turns per conversation before the UI proposes a new one. */
  maxTurns: number;
  /** Characters per question. */
  maxQuestionChars: number;
  /** Output tokens per model call. */
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolRounds: 4,
  questionBudget: 10_000,
  searchBudget: 4_000,
  readBudget: 3_000,
  defaultK: 6,
  maxTurns: 12,
  maxQuestionChars: 2_000,
  maxOutputTokens: 4_000,
};
