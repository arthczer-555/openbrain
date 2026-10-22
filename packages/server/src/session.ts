import { base64url, fromBase64url, fromUtf8, hmacSha256, timingSafeEqual, utf8 } from "./crypto.ts";

// Signed session cookie: payload.signature, HMAC-SHA256 with SESSION_SECRET,
// HttpOnly, Secure, SameSite=Lax, 30 days. Web Crypto only: the edge auth guard verifies it too.

export const SESSION_COOKIE = "ob_session";
export const SESSION_DAYS = 30;

export interface Session {
  /** Pseudonymous user id ("hash:..."). */
  sub: string;
  email: string | null;
  name: string | null;
  admin: boolean;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = base64url(utf8(JSON.stringify(session)));
  const signature = base64url(await hmacSha256(secret, payload));
  return `${payload}.${signature}`;
}

export async function verifySession(token: string | null | undefined, secret: string, nowMs = Date.now()): Promise<Session | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmacSha256(secret, payload);
    given = fromBase64url(signature);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(fromUtf8(fromBase64url(payload))) as Partial<Session>;
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number" || parsed.exp * 1000 < nowMs) return null;
    return {
      sub: parsed.sub,
      email: typeof parsed.email === "string" ? parsed.email : null,
      name: typeof parsed.name === "string" ? parsed.name : null,
      admin: parsed.admin === true,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}
