import type { ConversationState, TurnRecord } from "@openbrain/agent";
import type { NormalizedUsage } from "@openbrain/llm";
import type { KV, KVFactory } from "./kv.ts";
import type { Report, ReportStatus, ReportType } from "./protocol.ts";

// Runtime stores: conversations live 24 h (multi-turn and the thumbs-down copy), reports wait for
// the weekly update, usage holds counters only (no content), settings hold the models chosen in the admin.

export const CONVERSATION_TTL_MS = 24 * 3_600_000;

export interface StoredConversation {
  state: ConversationState;
  /** Turn records of the conversation, the source of a thumbs-down report. */
  turns: TurnRecord[];
  userId: string;
  expiresAt: string;
}

export class ConversationStore {
  constructor(private readonly kv: KV) {}

  async get(id: string, userId: string, now = Date.now()): Promise<StoredConversation | null> {
    if (!/^c_[\w-]{8,80}$/.test(id)) return null;
    const stored = await this.kv.get<StoredConversation>(id);
    if (!stored || stored.userId !== userId) return null;
    if (Date.parse(stored.expiresAt) < now) {
      await this.kv.delete(id);
      return null;
    }
    return stored;
  }

  async save(conversation: Omit<StoredConversation, "expiresAt">, now = Date.now()): Promise<void> {
    await this.kv.set(conversation.state.id, { ...conversation, expiresAt: new Date(now + CONVERSATION_TTL_MS).toISOString() });
  }

  /** Removes expired conversations (called opportunistically). */
  async purge(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const key of await this.kv.list("c_")) {
      const stored = await this.kv.get<StoredConversation>(key);
      if (!stored || Date.parse(stored.expiresAt) < now) {
        await this.kv.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export interface ReportFilter {
  type?: ReportType | undefined;
  status?: ReportStatus | undefined;
  limit?: number | undefined;
}

export class ReportStore {
  constructor(private readonly kv: KV) {}

  private key(report: Pick<Report, "id" | "created_at">): string {
    return `${report.created_at.slice(0, 10)}/${report.id}`;
  }

  async put(report: Report): Promise<void> {
    await this.kv.set(this.key(report), report);
  }

  /** Most recent first. */
  async list(filter: ReportFilter = {}): Promise<Report[]> {
    const keys = (await this.kv.list("")).reverse();
    const out: Report[] = [];
    for (const key of keys) {
      const report = await this.kv.get<Report>(key);
      if (!report) continue;
      if (filter.type && report.type !== filter.type) continue;
      if (filter.status && report.status !== filter.status) continue;
      out.push(report);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async mark(ids: readonly string[], status: ReportStatus, now = new Date()): Promise<number> {
    const wanted = new Set(ids);
    let changed = 0;
    for (const key of await this.kv.list("")) {
      const id = key.slice(key.lastIndexOf("/") + 1);
      if (!wanted.has(id)) continue;
      const report = await this.kv.get<Report>(key);
      if (!report) continue;
      const next: Report = { ...report, status };
      if (status === "done") next.done_at = now.toISOString();
      else delete next.done_at;
      await this.kv.set(key, next);
      changed++;
    }
    return changed;
  }

  /** Handled reports are purged after `days` (90 days at most). */
  async purge(days = 90, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const key of await this.kv.list("")) {
      const report = await this.kv.get<Report>(key);
      const doneAt = report?.done_at ? Date.parse(report.done_at) : Number.NaN;
      const createdAt = report ? Date.parse(report.created_at) : Number.NaN;
      if (!report || (report.status === "done" && doneAt < now - days * 86_400_000) || createdAt < now - days * 86_400_000) {
        await this.kv.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export interface MonthUsage {
  questions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Estimated from the catalog prices; unpriced models count as 0 and raise `unpriced`. */
  costUsd: number;
  unpriced: number;
  thumbsUp: number;
  thumbsDown: number;
  noAnswer: number;
}

const EMPTY_MONTH: MonthUsage = {
  questions: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpriced: 0,
  thumbsUp: 0,
  thumbsDown: 0,
  noAnswer: 0,
};

/** Counters only, no content. Read-modify-write: approximate under heavy concurrency. */
export class UsageStore {
  constructor(private readonly kv: KV) {}

  async questionsToday(userId: string, now = new Date()): Promise<number> {
    const day = await this.kv.get<{ questions: number }>(`day/${now.toISOString().slice(0, 10)}/${userId}`);
    return day?.questions ?? 0;
  }

  async month(now = new Date()): Promise<MonthUsage> {
    return { ...EMPTY_MONTH, ...(await this.kv.get<MonthUsage>(`month/${now.toISOString().slice(0, 7)}`)) };
  }

  private async bumpMonth(now: Date, change: (m: MonthUsage) => MonthUsage): Promise<void> {
    const key = `month/${now.toISOString().slice(0, 7)}`;
    const current = { ...EMPTY_MONTH, ...(await this.kv.get<MonthUsage>(key)) };
    await this.kv.set(key, change(current));
  }

  async recordTurn(userId: string, usage: NormalizedUsage, flagged: boolean, now = new Date()): Promise<void> {
    const dayKey = `day/${now.toISOString().slice(0, 10)}/${userId}`;
    const day = (await this.kv.get<{ questions: number }>(dayKey)) ?? { questions: 0 };
    await this.kv.set(dayKey, { questions: day.questions + 1 });
    await this.bumpMonth(now, (m) => ({
      ...m,
      questions: m.questions + 1,
      inputTokens: m.inputTokens + usage.inputTokens,
      cachedInputTokens: m.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: m.outputTokens + usage.outputTokens,
      costUsd: Math.round((m.costUsd + (usage.costUsd ?? 0)) * 1e6) / 1e6,
      unpriced: m.unpriced + (usage.costUsd === null ? 1 : 0),
      noAnswer: m.noAnswer + (flagged ? 1 : 0),
    }));
  }

  async recordFeedback(rating: "up" | "down", now = new Date()): Promise<void> {
    await this.bumpMonth(now, (m) => (rating === "up" ? { ...m, thumbsUp: m.thumbsUp + 1 } : { ...m, thumbsDown: m.thumbsDown + 1 }));
  }
}

export interface ModelOverrides {
  chat?: { model: string; effort: "low" | "medium" | "high" | null; fallbacks: string[] } | null;
  userChoice?: { enabled: boolean; allowed: string[] };
  updatedAt: string;
}

/** Models chosen from /admin/models: they win over openbrain.config.yaml, without a redeploy. */
export class SettingsStore {
  constructor(private readonly kv: KV) {}

  async models(): Promise<ModelOverrides | null> {
    return this.kv.get<ModelOverrides>("models");
  }

  async setModels(overrides: ModelOverrides): Promise<void> {
    await this.kv.set("models", overrides);
  }
}

/** Sliding window limiter (login attempts: 5 per 15 minutes per IP). */
export class RateLimiter {
  constructor(private readonly kv: KV) {}

  async hit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const recent = ((await this.kv.get<number[]>(key)) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSec: Math.ceil((oldest + windowMs - now) / 1000) };
    }
    recent.push(now);
    await this.kv.set(key, recent);
    return { allowed: true, retryAfterSec: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

export interface Stores {
  conversations: ConversationStore;
  reports: ReportStore;
  usage: UsageStore;
  settings: SettingsStore;
  limiter: RateLimiter;
}

export function createStores(factory: KVFactory): Stores {
  return {
    conversations: new ConversationStore(factory("conversations")),
    reports: new ReportStore(factory("reports")),
    usage: new UsageStore(factory("usage")),
    settings: new SettingsStore(factory("settings")),
    limiter: new RateLimiter(factory("ratelimit")),
  };
}
