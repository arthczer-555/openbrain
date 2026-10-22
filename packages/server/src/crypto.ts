// Web Crypto only (no node: imports): this file is shared with the Netlify edge function, which runs on Deno.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomId(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time comparison of two byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toBuffer(utf8(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBuffer(utf8(message))));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(utf8(text))));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable pseudonymous id of a user: reports can count "5 different people" without knowing who. */
export async function hashUser(secret: string, identity: string): Promise<string> {
  const mac = await hmacSha256(secret, `user:${identity.trim().toLowerCase()}`);
  return `hash:${base64url(mac).slice(0, 16)}`;
}

const PBKDF2_ITERATIONS = 210_000;

async function pbkdf2(code: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toBuffer(utf8(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: toBuffer(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Hash of an access code, stored in ACCESS_CODE_HASH / ADMIN_CODE_HASH: `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashCode(code: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(code, salt, iterations);
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyCode(code: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltText, hashText] = stored.trim().split("$");
  if (scheme !== "pbkdf2" || !iterationsText || !saltText || !hashText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 10_000) return false;
  const expected = fromBase64url(hashText);
  const actual = await pbkdf2(code, fromBase64url(saltText), iterations);
  return timingSafeEqual(actual, expected);
}
