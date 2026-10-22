import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChangesOptions, ListOptions, SourceRef, StreamEvent } from "@openbrain/core";
import {
  createMcpConnector,
  loadMcpMapping,
  McpWriteToolError,
  parseMcpMapping,
  renderArgs,
  writeLikeReason,
  type McpConnector,
  type McpMapping,
} from "../../src/index.ts";
import { collectAll } from "./helpers.ts";

// A fictional "Acme Tracker" MCP server, in memory: read tools, one write tool, and two tools that look
// read-only by name but are not (by description, by annotation). Calls are counted per tool.

const ISSUES = [
  {
    identifier: "ACME-12",
    title: "SSO login loops",
    url: "https://tracker.acme.example/ACME-12",
    updatedAt: "2026-10-21T10:00:00Z",
    description: "Users are redirected to the login page again after SAML.",
    state: { name: "Done" },
    labels: [{ name: "bug" }, { name: "auth" }],
    assignee: { name: "Dev A" },
  },
  {
    identifier: "ACME-11",
    title: "Export to CSV",
    url: "https://tracker.acme.example/ACME-11",
    updatedAt: "2026-10-18T09:00:00Z",
    description: "Exports are available from Settings > Data.",
    state: { name: "Done" },
    labels: [{ name: "feature" }],
    assignee: { name: "Dev B" },
  },
  {
    identifier: "ACME-3",
    title: "Old ticket",
    url: "https://tracker.acme.example/ACME-3",
    updatedAt: "2026-09-01T09:00:00Z",
    description: "Ignored: outside of the window.",
    state: { name: "Done" },
    labels: [],
    assignee: null,
  },
];

let calls: Record<string, Array<Record<string, unknown>>>;

function startServer(): () => InMemoryTransport {
  return () => {
    const server = new McpServer({ name: "acme-tracker", version: "1.2.0" });
    const record = (tool: string, args: Record<string, unknown>): void => {
      calls[tool] = [...(calls[tool] ?? []), args];
    };
    server.registerTool(
      "list_issues",
      {
        description: "List issues of the Acme tracker, most recently updated first. Filter with updatedAfter.",
        inputSchema: { updatedAfter: z.string().optional(), after: z.string().optional(), limit: z.number().optional() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        record("list_issues", args);
        const page = args.after === "c1" ? ISSUES.slice(2) : ISSUES.slice(0, 2);
        const body = { issues: page, pageInfo: { endCursor: args.after === "c1" ? null : "c1" } };
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      },
    );
    server.registerTool(
      "get_issue",
      { description: "Get one issue with its full description.", inputSchema: { id: z.string() } },
      async (args) => {
        record("get_issue", args);
        const issue = ISSUES.find((i) => i.identifier === args.id);
        return { content: [{ type: "text", text: JSON.stringify({ issue }) }], structuredContent: { issue } };
      },
    );
    server.registerTool(
      "create_issue",
      { description: "Creates a new issue in the tracker.", inputSchema: { title: z.string() } },
      async (args) => {
        record("create_issue", args);
        return { content: [{ type: "text", text: "created" }] };
      },
    );
    server.registerTool("export_items", { description: "Deletes the items once they have been exported." }, async () => {
      record("export_items", {});
      return { content: [{ type: "text", text: "{}" }] };
    });
    server.registerTool("fetch_items", { description: "Fetch items.", annotations: { destructiveHint: true } }, async () => {
      record("fetch_items", {});
      return { content: [{ type: "text", text: "{}" }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return clientSide;
  };
}

const STREAM_MAPPING = fileURLToPath(new URL("../../../../examples/acme/connectors/tracker.mapping.yaml", import.meta.url));
const WINDOW = { since: "2026-10-15T00:00:00Z", until: "2026-10-22T00:00:00Z" };

function documentsMapping(withFetch: boolean): McpMapping {
  return parseMcpMapping({
    kind: "documents",
    list: { tool: "list_issues", args: { updatedAfter: "{{since}}" }, items: "$.issues[*]", paginate: { cursor_arg: "after", next: "$.pageInfo.endCursor" } },
    ...(withFetch ? { fetch: { tool: "get_issue", args: { id: "{{id}}" }, text: "{{$.issue.description}}\n\nState: {{$.issue.state.name}}" } } : {}),
    map: { id: "$.identifier", title: "$.title", url: "$.url", modifiedAt: "$.updatedAt", ...(withFetch ? {} : { text: "$.description" }) },
  });
}

let connectors: McpConnector[];

function changesOf(connector: McpConnector, window: ChangesOptions): AsyncIterable<StreamEvent> {
  if (!connector.changes) throw new Error(`${connector.id} is not a stream`);
  return connector.changes(window);
}

function listOf(connector: McpConnector, opts: ListOptions): AsyncIterable<SourceRef> {
  if (!connector.list) throw new Error(`${connector.id} has no documents`);
  return connector.list(opts);
}

function connect(mapping: McpMapping): McpConnector {
  const connector = createMcpConnector({ id: "mcp:tracker", mapping, transport: startServer(), now: () => Date.parse("2026-10-22T10:00:00Z") });
  connectors.push(connector);
  return connector;
}

beforeEach(() => {
  calls = {};
  connectors = [];
  return async () => {
    for (const c of connectors) await c.close();
  };
});

describe("MCP write-tool guard", () => {
  it("refuses write verbs in names, write actions in descriptions, and destructive annotations", () => {
    expect(writeLikeReason({ name: "create_issue" })).toBe('its name contains "create"');
    expect(writeLikeReason({ name: "issues.delete" })).toBeDefined();
    expect(writeLikeReason({ name: "setStatus" })).toBe('its name contains "set"');
    expect(writeLikeReason({ name: "sendMessage" })).toBeDefined();
    expect(writeLikeReason({ name: "fetch", description: "Use this tool to send a message to a channel." })).toBeDefined();
    expect(writeLikeReason({ name: "export_items", description: "Deletes the items once exported." })).toBeDefined();
    expect(writeLikeReason({ name: "fetch_items", annotations: { destructiveHint: true } })).toBe("annotated destructiveHint: true");
    expect(writeLikeReason({ name: "get_page", annotations: { readOnlyHint: false } })).toBe("annotated readOnlyHint: false");
  });

  it("lets read tools through, even when they mention dates or nouns like updates and posts", () => {
    expect(writeLikeReason({ name: "list_updates", description: "List the updates, sorted by updated date." })).toBeUndefined();
    expect(writeLikeReason({ name: "get_settings", description: "Get the workspace settings." })).toBeUndefined();
    expect(writeLikeReason({ name: "search_posts", description: "Returns posts and their replies, with created and edited dates." })).toBeUndefined();
    expect(writeLikeReason({ name: "list_issues", description: "List issues, including archived ones." })).toBeUndefined();
  });
});

describe("MCP mapping", () => {
  it("loads the Acme example mapping", async () => {
    const mapping = await loadMcpMapping(STREAM_MAPPING);
    expect(mapping).toMatchObject({ kind: "stream", list: { tool: "list_issues", paginate: { cursor_arg: "after", max_pages: 20 } }, event_kind: "ticket" });
  });

  it("validates the mapping with readable errors", () => {
    expect(() => parseMcpMapping({ kind: "documents", list: { tool: "list_issues", items: "$.issues[*]" }, map: { id: "$.id", title: "$.t", modifiedAt: "$.u" } })).toThrow(
      /map\.text: map\.text or fetch is required/,
    );
    expect(() => parseMcpMapping({ kind: "stream", list: { tool: "x", items: "issues" }, map: { id: "$.id", title: "$.t", modifiedAt: "$.u", text: "$.x" } })).toThrow(
      /list\.items: expected a JSONPath/,
    );
  });

  it("renders args and drops variables without a value", () => {
    expect(renderArgs({ updatedAfter: "{{since}}", q: "updated:>{{since}}", limit: 5, nested: { until: "{{until}}" } }, { until: "2026-10-22" })).toEqual({
      q: "updated:>",
      limit: 5,
      nested: { until: "2026-10-22" },
    });
  });
});

describe("MCP connector", () => {
  it("turns a list tool into stream events of the window, following the cursor", async () => {
    const connector = connect(await loadMcpMapping(STREAM_MAPPING));
    expect(connector.kind).toBe("stream");
    const events = await collectAll(changesOf(connector, WINDOW));
    expect(events.map((e) => [e.ref.id, e.kind, e.occurredAt, e.author])).toEqual([
      ["ACME-12", "ticket", "2026-10-21T10:00:00.000Z", "Dev A"],
      ["ACME-11", "ticket", "2026-10-18T09:00:00.000Z", "Dev B"],
    ]);
    expect(events[0]?.ref).toMatchObject({ title: "ACME-12: SSO login loops", url: "https://tracker.acme.example/ACME-12" });
    expect(events[0]?.text).toBe("Users are redirected to the login page again after SAML.\n\nStatus: Done\nLabels: bug, auth");
    expect(calls.list_issues).toEqual([
      { updatedAfter: WINDOW.since, limit: 50 },
      { updatedAfter: WINDOW.since, limit: 50, after: "c1" },
    ]);
  });

  it("serves documents from the list items, or through a fetch tool", async () => {
    const inline = connect(documentsMapping(false));
    const refs = await collectAll(listOf(inline, { since: WINDOW.since }));
    expect(refs.map((r) => r.id)).toEqual(["ACME-12", "ACME-11"]);
    const first = refs[0];
    if (!first || !inline.fetch) throw new Error("missing ref");
    expect((await inline.fetch(first)).markdown).toBe("Users are redirected to the login page again after SAML.");
    expect(calls.list_issues?.[0]).toEqual({ updatedAfter: WINDOW.since });

    const fetched = connect(documentsMapping(true));
    const [ref] = await collectAll(listOf(fetched, {}));
    if (!ref || !fetched.fetch) throw new Error("missing ref");
    expect((await fetched.fetch(ref)).markdown).toBe("Users are redirected to the login page again after SAML.\n\nState: Done");
    expect(calls.get_issue).toEqual([{ id: "ACME-12" }]);
    // No since on a full collection: the {{since}} argument is omitted.
    expect(calls.list_issues?.at(-2)).toEqual({});
  });

  it("refuses a write tool by name before connecting", () => {
    const mapping = parseMcpMapping({ kind: "stream", list: { tool: "create_issue", items: "$" }, map: { id: "$.id", title: "$.t", modifiedAt: "$.u", text: "$.x" } });
    expect(() => createMcpConnector({ id: "mcp:tracker", mapping, transport: startServer() })).toThrow(McpWriteToolError);
    expect(calls).toEqual({});
  });

  it("refuses tools that are write-like by description or annotation before any call", async () => {
    for (const tool of ["export_items", "fetch_items"]) {
      const mapping = parseMcpMapping({ kind: "stream", list: { tool, items: "$" }, map: { id: "$.id", title: "$.t", modifiedAt: "$.u", text: "$.x" } });
      const connector = connect(mapping);
      await expect(collectAll(changesOf(connector, WINDOW))).rejects.toBeInstanceOf(McpWriteToolError);
    }
    expect(calls).toEqual({});
  });

  it("reports an unknown tool with the available ones", async () => {
    const mapping = parseMcpMapping({ kind: "stream", list: { tool: "list_tickets", items: "$" }, map: { id: "$.id", title: "$.t", modifiedAt: "$.u", text: "$.x" } });
    await expect(collectAll(changesOf(connect(mapping), WINDOW))).rejects.toThrow(/"list_tickets" not found on the server \(available: list_issues, get_issue/);
  });

  it("test(): server identity, write-like tools present but unused, and a sample", async () => {
    const report = await connect(await loadMcpMapping(STREAM_MAPPING)).test();
    expect(report).toMatchObject({ ok: true, identity: "MCP server acme-tracker 1.2.0", writeScopesDetected: true });
    expect(report.scopes).toEqual(["5 tools on the server, mapped: list_issues", "write-like tools present (never called): create_issue, export_items, fetch_items"]);
    expect(report.sample?.map((r) => r.id)).toEqual(["ACME-12", "ACME-11"]);
    expect(Object.keys(calls)).toEqual(["list_issues"]);
  });
});
