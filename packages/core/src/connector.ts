// Connector contract shared by every source.
// Three natures of source: documents are mirrored, streams are distilled, live tools are queried (v2).

export type ConnectorKind = "documents" | "stream" | "live";

export interface SourceRef {
  /** Stable id on the source side (page id, file id, channel:ts...). */
  id: string;
  /** Clickable link to the original, used in citations. */
  url?: string;
  title: string;
  /** ISO timestamp, drives incremental sync. */
  modifiedAt: string;
  /** Source-side hierarchy, used to propose sections. */
  path?: string[];
}

export interface SourceDocument extends SourceRef {
  /** Normalized content. */
  markdown: string;
  mimeType?: string;
  metadata: Record<string, string | number | boolean>;
}

export type StreamEventKind =
  | "message"
  | "thread"
  | "deal_change"
  | "note"
  | "meeting"
  | "commit"
  | "pull_request"
  | "ticket";

export interface StreamAttachment {
  name: string;
  url?: string;
  mimeType?: string;
}

export interface StreamEvent {
  ref: SourceRef;
  kind: StreamEventKind;
  occurredAt: string;
  /** Never written to the knowledge base. */
  author?: string;
  text: string;
  attachments?: StreamAttachment[];
}

export interface HealthReport {
  ok: boolean;
  /** For example "bot @openbrain in workspace X". */
  identity?: string;
  /** Scopes actually granted to the token. */
  scopes: string[];
  /** True when the token could write: the setup warns about it. */
  writeScopesDetected: boolean;
  /** A few visible items, to check the scope. */
  sample?: SourceRef[];
  /** Problems that do not block the connector but must be fixed (for example access beyond the scope). */
  warnings?: string[];
  error?: string;
}

export interface ListOptions {
  since?: string;
  cursor?: string;
}

export interface ChangesOptions {
  since: string;
  until: string;
}

/** Live tools are planned for v2: kept as an opaque shape for now. */
export interface LiveTool {
  name: string;
  description: string;
}

export interface Connector {
  /** "notion", "gdrive", "mcp:linear"... */
  id: string;
  kind: ConnectorKind;
  test(): Promise<HealthReport>;
  // documents
  list?(opts: ListOptions): AsyncIterable<SourceRef>;
  fetch?(ref: SourceRef): Promise<SourceDocument>;
  // stream
  changes?(opts: ChangesOptions): AsyncIterable<StreamEvent>;
  // live (v2)
  tools?(): LiveTool[];
}
