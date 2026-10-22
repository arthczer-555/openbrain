import { useEffect, useMemo, useState } from "react";
import type { KbIndex, KbPage, PublicConfig } from "@openbrain/server/protocol";
import { IconExternal, IconWarning } from "../components/icons.tsx";
import { Mark } from "../components/Logo.tsx";
import { originName } from "../components/SourcePanel.tsx";
import { api } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { Link, navigate, useRoute } from "../lib/router.tsx";
import { shortDate } from "../lib/time.ts";

// "Browse knowledge": the mirror of Notion, read-only, so anyone can check what the chatbot knows.

const STATUS: Record<KbPage["status"], string> = { validated: "Validated", to_confirm: "To confirm", stale: "May be outdated" };

export function Knowledge({ config }: { config: PublicConfig }) {
  const route = useRoute();
  const pageId = route.query.get("page");
  const [index, setIndex] = useState<KbIndex | null>(null);
  const [page, setPage] = useState<KbPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.kb().then(setIndex, () => setError("The knowledge base could not be loaded."));
  }, []);

  useEffect(() => {
    const id = pageId ?? index?.sections[0]?.pages[0]?.id;
    if (!id) return;
    setPage(null);
    api.kbPage(id).then(setPage, () => setError("This page does not exist."));
  }, [pageId, index]);

  const html = useMemo(() => {
    if (!page) return "";
    let origins = new Set<string>();
    try {
      origins = new Set([new URL(page.url).origin]);
    } catch {
      origins = new Set();
    }
    return renderMarkdown(page.markdown, origins);
  }, [page]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-inner">
          <Link href="/" className="brand">
            <Mark logoUrl={config.logoUrl} />
            <span>{config.assistantName}</span>
            <span className="tag">knowledge</span>
          </Link>
          <nav className="tabs" aria-label="Sections">
            <Link href="/" className="tab">
              Back to chat
            </Link>
          </nav>
        </div>
      </header>
      <div className="page-body">
        {error && <div className="empty">{error}</div>}
        {!index ? (
          !error && (
            <div className="loading">
              <div className="spinner" />
            </div>
          )
        ) : (
          <div className="kb">
            <nav className="kb-nav" aria-label="Pages">
              {index.sections.map((section) => (
                <div key={section.id}>
                  <h3>{section.title}</h3>
                  <p>{section.description}</p>
                  <ul>
                    {section.pages.map((p) => (
                      <li key={p.id}>
                        <button type="button" aria-current={page?.id === p.id} onClick={() => navigate(`/kb?page=${encodeURIComponent(p.id)}`)}>
                          {p.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <article className="kb-page">
              {page ? (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                    <span className={`badge ${page.status}`}>{STATUS[page.status]}</span>
                    <span className="cell-mono">{page.id}</span>
                    <span className="cell-date">updated {shortDate(page.updatedAt)}</span>
                  </div>
                  <h2>{page.title}</h2>
                  {page.warnings.map((w) => (
                    <div className="warning" key={w}>
                      <IconWarning />
                      <span>{w}</span>
                    </div>
                  ))}
                  <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
                  <a className="btn" style={{ alignSelf: "flex-start" }} href={page.url} target="_blank" rel="noopener noreferrer">
                    Open in {originName(page.url)}
                    <IconExternal />
                  </a>
                </>
              ) : (
                <div className="loading" style={{ minHeight: 200 }}>
                  <div className="spinner" />
                </div>
              )}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
