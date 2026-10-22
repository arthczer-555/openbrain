import type { KnowledgePort } from "@openbrain/agent";
import {
  builtinCatalog,
  createLLMChain,
  createProviderRegistry,
  formatRef,
  mergeCatalogs,
  parseRef,
  specFromConfig,
  type CatalogModel,
  type Env,
  type LLM,
  type ModelConfigLike,
  type ModelSpec,
  type ProviderRegistry,
} from "@openbrain/llm";
import { knowledgeFromBundle, type RuntimeBundle } from "./bundle.ts";
import { hashUser, timingSafeEqual, utf8 } from "./crypto.ts";
import { HttpError, type RequestContext } from "./http.ts";
import type { KVFactory } from "./kv.ts";
import type { AuthMode, ModelOption, SessionUser } from "./protocol.ts";
import { readCookie, SESSION_COOKIE, verifySession, type Session } from "./session.ts";
import { resolveSettings, type ChatbotSettings } from "./settings.ts";
import { createStores, type Stores } from "./stores.ts";

export interface ServerDeps {
  bundle: RuntimeBundle;
  env: Env;
  kv: KVFactory;
  /** `openbrain serve`: plain http allowed, `auth.mode: none` allowed. Never true on Netlify. */
  local?: boolean;
  /** Forces the chat model (the demo uses the extractive demo model). */
  chatOverride?: ModelConfigLike;
  /** Extra catalog layer (models.dev refresh). */
  catalog?: CatalogModel[];
  now?: () => Date;
  fetch?: typeof fetch;
  /** Builds the chat LLM (tests inject a mock model here). */
  llmFactory?: (specs: ModelSpec[]) => LLM;
}

export interface AppContext {
  deps: ServerDeps;
  settings: ChatbotSettings;
  /** The sign-in in effect: settings.auth.mode, or "open" when the deploy set no password. */
  authMode: AuthMode;
  stores: Stores;
  knowledge: KnowledgePort;
  registry: ProviderRegistry;
  catalog: CatalogModel[];
  now(): Date;
  fetch: typeof fetch;
  /** The session of the request, or null when signed out. */
  session(request: Request, ctx: RequestContext): Promise<Session | null>;
  requireSession(request: Request, ctx: RequestContext): Promise<Session>;
  /** Admin session, or the ADMIN_TOKEN bearer used by the weekly update from the terminal. */
  requireAdmin(request: Request, ctx: RequestContext): Promise<Session>;
  sessionUser(session: Session): SessionUser;
  chatModels(requested?: string): Promise<{ specs: ModelSpec[]; option: ModelOption }>;
  buildLLM(specs: ModelSpec[]): LLM;
}

const LOCAL_SESSION: Session = { sub: "hash:local", email: null, name: "Local user", admin: true, exp: Number.MAX_SAFE_INTEGER };

export function modelLabel(ref: { provider: string; model: string }, catalog: readonly CatalogModel[]): string {
  if (ref.provider === "demo") return "Demo (no LLM)";
  const entry = catalog.find((m) => m.provider === ref.provider && m.id === ref.model);
  return entry?.name ?? ref.model;
}

/**
 * Passcode mode without a password is open only when the deploy said so (OPENBRAIN_OPEN_ACCESS=1):
 * a forgotten ACCESS_CODE_HASH keeps the chatbot closed. A password, when set, always wins.
 */
export function effectiveAuthMode(settings: ChatbotSettings, env: Env): AuthMode {
  if (settings.auth.mode === "passcode" && !env.ACCESS_CODE_HASH && env.OPENBRAIN_OPEN_ACCESS === "1") return "open";
  return settings.auth.mode;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export function createContext(deps: ServerDeps): AppContext {
  const settings = resolveSettings(deps.bundle.config, deps.env);
  if (settings.auth.mode === "none" && !deps.local && deps.env.OPENBRAIN_ALLOW_NO_AUTH !== "1") {
    throw new Error('auth.mode "none" is refused outside local runs: the chatbot exposes internal knowledge');
  }
  const authMode = effectiveAuthMode(settings, deps.env);
  const registry = createProviderRegistry(settings.openaiCompatible);
  const catalog = mergeCatalogs(builtinCatalog(), deps.bundle.models ?? [], deps.catalog ?? []);
  const stores = createStores(deps.kv);
  const knowledge = knowledgeFromBundle(deps.bundle, deps.env);
  const now = deps.now ?? (() => new Date());
  const secret = deps.env.SESSION_SECRET ?? "";

  const session = async (request: Request, ctx: RequestContext): Promise<Session | null> => {
    if (settings.auth.mode === "none") return LOCAL_SESSION;
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    const verified = await verifySession(token, secret, now().getTime());
    if (verified) return verified;
    if (authMode === "netlify" || authMode === "open") {
      // Netlify protects the site itself, or there is no password: every visitor is let in. Without a session
      // cookie (open mode issues one with /api/config), the visitor is identified by IP hash for quotas.
      return { sub: await hashUser(secret || "netlify", `ip:${ctx.ip ?? "unknown"}`), email: null, name: null, admin: false, exp: 0 };
    }
    return null;
  };

  const context: AppContext = {
    deps,
    settings,
    authMode,
    stores,
    knowledge,
    registry,
    catalog,
    now,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    session,
    async requireSession(request, ctx) {
      if (settings.auth.mode !== "none" && !secret) {
        throw new HttpError(500, "misconfigured", "SESSION_SECRET is not set on the server");
      }
      const found = await session(request, ctx);
      if (!found) throw new HttpError(401, "unauthenticated", "sign in first");
      return found;
    },
    async requireAdmin(request, ctx) {
      const token = bearer(request);
      const adminToken = deps.env.ADMIN_TOKEN;
      if (token && adminToken && timingSafeEqual(utf8(token), utf8(adminToken))) {
        return { sub: "hash:admin-token", email: null, name: "weekly update", admin: true, exp: 0 };
      }
      const found = await context.requireSession(request, ctx);
      if (!found.admin) throw new HttpError(403, "forbidden", "admin only");
      return found;
    },
    sessionUser(s) {
      return { id: s.sub, email: s.email, name: s.name, isAdmin: s.admin };
    },
    async chatModels(requested) {
      const overrides = await stores.settings.models();
      let primary: ModelSpec = specFromConfig(settings.chat);
      let fallbacks: ModelSpec[] = settings.fallback.map(specFromConfig);
      if (overrides?.chat) {
        primary = { ref: parseRef(overrides.chat.model), effort: overrides.chat.effort ?? undefined };
        fallbacks = overrides.chat.fallbacks.map((id) => ({ ref: parseRef(id) }));
      }
      const userChoice = overrides?.userChoice ?? settings.userChoice;
      if (requested && userChoice.enabled && userChoice.allowed.includes(requested)) {
        primary = { ref: parseRef(requested), effort: primary.effort };
      }
      if (deps.chatOverride) {
        primary = specFromConfig(deps.chatOverride);
        fallbacks = [];
      }
      return {
        specs: [primary, ...fallbacks],
        option: { id: formatRef(primary.ref), label: modelLabel(primary.ref, catalog) },
      };
    },
    buildLLM(specs) {
      if (deps.llmFactory) return deps.llmFactory(specs);
      return createLLMChain(specs, {
        env: deps.env,
        registry,
        catalog,
        pricing: settings.pricing,
        // With a fallback ready, retry the primary once only: the user waits less.
        maxRetries: specs.length > 1 ? 1 : 2,
      });
    },
  };
  return context;
}
