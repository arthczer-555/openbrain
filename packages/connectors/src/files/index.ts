import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { HealthReport, ListOptions, SourceDocument, SourceRef } from "@openbrain/core";
import { csvToMarkdown, DEFAULT_MAX_TABLE_ROWS } from "../shared/csv.ts";
import { globFilter } from "../shared/glob.ts";
import { htmlToMarkdown } from "../shared/html.ts";
import { docxToMarkdown, pptxToMarkdown } from "../shared/office.ts";
import { isAfter } from "../shared/time.ts";
import { errorMessage, SkipItemError, type DocumentsConnector } from "../shared/types.ts";

export { FILES_MANIFEST } from "./manifest.ts";

// `files` input: local folders (an export of Confluence, Google Drive or SharePoint, a docs folder...).
// Read-only by construction: it only reads the configured paths, and refuses a ref outside of them.

export interface FilesConnectorOptions {
  id?: string;
  /** Folder that relative paths resolve against: the instance root. */
  baseDir: string;
  paths: string[];
  /** Globs on the path relative to each configured folder (default: every supported format). */
  include?: string[];
  exclude?: string[];
  maxFileMb?: number;
  /** Data rows kept from a CSV (default 200). */
  maxCsvRows?: number;
}

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const SUPPORTED_FILE_EXTENSIONS: readonly string[] = Object.keys(MIME_TYPES);

/** Listed so they show up as skipped (with a reason) instead of disappearing silently. */
const UNSUPPORTED_REASONS: Record<string, string> = {
  ".pdf": "PDF is not supported in v0.1: export it to .docx or Markdown, or paste its text into Notion",
  ".doc": "legacy .doc format: save it as .docx",
  ".ppt": "legacy .ppt format: save it as .pptx",
  ".xls": "spreadsheet: export the sheet to .csv",
  ".xlsx": "spreadsheet: export the sheet to .csv",
  ".odt": "OpenDocument text: save it as .docx",
  ".odp": "OpenDocument slides: save them as .pptx",
  ".rtf": "RTF: save it as .docx or .txt",
  ".pages": "Apple Pages: export it to .docx",
  ".key": "Apple Keynote: export it to .pptx",
  ".numbers": "Apple Numbers: export the sheet to .csv",
};

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".openbrain"]);
const DEFAULT_EXCLUDE = ["**/.DS_Store", "**/~$*", "**/.~lock.*"];

interface FoundFile {
  absolute: string;
  /** Path relative to the configured folder, "/" separated: what the globs see. */
  relative: string;
  stats: Stats;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase();
}

function isListed(file: string): boolean {
  const ext = extensionOf(file);
  return ext in MIME_TYPES || ext in UNSUPPORTED_REASONS;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function* walk(dir: string, prefix: string): AsyncGenerator<{ absolute: string; relative: string }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(absolute, relative);
    } else if (entry.isFile()) {
      yield { absolute, relative };
    }
  }
}

export function createFilesConnector(options: FilesConnectorOptions): DocumentsConnector {
  const id = options.id ?? "files";
  const baseDir = path.resolve(options.baseDir);
  const roots = options.paths.map((p) => ({ given: p, absolute: path.resolve(baseDir, p) }));
  const include = options.include ?? [];
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const maxBytes = (options.maxFileMb ?? 20) * 1024 * 1024;
  const maxCsvRows = options.maxCsvRows ?? DEFAULT_MAX_TABLE_ROWS;

  function refId(absolute: string): string {
    return isInside(absolute, baseDir) ? toPosix(path.relative(baseDir, absolute)) : toPosix(absolute);
  }

  function toRef(file: FoundFile): SourceRef {
    const id = refId(file.absolute);
    const segments = id.split("/");
    return {
      id,
      title: path.basename(file.absolute, path.extname(file.absolute)),
      modifiedAt: file.stats.mtime.toISOString(),
      path: segments.slice(0, -1),
    };
  }

  async function* files(): AsyncGenerator<FoundFile> {
    for (const root of roots) {
      let rootStats: Stats;
      try {
        rootStats = await stat(root.absolute);
      } catch {
        continue;
      }
      if (rootStats.isFile()) {
        const name = path.basename(root.absolute);
        if (isListed(name) && globFilter(name, include, exclude)) yield { absolute: root.absolute, relative: name, stats: rootStats };
        continue;
      }
      for await (const entry of walk(root.absolute, "")) {
        if (!isListed(entry.relative) || !globFilter(entry.relative, include, exclude)) continue;
        try {
          yield { ...entry, stats: await stat(entry.absolute) };
        } catch {
          // Deleted between the listing and the stat: ignore.
        }
      }
    }
  }

  async function* list(opts: ListOptions = {}): AsyncGenerator<SourceRef> {
    for await (const file of files()) {
      if (isAfter(file.stats.mtime.toISOString(), opts.since)) yield toRef(file);
    }
  }

  async function convert(absolute: string, ext: string, buffer: Buffer): Promise<{ markdown: string; metadata: Record<string, string | number | boolean> }> {
    const text = (): string => buffer.toString("utf8").replace(/^\ufeff/, "");
    switch (ext) {
      case ".md":
      case ".markdown":
      case ".txt":
        return { markdown: text().trim(), metadata: {} };
      case ".csv":
      case ".tsv": {
        const table = csvToMarkdown(text(), maxCsvRows);
        return { markdown: table.markdown, metadata: { rows: table.rows, truncated: table.truncated } };
      }
      case ".html":
      case ".htm": {
        const page = htmlToMarkdown(text());
        return { markdown: page.markdown, metadata: page.title ? { html_title: page.title } : {} };
      }
      case ".json": {
        let body = text();
        try {
          body = JSON.stringify(JSON.parse(body) as unknown, null, 2);
        } catch {
          // Not valid JSON: kept as is inside the fence.
        }
        return { markdown: `\`\`\`json\n${body.trim()}\n\`\`\``, metadata: {} };
      }
      case ".docx":
        return { markdown: docxToMarkdown(buffer), metadata: {} };
      case ".pptx":
        return { markdown: pptxToMarkdown(buffer), metadata: {} };
      default:
        throw new SkipItemError(`unsupported format ${ext || "(no extension)"}: ${path.basename(absolute)}`);
    }
  }

  async function fetchDocument(ref: SourceRef): Promise<SourceDocument> {
    const absolute = path.resolve(baseDir, ref.id);
    if (!roots.some((root) => isInside(absolute, root.absolute))) {
      throw new Error(`refused to read ${ref.id}: outside of the configured paths`);
    }
    const ext = extensionOf(absolute);
    const unsupported = UNSUPPORTED_REASONS[ext];
    if (unsupported) throw new SkipItemError(unsupported);
    const stats = await stat(absolute);
    if (stats.size > maxBytes) {
      throw new SkipItemError(`too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB > ${maxBytes / 1024 / 1024} MB (max_file_mb)`);
    }
    let converted: { markdown: string; metadata: Record<string, string | number | boolean> };
    try {
      converted = await convert(absolute, ext, await readFile(absolute));
    } catch (error) {
      if (error instanceof SkipItemError) throw error;
      throw new SkipItemError(`could not read ${ext} file: ${errorMessage(error)}`);
    }
    return {
      ...ref,
      modifiedAt: stats.mtime.toISOString(),
      markdown: converted.markdown,
      mimeType: MIME_TYPES[ext] ?? "application/octet-stream",
      metadata: { extension: ext, size_bytes: stats.size, ...converted.metadata },
    };
  }

  async function test(): Promise<HealthReport> {
    const missing: string[] = [];
    const counts: string[] = [];
    const sample: SourceRef[] = [];
    for (const root of roots) {
      try {
        await stat(root.absolute);
      } catch {
        missing.push(root.given);
        continue;
      }
      let count = 0;
      const single = createFilesConnector({ ...options, paths: [root.given] });
      for await (const ref of single.list({})) {
        count++;
        if (sample.length < 3) sample.push(ref);
      }
      counts.push(`${root.given} (${count} file${count === 1 ? "" : "s"})`);
    }
    const report: HealthReport = {
      ok: roots.length > 0 && missing.length === 0,
      identity: `local folders: ${counts.join(", ") || "none"}`,
      scopes: roots.map((root) => `read ${root.given}`),
      writeScopesDetected: false,
      sample,
    };
    if (roots.length === 0) report.error = "no path configured (inputs.files.paths)";
    else if (missing.length > 0) report.error = `not found: ${missing.join(", ")}`;
    return report;
  }

  return { id, kind: "documents", test, list, fetch: fetchDocument };
}
