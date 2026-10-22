// HTTP protocol between the chatbot UI (apps/web) and the server (Netlify Functions or `openbrain serve`).
// Pure types, no imports: the web app imports this file directly.

export type DocStatus = "validated" | "to_confirm" | "stale";
/** "open": passcode mode deployed without a password (no sign-in page, the admin code still guards /admin). */
export type AuthMode = "passcode" | "google" | "netlify" | "none" | "open";
export type ReportReason = "not_found" | "partial" | "contradiction" | "out_of_scope";

// ---------- GET /api/config (public: the login page needs the name and the colors) ----------

export interface ModelOption {
  /** "provider:model" */
  id: string;
  label: string;
}

export interface PublicConfig {
  assistantName: string;
  companyName: string;
  accent: string;
  logoUrl: string | null;
  authMode: AuthMode;
  /** Set when the user is signed in. */
  user: SessionUser | null;
  userChoice: { enabled: boolean; models: ModelOption[]; default: string };
  /** ISO date of the last weekly update, or of the most recent page when unknown. */
  knowledgeUpdatedAt: string | null;
  /** The chat model is the demo model (no LLM): the UI says so. */
  demo: boolean;
  limits: { maxQuestionChars: number; maxTurns: number };
}

export interface SessionUser {
  /** Stable hashed id (never the email unless the instance is in identified mode). */
  id: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
}

// ---------- POST /api/auth/* ----------

export interface LoginRequest {
  code: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

// ---------- POST /api/chat (Server-Sent Events) ----------

export interface ChatRequest {
  /** Omit to start a new conversation. */
  conversationId?: string;
  message: string;
  /** "provider:model", only honored when user choice is enabled and the model is allowed. */
  model?: string;
}

export interface PublicCitation {
  cite: number;
  docId: string;
  title: string;
  section: string;
  headingPath: string[];
  /** The exact passage the answer relies on. */
  text: string;
  /** The Notion page. */
  url: string;
  status: DocStatus;
  updatedAt: string;
  warnings: string[];
}

export type ChatStep =
  | { kind: "search"; query: string; section: string | null; hits: number }
  | { kind: "read"; docId: string; title: string }
  | { kind: "report"; reason: ReportReason };

export interface ChatUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** One SSE message: `event: <type>` + `data: <json>`. A comment line `: ping` is sent every 5 s. */
export type ChatStreamEvent =
  | { type: "meta"; conversationId: string; turnId: string; model: ModelOption }
  | { type: "step"; step: ChatStep }
  | { type: "text"; delta: string }
  | { type: "citation"; citation: PublicCitation }
  | { type: "report"; reason: ReportReason }
  | { type: "usage"; usage: ChatUsage }
  | { type: "error"; code: string; message: string }
  | { type: "done"; turnId: string; reason: "stop" | "deadline" | "length" | "refusal" | "aborted" | "error" };

// ---------- POST /api/feedback ----------

export interface FeedbackRequest {
  conversationId: string;
  turnId: string;
  rating: "up" | "down";
  /** Optional, thumbs down only. */
  comment?: string;
}

export interface FeedbackResponse {
  ok: true;
  /** Set for a thumbs down: the id of the stored report. */
  reportId?: string;
}

// ---------- GET /api/kb, GET /api/kb/page?id= ----------

export interface KbPageSummary {
  id: string;
  title: string;
  status: DocStatus;
  updatedAt: string;
  url: string;
}

export interface KbSection {
  id: string;
  title: string;
  description: string;
  pages: KbPageSummary[];
}

export interface KbIndex {
  sections: KbSection[];
}

export interface KbPage extends KbPageSummary {
  section: string;
  warnings: string[];
  /** Markdown rebuilt from the indexed passages (the mirror of the Notion page). */
  markdown: string;
}

// ---------- Admin ----------

export type ReportType = "no_answer" | "thumbs_down";
export type ReportStatus = "open" | "done";

export interface ReportCitation {
  cite: number;
  page: string;
  url: string;
  heading_path: string;
}

export interface ReportSearch {
  query: string;
  section: string | null;
  results: Array<{ page: string; score: number }>;
}

/** A flagged question. Field names are snake_case: the weekly update reads them as is. */
export interface Report {
  id: string;
  type: ReportType;
  created_at: string;
  status: ReportStatus;
  question: string;
  lang: "fr" | "en" | "other";
  user: string;
  turn_id: string;
  model: { provider: string; model: string; mode: string };
  deploy: { commit: string | null };
  /** no_answer */
  reason?: ReportReason;
  searched?: string[];
  top_results?: Array<{ page: string; score: number }>;
  /** thumbs_down */
  context?: Array<{ role: "user"; text: string }>;
  answer?: string;
  citations?: ReportCitation[];
  searches?: ReportSearch[];
  comment?: string | null;
  done_at?: string;
}

export interface ReportsResponse {
  reports: Report[];
  /** ISO date of the last weekly update, if known. */
  lastWeeklyUpdate: string | null;
}

export interface MarkReportsRequest {
  ids: string[];
  status: ReportStatus;
}

export type ModelRole = "chat";

export interface CatalogEntry {
  /** "provider:model" */
  id: string;
  provider: string;
  model: string;
  name: string;
  tools: boolean;
  contextWindow: number;
  /** USD per million tokens, null when unknown. */
  price: { input: number; output: number; cacheRead: number | null } | null;
  /** Reported by the provider's model list with the current key. */
  available: boolean;
  verified: boolean;
  local: boolean;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  /** Env variables that would enable it (names only, never values). */
  envKeys: string[];
  local: boolean;
  error: string | null;
}

export interface RoleSetting {
  /** "provider:model" */
  model: string;
  effort: "low" | "medium" | "high" | null;
  /** "settings": changed from the admin page (hot); "config": openbrain.config.yaml; "cli": forced by the command line. */
  source: "settings" | "config" | "cli";
  fallbacks: string[];
}

export interface ModelsResponse {
  roles: Record<ModelRole, RoleSetting>;
  providers: ProviderStatus[];
  models: CatalogEntry[];
  userChoice: { enabled: boolean; allowed: string[] };
}

export interface UpdateModelsRequest {
  chat?: { model: string; effort?: "low" | "medium" | "high" | null; fallbacks?: string[] } | null;
  userChoice?: { enabled: boolean; allowed: string[] };
}

export interface ModelTestResult {
  question: string;
  ok: boolean;
  answerPreview: string;
  citations: number;
  flagged: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
}

export interface ModelTestResponse {
  model: string;
  results: ModelTestResult[];
}
