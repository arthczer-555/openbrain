import type { AppContext } from "./context.ts";
import { apiError, json, type RequestContext } from "./http.ts";
import type { KbIndex, KbPage, KbPageSummary } from "./protocol.ts";

// Read-only knowledge browser (the "Browse knowledge" link of the chat): rebuilt from the index, so the
// deployed function needs neither knowledge/ nor Notion. Every page links to its Notion original.

export async function handleKbIndex(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  await app.requireSession(request, ctx);
  const { index, sections } = app.deps.bundle;
  const pages = new Map<string, KbPageSummary[]>();
  for (const doc of Object.values(index.docs)) {
    const list = pages.get(doc.section) ?? [];
    list.push({ id: doc.id, title: doc.title, status: doc.status, updatedAt: doc.updatedAt, url: doc.url });
    pages.set(doc.section, list);
  }
  const body: KbIndex = {
    sections: sections
      .filter((s) => (pages.get(s.id)?.length ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        pages: (pages.get(s.id) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
      })),
  };
  return json(body);
}

export async function handleKbPage(app: AppContext, request: Request, ctx: RequestContext): Promise<Response> {
  await app.requireSession(request, ctx);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const docId = app.knowledge.resolveDocId(id);
  const read = docId ? app.knowledge.read(docId, { maxTokens: Number.MAX_SAFE_INTEGER }) : null;
  if (!docId || !read) return apiError(404, "not_found", "no such page");
  const body: KbPage = {
    id: docId,
    title: read.title,
    section: read.section,
    status: read.status,
    updatedAt: read.updatedAt,
    url: read.url,
    warnings: read.warnings,
    markdown: read.text,
  };
  return json(body);
}
