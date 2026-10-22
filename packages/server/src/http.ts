import type { ApiError } from "./protocol.ts";

// Small helpers over the Web Request / Response API (Netlify Functions v2 and the local Node adapter).

export interface RequestContext {
  /** Client IP, for the login limiter (hashed before storage). */
  ip?: string | undefined;
  /** Keeps the function alive for background work after the response (Netlify `context.waitUntil`). */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

export function apiError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status, headers);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function readJson<T>(request: Request, maxBytes = 64_000): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "request body too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "bad_json", "the request body must be JSON");
  }
}

export function isSecure(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...NO_STORE, ...headers } });
}

/** Same-origin check for state-changing requests sent by browsers (CSRF defense on top of SameSite=Lax). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
