import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PublicCitation, PublicConfig } from "@openbrain/server/protocol";
import { Answer } from "../components/Answer.tsx";
import { IconBook, IconGear, IconMenu, IconPlus, IconSend } from "../components/icons.tsx";
import { Mark } from "../components/Logo.tsx";
import { SourcePanel } from "../components/SourcePanel.tsx";
import { api, ApiFailure, streamChat } from "../lib/api.ts";
import { groupByDay, loadConversations, newId, saveConversations, type UiConversation, type UiTurn } from "../lib/conversations.ts";
import { Link } from "../lib/router.tsx";
import { relativeDays } from "../lib/time.ts";

// The chat (.design/Chat.dc.html on desktop, ChatMobile.dc.html under 860 px).

function blankTurn(question: string): UiTurn {
  return {
    id: newId("u"),
    question,
    answer: "",
    steps: [],
    citations: [],
    flagged: null,
    turnId: null,
    status: "streaming",
    error: null,
    feedback: null,
    model: null,
  };
}

export function Chat({ config }: { config: PublicConfig }) {
  const [conversations, setConversations] = useState<UiConversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(() => loadConversations()[0]?.id ?? null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [model, setModel] = useState(config.userChoice.default);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const busy = active?.turns.some((t) => t.status === "streaming") ?? false;

  useEffect(() => saveConversations(conversations), [conversations]);

  // Every citation of the conversation: the server sends a citation once, later answers reuse its number.
  const citations = useMemo(() => {
    const map = new Map<number, PublicCitation>();
    for (const turn of active?.turns ?? []) for (const c of turn.citations) map.set(c.cite, c);
    return map;
  }, [active]);
  const selectedCitation = selected !== null ? (citations.get(selected) ?? null) : null;

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [active?.turns.length, active?.turns.at(-1)?.answer.length, active?.turns.at(-1)?.status]);

  const updateTurn = useCallback((conversationId: string, turnId: string, change: (t: UiTurn) => UiTurn) => {
    setConversations((list) =>
      list.map((c) =>
        c.id === conversationId ? { ...c, updatedAt: new Date().toISOString(), turns: c.turns.map((t) => (t.id === turnId ? change(t) : t)) } : c,
      ),
    );
  }, []);

  const ask = useCallback(
    async (question: string, conversation: UiConversation | null) => {
      const text = question.trim();
      if (!text || busy) return;
      const turn = blankTurn(text);
      const conv: UiConversation = conversation
        ? { ...conversation, updatedAt: new Date().toISOString(), turns: [...conversation.turns, turn] }
        : { id: newId("l"), serverId: null, title: text.slice(0, 80), updatedAt: new Date().toISOString(), turns: [turn] };
      setConversations((list) => [conv, ...list.filter((c) => c.id !== conv.id)]);
      setActiveId(conv.id);
      setDraft("");
      setSidebarOpen(false);

      const controller = new AbortController();
      abortRef.current = controller;
      const body = {
        message: text,
        ...(conv.serverId ? { conversationId: conv.serverId } : {}),
        ...(config.userChoice.enabled && model !== config.userChoice.default ? { model } : {}),
      };
      try {
        let firstCitation: number | null = null;
        for await (const event of streamChat(body, controller.signal)) {
          switch (event.type) {
            case "meta":
              setConversations((list) => list.map((c) => (c.id === conv.id ? { ...c, serverId: event.conversationId } : c)));
              updateTurn(conv.id, turn.id, (t) => ({ ...t, turnId: event.turnId, model: event.model.label }));
              break;
            case "step":
              updateTurn(conv.id, turn.id, (t) => ({ ...t, steps: [...t.steps, event.step] }));
              break;
            case "text":
              updateTurn(conv.id, turn.id, (t) => ({ ...t, answer: t.answer + event.delta }));
              break;
            case "citation":
              firstCitation ??= event.citation.cite;
              updateTurn(conv.id, turn.id, (t) => ({ ...t, citations: [...t.citations, event.citation] }));
              break;
            case "report":
              updateTurn(conv.id, turn.id, (t) => ({ ...t, flagged: t.flagged ?? event.reason }));
              break;
            case "error":
              updateTurn(conv.id, turn.id, (t) => ({ ...t, status: "error", error: { code: event.code, message: event.message } }));
              break;
            case "done":
              updateTurn(conv.id, turn.id, (t) => (t.status === "error" ? t : { ...t, status: "done" }));
              break;
            case "usage":
              break;
          }
        }
        // Wide screens show the first source of a new answer, like the design.
        if (firstCitation !== null && window.matchMedia("(min-width: 1181px)").matches) setSelected(firstCitation);
      } catch (error) {
        if (controller.signal.aborted) {
          updateTurn(conv.id, turn.id, (t) => ({ ...t, status: t.answer ? "done" : "error", error: t.answer ? null : { code: "aborted", message: "Stopped." } }));
          return;
        }
        const failure =
          error instanceof ApiFailure
            ? { code: error.code, message: error.code === "unauthenticated" ? "Your session has expired: sign in again." : error.message }
            : { code: "network", message: "The connection was interrupted. Check your network and try again." };
        if (error instanceof ApiFailure && error.code === "conversation_full") {
          failure.message = "This conversation is long enough. Start a new question to keep answers sharp.";
        }
        updateTurn(conv.id, turn.id, (t) => ({ ...t, status: "error", error: failure }));
        if (error instanceof ApiFailure && error.status === 401) window.location.assign("/login");
      } finally {
        abortRef.current = null;
      }
    },
    [busy, config.userChoice, model, updateTurn],
  );

  const feedback = useCallback(
    async (turn: UiTurn, rating: "up" | "down", comment?: string) => {
      if (!active?.serverId || !turn.turnId) return;
      updateTurn(active.id, turn.id, (t) => ({ ...t, feedback: rating }));
      try {
        await api.feedback({ conversationId: active.serverId, turnId: turn.turnId, rating, ...(comment ? { comment } : {}) });
      } catch (error) {
        if (error instanceof ApiFailure && error.code === "expired") {
          updateTurn(active.id, turn.id, (t) => ({ ...t, feedback: null }));
          alert("This answer is more than 24 hours old and can no longer be flagged.");
        }
      }
    },
    [active, updateTurn],
  );

  const newQuestion = (): void => {
    abortRef.current?.abort();
    setActiveId(null);
    setSelected(null);
    setPanelOpen(false);
    setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onCite = (cite: number): void => {
    setSelected(cite);
    setPanelOpen(true);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft, active);
    }
  };

  // Auto-grow the question box.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const groups = groupByDay(conversations);
  const updated = relativeDays(config.knowledgeUpdatedAt);
  const tooLong = draft.length > config.limits.maxQuestionChars;

  return (
    <div className="shell">
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`} aria-label="Conversations">
        <Link href="/" className="brand" onClick={newQuestion}>
          <Mark logoUrl={config.logoUrl} />
          <span>{config.assistantName}</span>
        </Link>
        <button type="button" className="btn btn-accent" onClick={newQuestion}>
          <IconPlus />
          New question
        </button>
        <nav aria-label="Recent">
          {groups.length === 0 && <span className="group-label">No conversation yet</span>}
          {groups.map((group) => (
            <div key={group.label} style={{ display: "contents" }}>
              <span className="group-label">{group.label}</span>
              {group.items.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className="conv-link"
                  aria-current={c.id === activeId}
                  onClick={() => {
                    setActiveId(c.id);
                    setSelected(null);
                    setSidebarOpen(false);
                  }}
                  title={c.title}
                >
                  {c.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <Link href="/kb" className="side-link">
            <IconBook />
            Browse knowledge
          </Link>
          <Link href="/admin" className="side-link">
            <IconGear />
            Admin
          </Link>
          {config.authMode !== "none" && config.authMode !== "netlify" && (
            <button
              type="button"
              className="side-link"
              onClick={() => {
                void api.logout().finally(() => window.location.assign("/login"));
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </aside>
      <div className={`overlay${sidebarOpen || panelOpen ? " show" : ""}`} onClick={() => (setSidebarOpen(false), setPanelOpen(false))} />

      <main className="main">
        <div className="mobile-bar">
          <button type="button" className="icon-btn" aria-label="Open conversations" onClick={() => setSidebarOpen(true)}>
            <IconMenu />
          </button>
          <span className="brand">
            <Mark size={24} logoUrl={config.logoUrl} />
            <span>{config.assistantName}</span>
          </span>
          <button type="button" className="send-btn" aria-label="New question" onClick={newQuestion}>
            <IconPlus size={18} />
          </button>
        </div>
        <div className="topbar">
          <h1>{active?.title ?? "New question"}</h1>
          <span className="meta">
            {config.demo && <span className="demo-banner">demo model, no LLM</span>}
            <span>Knowledge updated {updated}</span>
          </span>
        </div>

        <div className="thread" ref={threadRef}>
          <div className="thread-inner">
            {!active || active.turns.length === 0 ? (
              <div className="welcome">
                <span className="prompt">$ ask {config.companyName.toLowerCase().replace(/\s+/g, "-")}</span>
                <h2>
                  What do you need to know<span className="caret">_</span>
                </h2>
                <p>
                  Ask anything about {config.companyName}. Answers come only from its Notion, and every fact links to its page. When something is not
                  documented, I say so and flag it for the next weekly update.
                </p>
                <Link href="/kb" className="welcome-link">
                  <IconBook />
                  Browse knowledge
                </Link>
                {config.demo && (
                  <span className="demo-banner">Demo model: answers quote the best passages without an LLM. Configure a model to get real answers.</span>
                )}
              </div>
            ) : (
              active.turns.map((turn) => (
                <div key={turn.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div className="bubble-user">{turn.question}</div>
                  <Answer
                    turn={turn}
                    citations={citations}
                    selected={selected}
                    onCite={onCite}
                    onFeedback={(rating, comment) => feedback(turn, rating, comment)}
                    onRetry={() => void ask(turn.question, { ...active, turns: active.turns.filter((t) => t.id !== turn.id) })}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            <form
              className="composer-box"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(draft, active);
              }}
            >
              <label htmlFor="ask" className="sr-only">
                Ask a question
              </label>
              <textarea
                id="ask"
                ref={inputRef}
                rows={1}
                placeholder={`Ask anything about ${config.companyName}...`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                autoFocus
              />
              {config.userChoice.enabled && config.userChoice.models.length > 0 && (
                <select className="model-select" aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value={config.userChoice.default}>default</option>
                  {config.userChoice.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
              {busy ? (
                <button type="button" className="send-btn" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
                  <span style={{ width: 12, height: 12, background: "#fff", borderRadius: 2 }} />
                </button>
              ) : (
                <button type="submit" className="send-btn" aria-label="Send" disabled={!draft.trim() || tooLong}>
                  <IconSend />
                </button>
              )}
            </form>
            <span className="composer-note">
              {tooLong
                ? `Questions are limited to ${config.limits.maxQuestionChars} characters.`
                : `Answers come only from ${config.companyName}'s Notion and always cite the page.`}
            </span>
          </div>
        </div>
      </main>

      {citations.size > 0 && (
        <SourcePanel citation={selectedCitation} open={panelOpen && selectedCitation !== null} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
