import type { AppContext } from "./context.ts";
import { hashUser, randomId, sha256Hex, verifyCode } from "./crypto.ts";
import { apiError, HttpError, isSecure, json, readJson, redirect, type RequestContext } from "./http.ts";
import type { LoginRequest } from "./protocol.ts";
import { clearSessionCookie, readCookie, SESSION_DAYS, sessionCookie, signSession, type Session } from "./session.ts";

// Authentication: a shared access code by default (works on the free Netlify plan),
// Google sign-in for companies on Google Workspace, an admin code or an admin email list for /admin.
// Login attempts are limited to 5 per 15 minutes per IP.

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const STATE_COOKIE = "ob_oauth_state";

async function limiterKey(ctx: RequestContext, kind: string): Promise<string> {
  return `login/${kind}/${(await sha256Hex(ctx.ip ?? "unknown")).slice(0, 24)}`;
}

async function issueSession(app: AppContext, request: Request, session: Omit<Session, "exp">, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const secret = app.deps.env.SESSION_SECRET;
  if (!secret) throw new HttpError(500, "misconfigured", "SESSION_SECRET is not set on the server");
  const exp = Math.floor(app.now().getTime() / 1000) + SESSION_DAYS * 86_400;
  const token = await signSession({ ...session, exp }, secret);
  return json({ user: app.sessionUser({ ...session, exp }) }, 200, {
    "set-cookie": sessionCookie(token, isSecure(request) || !app.deps.local),
    ...extraHeaders,
  });
}

async function checkCode(app: AppContext, ctx: RequestContext, kind: "access" | "admin", code: string, stored: string | undefined): Promise<Response | null> {
  if (!stored) return apiError(500, "misconfigured", `${kind === "access" ? "ACCESS_CODE_HASH" : "ADMIN_CODE_HASH"} is not set on the server`);
  const key = await limiterKey(ctx, kind);
  const attempt = await app.stores.limiter.hit(key, LOGIN_LIMIT, LOGIN_WINDOW_MS, app.now().getTime());
  if (!attempt.allowed) {
    return apiError(429, "too_many_attempts", `too many attempts, try again in ${Math.ceil(attempt.retryAfterSec / 60)} minutes`, {
      "retry-after": String(attempt.retryAfterSec),
    });
  }
  if (!(await verifyCode(code, stored))) return apiError(401, "wrong_code", "wrong code");
  await app.stores.limiter.reset(key);
  return null;
}

export async function handleLogin(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (app.settings.auth.mode !== "passcode") return apiError(400, "wrong_mode", `this chatbot uses ${app.settings.auth.mode} sign-in`);
  const body = await readJson<LoginRequest>(request);
  if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 200) return apiError(400, "bad_request", "code required");
  const refused = await checkCode(app, ctx, "access", body.code, app.deps.env.ACCESS_CODE_HASH);
  if (refused) return refused;
  // Shared code: no identity. Each sign-in gets its own pseudonymous id (quotas, "5 different people").
  const sub = await hashUser(app.deps.env.SESSION_SECRET ?? "", `passcode:${randomId()}`);
  return issueSession(app, request, { sub, email: null, name: null, admin: false });
}

/** Upgrades the current session to admin with ADMIN_CODE_HASH (passcode and netlify modes). */
export async function handleAdminLogin(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  const body = await readJson<LoginRequest>(request);
  if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 200) return apiError(400, "bad_request", "code required");
  const refused = await checkCode(app, ctx, "admin", body.code, app.deps.env.ADMIN_CODE_HASH);
  if (refused) return refused;
  const current = await app.session(request, ctx);
  const sub = current?.sub ?? (await hashUser(app.deps.env.SESSION_SECRET ?? "", `admin:${randomId()}`));
  return issueSession(app, request, { sub, email: current?.email ?? null, name: current?.name ?? null, admin: true });
}

export async function handleLogout(app: AppContext, request: Request): Promise<Response> {
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(isSecure(request) || !app.deps.local) });
}

export async function handleMe(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  const session = await app.session(request, ctx);
  if (!session) return apiError(401, "unauthenticated", "sign in first");
  return json({ user: app.sessionUser(session) });
}

// ---------- Google sign-in (authorization code flow, server side) ----------

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}/api/auth/google/callback`;
}

export async function handleGoogleStart(app: AppContext, request: Request): Promise<Response> {
  const clientId = app.deps.env.GOOGLE_CLIENT_ID;
  if (app.settings.auth.mode !== "google" || !clientId) return apiError(400, "wrong_mode", "Google sign-in is not enabled");
  const state = randomId();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(request),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    ...(app.settings.auth.allowedDomains.length === 1 ? { hd: app.settings.auth.allowedDomains[0] ?? "" } : {}),
  });
  const secure = isSecure(request) || !app.deps.local;
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, {
    "set-cookie": `${STATE_COOKIE}=${state}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
  });
}

interface GoogleUser {
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
}

export async function handleGoogleCallback(app: AppContext, request: Request): Promise<Response> {
  const env = app.deps.env;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request.headers.get("cookie"), STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return redirect("/login?error=state");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return redirect("/login?error=config");

  const tokenResponse = await app.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(request),
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenResponse.ok) return redirect("/login?error=google");
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return redirect("/login?error=google");
  const userResponse = await app.fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userResponse.ok) return redirect("/login?error=google");
  const user = (await userResponse.json()) as GoogleUser;
  const email = user.email?.toLowerCase();
  if (!email || user.email_verified !== true) return redirect("/login?error=email");
  const domain = email.slice(email.indexOf("@") + 1);
  const allowed = app.settings.auth.allowedDomains;
  if (allowed.length > 0 && !allowed.includes(domain)) return redirect("/login?error=domain");

  const admins = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const sub = await hashUser(env.SESSION_SECRET ?? "", `google:${email}`);
  const response = await issueSession(app, request, { sub, email, name: user.name ?? null, admin: admins.includes(email) });
  const headers = new Headers(response.headers);
  headers.set("location", "/");
  headers.append("set-cookie", `${STATE_COOKIE}=; Path=/api/auth; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}
