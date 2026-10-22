import type { ChatStep, PublicCitation, ReportReason } from "@openbrain/server/protocol";

// Conversations are kept in this browser only (localStorage), for the sidebar. The server keeps a
// conversation 24 hours for follow-up questions; after that a follow-up simply starts a new one.

export interface UiTurn {
  id: string;
  question: string;
  answer: string;
  steps: ChatStep[];
  citations: PublicCitation[];
  flagged: ReportReason | null;
  turnId: string | null;
  status: "streaming" | "done" | "error";
  error: { code: string; message: string } | null;
  feedback: "up" | "down" | null;
  model: string | null;
}

export interface UiConversation {
  /** Local id, stable; the server id may change after 24 hours. */
  id: string;
  serverId: string | null;
  title: string;
  updatedAt: string;
  turns: UiTurn[];
}

const KEY = "openbrain.conversations.v1";
const MAX = 40;

export function loadConversations(): UiConversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as UiConversation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(list: UiConversation[]): void {
  try {
    const clean = list.slice(0, MAX).map((c) => ({
      ...c,
      turns: c.turns.map((t) => (t.status === "streaming" ? { ...t, status: "error" as const, error: { code: "interrupted", message: "Interrupted." } } : t)),
    }));
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // Private mode or full storage: the chat still works, the history is just not kept.
  }
}

export function groupByDay(list: UiConversation[], now = new Date()): Array<{ label: string; items: UiConversation[] }> {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: Record<string, UiConversation[]> = { Today: [], "This week": [], Earlier: [] };
  for (const c of list) {
    const t = Date.parse(c.updatedAt);
    const bucket = t >= startOfToday ? "Today" : t >= startOfToday - 6 * 86_400_000 ? "This week" : "Earlier";
    groups[bucket]?.push(c);
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
