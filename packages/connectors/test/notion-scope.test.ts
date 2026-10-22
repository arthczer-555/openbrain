import { describe, expect, it } from "vitest";
import { checkNotion, NotionClient, pagesOutsideTree, type FetchLike } from "../src/index.ts";

// The integration must see the root tree and nothing else.

const ROOT = "11111111-1111-1111-1111-111111111111";
const GUIDES = "22222222-2222-2222-2222-222222222222";
const COLUMN = "33333333-3333-3333-3333-333333333333";
const IN_COLUMN = "44444444-4444-4444-4444-444444444444";
const DATABASE = "55555555-5555-5555-5555-555555555555";
const ROW = "66666666-6666-6666-6666-666666666666";
const STRAY = "77777777-7777-7777-7777-777777777777";

type Parent = Record<string, unknown>;

const objects: Array<{ object: "page" | "database"; id: string; parent: Parent; title: string }> = [
  { object: "page", id: ROOT, parent: { type: "workspace", workspace: true }, title: "Acme brain" },
  { object: "page", id: GUIDES, parent: { type: "page_id", page_id: ROOT }, title: "Guides" },
  { object: "page", id: IN_COLUMN, parent: { type: "block_id", block_id: COLUMN }, title: "Inside a column" },
  { object: "database", id: DATABASE, parent: { type: "page_id", page_id: GUIDES }, title: "Pricing table" },
  { object: "page", id: ROW, parent: { type: "database_id", database_id: DATABASE }, title: "Row" },
  { object: "page", id: STRAY, parent: { type: "workspace", workspace: true }, title: "Board minutes" },
];
// Blocks that are not pages: only reachable through GET /blocks/{id}.
const blocks: Record<string, Parent> = { [COLUMN]: { type: "page_id", page_id: GUIDES } };

function asApi(o: (typeof objects)[number]): Record<string, unknown> {
  const rich = [{ type: "text", plain_text: o.title, href: null }];
  return o.object === "page"
    ? { object: "page", id: o.id, parent: o.parent, url: `https://www.notion.so/acme/${o.id.replace(/-/g, "")}`, last_edited_time: "2026-10-20T09:00:00.000Z", properties: { title: { type: "title", title: rich } } }
    : { object: "database", id: o.id, parent: o.parent, title: rich, properties: {} };
}

function fakeNotion(): { fetch: FetchLike; methods: string[] } {
  const methods: string[] = [];
  const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (input, init) => {
    const route = new URL(input).pathname.replace(/^\/v1/, "");
    methods.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/users/me") return reply({ object: "user", id: "bot", type: "bot", name: "OpenBrain", bot: { workspace_name: "Acme" } });
    if (route === "/search") return reply({ object: "list", results: objects.map(asApi), has_more: false, next_cursor: null });
    const page = /^\/pages\/(.+)$/.exec(route);
    if (page) {
      const found = objects.find((o) => o.id === page[1]);
      return found ? reply(asApi(found)) : reply({ object: "error", status: 404, code: "object_not_found", message: "no" }, 404);
    }
    const block = /^\/blocks\/([^/]+)$/.exec(route);
    if (block && block[1] && blocks[block[1]]) return reply({ object: "block", id: block[1], type: "column", has_children: true, parent: blocks[block[1]] });
    return reply({ object: "error", status: 400, code: "invalid_request_url", message: route }, 400);
  };
  return { fetch, methods };
}

describe("Notion scope check", () => {
  it("finds the pages shared outside the root tree, through columns and databases", async () => {
    const { fetch, methods } = fakeNotion();
    const client = new NotionClient({ token: "t", fetch, minIntervalMs: 0 });
    const scope = await pagesOutsideTree(client, ROOT);
    expect(scope.outside.map((p) => p.title)).toEqual(["Board minutes"]);
    expect(scope.partial).toBe(false);
    // Read-only: the only POST is the search.
    expect(methods.filter((m) => m.startsWith("POST"))).toEqual(["POST /search"]);
  });

  it("reports it as a warning of the health check", async () => {
    const { fetch } = fakeNotion();
    const report = await checkNotion(new NotionClient({ token: "t", fetch, minIntervalMs: 0 }), ROOT);
    expect(report.ok).toBe(true);
    expect(report.warnings?.[0]).toMatch(/1 page\(s\) outside the root tree \("Board minutes"\)/);
  });
});
