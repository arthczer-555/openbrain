import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { estimateTokens, type SourceDocument, type StreamEvent } from "@openbrain/core";
import { slugify } from "../notion/sync.ts";
import { detectSensitive, type SensitiveFinding } from "./sensitive.ts";
import { daysAgo, isAfter, toIso } from "./time.ts";
import { errorMessage, hasDocuments, hasStream, isSkip, type InputConnector, type SkippedItem } from "./types.ts";

// Collection of the inputs for the weekly update and the initialization,
// without any LLM: documents changed in the window and stream events of the window are written as Markdown
// files with a provenance header under .openbrain/<...>/inputs/<connector>/, plus a manifest.json with counts,
// skipped items, estimated tokens and sensitive findings (kinds, counts, lines: never the values).
// Nothing is ever written outside .openbrain/, and stream files never carry an author.

export const OPENBRAIN_DIR = ".openbrain";
export const SYNC_STATE_FILE = "state/sync.json";
export const DEFAULT_WINDOW_DAYS = 7;
const MAX_ERRORS = 50;

export interface CollectWindow {
  since: string;
  until: string;
  /** Where `since` comes from: "--since", "state/sync.json last_weekly" or "default: 7 days". */
  sinceSource: string;
}

/** --since wins, then state/sync.json `last_weekly`, then 7 days before `until`. */
export async function resolveCollectWindow(options: { root: string; since?: string; until?: string; now?: Date }): Promise<CollectWindow> {
  const now = options.now ?? new Date();
  const until = options.until ? toIso(options.until) : now.toISOString();
  if (!until) throw new Error(`--until is not a date: ${options.until ?? ""}`);
  if (options.since) {
    const since = toIso(options.since);
    if (!since) throw new Error(`--since is not a date: ${options.since}`);
    return { since, until, sinceSource: "--since" };
  }
  try {
    const state = JSON.parse(await readFile(path.join(options.root, SYNC_STATE_FILE), "utf8")) as Record<string, unknown>;
    const last = toIso(state.last_weekly);
    if (last) return { since: last, until, sinceSource: `${SYNC_STATE_FILE} last_weekly` };
  } catch {
    // No state yet: first weekly update.
  }
  return { since: daysAgo(new Date(until), DEFAULT_WINDOW_DAYS), until, sinceSource: `default: ${DEFAULT_WINDOW_DAYS} days` };
}

/** Output folder, absolute; refuses anything outside <root>/.openbrain/. */
export function resolveOutDir(root: string, out: string | undefined, now: Date = new Date()): string {
  const base = path.resolve(root, OPENBRAIN_DIR);
  const target = path.resolve(root, out ?? path.join(OPENBRAIN_DIR, "weekly", now.toISOString().slice(0, 10)));
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`--out must be a folder inside ${OPENBRAIN_DIR}/ (got ${out ?? target})`);
  }
  return target;
}

export interface CollectedFile {
  /** Relative to the output folder, "/" separated. */
  path: string;
  kind: "document" | "events";
  ref_id?: string;
  title: string;
  url?: string;
  modified_at?: string;
  events?: number;
  tokens: number;
  sensitive: SensitiveFinding[];
}

export interface ConnectorCollectReport {
  id: string;
  dir: string;
  status: "ok" | "partial" | "error";
  window: { since: string; until: string; full: boolean };
  documents: number;
  events: number;
  skipped: SkippedItem[];
  errors: string[];
  files: CollectedFile[];
  tokens: number;
}

export interface CollectManifest {
  version: 1;
  generated_at: string;
  dry_run: boolean;
  window: { since: string; until: string; since_source: string; full: boolean };
  connectors: ConnectorCollectReport[];
  totals: {
    documents: number;
    events: number;
    files: number;
    skipped: number;
    errors: number;
    tokens: number;
    files_with_sensitive_data: number;
    sensitive: Record<string, number>;
  };
}

export interface CollectInput {
  id: string;
  /** Folder name under inputs/. */
  dir: string;
  create(): Promise<InputConnector>;
}

export interface CollectOptions {
  root: string;
  inputs: CollectInput[];
  window: CollectWindow;
  /** Absolute output folder (see resolveOutDir); files go to <outDir>/inputs/<connector>/. */
  outDir: string;
  /** Documents: ignore `since` and collect everything (initialization). */
  full?: boolean;
  dryRun?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

function frontmatter(data: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
  return `---\n${stringifyYaml(clean).trimEnd()}\n---\n`;
}

export function renderDocumentFile(connectorId: string, doc: SourceDocument): string {
  const header = frontmatter({
    connector: connectorId,
    ref: doc.id,
    title: doc.title,
    url: doc.url,
    modified_at: doc.modifiedAt,
    path: doc.path?.join(" / "),
    mime_type: doc.mimeType,
    metadata: Object.keys(doc.metadata).length > 0 ? doc.metadata : undefined,
  });
  const body = doc.markdown.trim();
  const heading = /^#\s/.test(body) ? "" : `# ${doc.title}\n\n`;
  return `${header}\n${heading}${body}\n`;
}

/** One file per day of events. The author is deliberately left out. */
export function renderEventsFile(connectorId: string, day: string, events: StreamEvent[]): string {
  const header = frontmatter({ connector: connectorId, kind: "stream", date: day, events: events.length });
  const sections = events.map((event) => {
    const lines = [
      `## ${event.ref.title.replace(/\s+/g, " ").trim() || event.ref.id}`,
      "",
      `- ref: ${event.ref.id}`,
      `- kind: ${event.kind}`,
      `- occurred_at: ${event.occurredAt}`,
      ...(event.ref.url ? [`- url: ${event.ref.url}`] : []),
      ...(event.attachments && event.attachments.length > 0 ? [`- attachments: ${event.attachments.map((a) => a.name).join(", ")}`] : []),
      "",
      event.text.trim(),
    ];
    return lines.join("\n");
  });
  return `${header}\n${sections.join("\n\n")}\n`;
}

function uniquePath(used: Set<string>, wanted: string): string {
  let candidate = wanted;
  for (let n = 2; used.has(candidate); n++) candidate = wanted.replace(/\.md$/, `-${n}.md`);
  used.add(candidate);
  return candidate;
}

function documentPath(dir: string, doc: SourceDocument, used: Set<string>): string {
  const folders = (doc.path ?? []).slice(0, 4).map(slugify);
  return uniquePath(used, ["inputs", dir, ...folders, `${slugify(doc.title)}.md`].join("/"));
}

class ConnectorRun {
  readonly report: ConnectorCollectReport;
  private readonly outDir: string;
  private readonly dryRun: boolean;
  private readonly used = new Set<string>();

  constructor(input: CollectInput, window: CollectWindow, full: boolean, outDir: string, dryRun: boolean) {
    this.outDir = outDir;
    this.dryRun = dryRun;
    this.report = {
      id: input.id,
      dir: input.dir,
      status: "ok",
      window: { since: window.since, until: window.until, full },
      documents: 0,
      events: 0,
      skipped: [],
      errors: [],
      files: [],
      tokens: 0,
    };
  }

  error(message: string): void {
    if (this.report.errors.length < MAX_ERRORS) this.report.errors.push(message);
    this.report.status = "partial";
  }

  async write(relative: string, content: string, file: Omit<CollectedFile, "path" | "tokens" | "sensitive">): Promise<void> {
    const tokens = estimateTokens(content);
    this.report.tokens += tokens;
    if (this.dryRun) return;
    const absolute = path.join(this.outDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    this.report.files.push({ path: relative, tokens, sensitive: detectSensitive(content), ...file });
  }

  async collectDocuments(connector: InputConnector & Required<Pick<InputConnector, "list" | "fetch">>, since: string | undefined): Promise<void> {
    for await (const ref of connector.list(since ? { since } : {})) {
      if (this.dryRun) {
        this.report.documents++;
        continue;
      }
      let doc: SourceDocument;
      try {
        doc = await connector.fetch(ref);
      } catch (error) {
        if (isSkip(error)) this.report.skipped.push({ id: ref.id, title: ref.title, reason: error.reason });
        else this.error(`${ref.id}: ${errorMessage(error)}`);
        continue;
      }
      if (since && !isAfter(doc.modifiedAt, since)) {
        this.report.skipped.push({ id: ref.id, title: doc.title, reason: `not modified since ${since}` });
        continue;
      }
      if (!doc.markdown.trim()) {
        this.report.skipped.push({ id: ref.id, title: doc.title, reason: "empty after conversion" });
        continue;
      }
      this.report.documents++;
      await this.write(documentPath(this.report.dir, doc, this.used), renderDocumentFile(this.report.id, doc), {
        kind: "document",
        ref_id: doc.id,
        title: doc.title,
        ...(doc.url ? { url: doc.url } : {}),
        modified_at: doc.modifiedAt,
      });
    }
  }

  async collectEvents(connector: InputConnector & Required<Pick<InputConnector, "changes">>, window: CollectWindow): Promise<void> {
    const byDay = new Map<string, StreamEvent[]>();
    try {
      for await (const event of connector.changes({ since: window.since, until: window.until })) {
        if (!event.text.trim()) {
          this.report.skipped.push({ id: event.ref.id, title: event.ref.title, reason: "empty event" });
          continue;
        }
        this.report.events++;
        const day = (toIso(event.occurredAt) ?? window.until).slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), event]);
      }
    } finally {
      // Events gathered before an error are still written.
      for (const [day, events] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
        await this.write(`inputs/${this.report.dir}/events-${day}.md`, renderEventsFile(this.report.id, day, events), {
          kind: "events",
          title: `${this.report.id} events on ${day}`,
          events: events.length,
        });
      }
    }
  }
}

function totalsOf(connectors: ConnectorCollectReport[]): CollectManifest["totals"] {
  const sensitive: Record<string, number> = {};
  let filesWithSensitive = 0;
  for (const file of connectors.flatMap((c) => c.files)) {
    if (file.sensitive.length > 0) filesWithSensitive++;
    for (const finding of file.sensitive) sensitive[finding.kind] = (sensitive[finding.kind] ?? 0) + finding.count;
  }
  const sum = (pick: (c: ConnectorCollectReport) => number): number => connectors.reduce((total, c) => total + pick(c), 0);
  return {
    documents: sum((c) => c.documents),
    events: sum((c) => c.events),
    files: sum((c) => c.files.length),
    skipped: sum((c) => c.skipped.length),
    errors: sum((c) => c.errors.length),
    tokens: sum((c) => c.tokens),
    files_with_sensitive_data: filesWithSensitive,
    sensitive,
  };
}

async function previousReports(manifestFile: string): Promise<ConnectorCollectReport[]> {
  try {
    const previous = JSON.parse(await readFile(manifestFile, "utf8")) as Partial<CollectManifest>;
    return Array.isArray(previous.connectors) ? previous.connectors : [];
  } catch {
    return [];
  }
}

export async function collectInputs(options: CollectOptions): Promise<CollectManifest> {
  const root = path.resolve(options.root);
  const outDir = resolveOutDir(root, options.outDir);
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const full = options.full === true;
  const progress = options.onProgress ?? (() => undefined);
  const reports: ConnectorCollectReport[] = [];

  for (const input of options.inputs) {
    const run = new ConnectorRun(input, options.window, full, outDir, dryRun);
    progress(`${input.id}: collecting...`);
    let connector: InputConnector | undefined;
    try {
      connector = await input.create();
      if (!dryRun) await rm(path.join(outDir, "inputs", input.dir), { recursive: true, force: true });
      if (hasDocuments(connector)) {
        try {
          await run.collectDocuments(connector, full ? undefined : options.window.since);
        } catch (error) {
          run.error(`documents: ${errorMessage(error)}`);
        }
      }
      if (hasStream(connector)) {
        try {
          await run.collectEvents(connector, options.window);
        } catch (error) {
          run.error(`stream: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      run.error(errorMessage(error));
      run.report.status = "error";
    } finally {
      await connector?.close?.().catch(() => undefined);
    }
    if (run.report.status === "partial" && run.report.documents + run.report.events === 0 && run.report.files.length === 0) {
      run.report.status = "error";
    }
    reports.push(run.report);
    progress(`${input.id}: ${run.report.documents} documents, ${run.report.events} events, ${run.report.skipped.length} skipped, ${run.report.errors.length} errors`);
  }

  const manifestFile = path.join(outDir, "inputs", "manifest.json");
  const collected = new Set(reports.map((r) => r.id));
  const merged = dryRun ? reports : [...(await previousReports(manifestFile)).filter((r) => !collected.has(r.id)), ...reports];
  const manifest: CollectManifest = {
    version: 1,
    generated_at: now().toISOString(),
    dry_run: dryRun,
    window: { since: options.window.since, until: options.window.until, since_source: options.window.sinceSource, full },
    connectors: merged,
    totals: totalsOf(merged),
  };
  if (!dryRun) {
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return manifest;
}
