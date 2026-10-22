import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { asRecord, asString } from "../notion/types.ts";
import type { ReadOnlyHttp } from "../shared/http.ts";

// Google service account auth without a dependency: a JWT signed with RS256 (node:crypto) is exchanged at the
// OAuth token endpoint for an access token limited to drive.readonly. That POST is the only non-GET request.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
}

/** GDRIVE_SA_JSON holds either the JSON key itself or a path to the key file. */
export function loadServiceAccount(value: string, baseDir: string = process.cwd()): ServiceAccountKey {
  const trimmed = value.trim();
  let raw: string;
  if (trimmed.startsWith("{")) {
    raw = trimmed;
  } else {
    try {
      raw = readFileSync(path.resolve(baseDir, trimmed), "utf8");
    } catch {
      throw new Error("GDRIVE_SA_JSON: the key file cannot be read (give a path to the JSON key or the JSON itself)");
    }
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(raw) as unknown);
  } catch {
    throw new Error("GDRIVE_SA_JSON: not valid JSON");
  }
  const key: ServiceAccountKey = { client_email: asString(parsed.client_email), private_key: asString(parsed.private_key) };
  if (!key.client_email || !key.private_key.includes("PRIVATE KEY")) {
    throw new Error("GDRIVE_SA_JSON: not a service account key (client_email and private_key are required)");
  }
  const keyId = asString(parsed.private_key_id);
  const projectId = asString(parsed.project_id);
  if (keyId) key.private_key_id = keyId;
  if (projectId) key.project_id = projectId;
  return key;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** RS256-signed assertion for the JWT bearer grant (RFC 7523), valid one hour. */
export function signServiceAccountJwt(key: ServiceAccountKey, scope: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = { iss: key.client_email, scope, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

/** Caches the access token until a minute before it expires. */
export class GoogleTokenSource {
  private readonly http: ReadOnlyHttp;
  private readonly key: ServiceAccountKey;
  private readonly scope: string;
  private readonly now: () => number;
  private cached?: { token: string; expiresAt: number };

  constructor(http: ReadOnlyHttp, key: ServiceAccountKey, scope: string, now: () => number) {
    this.http = http;
    this.key = key;
    this.scope = scope;
    this.now = now;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const assertion = signServiceAccountJwt(this.key, this.scope, this.now());
    const body = asRecord(
      await this.http.postTokenForm(GOOGLE_TOKEN_URL, {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    );
    const token = asString(body.access_token);
    if (!token) throw new Error("Google token endpoint returned no access_token");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
    return token;
  }
}
