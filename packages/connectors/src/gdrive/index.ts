import type { HealthReport, ListOptions, SourceDocument, SourceRef } from "@openbrain/core";
import type { FetchLike } from "../notion/client.ts";
import { asArray, asRecord, asString } from "../notion/types.ts";
import { csvToMarkdown, DEFAULT_MAX_TABLE_ROWS } from "../shared/csv.ts";
import { htmlToMarkdown } from "../shared/html.ts";
import { HttpStatusError, ReadOnlyHttp } from "../shared/http.ts";
import { docxToMarkdown, pptxToMarkdown } from "../shared/office.ts";
import { toIso } from "../shared/time.ts";
import { errorMessage, SkipItemError, type DocumentsConnector } from "../shared/types.ts";
import { DRIVE_READONLY_SCOPE, GOOGLE_TOKEN_URL, GoogleTokenSource, type ServiceAccountKey } from "./auth.ts";

export { GDRIVE_MANIFEST } from "./manifest.ts";
export {
  DRIVE_READONLY_SCOPE,
  GOOGLE_TOKEN_URL,
  GoogleTokenSource,
  loadServiceAccount,
  signServiceAccountJwt,
  type ServiceAccountKey,
} from "./auth.ts";

// `gdrive` input: the configured folders, recursively, with a service account token limited to
// drive.readonly. Docs are exported as Markdown (plain text as a fallback), Sheets as CSV (first tab, capped)
// turned into a table, Slides as plain text; uploaded .docx / .pptx / text files are downloaded and converted.

export const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";

export type GdriveMimeCategory = "doc" | "sheet" | "slides" | "text" | "pdf";

export const DEFAULT_GDRIVE_MIME: readonly GdriveMimeCategory[] = ["doc", "sheet", "slides", "text"];

const FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const TEXT_MIME = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/html"]);

export interface GdriveConnectorOptions {
  id?: string;
  serviceAccount: ServiceAccountKey;
  folders: string[];
  mime?: readonly GdriveMimeCategory[];
  maxFileMb?: number;
  /** Data rows kept from a Sheet (default 200). */
  maxSheetRows?: number;
  apiUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number;
  webViewLink: string;
}

export function mimeCategory(mimeType: string): GdriveMimeCategory | undefined {
  if (mimeType === GOOGLE_DOC || mimeType === DOCX) return "doc";
  if (mimeType === GOOGLE_SHEET || mimeType === "text/csv") return "sheet";
  if (mimeType === GOOGLE_SLIDES || mimeType === PPTX) return "slides";
  if (TEXT_MIME.has(mimeType)) return "text";
  if (mimeType === "application/pdf") return "pdf";
  return undefined;
}

function toDriveFile(value: unknown): DriveFile {
  const record = asRecord(value);
  const size = Number.parseInt(asString(record.size), 10);
  return {
    id: asString(record.id),
    name: asString(record.name),
    mimeType: asString(record.mimeType),
    modifiedTime: asString(record.modifiedTime),
    size: Number.isFinite(size) ? size : 0,
    webViewLink: asString(record.webViewLink),
  };
}

/** Drive query literals are single-quoted with backslash escapes. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

export function createGdriveConnector(options: GdriveConnectorOptions): DocumentsConnector {
  const id = options.id ?? "gdrive";
  const apiUrl = (options.apiUrl ?? DRIVE_API_URL).replace(/\/$/, "");
  const categories = new Set(options.mime ?? DEFAULT_GDRIVE_MIME);
  const maxBytes = (options.maxFileMb ?? 20) * 1024 * 1024;
  const maxSheetRows = options.maxSheetRows ?? DEFAULT_MAX_TABLE_ROWS;
  const now = options.now ?? (() => Date.now());
  const http = new ReadOnlyHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now,
    tokenEndpoints: [GOOGLE_TOKEN_URL],
  });
  const tokens = new GoogleTokenSource(http, options.serviceAccount, DRIVE_READONLY_SCOPE, now);
  const known = new Map<string, DriveFile>();

  async function get(url: string, accept = "application/json"): Promise<Response> {
    return http.get(url, { Authorization: `Bearer ${await tokens.token()}`, Accept: accept });
  }

  async function getJson(url: string): Promise<Record<string, unknown>> {
    const response = await get(url);
    if (!response.ok) throw new HttpStatusError(response.status, url, await driveError(response));
    return asRecord((await response.json()) as unknown);
  }

  async function driveError(response: Response): Promise<string> {
    const body = asRecord(await response.json().catch(() => ({})));
    return asString(asRecord(body.error).message);
  }

  async function folderMeta(folderId: string): Promise<{ name: string; canEdit: boolean }> {
    const query = new URLSearchParams({ fields: "id,name,mimeType,capabilities(canEdit)", supportsAllDrives: "true" });
    const body = await getJson(`${apiUrl}/files/${encodeURIComponent(folderId)}?${query.toString()}`);
    return { name: asString(body.name) || folderId, canEdit: asRecord(body.capabilities).canEdit === true };
  }

  async function* children(folderId: string, since: string | undefined): AsyncGenerator<DriveFile> {
    let q = `${quote(folderId)} in parents and trashed = false`;
    // Folders are always listed: their modifiedTime does not change when a nested file does.
    if (since) q += ` and (modifiedTime > ${quote(since)} or mimeType = ${quote(FOLDER)})`;
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "100",
        orderBy: "folder,name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const body = await getJson(`${apiUrl}/files?${query.toString()}`);
      for (const file of asArray(body.files)) yield toDriveFile(file);
      pageToken = asString(body.nextPageToken);
    } while (pageToken);
  }

  function toRef(file: DriveFile, folderPath: string[]): SourceRef {
    known.set(file.id, file);
    return {
      id: file.id,
      url: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
      title: file.name,
      modifiedAt: toIso(file.modifiedTime) ?? new Date(now()).toISOString(),
      path: folderPath,
    };
  }

  async function* list(opts: ListOptions = {}): AsyncGenerator<SourceRef> {
    const visited = new Set<string>();
    for (const folderId of options.folders) {
      const meta = await folderMeta(folderId);
      const queue: Array<{ id: string; path: string[] }> = [{ id: folderId, path: [meta.name] }];
      while (queue.length > 0) {
        const folder = queue.shift();
        if (!folder || visited.has(folder.id)) continue;
        visited.add(folder.id);
        for await (const file of children(folder.id, opts.since)) {
          if (file.mimeType === FOLDER) {
            queue.push({ id: file.id, path: [...folder.path, file.name] });
            continue;
          }
          const category = mimeCategory(file.mimeType);
          if (category && categories.has(category)) yield toRef(file, folder.path);
        }
      }
    }
  }

  async function fileMeta(fileId: string): Promise<DriveFile> {
    const cached = known.get(fileId);
    if (cached) return cached;
    const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    return toDriveFile(await getJson(`${apiUrl}/files/${encodeURIComponent(fileId)}?${query.toString()}`));
  }

  /** Export of a native Google file; tries each format in turn (text/markdown is recent, text/plain always works). */
  async function exportAs(file: DriveFile, formats: string[]): Promise<string> {
    let lastError: HttpStatusError | undefined;
    for (const format of formats) {
      const url = `${apiUrl}/files/${encodeURIComponent(file.id)}/export?${new URLSearchParams({ mimeType: format }).toString()}`;
      const response = await get(url, format);
      if (response.ok) return (await response.text()).replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
      const detail = await driveError(response);
      if (/exportSizeLimitExceeded|too large/i.test(detail)) throw new SkipItemError("too large for the Drive export API (10 MB)");
      lastError = new HttpStatusError(response.status, url, detail);
    }
    throw lastError ?? new Error(`export failed for ${file.name}`);
  }

  async function download(file: DriveFile): Promise<Buffer> {
    if (file.size > maxBytes) {
      throw new SkipItemError(`too large: ${(file.size / 1024 / 1024).toFixed(1)} MB > ${maxBytes / 1024 / 1024} MB (max_file_mb)`);
    }
    const url = `${apiUrl}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    const response = await get(url, "*/*");
    if (!response.ok) throw new HttpStatusError(response.status, url, await driveError(response));
    return Buffer.from(await response.arrayBuffer());
  }

  async function convert(file: DriveFile): Promise<{ markdown: string; metadata: Record<string, string | number | boolean> }> {
    switch (file.mimeType) {
      case GOOGLE_DOC:
        return { markdown: (await exportAs(file, ["text/markdown", "text/plain"])).trim(), metadata: {} };
      case GOOGLE_SHEET: {
        const table = csvToMarkdown(await exportAs(file, ["text/csv"]), maxSheetRows);
        return { markdown: table.markdown, metadata: { rows: table.rows, truncated: table.truncated, first_tab_only: true } };
      }
      case GOOGLE_SLIDES:
        return { markdown: (await exportAs(file, ["text/plain"])).trim(), metadata: {} };
      case DOCX:
        return { markdown: docxToMarkdown(await download(file)), metadata: {} };
      case PPTX:
        return { markdown: pptxToMarkdown(await download(file)), metadata: {} };
      case "text/csv": {
        const table = csvToMarkdown((await download(file)).toString("utf8"), maxSheetRows);
        return { markdown: table.markdown, metadata: { rows: table.rows, truncated: table.truncated } };
      }
      case "text/html":
        return { markdown: htmlToMarkdown((await download(file)).toString("utf8")).markdown, metadata: {} };
      case "application/pdf":
        throw new SkipItemError("PDF is not supported in v0.1: convert it to a Google Doc in Drive (Open with > Google Docs)");
      default:
        if (TEXT_MIME.has(file.mimeType)) return { markdown: (await download(file)).toString("utf8").trim(), metadata: {} };
        throw new SkipItemError(`unsupported type ${file.mimeType}`);
    }
  }

  async function fetchDocument(ref: SourceRef): Promise<SourceDocument> {
    const file = await fileMeta(ref.id);
    const converted = await convert(file);
    return {
      ...ref,
      title: file.name || ref.title,
      modifiedAt: toIso(file.modifiedTime) ?? ref.modifiedAt,
      markdown: converted.markdown,
      mimeType: file.mimeType,
      metadata: { drive_mime_type: file.mimeType, ...converted.metadata },
    };
  }

  async function test(): Promise<HealthReport> {
    const scopes = [DRIVE_READONLY_SCOPE];
    const identity = `service account ${options.serviceAccount.client_email}`;
    try {
      await tokens.token();
    } catch (error) {
      return { ok: false, identity, scopes, writeScopesDetected: false, error: `token exchange failed: ${errorMessage(error)}` };
    }
    let writeScopesDetected = false;
    const problems: string[] = [];
    for (const folderId of options.folders) {
      try {
        const meta = await folderMeta(folderId);
        scopes.push(`folder "${meta.name}": ${meta.canEdit ? "editor (Viewer is enough)" : "viewer"}`);
        // The token is read-only, but an editor share lets the key write with another scope.
        if (meta.canEdit) writeScopesDetected = true;
      } catch (error) {
        problems.push(`${folderId}: ${errorMessage(error)}`);
      }
    }
    const sample: SourceRef[] = [];
    if (problems.length === 0) {
      try {
        for await (const ref of list({})) {
          sample.push(ref);
          if (sample.length >= 3) break;
        }
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
    const report: HealthReport = { ok: problems.length === 0 && options.folders.length > 0, identity, scopes, writeScopesDetected, sample };
    if (options.folders.length === 0) report.error = "no folder configured (inputs.gdrive.folders)";
    else if (problems.length > 0) report.error = `not accessible (share the folder with ${options.serviceAccount.client_email}): ${problems.join("; ")}`;
    return report;
  }

  return { id, kind: "documents", test, list, fetch: fetchDocument };
}
