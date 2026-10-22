import { newConversation, runTurn, type AgentEvent, type Citation, type DEFAULT_LIMITS, type TurnRecord } from "@openbrain/agent";
import { LlmError } from "@openbrain/llm";
import type { AppContext } from "./context.ts";
import { apiError, HttpError, json, readJson, sameOrigin, type RequestContext } from "./http.ts";
import type { ChatRequest, ChatStreamEvent, FeedbackRequest, FeedbackResponse, PublicCitation, Report } from "./protocol.ts";
import type { Session } from "./session.ts";
import type { StoredConversation } from "./stores.ts";

// POST /api/chat streams one answer as Server-Sent Events; POST /api/feedback records a
// thumbs up (a counter) or a thumbs down (the turn is copied into the reports store).

const HEARTBEAT_MS = 5_000;
const ANSWER_DEADLINE_MS = 50_000;
export const CHAT_LIMITS: Pick<typeof DEFAULT_LIMITS, "maxQuestionChars" | "maxTurns"> = { maxQuestionChars: 2_000, maxTurns: 12 };

export function publicCitation(c: Citation): PublicCitation {
  return {
    cite: c.cite,
    docId: c.docId,
    title: c.title,
    section: c.section,
    headingPath: c.headingPath,
    text: c.text,
    url: c.url,
    status: c.status,
    updatedAt: c.updatedAt,
    warnings: c.warnings,
  };
}

function toStreamEvent(event: AgentEvent): ChatStreamEvent | null {
  switch (event.type) {
    case "step":
      return { type: "step", step: event.step };
    case "text":
      return { type: "text", delta: event.delta };
    case "citation":
      return { type: "citation", citation: publicCitation(event.citation) };
    case "report":
      return { type: "report", reason: event.gap.reason };
    case "usage":
      return {
        type: "usage",
        usage: {
          inputTokens: event.usage.inputTokens,
          cachedInputTokens: event.usage.cachedInputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.usage.costUsd,
        },
      };
    case "done":
      return null;
  }
}

function errorMessage(error: unknown): { code: string; message: string } {
  if (error instanceof LlmError) {
    if (error.kind === "config") return { code: "model_config", message: error.message };
    if (error.kind === "retryable") return { code: "model_unavailable", message: "The model is unavailable right now. Please try again in a minute." };
    if (error.kind === "refusal") return { code: "model_refusal", message: "The model declined to answer this question." };
    return { code: "model_error", message: "The model returned an error. Please try again." };
  }
  if (error instanceof HttpError) return { code: error.code, message: error.message };
  return { code: "server_error", message: "Something went wrong on the server. Please try again." };
}

async function reportUser(app: AppContext, session: Session): Promise<string> {
  return app.settings.auth.identified && session.email ? session.email : session.sub;
}

function noAnswerReport(record: TurnRecord, user: string, commit: string | null): Report | null {
  const gap = record.gaps[0];
  if (!gap) return null;
  return {
    id: `r_${record.turnId.slice(2)}_gap`,
    type: "no_answer",
    created_at: record.createdAt,
    status: "open",
    question: record.question,
    lang: record.lang,
    user,
    turn_id: record.turnId,
    model: record.model,
    deploy: { commit },
    reason: gap.reason,
    searched: gap.searched,
    top_results: gap.topResults,
  };
}

export async function handleChat(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (!sameOrigin(request)) return apiError(403, "bad_origin", "cross-origin request refused");
  const session = await app.requireSession(request, ctx);
  const body = await readJson<ChatRequest>(request);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return apiError(400, "empty", "ask a question");
  if (message.length > CHAT_LIMITS.maxQuestionChars) {
    return apiError(400, "too_long", `questions are limited to ${CHAT_LIMITS.maxQuestionChars} characters`);
  }

  const now = app.now();
  const { budgets } = app.settings;
  if ((await app.stores.usage.questionsToday(session.sub, now)) >= budgets.questionsPerUserPerDay) {
    return apiError(429, "quota", `daily limit of ${budgets.questionsPerUserPerDay} questions reached, back tomorrow`);
  }
  const month = await app.stores.usage.month(now);
  if (budgets.monthlyUsd > 0 && month.costUsd >= budgets.monthlyUsd) {
    return apiError(429, "budget", "the monthly budget of the chatbot is reached: it will answer again next month");
  }

  const existing = body.conversationId ? await app.stores.conversations.get(body.conversationId, session.sub, now.getTime()) : null;
  const conversation: Omit<StoredConversation, "expiresAt"> = existing ?? { state: newConversation(undefined, now), turns: [], userId: session.sub };
  if (conversation.state.turnCount >= CHAT_LIMITS.maxTurns) {
    return apiError(409, "conversation_full", "this conversation is long enough: start a new one");
  }

  const { specs, option } = await app.chatModels(body.model);
  const llm = app.buildLLM(specs);
  const mode = app.settings.mode === "auto" ? undefined : app.settings.mode;
  const turnId = `t_${crypto.randomUUID()}`;
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const commit = app.deps.bundle.commit;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (chunk: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      const send = (event: ChatStreamEvent): void => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      send({ type: "meta", conversationId: conversation.state.id, turnId, model: option });
      try {
        const record = await runTurn({
          llm,
          knowledge: app.knowledge,
          brain: app.deps.bundle.brain,
          state: conversation.state,
          question: message,
          ...(mode ? { mode } : {}),
          now,
          deadline: Date.now() + ANSWER_DEADLINE_MS,
          abortSignal: abort.signal,
          turnId,
          onEvent: (event) => {
            const mapped = toStreamEvent(event);
            if (mapped) send(mapped);
          },
        });
        send({ type: "done", turnId, reason: record.done });

        // Persist before closing the stream: the function stays alive until then. The answer is already
        // delivered, so a storage failure is logged, not shown.
        try {
          conversation.turns.push(record);
          const user = await reportUser(app, session);
          const report = noAnswerReport(record, user, commit);
          await Promise.all([
            app.stores.conversations.save(conversation, now.getTime()),
            app.stores.usage.recordTurn(session.sub, record.usage, report !== null, now),
            report ? app.stores.reports.put(report) : Promise.resolve(),
          ]);
        } catch (error) {
          console.error("[openbrain] could not store the turn", error);
        }
      } catch (error) {
        if (!(error instanceof LlmError) && !(error instanceof HttpError)) console.error("[openbrain] chat failed", error);
        const { code, message: text } = errorMessage(error);
        send({ type: "error", code, message: text });
        send({ type: "done", turnId, reason: "error" });
      } finally {
        clearInterval(heartbeat);
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  // Opportunistic cleanup of expired conversations and old reports, off the request path.
  if (ctx.waitUntil && Math.random() < 0.02) {
    ctx.waitUntil(Promise.all([app.stores.conversations.purge(), app.stores.reports.purge()]).catch(() => undefined));
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function handleFeedback(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  if (!sameOrigin(request)) return apiError(403, "bad_origin", "cross-origin request refused");
  const session = await app.requireSession(request, ctx);
  const body = await readJson<FeedbackRequest>(request);
  if (body.rating !== "up" && body.rating !== "down") return apiError(400, "bad_request", "rating must be up or down");
  const now = app.now();

  if (body.rating === "up") {
    await app.stores.usage.recordFeedback("up", now);
    const response: FeedbackResponse = { ok: true };
    return json(response);
  }

  const conversation =
    typeof body.conversationId === "string" ? await app.stores.conversations.get(body.conversationId, session.sub, now.getTime()) : null;
  const turn = conversation?.turns.find((t) => t.turnId === body.turnId);
  if (!conversation || !turn) {
    return apiError(410, "expired", "this answer is older than 24 hours and can no longer be flagged");
  }
  const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim().slice(0, 2_000) : null;
  const id = `r_${turn.turnId.slice(2)}_down`;
  const report: Report = {
    id,
    type: "thumbs_down",
    created_at: now.toISOString(),
    status: "open",
    question: turn.question,
    lang: turn.lang,
    user: await reportUser(app, session),
    turn_id: turn.turnId,
    model: turn.model,
    deploy: { commit: app.deps.bundle.commit },
    context: turn.context,
    answer: turn.answer,
    citations: turn.citations,
    searches: turn.searches,
    comment,
  };
  // A second click (to add a comment) overwrites the same report, keyed by turn.
  const existingReports = await app.stores.reports.list({ type: "thumbs_down" });
  const previous = existingReports.find((r) => r.id === id);
  await app.stores.reports.put(previous ? { ...report, created_at: previous.created_at } : report);
  if (!previous) await app.stores.usage.recordFeedback("down", now);
  const response: FeedbackResponse = { ok: true, reportId: id };
  return json(response);
}
