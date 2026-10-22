import { handleMarkReports, handleModels, handleReports, handleTestModel, handleUpdateModels, handleUsage } from "./admin.ts";
import { handleAdminLogin, handleGoogleCallback, handleGoogleStart, handleLogin, handleLogout, handleMe } from "./auth.ts";
import { CHAT_LIMITS, handleChat, handleFeedback } from "./chat.ts";
import { createContext, type AppContext, type ServerDeps } from "./context.ts";
import { apiError, HttpError, json, type RequestContext } from "./http.ts";
import { handleKbIndex, handleKbPage } from "./kb.ts";
import type { PublicConfig } from "./protocol.ts";

// One router for every /api route. Netlify mounts it in two functions (chat, with its own rate limit, and
// the rest); `openbrain serve` mounts it in a Node server. Handlers take and return Web Request / Response.

type Handler = (app: AppContext, request: Request, ctx: RequestContext) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "GET /api/config": handleConfig,
  "GET /api/health": handleHealth,
  "POST /api/auth/login": handleLogin,
  "POST /api/auth/admin": handleAdminLogin,
  "POST /api/auth/logout": (app, request) => handleLogout(app, request),
  "GET /api/auth/me": handleMe,
  "GET /api/auth/google": (app, request) => handleGoogleStart(app, request),
  "GET /api/auth/google/callback": (app, request) => handleGoogleCallback(app, request),
  "POST /api/chat": handleChat,
  "POST /api/feedback": handleFeedback,
  "GET /api/kb": handleKbIndex,
  "GET /api/kb/page": handleKbPage,
  "GET /api/admin/reports": handleReports,
  "POST /api/admin/reports/mark": handleMarkReports,
  "GET /api/admin/usage": handleUsage,
  "GET /api/admin/models": handleModels,
  "POST /api/admin/models": handleUpdateModels,
  "POST /api/admin/models/test": handleTestModel,
};

async function handleConfig(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  const session = await app.session(request, ctx);
  const { settings, deps } = app;
  const { option } = await app.chatModels();
  const overrides = await app.stores.settings.models();
  const userChoice = overrides?.userChoice ?? settings.userChoice;
  const latestPage = Object.values(deps.bundle.index.docs)
    .map((d) => d.updatedAt)
    .sort()
    .at(-1);
  const body: PublicConfig = {
    assistantName: settings.assistantName,
    companyName: settings.companyName,
    accent: settings.accent,
    logoUrl: settings.logoUrl,
    authMode: settings.auth.mode,
    user: session ? app.sessionUser(session) : null,
    userChoice: {
      enabled: userChoice.enabled,
      models: userChoice.enabled ? userChoice.allowed.map((id) => ({ id, label: id.slice(id.indexOf(":") + 1) })) : [],
      default: option.id,
    },
    knowledgeUpdatedAt: deps.bundle.lastWeeklyUpdate ?? latestPage ?? null,
    demo: option.id.startsWith("demo:"),
    limits: { maxQuestionChars: CHAT_LIMITS.maxQuestionChars, maxTurns: CHAT_LIMITS.maxTurns },
  };
  return json(body);
}

async function handleHealth(app: AppContext): Promise<Response> {
  const { bundle } = app.deps;
  return json({
    ok: true,
    builtAt: bundle.builtAt,
    commit: bundle.commit,
    pages: Object.keys(bundle.index.docs).length,
    passages: bundle.index.chunks.length,
  });
}

export type App = (request: Request, ctx?: RequestContext) => Promise<Response>;

export function createApp(deps: ServerDeps): App {
  const app = createContext(deps);
  return async (request, ctx = {}) => {
    const url = new URL(request.url);
    const route = ROUTES[`${request.method} ${url.pathname.replace(/\/+$/, "")}`];
    if (!route) {
      const known = Object.keys(ROUTES).some((key) => key.endsWith(` ${url.pathname}`));
      return known ? apiError(405, "method_not_allowed", "method not allowed") : apiError(404, "not_found", "no such endpoint");
    }
    try {
      return await route(app, request, ctx);
    } catch (error) {
      if (error instanceof HttpError) return apiError(error.status, error.code, error.message);
      console.error("[openbrain]", error);
      return json({ error: { code: "server_error", message: "unexpected server error" } }, 500);
    }
  };
}
