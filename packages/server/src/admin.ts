import { newConversation, runTurn } from "@openbrain/agent";
import { formatRef, isConfigured, listProviderModels, parseRef, type ListedModel } from "@openbrain/llm";
import type { AppContext } from "./context.ts";
import { apiError, HttpError, json, readJson, sameOrigin, type RequestContext } from "./http.ts";
import type {
  CatalogEntry,
  MarkReportsRequest,
  ModelsResponse,
  ModelTestResponse,
  ModelTestResult,
  ProviderStatus,
  ReportsResponse,
  ReportStatus,
  ReportType,
  UpdateModelsRequest,
} from "./protocol.ts";

// The admin: flagged questions and models, nothing else. The weekly update calls the
// same endpoints from the terminal with the ADMIN_TOKEN bearer.

export async function handleReports(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  await app.requireAdmin(request, ctx);
  const params = new URL(request.url).searchParams;
  const type = params.get("type");
  const status = params.get("status");
  const reports = await app.stores.reports.list({
    type: type === "no_answer" || type === "thumbs_down" ? (type satisfies ReportType) : undefined,
    status: status === "open" || status === "done" ? (status satisfies ReportStatus) : undefined,
    limit: Math.min(Number(params.get("limit") ?? 500) || 500, 2_000),
  });
  const body: ReportsResponse = { reports, lastWeeklyUpdate: app.deps.bundle.lastWeeklyUpdate };
  return json(body);
}

export async function handleMarkReports(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (!sameOrigin(request)) return apiError(403, "bad_origin", "cross-origin request refused");
  await app.requireAdmin(request, ctx);
  const body = await readJson<MarkReportsRequest>(request);
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || (body.status !== "open" && body.status !== "done")) {
    return apiError(400, "bad_request", "expected { ids: string[], status: open | done }");
  }
  const changed = await app.stores.reports.mark(body.ids, body.status, app.now());
  return json({ ok: true, changed });
}

export async function handleUsage(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  await app.requireAdmin(request, ctx);
  const month = await app.stores.usage.month(app.now());
  return json({ month, monthlyBudgetUsd: app.settings.budgets.monthlyUsd });
}

// ---------- Models ----------

const LIST_TTL_MS = 10 * 60_000;
const listCache = new Map<string, { at: number; models: ListedModel[]; error: string | null }>();

async function listedModels(app: AppContext, providerId: string): Promise<{ models: ListedModel[]; error: string | null }> {
  const cached = listCache.get(providerId);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached;
  const def = app.registry.get(providerId);
  if (!def) return { models: [], error: "unknown provider" };
  let result: { models: ListedModel[]; error: string | null };
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8_000));
    result = { models: await Promise.race([listProviderModels(def, app.deps.env, app.fetch), timeout]), error: null };
  } catch (error) {
    result = { models: [], error: error instanceof Error ? error.message : String(error) };
  }
  listCache.set(providerId, { at: Date.now(), ...result });
  return result;
}

export async function handleModels(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  await app.requireAdmin(request, ctx);
  const overrides = await app.stores.settings.models();
  const { specs } = await app.chatModels();
  const [primary, ...fallbacks] = specs;
  if (!primary) throw new HttpError(500, "misconfigured", "no chat model");

  const configured = app.registry.providers.filter((p) => isConfigured(p, app.deps.env) && !p.local);
  const listings = new Map(await Promise.all(configured.map(async (p) => [p.id, await listedModels(app, p.id)] as const)));

  const providers: ProviderStatus[] = app.registry.providers.map((p) => ({
    id: p.id,
    label: p.label,
    configured: isConfigured(p, app.deps.env),
    envKeys: p.envKeys,
    local: p.local === true,
    error: listings.get(p.id)?.error ?? null,
  }));

  const entries = new Map<string, CatalogEntry>();
  for (const m of app.catalog) {
    const def = app.registry.get(m.provider);
    if (!def || !configured.some((p) => p.id === m.provider)) continue;
    const listing = listings.get(m.provider);
    entries.set(`${m.provider}:${m.id}`, {
      id: `${m.provider}:${m.id}`,
      provider: m.provider,
      model: m.id,
      name: m.name,
      tools: m.caps.tools,
      contextWindow: m.caps.contextWindow,
      price: m.price ? { input: m.price.input, output: m.price.output, cacheRead: m.price.cacheRead ?? null } : null,
      available: listing ? listing.error === null && listing.models.some((l) => l.id === m.id) : false,
      verified: true,
      local: def.local === true,
    });
  }
  for (const [providerId, listing] of listings) {
    for (const l of listing.models) {
      const id = `${providerId}:${l.id}`;
      if (entries.has(id)) continue;
      entries.set(id, {
        id,
        provider: providerId,
        model: l.id,
        name: l.name ?? l.id,
        tools: true,
        contextWindow: l.contextWindow ?? 0,
        price: null,
        available: true,
        verified: false,
        local: false,
      });
    }
  }
  entries.set("demo:extractive", {
    id: "demo:extractive",
    provider: "demo",
    model: "extractive",
    name: "Demo (no LLM, quotes passages)",
    tools: true,
    contextWindow: 0,
    price: { input: 0, output: 0, cacheRead: 0 },
    available: true,
    verified: true,
    local: false,
  });

  const body: ModelsResponse = {
    roles: {
      chat: {
        model: formatRef(primary.ref),
        effort: primary.effort ?? null,
        source: app.deps.chatOverride ? "cli" : overrides?.chat ? "settings" : "config",
        fallbacks: fallbacks.map((f) => formatRef(f.ref)),
      },
    },
    providers,
    models: [...entries.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
    userChoice: overrides?.userChoice ?? app.settings.userChoice,
  };
  return json(body);
}

function validModelId(app: AppContext, id: string): boolean {
  try {
    const ref = parseRef(id);
    return app.registry.get(ref.provider) !== undefined;
  } catch {
    return false;
  }
}

export async function handleUpdateModels(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (!sameOrigin(request)) return apiError(403, "bad_origin", "cross-origin request refused");
  await app.requireAdmin(request, ctx);
  const body = await readJson<UpdateModelsRequest>(request);
  const current = (await app.stores.settings.models()) ?? { updatedAt: app.now().toISOString() };
  const next = { ...current, updatedAt: app.now().toISOString() };

  if (body.chat === null) {
    next.chat = null;
  } else if (body.chat) {
    const ids = [body.chat.model, ...(body.chat.fallbacks ?? [])];
    const bad = ids.find((id) => typeof id !== "string" || !validModelId(app, id));
    if (bad !== undefined) return apiError(400, "bad_model", `unknown model "${String(bad)}" (expected provider:model)`);
    const effort = body.chat.effort ?? null;
    if (effort !== null && !["low", "medium", "high"].includes(effort)) return apiError(400, "bad_effort", "effort must be low, medium or high");
    next.chat = { model: body.chat.model, effort, fallbacks: body.chat.fallbacks ?? [] };
  }
  if (body.userChoice) {
    const bad = body.userChoice.allowed.find((id) => !validModelId(app, id));
    if (bad !== undefined) return apiError(400, "bad_model", `unknown model "${bad}"`);
    next.userChoice = { enabled: body.userChoice.enabled === true, allowed: body.userChoice.allowed };
  }
  await app.stores.settings.setModels(next);
  return json({ ok: true });
}

/** "Test on 5 questions": the instance's own eval questions, answered by the candidate model. */
export async function handleTestModel(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (!sameOrigin(request)) return apiError(403, "bad_origin", "cross-origin request refused");
  await app.requireAdmin(request, ctx);
  const body = await readJson<{ model?: string }>(request);
  if (typeof body.model !== "string" || !validModelId(app, body.model)) return apiError(400, "bad_model", "expected { model: provider:model }");
  const questions = app.deps.bundle.evalQuestions.slice(0, 5);
  if (questions.length === 0) return apiError(400, "no_questions", "evals/golden.yaml has no question to test with");

  const llm = app.buildLLM([{ ref: parseRef(body.model), effort: "low" }]);
  const deadline = Date.now() + 45_000;
  const results = await Promise.all(
    questions.map(async (question): Promise<ModelTestResult> => {
      const started = Date.now();
      try {
        const record = await runTurn({ llm, knowledge: app.knowledge, brain: app.deps.bundle.brain, state: newConversation(), question, deadline });
        return {
          question,
          ok: record.done === "stop",
          answerPreview: record.answer.slice(0, 280),
          citations: record.citations.length,
          flagged: record.gaps.length > 0,
          latencyMs: record.latencyMs,
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          costUsd: record.usage.costUsd,
          error: null,
        };
      } catch (error) {
        return {
          question,
          ok: false,
          answerPreview: "",
          citations: 0,
          flagged: false,
          latencyMs: Date.now() - started,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const response: ModelTestResponse = { model: body.model, results };
  return json(response);
}
