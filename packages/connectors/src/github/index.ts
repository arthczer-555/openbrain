import path from "node:path";
import type { ChangesOptions, HealthReport, ListOptions, SourceDocument, SourceRef, StreamEvent } from "@openbrain/core";
import type { FetchLike } from "../notion/client.ts";
import { asArray, asRecord, asString } from "../notion/types.ts";
import { csvToMarkdown } from "../shared/csv.ts";
import { matchAnyGlob } from "../shared/glob.ts";
import { htmlToMarkdown } from "../shared/html.ts";
import { discardBody, HttpStatusError, ReadOnlyHttp } from "../shared/http.ts";
import { inWindow, toIso } from "../shared/time.ts";
import { errorMessage, SkipItemError, type DocumentsConnector, type StreamConnector } from "../shared/types.ts";

export { GITHUB_MANIFEST } from "./manifest.ts";

// `github` input, REST v3 with a read-only token (GITHUB_TOKEN):
//   documents  files of the default branch matching docs_globs (git trees API, raw content)
//   stream     commits of the default branch (first line + files changed) and merged pull requests
// Authors are kept in StreamEvent.author for triage only: they are never written to the knowledge base.

export const GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_DOCS_GLOBS = ["README.md", "docs/**/*.md"];

export interface GithubConnectorOptions {
  id?: string;
  token: string;
  /** "owner/repo" */
  repos: string[];
  docsGlobs?: string[];
  /** Stream of commits (default true). */
  commits?: boolean;
  /** Merged pull requests in the stream (default true). */
  pullRequests?: boolean;
  /** Branch to read (default: each repository's default branch). */
  branch?: string;
  /** GitHub Enterprise: https://<host>/api/v3 */
  apiUrl?: string;
  maxFileMb?: number;
  /** Commits read per repository and window (default 300). */
  maxCommits?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type GithubConnector = DocumentsConnector & StreamConnector;

interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  permissions: Record<string, boolean>;
}

interface TreeBlob {
  path: string;
  size: number;
}

interface CommitDetail {
  files: string[];
  additions: number;
  deletions: number;
  date: string;
}

/** Classic token scopes that cannot write; any other scope (repo, workflow, write:*, admin:*) can. */
const READ_ONLY_CLASSIC_SCOPES = new Set([
  "read:org",
  "read:user",
  "user:email",
  "read:packages",
  "read:discussion",
  "read:project",
  "read:gpg_key",
  "read:public_key",
  "read:repo_hook",
  "read:enterprise",
  "read:audit_log",
  "read:ssh_signing_key",
]);

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"]);

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

function encodePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function isBot(user: unknown): boolean {
  const record = asRecord(user);
  return asString(record.type) === "Bot" || asString(record.login).endsWith("[bot]");
}

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

function excerpt(body: string, max = 1200): string {
  const clean = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}...` : clean;
}

export function createGithubConnector(options: GithubConnectorOptions): GithubConnector {
  if (!options.token) throw new Error("GitHub token missing (set GITHUB_TOKEN)");
  const id = options.id ?? "github";
  const apiUrl = (options.apiUrl ?? GITHUB_API_URL).replace(/\/$/, "");
  const docsGlobs = options.docsGlobs ?? DEFAULT_DOCS_GLOBS;
  const maxBytes = (options.maxFileMb ?? 5) * 1024 * 1024;
  const maxCommits = options.maxCommits ?? 300;
  const now = options.now ?? (() => Date.now());
  const http = new ReadOnlyHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now,
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openbrain-connector",
    },
    retryDelay: (response) => {
      // Primary rate limit: 403 / 429 with x-ratelimit-remaining 0, wait until x-ratelimit-reset.
      if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
        return Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) + 1000 : undefined;
      }
      // Secondary rate limit: 403 with Retry-After.
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
      return response.status === 403 && Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
    },
  });
  const repoCache = new Map<string, Promise<RepoInfo>>();
  const commitCache = new Map<string, Promise<CommitDetail>>();
  const sizes = new Map<string, number>();

  async function getJson(apiPath: string, accept?: string): Promise<{ body: unknown; next?: string }> {
    const url = apiPath.startsWith("http") ? apiPath : `${apiUrl}${apiPath}`;
    const response = await http.get(url, accept ? { Accept: accept } : {});
    if (!response.ok) {
      const detail = asString(asRecord(await response.json().catch(() => ({}))).message);
      throw new HttpStatusError(response.status, url, detail);
    }
    const next = nextLink(response.headers.get("link"));
    return { body: (await response.json()) as unknown, ...(next ? { next } : {}) };
  }

  /** Follows Link rel="next" while `keepGoing` accepts the items. */
  async function* paginate(apiPath: string, limit: number): AsyncGenerator<unknown> {
    let url: string | undefined = apiPath;
    let count = 0;
    while (url) {
      const page: { body: unknown; next?: string } = await getJson(url);
      for (const item of asArray(page.body)) {
        if (count++ >= limit) return;
        yield item;
      }
      url = page.next;
    }
  }

  function repoInfo(repo: string): Promise<RepoInfo> {
    let info = repoCache.get(repo);
    if (!info) {
      info = getJson(`/repos/${repo}`).then(({ body }) => {
        const record = asRecord(body);
        const permissions = asRecord(record.permissions);
        return {
          fullName: asString(record.full_name) || repo,
          defaultBranch: asString(record.default_branch) || "main",
          htmlUrl: asString(record.html_url) || `https://github.com/${repo}`,
          permissions: Object.fromEntries(Object.entries(permissions).map(([k, v]) => [k, v === true])),
        };
      });
      repoCache.set(repo, info);
    }
    return info;
  }

  async function branchOf(repo: string): Promise<string> {
    return options.branch ?? (await repoInfo(repo)).defaultBranch;
  }

  async function docBlobs(repo: string, branch: string): Promise<TreeBlob[]> {
    const { body } = await getJson(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    return asArray(asRecord(body).tree)
      .map(asRecord)
      .filter((entry) => asString(entry.type) === "blob" && matchAnyGlob(asString(entry.path), docsGlobs))
      .map((entry) => ({ path: asString(entry.path), size: typeof entry.size === "number" ? entry.size : 0 }));
  }

  function commitDetail(repo: string, sha: string): Promise<CommitDetail> {
    const key = `${repo}@${sha}`;
    let detail = commitCache.get(key);
    if (!detail) {
      detail = getJson(`/repos/${repo}/commits/${sha}`).then(({ body }) => {
        const record = asRecord(body);
        const stats = asRecord(record.stats);
        const files = asArray(record.files)
          .map(asRecord)
          .flatMap((f) => [asString(f.filename), asString(f.previous_filename)].filter(Boolean));
        const date = asString(asRecord(asRecord(record.commit).committer).date);
        return {
          files,
          additions: typeof stats.additions === "number" ? stats.additions : 0,
          deletions: typeof stats.deletions === "number" ? stats.deletions : 0,
          date,
        };
      });
      commitCache.set(key, detail);
    }
    return detail;
  }

  function commitsPath(repo: string, branch: string, since: string, until: string): string {
    const query = new URLSearchParams({ sha: branch, since, until, per_page: "100" });
    return `/repos/${repo}/commits?${query.toString()}`;
  }

  /** Paths changed on the branch since `since`, with the date of their latest change. */
  async function changedPaths(repo: string, branch: string, since: string): Promise<Map<string, string>> {
    const changed = new Map<string, string>();
    const until = new Date(now()).toISOString();
    for await (const item of paginate(commitsPath(repo, branch, since, until), maxCommits)) {
      const commit = asRecord(item);
      if (asArray(commit.parents).length > 1) continue;
      const detail = await commitDetail(repo, asString(commit.sha));
      for (const file of detail.files) {
        const previous = changed.get(file);
        if (!previous || detail.date > previous) changed.set(file, detail.date);
      }
    }
    return changed;
  }

  async function lastCommitDate(repo: string, branch: string, filePath: string): Promise<string | undefined> {
    const query = new URLSearchParams({ sha: branch, path: filePath, per_page: "1" });
    const { body } = await getJson(`/repos/${repo}/commits?${query.toString()}`);
    const first = asRecord(asArray(body)[0]);
    return toIso(asString(asRecord(asRecord(first.commit).committer).date));
  }

  function docRef(repo: string, info: RepoInfo, branch: string, blob: TreeBlob, modifiedAt: string): SourceRef {
    const refId = `${repo}:${blob.path}`;
    sizes.set(refId, blob.size);
    return {
      id: refId,
      url: `${info.htmlUrl}/blob/${encodeURIComponent(branch)}/${encodePath(blob.path)}`,
      title: blob.path,
      modifiedAt,
      path: [repo, ...blob.path.split("/").slice(0, -1)],
    };
  }

  async function* list(opts: ListOptions = {}): AsyncGenerator<SourceRef> {
    for (const repo of options.repos) {
      const info = await repoInfo(repo);
      const branch = await branchOf(repo);
      const blobs = await docBlobs(repo, branch);
      if (opts.since) {
        const changed = await changedPaths(repo, branch, opts.since);
        for (const blob of blobs) {
          const date = changed.get(blob.path);
          if (date) yield docRef(repo, info, branch, blob, toIso(date) ?? date);
        }
      } else {
        for (const blob of blobs) {
          const date = (await lastCommitDate(repo, branch, blob.path)) ?? new Date(now()).toISOString();
          yield docRef(repo, info, branch, blob, date);
        }
      }
    }
  }

  async function fetchDocument(ref: SourceRef): Promise<SourceDocument> {
    const colon = ref.id.indexOf(":");
    const repo = ref.id.slice(0, colon);
    const filePath = ref.id.slice(colon + 1);
    if (colon <= 0 || !options.repos.includes(repo)) throw new Error(`refused to read ${ref.id}: not a configured repository`);
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && ext !== ".html" && ext !== ".htm" && ext !== ".csv") {
      throw new SkipItemError(`unsupported format ${ext || "(no extension)"} (docs_globs should target text files)`);
    }
    const size = sizes.get(ref.id) ?? 0;
    if (size > maxBytes) throw new SkipItemError(`too large: ${(size / 1024 / 1024).toFixed(1)} MB`);
    const branch = await branchOf(repo);
    const url = `${apiUrl}/repos/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`;
    const response = await http.get(url, { Accept: "application/vnd.github.raw+json" });
    if (!response.ok) throw new HttpStatusError(response.status, url, "file not readable");
    const text = (await response.text()).replace(/^\ufeff/, "");
    let markdown = text.trim();
    if (ext === ".html" || ext === ".htm") markdown = htmlToMarkdown(text).markdown;
    if (ext === ".csv") markdown = csvToMarkdown(text).markdown;
    const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    return {
      ...ref,
      title: heading ? `${heading} (${filePath})` : ref.title,
      markdown,
      mimeType: ext === ".csv" ? "text/csv" : ext.startsWith(".htm") ? "text/html" : "text/markdown",
      metadata: { repo, branch, file_path: filePath, size_bytes: size },
    };
  }

  async function* commitEvents(repo: string, branch: string, window: ChangesOptions): AsyncGenerator<StreamEvent> {
    for await (const item of paginate(commitsPath(repo, branch, window.since, window.until), maxCommits)) {
      const commit = asRecord(item);
      if (asArray(commit.parents).length > 1 || isBot(commit.author)) continue;
      const sha = asString(commit.sha);
      const inner = asRecord(commit.commit);
      const title = firstLine(asString(inner.message));
      const date = toIso(asString(asRecord(inner.committer).date)) ?? window.until;
      if (!title || !inWindow(date, window.since, window.until)) continue;
      const detail = await commitDetail(repo, sha);
      const files = detail.files.length;
      const author = asString(asRecord(commit.author).login) || asString(asRecord(inner.author).name);
      yield {
        ref: { id: `${repo}@${sha.slice(0, 7)}`, url: asString(commit.html_url) || undefined, title, modifiedAt: date, path: [repo, branch] },
        kind: "commit",
        occurredAt: date,
        ...(author ? { author } : {}),
        text: `${title}\n\n${files} file${files === 1 ? "" : "s"} changed (+${detail.additions} -${detail.deletions}) on ${repo}@${branch}`,
      };
    }
  }

  async function* pullRequestEvents(repo: string, branch: string, window: ChangesOptions): AsyncGenerator<StreamEvent> {
    const query = new URLSearchParams({ state: "closed", base: branch, sort: "updated", direction: "desc", per_page: "100" });
    for await (const item of paginate(`/repos/${repo}/pulls?${query.toString()}`, maxCommits)) {
      const pr = asRecord(item);
      // Sorted by last update, newest first: past the window start, nothing older can have been merged in it.
      const updated = toIso(asString(pr.updated_at));
      if (updated && Date.parse(updated) <= Date.parse(window.since)) return;
      const mergedAt = toIso(asString(pr.merged_at));
      if (!mergedAt || !inWindow(mergedAt, window.since, window.until) || isBot(pr.user)) continue;
      const number = typeof pr.number === "number" ? pr.number : 0;
      const title = asString(pr.title).trim();
      const labels = asArray(pr.labels)
        .map((l) => asString(asRecord(l).name))
        .filter(Boolean);
      const body = excerpt(asString(pr.body));
      const author = asString(asRecord(pr.user).login);
      yield {
        ref: { id: `${repo}#${number}`, url: asString(pr.html_url) || undefined, title: `PR #${number}: ${title}`, modifiedAt: mergedAt, path: [repo, branch] },
        kind: "pull_request",
        occurredAt: mergedAt,
        ...(author ? { author } : {}),
        text: [`Merged pull request #${number} into ${branch}: ${title}`, body, labels.length > 0 ? `Labels: ${labels.join(", ")}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
  }

  async function* changes(window: ChangesOptions): AsyncGenerator<StreamEvent> {
    for (const repo of options.repos) {
      const branch = await branchOf(repo);
      if (options.commits !== false) yield* commitEvents(repo, branch, window);
      if (options.pullRequests !== false) yield* pullRequestEvents(repo, branch, window);
    }
  }

  async function test(): Promise<HealthReport> {
    const scopes: string[] = [];
    let writeScopesDetected = false;
    let identity: string;
    try {
      const response = await http.get(`${apiUrl}/user`);
      if (response.status === 401) {
        return { ok: false, scopes, writeScopesDetected, error: "token rejected (401): check GITHUB_TOKEN" };
      }
      const classic = response.headers.get("x-oauth-scopes");
      if (classic !== null) {
        const granted = classic.split(",").map((s) => s.trim()).filter(Boolean);
        scopes.push(...granted.map((s) => `classic: ${s}`));
        if (granted.some((s) => !READ_ONLY_CLASSIC_SCOPES.has(s))) writeScopesDetected = true;
      } else {
        scopes.push("fine-grained token (its permissions cannot be read back: use Contents and Metadata read-only)");
      }
      identity = response.ok ? `user ${asString(asRecord(await response.json()).login)}` : `token without user access (HTTP ${response.status})`;
      if (!response.ok) discardBody(response);
      const problems: string[] = [];
      for (const repo of options.repos) {
        try {
          const info = await repoInfo(repo);
          const p = info.permissions;
          const level = p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "push" : p.triage ? "triage" : "pull";
          scopes.push(`${info.fullName}: ${level}`);
          if (p.admin || p.maintain || p.push) writeScopesDetected = true;
        } catch (error) {
          problems.push(`${repo}: ${errorMessage(error)}`);
        }
      }
      const sample: SourceRef[] = [];
      if (problems.length === 0) {
        for await (const ref of list({})) {
          sample.push(ref);
          if (sample.length >= 3) break;
        }
      }
      const report: HealthReport = { ok: problems.length === 0 && options.repos.length > 0, identity, scopes, writeScopesDetected, sample };
      if (options.repos.length === 0) report.error = "no repository configured (inputs.github.repos)";
      else if (problems.length > 0) report.error = `not accessible: ${problems.join("; ")}`;
      return report;
    } catch (error) {
      return { ok: false, scopes, writeScopesDetected, error: errorMessage(error) };
    }
  }

  return { id, kind: "documents", test, list, fetch: fetchDocument, changes };
}
