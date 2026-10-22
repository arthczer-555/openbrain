import { gunzipSync } from "node:zlib";
import type { HealthReport, ListOptions, SourceDocument, SourceRef } from "@openbrain/core";
import type { FetchLike } from "../notion/client.ts";
import { htmlToMarkdown } from "../shared/html.ts";
import { discardBody, HttpStatusError, ReadOnlyHttp } from "../shared/http.ts";
import { isAfter, toIso } from "../shared/time.ts";
import { errorMessage, SkipItemError, type DocumentsConnector } from "../shared/types.ts";
import { ALLOW_ALL, DISALLOW_ALL, isAllowedByRobots, parseRobots, type RobotsPolicy } from "./robots.ts";
import { parseSitemap, type SitemapEntry } from "./sitemap.ts";

export { WEB_MANIFEST } from "./manifest.ts";
export { isAllowedByRobots, parseRobots, type RobotsPolicy, type RobotsRule } from "./robots.ts";
export { parseSitemap, type ParsedSitemap, type SitemapEntry } from "./sitemap.ts";

// `web` input: public pages from a sitemap (nested indexes and .gz supported) and / or a URL list.
// GET only, robots.txt respected, one request at a time with a polite delay, main content kept as Markdown.

export const WEB_USER_AGENT = "Mozilla/5.0 (compatible; OpenBrain/0.1; read-only knowledge collector)";
/** Product token matched against robots.txt groups. */
export const WEB_ROBOTS_TOKEN = "openbrain";

export interface WebConnectorOptions {
  id?: string;
  sitemaps?: string[];
  urls?: string[];
  /** Path prefixes kept from the sitemaps, for example "/docs/" (default: all). */
  include?: string[];
  /** Path prefixes dropped from the sitemaps. */
  exclude?: string[];
  maxPages?: number;
  /** Delay between two requests (default 1000 ms). */
  delayMs?: number;
  maxPageMb?: number;
  userAgent?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_SITEMAP_FILES = 50;
const MAX_SITEMAP_DEPTH = 3;
const MAX_CRAWL_DELAY_MS = 10_000;

function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function titleFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? decodeURIComponent(last).replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ") : url.host;
}

function pathOf(url: URL): string[] {
  return [url.host, ...url.pathname.split("/").filter(Boolean).slice(0, -1)];
}

/** Sitemap body, gunzipped when served as a raw .gz file (gzip magic bytes). */
async function bodyText(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gzipped ? gunzipSync(bytes, { maxOutputLength: 50 * 1024 * 1024 }) : bytes).toString("utf8");
}

export function createWebConnector(options: WebConnectorOptions): DocumentsConnector {
  const id = options.id ?? "web";
  const delayMs = options.delayMs ?? 1000;
  const maxPages = options.maxPages ?? 200;
  const maxBytes = (options.maxPageMb ?? 5) * 1024 * 1024;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const http = new ReadOnlyHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    sleep,
    now,
    minIntervalMs: delayMs,
    headers: { "User-Agent": options.userAgent ?? WEB_USER_AGENT },
  });
  const robots = new Map<string, Promise<RobotsPolicy>>();
  /** Window start of the last list(): sent as If-Modified-Since by fetch(). */
  let lastSince: string | undefined;

  async function loadRobots(origin: string): Promise<RobotsPolicy> {
    try {
      const response = await http.get(`${origin}/robots.txt`, { Accept: "text/plain" });
      if (response.ok) return parseRobots(await response.text(), WEB_ROBOTS_TOKEN);
      discardBody(response);
      // RFC 9309: unavailable (4xx) means no restriction, unreachable (5xx) means disallow everything.
      return response.status >= 500 ? DISALLOW_ALL : ALLOW_ALL;
    } catch {
      return DISALLOW_ALL;
    }
  }

  function robotsFor(url: URL): Promise<RobotsPolicy> {
    let policy = robots.get(url.origin);
    if (!policy) {
      policy = loadRobots(url.origin);
      robots.set(url.origin, policy);
    }
    return policy;
  }

  function keepSitemapUrl(url: URL, sitemapHost: string): boolean {
    if (url.host !== sitemapHost) return false;
    if (include.length > 0 && !include.some((prefix) => url.pathname.startsWith(prefix))) return false;
    return !exclude.some((prefix) => url.pathname.startsWith(prefix));
  }

  async function readSitemaps(): Promise<SitemapEntry[]> {
    const entries: SitemapEntry[] = [];
    const queue = (options.sitemaps ?? []).map((url) => ({ url, depth: 0, host: new URL(url).host }));
    const seen = new Set<string>();
    while (queue.length > 0 && seen.size < MAX_SITEMAP_FILES) {
      const next = queue.shift();
      if (!next || seen.has(next.url)) continue;
      seen.add(next.url);
      const response = await http.get(next.url, { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" });
      if (!response.ok) {
        discardBody(response);
        throw new HttpStatusError(response.status, next.url, "sitemap not readable");
      }
      const parsed = parseSitemap(await bodyText(response));
      for (const nested of parsed.sitemaps) {
        if (next.depth < MAX_SITEMAP_DEPTH) queue.push({ url: nested, depth: next.depth + 1, host: next.host });
      }
      for (const entry of parsed.urls) {
        const url = normalizeUrl(entry.url);
        if (url && keepSitemapUrl(new URL(url), next.host)) entries.push({ ...entry, url });
      }
    }
    return entries;
  }

  /** Listed URLs first (taken as is), then the filtered sitemap entries, deduplicated. */
  async function candidates(): Promise<SitemapEntry[]> {
    const byUrl = new Map<string, SitemapEntry>();
    for (const raw of options.urls ?? []) {
      const url = normalizeUrl(raw);
      if (url) byUrl.set(url, { url });
    }
    for (const entry of await readSitemaps()) {
      if (!byUrl.has(entry.url)) byUrl.set(entry.url, entry);
    }
    return [...byUrl.values()];
  }

  function toRef(entry: SitemapEntry): SourceRef {
    const url = new URL(entry.url);
    return {
      id: entry.url,
      url: entry.url,
      title: titleFromUrl(url),
      // Without a lastmod the date is unknown: the page counts as changed, fetch() refines it.
      modifiedAt: toIso(entry.lastmod) ?? new Date(now()).toISOString(),
      path: pathOf(url),
    };
  }

  async function* list(opts: ListOptions = {}): AsyncGenerator<SourceRef> {
    lastSince = opts.since;
    let yielded = 0;
    for (const entry of await candidates()) {
      if (yielded >= maxPages) return;
      if (entry.lastmod && !isAfter(toIso(entry.lastmod), opts.since)) continue;
      yielded++;
      yield toRef(entry);
    }
  }

  async function fetchDocument(ref: SourceRef): Promise<SourceDocument> {
    const target = new URL(ref.url ?? ref.id);
    const policy = await robotsFor(target);
    if (!isAllowedByRobots(policy, `${target.pathname}${target.search}`)) {
      throw new SkipItemError(policy.mode === "disallow-all" ? "robots.txt unreachable (server error): crawling not allowed" : "disallowed by robots.txt");
    }
    const crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, (policy.crawlDelaySec ?? 0) * 1000);
    if (crawlDelayMs > delayMs) await sleep(crawlDelayMs - delayMs);
    const headers: Record<string, string> = { Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.8" };
    if (lastSince) headers["If-Modified-Since"] = new Date(lastSince).toUTCString();
    const response = await http.get(target.href, headers);
    if (response.status === 304) throw new SkipItemError(`not modified since ${lastSince ?? "the last collection"}`);
    if (!response.ok) {
      discardBody(response);
      throw new HttpStatusError(response.status, target.href, "page not readable");
    }
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(length) && length > maxBytes) {
      discardBody(response);
      throw new SkipItemError(`page too large: ${(length / 1024 / 1024).toFixed(1)} MB`);
    }
    const contentType = (response.headers.get("content-type") ?? "text/html").toLowerCase();
    const text = await response.text();
    if (text.length > maxBytes) throw new SkipItemError(`page too large: ${(text.length / 1024 / 1024).toFixed(1)} MB`);
    const lastModified = toIso(response.headers.get("last-modified"));
    const finalUrl = response.url || target.href;
    let markdown: string;
    let title = ref.title;
    if (contentType.includes("html")) {
      const page = htmlToMarkdown(text, { baseUrl: finalUrl });
      markdown = page.markdown;
      if (page.title) title = page.title;
    } else if (contentType.startsWith("text/plain") || contentType.includes("markdown")) {
      markdown = text.trim();
    } else {
      throw new SkipItemError(`unsupported content type ${contentType.split(";")[0] ?? contentType}`);
    }
    return {
      ...ref,
      title,
      modifiedAt: lastModified ?? ref.modifiedAt,
      markdown,
      mimeType: contentType.split(";")[0]?.trim() ?? "text/html",
      metadata: { status: response.status, final_url: finalUrl, modified_at_known: Boolean(lastModified) },
    };
  }

  async function test(): Promise<HealthReport> {
    const scopes = [`GET only, robots.txt respected (user agent token "${WEB_ROBOTS_TOKEN}")`];
    try {
      const entries = await candidates();
      const hosts = [...new Set(entries.map((e) => new URL(e.url).host))];
      const blocked: string[] = [];
      const sample: SourceRef[] = [];
      for (const entry of entries) {
        const url = new URL(entry.url);
        if (!isAllowedByRobots(await robotsFor(url), `${url.pathname}${url.search}`)) {
          blocked.push(entry.url);
          continue;
        }
        if (sample.length < 3) sample.push(toRef(entry));
      }
      const sitemapCount = (options.sitemaps ?? []).length;
      const report: HealthReport = {
        ok: entries.length > 0 && sample.length > 0,
        identity: `web: ${hosts.join(", ") || "no host"} (${entries.length} URL${entries.length === 1 ? "" : "s"} from ${sitemapCount} sitemap${sitemapCount === 1 ? "" : "s"} and ${(options.urls ?? []).length} listed, ${blocked.length} disallowed by robots.txt, max_pages ${maxPages})`,
        scopes,
        writeScopesDetected: false,
        sample,
      };
      if (entries.length === 0) report.error = "no URL found: check the sitemap, the include prefixes or the urls list";
      else if (sample.length === 0) report.error = "every URL is disallowed by robots.txt";
      return report;
    } catch (error) {
      return { ok: false, scopes, writeScopesDetected: false, error: errorMessage(error) };
    }
  }

  return { id, kind: "documents", test, list, fetch: fetchDocument };
}
