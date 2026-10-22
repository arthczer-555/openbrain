import type { NotionBlock, NotionDatabase, NotionList, NotionPage, NotionUser } from "./types.ts";
import { asRecord, asString, normalizeId } from "./types.ts";

// Read-only Notion REST client with native fetch: requests are serialized and spaced (~3 per second, the
// average rate limit of the API), 429 honors Retry-After, 5xx and network errors are retried with backoff.

export const NOTION_API_URL = "https://api.notion.com/v1";
/** Pinned API version: pages, blocks and database queries are stable under it. */
export const NOTION_VERSION = "2022-06-28";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotionClientOptions {
  token: string;
  version?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Minimum delay between two requests (default 340 ms, about 3 requests per second). */
  minIntervalMs?: number;
  /** Attempts per request, first one included (default 5). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class NotionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`Notion API ${status} ${code}: ${message}`);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }

  /** The object does not exist or is not shared with the integration. */
  get notFound(): boolean {
    return this.status === 404 || this.code === "object_not_found";
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NotionClient {
  private readonly token: string;
  private readonly version: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Number of HTTP requests sent, retries included. */
  requestCount = 0;

  constructor(options: NotionClientOptions) {
    if (!options.token) throw new Error("Notion token missing (set NOTION_TOKEN)");
    this.token = options.token;
    this.version = options.version ?? NOTION_VERSION;
    this.baseUrl = (options.baseUrl ?? NOTION_API_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = options.minIntervalMs ?? 340;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  /** Serialized and rate-limited request. Returns the parsed JSON body. */
  request(method: "GET" | "POST", apiPath: string, body?: unknown): Promise<unknown> {
    const run = this.queue.then(() => this.send(method, apiPath, body));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitTurn(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private async send(method: "GET" | "POST", apiPath: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${apiPath}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.waitTurn();
      this.requestCount++;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": this.version,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // Network error: retry with backoff.
        lastError = error;
        if (attempt < this.maxAttempts) await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) return (await response.json()) as unknown;

      const payload = asRecord(await response.json().catch(() => ({})));
      const error = new NotionApiError(
        response.status,
        asString(payload.code) || "unknown_error",
        asString(payload.message) || response.statusText,
      );
      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) throw error;
      lastError = error;
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
      const delay =
        response.status === 429 && Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await this.sleep(delay);
    }
    throw lastError instanceof Error ? lastError : new Error(`Notion request failed: ${method} ${apiPath}`);
  }

  async me(): Promise<NotionUser> {
    return (await this.request("GET", "/users/me")) as NotionUser;
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return (await this.request("GET", `/pages/${normalizeId(pageId)}`)) as NotionPage;
  }

  /** All children of a block or page, following pagination. */
  async listChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const page = (await this.request(
        "GET",
        `/blocks/${normalizeId(blockId)}/children?${query.toString()}`,
      )) as NotionList<NotionBlock>;
      blocks.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return blocks;
  }

  async getBlock(blockId: string): Promise<NotionBlock> {
    return (await this.request("GET", `/blocks/${normalizeId(blockId)}`)) as NotionBlock;
  }

  /**
   * Every page and database shared with the integration (read-only POST /search), capped at `max`.
   * Used to check that the integration sees nothing outside the root page tree.
   */
  async search(max = 1000): Promise<{ results: Array<NotionPage | NotionDatabase>; truncated: boolean }> {
    const results: Array<NotionPage | NotionDatabase> = [];
    let cursor: string | null = null;
    let hasMore = false;
    do {
      const body: Record<string, unknown> = { page_size: Math.min(100, max - results.length) };
      if (cursor) body.start_cursor = cursor;
      const page = (await this.request("POST", "/search", body)) as NotionList<NotionPage | NotionDatabase>;
      results.push(...page.results);
      hasMore = page.has_more;
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && results.length < max);
    return { results, truncated: hasMore && results.length >= max };
  }

  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return (await this.request("GET", `/databases/${normalizeId(databaseId)}`)) as NotionDatabase;
  }

  /** Rows of a database, capped at `max`. `truncated` tells whether rows were left out. */
  async queryDatabase(databaseId: string, max = 200): Promise<{ rows: NotionPage[]; truncated: boolean }> {
    const rows: NotionPage[] = [];
    let cursor: string | null = null;
    let hasMore = false;
    do {
      const body: Record<string, unknown> = { page_size: Math.min(100, max - rows.length) };
      if (cursor) body.start_cursor = cursor;
      const page = (await this.request(
        "POST",
        `/databases/${normalizeId(databaseId)}/query`,
        body,
      )) as NotionList<NotionPage>;
      rows.push(...page.results);
      hasMore = page.has_more;
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && rows.length < max);
    return { rows: rows.slice(0, max), truncated: hasMore || rows.length > max };
  }
}
