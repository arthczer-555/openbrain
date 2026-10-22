import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintKnowledgeBase, loadKnowledgeBase, parseMirrorFrontmatter } from "@openbrain/core";
import {
  NotionApiError,
  NotionClient,
  renderBlocks,
  richTextToMarkdown,
  slugify,
  syncNotion,
  type FetchLike,
  type NotionBlock,
  type NotionList,
  type RenderContext,
} from "../src/index.ts";
import { childDatabase, childPage, FakeNotion, heading, id, linkToPage, paragraph } from "./fake-notion.ts";

const noSleep = async (): Promise<void> => undefined;

function fakeClient(fake: FakeNotion): NotionClient {
  return new NotionClient({ token: "secret_test", fetch: fake.fetch, sleep: noSleep, minIntervalMs: 0 });
}

async function loadFixture(): Promise<NotionBlock[]> {
  const raw = await readFile(new URL("./fixtures/notion-blocks.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as NotionList<NotionBlock>).results;
}

function ctxWith(children: Record<string, NotionBlock[]>, warnings: string[] = []): RenderContext {
  return {
    children: async (blockId) => children[blockId] ?? [],
    childPage: (pageId, title) => `${slugify(title)}.md#${pageId.slice(-2)}`,
    pageLink: (pageId) => `https://www.notion.so/${pageId}`,
    database: async (_dbId, title) => `### ${title}`,
    warn: (message) => warnings.push(message),
  };
}

describe("render", () => {
  it("renders rich text annotations and links", () => {
    expect(
      richTextToMarkdown([
        { type: "text", plain_text: "Bold ", href: null, annotations: { bold: true } },
        { type: "text", plain_text: "link", href: "https://x.test", annotations: { italic: true } },
        { type: "text", plain_text: " and ", href: null },
        { type: "text", plain_text: "code", href: null, annotations: { code: true } },
      ]),
    ).toBe("**Bold** [*link*](https://x.test) and `code`");
  });

  it("renders a recorded page of blocks to Markdown", async () => {
    const blocks = await loadFixture();
    const warnings: string[] = [];
    const markdown = await renderBlocks(
      blocks,
      ctxWith(
        {
          "b0000000-0000-0000-0000-000000000003": [
            { object: "block", id: "c1", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [{ type: "text", plain_text: "nested item", href: null }] } },
          ],
          "b0000000-0000-0000-0000-000000000009": [
            { object: "block", id: "r1", type: "table_row", has_children: false, table_row: { cells: [[{ type: "text", plain_text: "Age", href: null }], [{ type: "text", plain_text: "Refund", href: null }]] } },
            { object: "block", id: "r2", type: "table_row", has_children: false, table_row: { cells: [[{ type: "text", plain_text: "Under 30 days", href: null }], [{ type: "text", plain_text: "full | partial", href: null }]] } },
          ],
          "b0000000-0000-0000-0000-000000000014": [paragraph("Inside the toggle.")],
        },
        warnings,
      ),
    );
    expect(markdown).toContain("## Refund an invoice");
    expect(markdown).toContain("Refund **within 30 days** of payment, from `Settings`. See the [*help center*](https://help.example.com/refunds).");
    expect(markdown).toContain("- Client side\n   - nested item\n1. Open the invoice\n2. Click Refund\n- [x] Notify the account manager");
    expect(markdown).toContain("> ⚠️ A refund over 500 EUR needs a manager.");
    expect(markdown).toContain("```bash\ncurl -X POST /invoices/42/refund\n```");
    expect(markdown).toContain("| Age | Refund |\n|---|---|\n| Under 30 days | full \\| partial |");
    expect(markdown).toContain("\n---\n");
    expect(markdown).toContain("[image: Refund button](https://cdn.example.com/refund.png)");
    expect(markdown).toContain("[image (file in Notion)]");
    expect(markdown).not.toContain("s3.example.com");
    expect(markdown).toContain("[https://status.example.com](https://status.example.com)");
    expect(markdown).toContain("**Edge cases**\n\nInside the toggle.");
    expect(markdown).toContain("- [Partial refunds](partial-refunds.md#15)");
    expect(warnings).toEqual([]);
  });

  it("slugifies titles with accents and emoji", () => {
    expect(slugify("🎓 Équipes & réglages")).toBe("equipes-reglages");
    expect(slugify("!!!")).toBe("page");
  });
});

describe("NotionClient", () => {
  it("honors Retry-After on 429 and retries 5xx with backoff", async () => {
    const sleeps: number[] = [];
    const responses = [
      new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
      new Response("{}", { status: 503 }),
      new Response(JSON.stringify({ object: "user", id: "bot" }), { status: 200 }),
    ];
    const fetchImpl: FetchLike = async () => responses.shift() ?? new Response("{}", { status: 500 });
    const client = new NotionClient({ token: "t", fetch: fetchImpl, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    const me = await client.me();
    expect(me.id).toBe("bot");
    expect(sleeps).toEqual([2000, 1000]);
    expect(client.requestCount).toBe(3);
  });

  it("throws a typed error on 404 without retrying", async () => {
    const fake = new FakeNotion();
    const client = fakeClient(fake);
    const error = await client.getPage(id(42)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).notFound).toBe(true);
    expect(client.requestCount).toBe(1);
  });

  it("spaces requests to respect the rate limit", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fake = new FakeNotion();
    fake.pages.set(id(1), { title: "A", last_edited_time: "2026-10-01T00:00:00.000Z" });
    const client = new NotionClient({
      token: "t",
      fetch: fake.fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([client.getPage(id(1)), client.getPage(id(1)), client.getPage(id(1))]);
    expect(sleeps).toEqual([340, 340]);
  });

  it("follows pagination of block children", async () => {
    const fake = new FakeNotion();
    fake.pageSize = 2;
    fake.children.set(id(1), [paragraph("a"), paragraph("b"), paragraph("c"), paragraph("d"), paragraph("e")]);
    const blocks = await fakeClient(fake).listChildren(id(1));
    expect(blocks).toHaveLength(5);
    expect(fake.callsTo("/children")).toBe(3);
  });
});

// A small Notion tree: root -> Product (Tickets & SLAs -> Breached SLA, Tarifs détaillés with a database), People & HR.
const ROOT = id(1);
const PRODUCT = id(10);
const TICKETS = id(11);
const BREACH = id(12);
const PRICING = id(13);
const PEOPLE = id(20);
const REMOTE = id(21);
const PLANS_DB = id(30);
const T0 = "2026-10-01T09:00:00.000Z";
const T1 = "2026-10-20T09:00:00.000Z";

function world(): FakeNotion {
  const fake = new FakeNotion();
  fake.pages.set(PRODUCT, { title: "Product", last_edited_time: T0 });
  fake.pages.set(TICKETS, { title: "Tickets & SLAs", last_edited_time: T0 });
  fake.pages.set(BREACH, { title: "Breached SLA", last_edited_time: T0 });
  fake.pages.set(PRICING, { title: "Tarifs détaillés", last_edited_time: T0 });
  fake.pages.set(PEOPLE, { title: "People & HR", last_edited_time: T0 });
  fake.pages.set(REMOTE, { title: "Remote work", last_edited_time: T0 });
  fake.children.set(ROOT, [paragraph("Root intro, not mirrored."), childPage(PRODUCT, "Product"), childPage(PEOPLE, "People & HR")]);
  fake.children.set(PRODUCT, [childPage(TICKETS, "Tickets & SLAs"), childPage(PRICING, "Tarifs détaillés")]);
  fake.children.set(TICKETS, [heading(1, "Reply times"), paragraph("First reply within 4 hours."), childPage(BREACH, "Breached SLA"), linkToPage(PRICING)]);
  fake.children.set(BREACH, [paragraph("After 8 hours: escalate to the on-call lead.")]);
  fake.children.set(PRICING, [paragraph("Each plan includes a number of seats."), childDatabase(PLANS_DB, "Plans")]);
  fake.children.set(PEOPLE, [childPage(REMOTE, "Remote work")]);
  fake.children.set(REMOTE, [paragraph("Up to three days a week.")]);
  fake.databases.set(PLANS_DB, {
    title: "Plans",
    properties: { Name: { type: "title", title: {} }, Seats: { type: "number", number: {} }, Tier: { type: "select", select: {} } },
    rows: [
      { Name: { type: "title", title: [{ type: "text", plain_text: "Starter", href: null }] }, Seats: { type: "number", number: 10 }, Tier: { type: "select", select: { name: "Basic" } } },
      { Name: { type: "title", title: [{ type: "text", plain_text: "Scale", href: null }] }, Seats: { type: "number", number: 50 }, Tier: { type: "select", select: { name: "Pro" } } },
    ],
  });
  return fake;
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openbrain-notion-"));
}

async function read(root: string, rel: string): Promise<string> {
  return readFile(path.join(root, "knowledge", `${rel}.md`), "utf8");
}

describe("syncNotion", () => {
  it("mirrors the tree with valid frontmatter, relative links and sticky sections", async () => {
    const fake = world();
    const root = await tempRoot();
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });

    expect(report.written).toEqual([
      "people-hr/index",
      "people-hr/remote-work",
      "product/index",
      "product/tarifs-detailles",
      "product/tickets-slas",
      "product/tickets-slas/breached-sla",
    ]);
    const tickets = await read(root, "product/tickets-slas");
    const parsed = parseMirrorFrontmatter(tickets);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ id: "product/tickets-slas", title: "Tickets & SLAs", section: "product" });
    expect(parsed.value.source.page_id).toBe(TICKETS);
    expect(parsed.value.updated_at).toBe(T0);
    expect(parsed.body).toContain("# Tickets & SLAs\n\n## Reply times\n\nFirst reply within 4 hours.");
    expect(parsed.body).toContain("- [Breached SLA](tickets-slas/breached-sla.md)");
    expect(parsed.body).toContain("- [Linked page](tarifs-detailles.md)");
    expect(await read(root, "product/index")).toContain("- [Tickets & SLAs](tickets-slas.md)\n- [Tarifs détaillés](tarifs-detailles.md)");
    expect(await read(root, "product/tarifs-detailles")).toContain("### Plans\n\n| Name | Seats | Tier |\n|---|---|---|\n| Starter | 10 | Basic |");
    expect(await read(root, "product/index")).not.toContain("Root intro");

    // The mirror loads, has no broken link, and every page holding knowledge asks for a registry entry.
    const issues = lintKnowledgeBase(await loadKnowledgeBase(root));
    expect(issues.filter((i) => i.rule === "broken-link")).toEqual([]);
    expect(issues.filter((i) => i.rule === "missing-registry-entry").map((i) => i.file).sort()).toEqual([
      "knowledge/people-hr/remote-work.md",
      "knowledge/product/tarifs-detailles.md",
      "knowledge/product/tickets-slas.md",
      "knowledge/product/tickets-slas/breached-sla.md",
    ]);
    expect(existsSync(path.join(root, "state/notion-sync.json"))).toBe(true);
  });

  it("skips unchanged pages on the next run (no block fetch)", async () => {
    const fake = world();
    const root = await tempRoot();
    await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    fake.calls = [];
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    expect(report.written).toEqual([]);
    expect(report.unchanged).toBe(6);
    expect(fake.callsTo("/children")).toBe(1); // the root page only
    expect(fake.callsTo("/databases/")).toBe(0);
  });

  it("keeps the path of a renamed page and updates its title", async () => {
    const fake = world();
    const root = await tempRoot();
    await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    fake.pages.set(TICKETS, { title: "Tickets, SLAs and escalations", last_edited_time: T1 });
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    expect(report.written).toEqual(["product/tickets-slas"]);
    expect(report.renamed).toEqual([{ path: "product/tickets-slas", from: "Tickets & SLAs", to: "Tickets, SLAs and escalations" }]);
    expect(await read(root, "product/tickets-slas")).toContain("title: Tickets, SLAs and escalations");
  });

  it("removes pages deleted in Notion and their empty folders", async () => {
    const fake = world();
    const root = await tempRoot();
    await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    fake.children.set(TICKETS, [heading(1, "Reply times"), paragraph("First reply within 4 hours.")]);
    fake.pages.set(TICKETS, { title: "Tickets & SLAs", last_edited_time: T1 });
    fake.pages.set(BREACH, { title: "Breached SLA", last_edited_time: T1, archived: true });
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    expect(report.deleted).toEqual(["product/tickets-slas/breached-sla"]);
    expect(existsSync(path.join(root, "knowledge/product/tickets-slas"))).toBe(false);
  });

  it("writes nothing in dry-run mode", async () => {
    const fake = world();
    const root = await tempRoot();
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake), dryRun: true });
    expect(report.written).toHaveLength(6);
    expect(existsSync(path.join(root, "knowledge/product/index.md"))).toBe(false);
    expect(existsSync(path.join(root, "state/notion-sync.json"))).toBe(false);
  });

  it("reports a database that is not shared with the integration", async () => {
    const fake = world();
    fake.databases.clear();
    const root = await tempRoot();
    const report = await syncNotion({ root, rootPageId: ROOT, client: fakeClient(fake) });
    expect(report.warnings.join("\n")).toContain('database "Plans" in product/tarifs-detailles is not shared');
    expect(await read(root, "product/tarifs-detailles")).toContain('_Database "Plans" is not shared with the integration._');
  });
});
