import { useMemo, useState, type MouseEvent } from "react";
import type { ChatStep, PublicCitation } from "@openbrain/server/protocol";
import type { UiTurn } from "../lib/conversations.ts";
import { renderAnswer } from "../lib/markdown.ts";
import { IconCheck, IconCopy, IconDown, IconInfo, IconSearch, IconUp } from "./icons.tsx";
import { originName } from "./SourcePanel.tsx";

// One answer of the chat (.design/Chat.dc.html): steps, text with citation chips, sources (mobile),
// copy / thumbs up / thumbs down with an optional comment, "not documented" callout, errors.

const CITE_IN_TEXT = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

export function citedIds(text: string, known: ReadonlyMap<number, PublicCitation>): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(CITE_IN_TEXT)) {
    for (const part of (match[1] ?? "").split(/[,;]/)) {
      const id = Number(part.trim());
      if (known.has(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

function stepLabel(step: ChatStep): string | null {
  if (step.kind === "search") return `searched ${step.section ?? "everything"}${step.hits === 0 ? ", nothing" : ""}`;
  if (step.kind === "read") return `read ${step.title}`;
  return null;
}

function uniqueSteps(steps: ChatStep[]): string[] {
  const labels: string[] = [];
  for (const s of steps) {
    const label = stepLabel(s);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

export interface AnswerProps {
  turn: UiTurn;
  citations: ReadonlyMap<number, PublicCitation>;
  selected: number | null;
  onCite: (cite: number) => void;
  onFeedback: (rating: "up" | "down", comment?: string) => Promise<void>;
  onRetry: () => void;
}

export function Answer({ turn, citations, selected, onCite, onFeedback, onRetry }: AnswerProps) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const cited = useMemo(() => citedIds(turn.answer, citations), [turn.answer, citations]);
  const origins = useMemo(() => {
    const set = new Set<string>();
    for (const c of citations.values()) {
      try {
        set.add(new URL(c.url).origin);
      } catch {
        // relative or invalid: links to it are relative anyway
      }
    }
    return set;
  }, [citations]);
  const html = useMemo(
    () => renderAnswer(turn.answer, { cites: new Set(citations.keys()), origins, selected }),
    [turn.answer, citations, origins, selected],
  );

  const steps = uniqueSteps(turn.steps);
  const streaming = turn.status === "streaming";
  const searchedQueries = turn.steps.flatMap((s) => (s.kind === "search" ? [s.query] : []));
  const searchedSections = [...new Set(turn.steps.flatMap((s) => (s.kind === "search" && s.section ? [s.section] : [])))];
  const notDocumented = turn.flagged !== null && turn.flagged !== "partial" && cited.length === 0 && !streaming;

  const onProseClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button.cite");
    const id = target?.dataset.cite;
    if (id) onCite(Number(id));
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const thumbsDown = async (): Promise<void> => {
    if (turn.feedback === "down") {
      setCommentOpen((open) => !open);
      return;
    }
    setCommentOpen(true);
    await onFeedback("down");
  };

  const sendComment = async (): Promise<void> => {
    if (!comment.trim()) {
      setCommentOpen(false);
      return;
    }
    await onFeedback("down", comment.trim());
    setSent(true);
    setTimeout(() => setCommentOpen(false), 900);
  };

  return (
    <div className="answer">
      {(steps.length > 0 || (streaming && !turn.answer)) && (
        <div className="steps" aria-live="polite">
          {steps.map((label, i) => (
            <span className="step" key={label}>
              {i === 0 && label.startsWith("searched") ? <IconSearch /> : null}
              {label}
            </span>
          ))}
          {streaming && !turn.answer && <span className="step live">{steps.length === 0 ? "searching" : "reading"}</span>}
        </div>
      )}

      {turn.status === "error" && turn.error ? (
        <div className="callout error" role="alert">
          <IconInfo />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <b>{turn.error.code === "budget" || turn.error.code === "quota" ? "Not available right now" : "Something went wrong"}</b>
            <span>{turn.error.message}</span>
            {turn.error.code !== "budget" && turn.error.code !== "quota" && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        </div>
      ) : notDocumented ? (
        <div className="callout" role="status">
          <IconInfo />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <b>{turn.flagged === "out_of_scope" ? "This is outside what I can answer." : "This is not documented yet."}</b>
            <span>
              {searchedQueries.length > 0 ? (
                <>
                  I searched{searchedSections.length > 0 ? <> <b style={{ display: "inline" }}>{searchedSections.join(", ")}</b></> : " the knowledge base"} for{" "}
                  {searchedQueries.slice(0, 3).map((q, i) => (
                    <span key={q}>
                      {i > 0 ? (i === Math.min(searchedQueries.length, 3) - 1 ? " and " : ", ") : ""}"{q}"
                    </span>
                  ))}
                  .{" "}
                </>
              ) : null}
              This question has been flagged for the next weekly update.
            </span>
          </div>
        </div>
      ) : (
        <div className="prose" onClick={onProseClick}>
          <div dangerouslySetInnerHTML={{ __html: html }} />
          {streaming && turn.answer && <span className="cursor" aria-hidden="true" />}
        </div>
      )}

      {!streaming && turn.flagged === "partial" && (
        <span className="demo-banner">Partly documented: flagged for the next weekly update.</span>
      )}

      {cited.length > 0 && !streaming && (
        <div className="source-list">
          {cited.map((id) => {
            const c = citations.get(id);
            if (!c) return null;
            return (
              <button type="button" className="source-row" key={id} onClick={() => onCite(id)}>
                <b>{id}</b>
                <span>{c.title}</span>
                <span className="origin">{originName(c.url)}</span>
              </button>
            );
          })}
        </div>
      )}

      {turn.status === "done" && (
        <div className="answer-actions">
          <button type="button" className="icon-btn" aria-label={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Helpful"
            aria-pressed={turn.feedback === "up"}
            disabled={turn.feedback !== null}
            onClick={() => void onFeedback("up")}
          >
            <IconUp />
          </button>
          <button type="button" className="icon-btn" aria-label="Not helpful" aria-pressed={turn.feedback === "down"} disabled={turn.feedback === "up"} onClick={() => void thumbsDown()}>
            <IconDown />
          </button>
          {turn.feedback === "up" ? (
            <span className="thanks">Thanks!</span>
          ) : cited.length > 0 ? (
            <span className="count">
              {cited.length} source{cited.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      )}

      {commentOpen && (
        <div className="feedback-box">
          <label htmlFor={`comment-${turn.id}`}>What was wrong? (optional)</label>
          <textarea
            id={`comment-${turn.id}`}
            rows={2}
            placeholder="A word helps the next update"
            value={comment}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="row">
            <span className="note">{sent ? "Comment added. Thank you." : "Flagged. Your question and this answer will be reviewed at the next weekly update."}</span>
            <button type="button" className="btn btn-dark btn-sm" onClick={() => void sendComment()}>
              {comment.trim() ? "Send" : "Close"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
