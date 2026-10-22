import type {
  ChangesOptions,
  Connector,
  ConnectorKind,
  ListOptions,
  SourceDocument,
  SourceRef,
  StreamEvent,
} from "@openbrain/core";

// Types shared by the input connectors (files, web, github, gdrive, mcp). Inputs are read-only by design:
// the only non-GET request any of them may send is an OAuth token exchange.

export type InputTransport = "local" | "http" | "rest" | "mcp";

export interface ManifestEnvVar {
  name: string;
  required: boolean;
  description: string;
}

/** Static description of a connector: what it reads, with which credentials, under which limits. */
export interface ConnectorManifest {
  id: string;
  name: string;
  kinds: readonly ConnectorKind[];
  transport: InputTransport;
  env: readonly ManifestEnvVar[];
  /** Minimal scopes or permissions to grant, all read-only. */
  scopes: readonly string[];
  defaultScope: string;
  rateLimit: string;
  /** Setup guide, relative to packages/connectors/src. */
  setup: string;
}

/** An input connector. `close()` releases a connection (MCP) when the collection is done. */
export interface InputConnector extends Connector {
  close?(): Promise<void>;
}

export interface DocumentsConnector extends InputConnector {
  list(opts: ListOptions): AsyncIterable<SourceRef>;
  fetch(ref: SourceRef): Promise<SourceDocument>;
}

export interface StreamConnector extends InputConnector {
  changes(opts: ChangesOptions): AsyncIterable<StreamEvent>;
}

export interface SkippedItem {
  id: string;
  title: string;
  reason: string;
}

/** Thrown by `fetch()` for an item that is listed but deliberately not collected (format, size, robots). */
export class SkipItemError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "SkipItemError";
    this.reason = reason;
  }
}

export function isSkip(error: unknown): error is SkipItemError {
  return error instanceof SkipItemError;
}

/** Thrown before sending a request that could modify data on the source side. */
export class ReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolationError";
  }
}

export function hasDocuments(connector: InputConnector): connector is DocumentsConnector {
  return typeof connector.list === "function" && typeof connector.fetch === "function";
}

export function hasStream(connector: InputConnector): connector is StreamConnector {
  return typeof connector.changes === "function";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
