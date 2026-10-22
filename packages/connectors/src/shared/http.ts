import type { FetchLike } from "../notion/client.ts";
import { ReadOnlyViolationError } from "./types.ts";

// Read-only HTTP for the input connectors: native fetch, requests serialized and spaced, retries on
// 429 / 5xx / network errors (Retry-After honored), and a guard that refuses any method other than GET,
// except a form POST to a declared OAuth token endpoint.

export interface RetryOptions {
  /** Attempts per request, first one included (default 4). */
  maxAttempts?: number;
  /** First backoff delay, doubled at each attempt (default 500 ms). */
  baseDelayMs?: number;
  /** A longer wait (a rate limit resetting in an hour) is not slept: the response is returned as is. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Source-specific retry rule (GitHub 403 rate limit...): a delay in ms, or undefined for the default rule. */
  retryDelay?: (response: Response, attempt: number) => number | undefined;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Releases a response body that will not be read. Not awaited on purpose: cancelling one branch of a
 * tee'd body (a cloned response) only settles once the other branch is cancelled too.
 */
export function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either a number of seconds or an HTTP date. Returns milliseconds. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && /^\s*\d+(\.\d+)?\s*$/.test(value)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function defaultDelay(response: Response, attempt: number, baseDelayMs: number, now: number): number | undefined {
  if (!RETRYABLE_STATUS.has(response.status)) return undefined;
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now);
  return retryAfter ?? baseDelayMs * 2 ** (attempt - 1);
}

/** Sends with retries. Returns the last response (possibly an error status): the caller decides. */
export async function withRetry(send: () => Promise<Response>, options: RetryOptions = {}): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      // Network error: retry with backoff.
      lastError = error;
      if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    const delay = options.retryDelay?.(response, attempt) ?? defaultDelay(response, attempt, baseDelayMs, now());
    if (delay === undefined || attempt === maxAttempts || delay > maxDelayMs) return response;
    discardBody(response);
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error("request failed after retries");
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, detail: string) {
    super(`HTTP ${status} on ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.url = url;
  }
}

export interface ReadOnlyHttpOptions extends RetryOptions {
  fetch?: FetchLike;
  /** Minimum delay between two requests (default 0). */
  minIntervalMs?: number;
  /** Headers sent with every request (User-Agent...). */
  headers?: Record<string, string>;
  /** The only URLs that accept a POST: OAuth token exchange endpoints. */
  tokenEndpoints?: readonly string[];
}

function stripQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

export class ReadOnlyHttp {
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly headers: Record<string, string>;
  private readonly tokenEndpoints: Set<string>;
  private readonly retry: RetryOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Number of HTTP requests sent, retries included. */
  requestCount = 0;

  constructor(options: ReadOnlyHttpOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.headers = options.headers ?? {};
    this.tokenEndpoints = new Set((options.tokenEndpoints ?? []).map(stripQuery));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.retry = { ...options, sleep: this.sleep, now: this.now };
  }

  /** GET with retries. Any final status is returned (304, 404...): use getJson / getText to throw on errors. */
  get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.enqueue("GET", url, { headers: { ...this.headers, ...headers } });
  }

  async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.get(url, { Accept: "application/json", ...headers });
    if (!response.ok) throw new HttpStatusError(response.status, url, await errorDetail(response));
    return (await response.json()) as unknown;
  }

  async getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await this.get(url, headers);
    if (!response.ok) throw new HttpStatusError(response.status, url, await errorDetail(response));
    return response.text();
  }

  /** OAuth token exchange: the only POST an input may send, and only to a declared token endpoint. */
  async postTokenForm(url: string, form: Record<string, string>): Promise<unknown> {
    if (!this.tokenEndpoints.has(stripQuery(url))) {
      throw new ReadOnlyViolationError(`refused POST ${url}: inputs are read-only (only token endpoints accept a POST)`);
    }
    const response = await this.enqueue("POST", url, {
      headers: { ...this.headers, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) throw new HttpStatusError(response.status, url, await errorDetail(response));
    return (await response.json()) as unknown;
  }

  private enqueue(method: "GET" | "POST", url: string, init: RequestInit): Promise<Response> {
    if (method !== "GET" && !this.tokenEndpoints.has(stripQuery(url))) {
      return Promise.reject(new ReadOnlyViolationError(`refused ${method} ${url}: inputs are read-only`));
    }
    const run = this.queue.then(() => withRetry(() => this.send(method, url, init), this.retry));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async send(method: "GET" | "POST", url: string, init: RequestInit): Promise<Response> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    this.requestCount++;
    return this.fetchImpl(url, { ...init, method });
  }
}
