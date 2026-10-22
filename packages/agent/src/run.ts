import { randomUUID } from "node:crypto";
import { addUsage, EMPTY_USAGE, LlmError, type LLM, type ModelMessage, type NormalizedUsage, type ToolCall } from "@openbrain/llm";
import { systemPrompt, type Brain, type KnowledgePort } from "./brain.ts";
import { detectLanguage } from "./language.ts";
import { citedIds } from "./state.ts";
import { runSearch, runTool, TOOL_SPECS, type TurnContext } from "./tools.ts";
import {
  DEFAULT_LIMITS,
  type AgentEvent,
  type AgentLimits,
  type AgentMode,
  type ConversationState,
  type DoneReason,
  type TurnRecord,
} from "./types.ts";

// One question, one turn. The loop is ours, not the SDK's, so the budgets are
// enforced in code: at most 4 tool rounds, then a final call without tools; a token budget for tool results;
// a 50 s deadline under the 60 s limit of Netlify. History is append-only: a turn is only kept when it ends.

export interface RunTurnInput {
  llm: LLM;
  knowledge: KnowledgePort;
  brain: Brain;
  /** Mutated: the turn is appended to it when it completes. */
  state: ConversationState;
  question: string;
  /** Default: "agent" when the model calls tools, "retrieval_first" otherwise. */
  mode?: AgentMode;
  now?: Date;
  /** Absolute time (ms) at which the answer must be closed. Default: start + 50 s. */
  deadline?: number;
  abortSignal?: AbortSignal;
  limits?: Partial<AgentLimits>;
  turnId?: string;
  onEvent?: (event: AgentEvent) => void;
}

/** Marker a model without tools writes when the passages do not answer (retrieval-first mode). */
export const NOT_DOCUMENTED = "NOT_DOCUMENTED";

const FINAL_CALL_MARGIN_MS = 8_000;

function userMessage(question: string, now: Date, extra?: string): ModelMessage {
  // The date lives here, never in the system prompt (the prefix must stay byte-identical for the cache).
  const parts: Array<{ type: "text"; text: string }> = [{ type: "text", text: question }];
  if (extra) parts.push({ type: "text", text: extra });
  parts.push({ type: "text", text: `(Today is ${now.toISOString().slice(0, 10)}.)` });
  return { role: "user", content: parts };
}

function toolMessage(calls: ToolCall[], results: Array<{ text: string; isError: boolean }>): ModelMessage {
  return {
    role: "tool",
    content: calls.map((call, i) => {
      const result = results[i] ?? { text: "No result.", isError: true };
      return {
        type: "tool-result" as const,
        toolCallId: call.id,
        toolName: call.name,
        output: result.isError ? { type: "error-text" as const, value: result.text } : { type: "text" as const, value: result.text },
      };
    }),
  };
}

function isAbort(error: unknown): boolean {
  if (error instanceof LlmError && error.cause !== undefined) return isAbort(error.cause);
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /aborted/i.test(error.message));
}

interface StreamOutcome {
  text: string;
  calls: ToolCall[];
  usage: NormalizedUsage;
  responseMessages: ModelMessage[];
  finished: boolean;
  reason: DoneReason;
  servedBy: TurnRecord["model"] | null;
}

export async function runTurn(input: RunTurnInput): Promise<TurnRecord> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const deadline = input.deadline ?? started + 50_000;
  const mode: AgentMode = input.mode ?? (input.llm.caps.tools ? "agent" : "retrieval_first");
  const turnId = input.turnId ?? `t_${randomUUID()}`;
  const emit = (event: AgentEvent): void => input.onEvent?.(event);
  const state = input.state;

  const question = input.question.trim();
  if (question.length === 0) throw new Error("empty question");
  if (question.length > limits.maxQuestionChars) throw new Error(`question longer than ${limits.maxQuestionChars} characters`);

  // Snapshot for rollback: an unfinished turn never stays in the history.
  const snapshot = {
    messages: state.messages.length,
    citations: state.citations.length,
    servedChunks: state.servedChunks.length,
    warnedDocs: state.warnedDocs.length,
    ruledSections: state.ruledSections.length,
  };
  const rollback = (): void => {
    state.messages.length = snapshot.messages;
    state.citations.length = snapshot.citations;
    state.servedChunks.length = snapshot.servedChunks;
    state.warnedDocs.length = snapshot.warnedDocs;
    state.ruledSections.length = snapshot.ruledSections;
  };

  const ctx: TurnContext = {
    state,
    knowledge: input.knowledge,
    limits,
    usedTokens: 0,
    searches: [],
    reads: [],
    gaps: [],
    emit,
  };

  const timeout = AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
  const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout;
  const system = systemPrompt(input.brain);
  let usage: NormalizedUsage = { ...EMPTY_USAGE, costUsd: input.llm.price ? 0 : null };
  let answer = "";
  let rounds = 0;
  let done: DoneReason = "stop";
  let servedBy: TurnRecord["model"] = { ...input.llm.ref, mode };

  const streamOnce = async (messages: ModelMessage[], toolsAllowed: boolean, filter?: (delta: string) => string): Promise<StreamOutcome> => {
    const outcome: StreamOutcome = {
      text: "",
      calls: [],
      usage: { ...EMPTY_USAGE },
      responseMessages: [],
      finished: false,
      reason: "stop",
      servedBy: null,
    };
    try {
      for await (const event of input.llm.stream({
        system,
        messages,
        ...(mode === "agent" ? { tools: TOOL_SPECS, toolChoice: toolsAllowed ? "auto" : "none" } : {}),
        maxOutputTokens: limits.maxOutputTokens,
        abortSignal: signal,
      })) {
        if (event.type === "text") {
          outcome.text += event.delta;
          const visible = filter ? filter(event.delta) : event.delta;
          if (visible) emit({ type: "text", delta: visible });
        } else if (event.type === "tool_call") {
          outcome.calls.push(event.call);
        } else {
          outcome.finished = true;
          outcome.usage = event.usage;
          outcome.responseMessages = event.responseMessages;
          outcome.servedBy = { ...event.servedBy, mode };
          outcome.reason = event.reason === "length" ? "length" : event.reason === "refusal" ? "refusal" : "stop";
        }
      }
    } catch (error) {
      if (!isAbort(error)) throw error;
      outcome.reason = input.abortSignal?.aborted ? "aborted" : "deadline";
    }
    return outcome;
  };

  try {
    if (mode === "agent") {
      state.messages.push(userMessage(question, now));
      for (;;) {
        const timeLeft = deadline - Date.now();
        const toolsAllowed = rounds < limits.maxToolRounds && timeLeft > FINAL_CALL_MARGIN_MS;
        const outcome = await streamOnce(state.messages, toolsAllowed);
        usage = addUsage(usage, outcome.usage);
        if (outcome.servedBy) servedBy = outcome.servedBy;
        answer += outcome.text;
        if (!outcome.finished) {
          // Deadline or abort mid-stream: keep what was said, close the turn cleanly.
          if (outcome.text) state.messages.push({ role: "assistant", content: [{ type: "text", text: outcome.text }] });
          done = outcome.reason;
          break;
        }
        state.messages.push(...outcome.responseMessages);
        if (outcome.calls.length > 0 && !toolsAllowed) {
          // A model that calls a tool anyway: every tool call needs its result, or the next turn is refused.
          state.messages.push(
            toolMessage(
              outcome.calls,
              outcome.calls.map(() => ({ text: "Not executed: the tool budget of this question is spent.", isError: true })),
            ),
          );
        }
        if (outcome.calls.length === 0 || !toolsAllowed) {
          done = outcome.reason;
          break;
        }
        rounds++;
        const results = await Promise.all(outcome.calls.map((call) => runTool(ctx, call.name, call.input)));
        if (rounds >= limits.maxToolRounds) {
          const last = results[results.length - 1];
          if (last) last.text += "\n\nTool limit reached for this question: answer now with what you found.";
        }
        state.messages.push(toolMessage(outcome.calls, results));
      }
    } else {
      // Retrieval-first: the server searches once with the question, the model answers in one call.
      const found = await runSearch(ctx, { query: question, k: limits.defaultK });
      rounds = 1;
      const instructions =
        `Knowledge base passages for this question:\n\n${found.text}\n\n` +
        "Answer only from these passages and cite each fact as [n]. " +
        `If they do not contain the answer, start your reply with ${NOT_DOCUMENTED}, then say what you searched and what is missing.`;
      state.messages.push(userMessage(question, now, instructions));

      // Hold the first characters back until we know whether the marker is there.
      let head = "";
      let decided = false;
      let notDocumented = false;
      const filter = (delta: string): string => {
        if (decided) return delta;
        head += delta;
        const trimmed = head.trimStart();
        if (trimmed.length < NOT_DOCUMENTED.length && NOT_DOCUMENTED.startsWith(trimmed)) return "";
        decided = true;
        if (trimmed.startsWith(NOT_DOCUMENTED)) {
          notDocumented = true;
          return trimmed.slice(NOT_DOCUMENTED.length).replace(/^[\s:.,-]+/, "");
        }
        return head;
      };
      const outcome = await streamOnce(state.messages, false, filter);
      if (!decided && head) {
        const trimmed = head.trimStart();
        notDocumented = trimmed.startsWith(NOT_DOCUMENTED);
        const visible = notDocumented ? trimmed.slice(NOT_DOCUMENTED.length).trim() : head;
        if (visible) emit({ type: "text", delta: visible });
      }
      usage = addUsage(usage, outcome.usage);
      if (outcome.servedBy) servedBy = outcome.servedBy;
      answer = notDocumented ? outcome.text.trimStart().slice(NOT_DOCUMENTED.length).replace(/^[\s:.,-]+/, "") : outcome.text;
      if (outcome.finished) state.messages.push(...outcome.responseMessages);
      else if (outcome.text) state.messages.push({ role: "assistant", content: [{ type: "text", text: outcome.text }] });
      done = outcome.finished ? outcome.reason : outcome.reason;
      if (notDocumented) {
        await runTool(ctx, "report_gap", { question, searched: [question], reason: "not_found" });
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }

  if (answer.trim().length === 0) {
    const fallback =
      done === "deadline"
        ? "I ran out of time before finishing the answer. Please ask again, or narrow the question."
        : "I could not produce an answer this time. Please try again.";
    emit({ type: "text", delta: fallback });
    answer = fallback;
    state.messages.push({ role: "assistant", content: [{ type: "text", text: fallback }] });
  }

  const previous = state.questions.slice(-2).map((text) => ({ role: "user" as const, text: text.slice(0, 300) }));
  state.questions.push(question);
  state.turnCount += 1;
  state.updatedAt = new Date().toISOString();

  emit({ type: "usage", usage });
  emit({ type: "done", reason: done });

  const cited = citedIds(answer, state);
  return {
    turnId,
    conversationId: state.id,
    createdAt: now.toISOString(),
    question,
    context: previous,
    answer,
    lang: detectLanguage(question),
    citations: cited.flatMap((id) => {
      const c = state.citations.find((x) => x.cite === id);
      return c ? [{ cite: c.cite, page: c.docId, url: c.url, heading_path: c.headingPath.join(" > ") }] : [];
    }),
    searches: ctx.searches,
    reads: ctx.reads,
    gaps: ctx.gaps,
    model: servedBy,
    usage,
    rounds,
    done,
    latencyMs: Date.now() - started,
  };
}
