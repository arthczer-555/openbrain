import type { PublicCitation } from "@openbrain/server/protocol";
import { IconClose, IconExternal, IconWarning } from "./icons.tsx";
import { renderMarkdown } from "../lib/markdown.ts";
import { shortDate } from "../lib/time.ts";

// The passage behind a citation: exact text, status, warnings, link to the Notion page.

const STATUS_LABEL: Record<PublicCitation["status"], string> = {
  validated: "Validated",
  to_confirm: "To confirm",
  stale: "May be outdated",
};

export function originName(url: string): string {
  try {
    const host = new URL(url, window.location.origin).hostname;
    if (host.endsWith("notion.so") || host.endsWith("notion.site")) return "Notion";
    if (host === window.location.hostname) return "the knowledge base";
    return host.replace(/^www\./, "");
  } catch {
    return "the source";
  }
}

export function SourcePanel({
  citation,
  open,
  onClose,
}: {
  citation: PublicCitation | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <aside className={`source-panel${open ? " open" : ""}`} aria-label="Source" aria-hidden={!open && citation === null}>
      {citation ? (
        <>
          <div className="head">
            <span className="label">Source {citation.cite}</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`badge ${citation.status}`}>{STATUS_LABEL[citation.status]}</span>
              <button type="button" className="icon-btn panel-close" aria-label="Close the source" onClick={onClose}>
                <IconClose />
              </button>
            </div>
          </div>
          <h2>{citation.title}</h2>
          <span className="path">
            {citation.section} / {citation.docId.split("/").slice(1).join("/") || citation.docId}
            {citation.headingPath.length > 0 ? ` > ${citation.headingPath.join(" > ")}` : ""}
          </span>
          <blockquote className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(citation.text) }} />
          {citation.warnings.map((w) => (
            <div className="warning" key={w}>
              <IconWarning />
              <span>{w}</span>
            </div>
          ))}
          <div className="facts">
            <span>Updated {shortDate(citation.updatedAt)}</span>
            <span aria-hidden="true">/</span>
            <span>from {originName(citation.url)}</span>
          </div>
          <a className="btn" style={{ alignSelf: "flex-start" }} href={citation.url} target="_blank" rel="noopener noreferrer">
            Open in {originName(citation.url)}
            <IconExternal />
          </a>
        </>
      ) : (
        <p className="source-empty">Click a citation number in an answer to see the exact passage and open the page.</p>
      )}
    </aside>
  );
}
