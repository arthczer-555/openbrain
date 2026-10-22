import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangesOptions, ListOptions, SourceRef, StreamEvent } from "@openbrain/core";
import {
  createApiConnector,
  describeInputs,
  parseApiMapping,
  parseInputsConfig,
  windowVars,
  type ApiConnector,
  type ApiMapping,
} from "../../src/index.ts";
import { collectAll, expectReadOnly, json, noSleep, RecordingFetch } from "./helpers.ts";

// A fictional "Acme CRM" REST API: deals (stream, cursor pagination) and help articles (documents, page
// numbers, then a detail request per article). No network: every request goes through a recording fetch.

const BASE = "https://api.crm.acme.example/v2";
const NOW = Date.parse("2026-10-22T12:00:00Z");

const DEALS = [
  { id: "d-41", name: "Globex renewal", stage: "closed_won", updatedAt: "2026-10-21T09:00:00Z", owner: { name: "Rep A" } },
  { id: "d-40", name: "Initech pilot", stage: "proposal", updatedAt: "2026-10-19T15:00:00Z", owner: { name: "Rep B" } },
  { id: "d-12", name: "Old deal", stage: "lost", updatedAt: "2026-08-01T10:00:00Z", owner: null },
];

const dealsMapping: ApiMapping = parseApiMapping({
  kind: "stream",
  list: {
    path: "/deals",
    query: { updated_since: "{{since_date}}", limit: 2 },
    items: "$.results[*]",
    paginate: { cursor_param: "after", next: "$.paging.next" },
  },
  map: {
    id: "$.id",
    title: "{{$.name}}",
    url: "https://crm.acme.example/deals/{{$.id}}",
    modifiedAt: "$.updatedAt",
    author: "$.owner.name",
    text: "Deal {{$.name}} moved to {{$.stage}}",
  },
  event_kind: "deal_change",
});

function changesOf(connector: ApiConnector, window: ChangesOptions): AsyncIterable<StreamEvent> {
  if (!connector.changes) throw new Error(`${connector.id} is not a stream`);
  return connector.changes(window);
}

function listOf(connector: ApiConnector, opts: ListOptions): AsyncIterable<SourceRef> {
  if (!connector.list) throw new Error(`${connector.id} has no documents`);
  return connector.list(opts);
}

function crm(): RecordingFetch {
  return new RecordingFetch()
    .on(`${BASE}/deals`, (url) => {
      const after = url.searchParams.get("after");
      return after === "c2"
        ? json({ results: [DEALS[2]], paging: {} })
        : json({ results: DEALS.slice(0, 2), paging: { next: "c2" } });
    })
    .on(`${BASE}/articles`, (url) => {
      const page = url.searchParams.get("page");
      if (page === "1") return json({ articles: [{ id: 7, title: "Reset a password", updated: "2026-10-20T08:00:00Z" }] });
      if (page === "2") return json({ articles: [{ id: 8, title: "Export data", updated: "2026-10-01T08:00:00Z" }] });
      return json({ articles: [] });
    })
    .on(/\/articles\/\d+$/, (url) => json({ article: { body: `Body of article ${url.pathname.split("/").pop() ?? ""}` } }));
}

describe("api input (generic REST)", () => {
  it("reads a stream with cursor pagination, GET only, bearer token in the header", async () => {
    const http = crm();
    const connector = createApiConnector({
      id: "api:crm",
      baseUrl: BASE,
      mapping: dealsMapping,
      auth: { type: "bearer", env: "CRM_TOKEN" },
      env: { CRM_TOKEN: "secret-123" },
      fetch: http.fetch,
      sleep: noSleep,
      now: () => NOW,
    });
    const events = await collectAll(changesOf(connector, { since: "2026-10-15T00:00:00Z", until: "2026-10-22T12:00:00Z" }));
    expect(events.map((e) => e.ref.id)).toEqual(["d-41", "d-40"]);
    expect(events[0]).toMatchObject({ kind: "deal_change", author: "Rep A", text: "Deal Globex renewal moved to closed_won" });
    expect(events[0]?.ref.url).toBe("https://crm.acme.example/deals/d-41");
    expectReadOnly(http.calls);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.url).toBe(`${BASE}/deals?updated_since=2026-10-15&limit=2`);
    expect(http.calls[1]?.url).toContain("after=c2");
    expect(http.calls.every((c) => c.headers.authorization === "Bearer secret-123")).toBe(true);
  });

  it("reads documents with page numbers and a fetch request per item", async () => {
    const http = crm();
    const connector = createApiConnector({
      id: "api:help",
      baseUrl: `${BASE}/`,
      mapping: parseApiMapping({
        kind: "documents",
        list: { path: "articles", items: "$.articles[*]", paginate: { page_param: "page" } },
        fetch: { path: "/articles/{{id}}", text: "$.article.body" },
        map: { id: "$.id", title: "$.title", modifiedAt: "$.updated" },
      }),
      auth: { type: "header", name: "X-Api-Key", env: "HELP_KEY" },
      env: { HELP_KEY: "k-1" },
      fetch: http.fetch,
      sleep: noSleep,
      now: () => NOW,
    });
    const refs = await collectAll(listOf(connector, { since: "2026-10-10T00:00:00Z" }));
    expect(refs.map((r) => r.id)).toEqual(["7"]);
    const doc = await connector.fetch?.(refs[0] as SourceRef);
    expect(doc?.markdown).toBe("Body of article 7");
    expectReadOnly(http.calls);
    expect(http.urls()).toEqual([`${BASE}/articles?page=1`, `${BASE}/articles?page=2`, `${BASE}/articles?page=3`, `${BASE}/articles/7`]);
    expect(http.calls.every((c) => c.headers["x-api-key"] === "k-1")).toBe(true);
  });

  it("never sends the credential to another host, and masks it in errors", async () => {
    const http = new RecordingFetch()
      .on(`${BASE}/items`, json({ items: [{ id: "1", t: "a", m: "2026-10-21" }], next: "https://evil.example/steal" }))
      .on(`${BASE}/missing`, json({ error: "bad key k-secret" }, 401));
    const make = (mapping: ApiMapping) =>
      createApiConnector({
        id: "api:x",
        baseUrl: BASE,
        mapping,
        auth: { type: "query", name: "key", env: "X_KEY" },
        env: { X_KEY: "k-secret" },
        fetch: http.fetch,
        sleep: noSleep,
        now: () => NOW,
      });
    const map = { id: "$.id", title: "$.t", modifiedAt: "$.m", text: "$.t" };
    const offHost = make(parseApiMapping({ kind: "documents", list: { path: "/items", items: "$.items[*]", paginate: { next_url: "$.next" } }, map }));
    await expect(collectAll(listOf(offHost, {}))).rejects.toThrow(/only https:\/\/api\.crm\.acme\.example is allowed/);
    expect(http.urls().some((u) => u.includes("evil.example"))).toBe(false);

    const failing = make(parseApiMapping({ kind: "documents", list: { path: "/missing", items: "$.items[*]" }, map }));
    const report = await failing.test();
    expect(report.ok).toBe(false);
    expect(report.error).toContain("HTTP 401");
    expect(report.error).not.toContain("k-secret");
  });

  it("refuses a non-https base_url and an incomplete pagination", () => {
    expect(() => createApiConnector({ id: "api:x", baseUrl: "http://api.acme.example", mapping: dealsMapping })).toThrow(/https/);
    expect(() => createApiConnector({ id: "api:x", baseUrl: "http://localhost:8080", mapping: dealsMapping })).not.toThrow();
    expect(() =>
      parseApiMapping({ kind: "stream", list: { path: "/a", items: "$[*]", paginate: { cursor_param: "after" } }, map: { id: "$.id", title: "$.id", modifiedAt: "$.d", text: "$.id" } }),
    ).toThrow(/cursor_param and next/);
  });

  it("is declared under inputs.api and listed as api:<name>", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openbrain-api-"));
    await writeFile(
      path.join(root, "crm.mapping.yaml"),
      "kind: stream\nlist: { path: /deals, items: \"$.results[*]\" }\nmap: { id: \"$.id\", title: \"$.name\", modifiedAt: \"$.updatedAt\", text: \"$.stage\" }\n",
    );
    const inputs = parseInputsConfig({ api: { crm: { base_url: BASE, auth: { env: "CRM_TOKEN" }, mapping: "./crm.mapping.yaml" } } });
    const [entry] = describeInputs(inputs, { root, env: {} });
    expect(entry).toMatchObject({ id: "api:crm", dir: "api-crm", supported: true, enabled: true, kinds: ["stream"] });
    expect(entry?.env).toEqual([{ name: "CRM_TOKEN", set: false }]);
    expect(() => parseInputsConfig({ api: { x: { base_url: BASE, auth: { type: "header", env: "K" }, mapping: "m.yaml" } } })).toThrow(/need a name/);
  });

  it("offers the window in several date formats", () => {
    expect(windowVars("2026-10-15T00:00:00Z", "2026-10-22T12:00:00Z")).toEqual({
      since: "2026-10-15T00:00:00Z",
      until: "2026-10-22T12:00:00Z",
      since_date: "2026-10-15",
      until_date: "2026-10-22",
      since_unix: "1792022400",
      until_unix: "1792670400",
    });
  });
});
