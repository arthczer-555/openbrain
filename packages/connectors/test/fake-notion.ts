import type { FetchLike, NotionBlock, NotionProperty } from "../src/index.ts";

// In-memory Notion API for tests: pages, block children (paginated), databases. No network.

export interface FakePage {
  title: string;
  last_edited_time: string;
  archived?: boolean;
}

export interface FakeDatabase {
  title: string;
  properties: Record<string, NotionProperty>;
  rows: Array<Record<string, NotionProperty>>;
}

export function id(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function text(content: string): Array<{ type: string; plain_text: string; href: null }> {
  return [{ type: "text", plain_text: content, href: null }];
}

let blockCounter = 1000;

export function paragraph(content: string): NotionBlock {
  return { object: "block", id: id(++blockCounter), type: "paragraph", has_children: false, paragraph: { rich_text: text(content) } };
}

export function heading(level: 1 | 2 | 3, content: string): NotionBlock {
  const type = `heading_${level}`;
  return { object: "block", id: id(++blockCounter), type, has_children: false, [type]: { rich_text: text(content) } };
}

export function childPage(pageId: string, title: string): NotionBlock {
  return { object: "block", id: pageId, type: "child_page", has_children: true, child_page: { title } };
}

export function childDatabase(databaseId: string, title: string): NotionBlock {
  return { object: "block", id: databaseId, type: "child_database", has_children: false, child_database: { title } };
}

export function linkToPage(pageId: string): NotionBlock {
  return { object: "block", id: id(++blockCounter), type: "link_to_page", has_children: false, link_to_page: { type: "page_id", page_id: pageId } };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export class FakeNotion {
  pages = new Map<string, FakePage>();
  children = new Map<string, NotionBlock[]>();
  databases = new Map<string, FakeDatabase>();
  calls: string[] = [];
  pageSize = 100;

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const route = url.pathname.replace(/^\/v1/, "");
    this.calls.push(`${method} ${route}`);
    let match: RegExpExecArray | null;

    if (route === "/users/me") return json(200, { object: "user", id: "bot", type: "bot", name: "OpenBrain", bot: { workspace_name: "Acme" } });

    if ((match = /^\/pages\/([^/]+)$/.exec(route))) {
      const pageId = match[1] ?? "";
      const page = this.pages.get(pageId);
      if (!page) return json(404, { object: "error", status: 404, code: "object_not_found", message: "Could not find page" });
      return json(200, {
        object: "page",
        id: pageId,
        url: `https://www.notion.so/acme/${pageId.replace(/-/g, "")}`,
        last_edited_time: page.last_edited_time,
        archived: page.archived ?? false,
        properties: { title: { id: "title", type: "title", title: text(page.title) } },
      });
    }

    if ((match = /^\/blocks\/([^/]+)\/children$/.exec(route))) {
      const all = this.children.get(match[1] ?? "") ?? [];
      const start = Number(url.searchParams.get("start_cursor") ?? "0");
      const slice = all.slice(start, start + this.pageSize);
      const nextStart = start + this.pageSize;
      const hasMore = nextStart < all.length;
      return json(200, { object: "list", results: slice, has_more: hasMore, next_cursor: hasMore ? String(nextStart) : null });
    }

    if ((match = /^\/databases\/([^/]+)(\/query)?$/.exec(route))) {
      const database = this.databases.get(match[1] ?? "");
      if (!database) return json(404, { object: "error", status: 404, code: "object_not_found", message: "Could not find database" });
      if (match[2]) {
        return json(200, {
          object: "list",
          results: database.rows.map((properties, i) => ({ object: "page", id: id(9000 + i), url: "", last_edited_time: "2026-10-01T00:00:00.000Z", properties })),
          has_more: false,
          next_cursor: null,
        });
      }
      return json(200, { object: "database", id: match[1], title: text(database.title), properties: database.properties });
    }

    return json(400, { object: "error", status: 400, code: "invalid_request_url", message: `no route for ${route}` });
  };

  callsTo(prefix: string): number {
    return this.calls.filter((c) => c.includes(prefix)).length;
  }
}
