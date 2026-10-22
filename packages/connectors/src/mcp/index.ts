import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChangesOptions, HealthReport, ListOptions, SourceDocument, SourceRef, StreamEvent } from "@openbrain/core";
import { asArray, asRecord, asString } from "../notion/types.ts";
import { interpolateEnv, isEnvSet, type EnvMap } from "../shared/env.ts";
import { firstJsonPath, queryJsonPath, resolveMappingValue, stringifyValue } from "../shared/jsonpath.ts";
import { daysAgo, inWindow, isAfter, toIso } from "../shared/time.ts";
import { errorMessage, type InputConnector } from "../shared/types.ts";
import { mapItem, renderArgs, windowVars, type MappedItem, type McpMapping, type TemplateVars } from "./mapping.ts";
import { McpWriteToolError, writeLikeName, writeLikeReason, type ToolLike } from "./safety.ts";

export { MCP_MANIFEST } from "./manifest.ts";
export {
  loadMcpMapping,
  mapItem,
  McpMappingSchema,
  parseMcpMapping,
  renderArgs,
  windowVars,
  type ItemMap,
  type MappedItem,
  type McpMapping,
  type TemplateVars,
} from "./mapping.ts";
export { McpWriteToolError, nameWords, WRITE_VERBS, writeLikeName, writeLikeReason, type ToolLike } from "./safety.ts";

// Generic MCP input: connects to a server over stdio or Streamable HTTP and turns one list tool (plus an
// optional fetch tool) into documents or stream events through a YAML mapping. Read-only is enforced
// before any tool call: mapped tool names are checked at creation, names, descriptions and annotations
// once the server's tool list is known, and every call goes through that check.

export interface McpServerConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** Values may reference the environment: { API_KEY: "${LINEAR_API_KEY}" }. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Name of the environment variable holding the bearer token (HTTP). */
  authEnv?: string;
  headers?: Record<string, string>;
}

export interface McpConnectorOptions {
  /** "mcp:linear" */
  id: string;
  mapping: McpMapping;
  server?: McpServerConfig;
  /** Overrides the transport built from `server` (tests: an InMemoryTransport). */
  transport?: () => Transport;
  env?: EnvMap;
  now?: () => number;
  /** Per tool call (default 60 s). */
  timeoutMs?: number;
}

export interface McpConnector extends InputConnector {
  readonly mapping: McpMapping;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: "openbrain", version: "0.1.0" };

function buildTransport(server: McpServerConfig, env: EnvMap): Transport {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("MCP stdio server: command is required");
    const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [name, value] of Object.entries(server.env ?? {})) childEnv[name] = interpolateEnv(value, env);
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: childEnv,
      stderr: "inherit",
      ...(server.cwd ? { cwd: server.cwd } : {}),
    });
  }
  if (!server.url) throw new Error("MCP http server: url is required");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers ?? {})) headers[name] = interpolateEnv(value, env);
  if (server.authEnv) {
    if (!isEnvSet(env, server.authEnv)) throw new Error(`${server.authEnv} is not set (bearer token of the MCP server)`);
    headers.Authorization = `Bearer ${env[server.authEnv] ?? ""}`;
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
}

/** Data of a tool result: structuredContent, else the text content parsed as JSON, else { text }. */
export function toolResultData(result: unknown, tool: string): unknown {
  const record = asRecord(result);
  const text = asArray(record.content)
    .map(asRecord)
    .filter((c) => c.type === "text")
    .map((c) => asString(c.text))
    .join("\n");
  if (record.isError === true) throw new Error(`MCP tool ${tool} returned an error: ${text.slice(0, 300)}`);
  if (record.structuredContent !== undefined) return record.structuredContent;
  if ("toolResult" in record) return record.toolResult;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

export function createMcpConnector(options: McpConnectorOptions): McpConnector {
  const { mapping } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const timeout = options.timeoutMs ?? 60_000;
  const usedTools = [mapping.list.tool, ...(mapping.fetch ? [mapping.fetch.tool] : [])];
  // First barrier, before connecting: a mapped tool named like a write tool is refused outright.
  for (const tool of usedTools) {
    const reason = writeLikeName(tool);
    if (reason) throw new McpWriteToolError(tool, reason);
  }

  let client: Client | undefined;
  let connecting: Promise<{ client: Client; tools: ToolLike[] }> | undefined;
  const verified = new Set<string>();
  const items = new Map<string, MappedItem>();

  async function listAllTools(c: Client): Promise<ToolLike[]> {
    const tools: ToolLike[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : undefined, { timeout });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  function connect(): Promise<{ client: Client; tools: ToolLike[] }> {
    if (!connecting) {
      connecting = (async () => {
        const transport = options.transport ? options.transport() : buildTransport(options.server ?? { transport: "stdio" }, env);
        const c = new Client(CLIENT_INFO);
        await c.connect(transport, { timeout });
        client = c;
        const tools = await listAllTools(c);
        // Second barrier: the mapped tools must exist and look read-only by description and annotations too.
        for (const name of usedTools) {
          const tool = tools.find((t) => t.name === name);
          if (!tool) throw new Error(`MCP tool "${name}" not found on the server (available: ${tools.map((t) => t.name).join(", ")})`);
          const reason = writeLikeReason(tool);
          if (reason) throw new McpWriteToolError(name, reason);
          verified.add(name);
        }
        return { client: c, tools };
      })();
      connecting.catch(() => undefined);
    }
    return connecting;
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const { client: c } = await connect();
    // Every call goes through the barrier: only verified, mapped tools can be called.
    if (!verified.has(tool)) throw new McpWriteToolError(tool, "not a verified read tool of the mapping");
    return toolResultData(await c.callTool({ name: tool, arguments: args }, undefined, { timeout }), tool);
  }

  async function* listItems(vars: TemplateVars): AsyncGenerator<unknown> {
    let args = renderArgs(mapping.list.args, vars);
    const seenCursors = new Set<string>();
    for (let page = 1; ; page++) {
      const data = await call(mapping.list.tool, args);
      yield* queryJsonPath(data, mapping.list.items);
      const paginate = mapping.list.paginate;
      if (!paginate || page >= paginate.max_pages) return;
      const next = stringifyValue(firstJsonPath(data, paginate.next));
      if (!next || seenCursors.has(next)) return;
      seenCursors.add(next);
      args = { ...args, [paginate.cursor_arg]: next };
    }
  }

  function refOf(item: MappedItem): SourceRef {
    return {
      id: item.id,
      title: item.title,
      modifiedAt: toIso(item.modifiedAt) ?? toIso(item.occurredAt) ?? new Date(now()).toISOString(),
      ...(item.url ? { url: item.url } : {}),
      ...(item.path ? { path: item.path } : {}),
    };
  }

  async function* list(opts: ListOptions = {}): AsyncGenerator<SourceRef> {
    const vars = windowVars(opts.since, new Date(now()).toISOString());
    for await (const raw of listItems(vars)) {
      const item = mapItem(mapping, raw, vars);
      if (!isAfter(toIso(item.modifiedAt), opts.since)) continue;
      items.set(item.id, item);
      yield refOf(item);
    }
  }

  async function fetchDocument(ref: SourceRef): Promise<SourceDocument> {
    let markdown: string;
    if (mapping.fetch) {
      const vars: TemplateVars = { id: ref.id, url: ref.url, title: ref.title };
      const data = await call(mapping.fetch.tool, renderArgs(mapping.fetch.args, vars));
      const spec = mapping.fetch.text;
      const record = asRecord(data);
      markdown = spec
        ? stringifyValue(resolveMappingValue(spec, data, vars))
        : typeof record.text === "string"
          ? record.text
          : `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    } else {
      const item = items.get(ref.id);
      if (!item) throw new Error(`MCP item ${ref.id} was not listed in this run`);
      markdown = item.text ?? "";
    }
    return { ...ref, markdown: markdown.trim(), metadata: { mcp_tool: mapping.fetch?.tool ?? mapping.list.tool } };
  }

  async function* changes(window: ChangesOptions): AsyncGenerator<StreamEvent> {
    const vars = windowVars(window.since, window.until);
    for await (const raw of listItems(vars)) {
      const item = mapItem(mapping, raw, vars);
      const occurredAt = toIso(item.occurredAt) ?? toIso(item.modifiedAt);
      if (!inWindow(occurredAt, window.since, window.until)) continue;
      yield {
        ref: refOf(item),
        kind: mapping.event_kind,
        occurredAt: occurredAt ?? window.until,
        ...(item.author ? { author: item.author } : {}),
        text: item.text ?? item.title,
      };
    }
  }

  async function test(): Promise<HealthReport> {
    const scopes: string[] = [];
    try {
      const { client: c, tools } = await connect();
      const server = c.getServerVersion();
      const writeLike = tools.filter((t) => writeLikeReason(t) !== undefined).map((t) => t.name);
      scopes.push(`${tools.length} tools on the server, mapped: ${usedTools.join(", ")}`);
      if (writeLike.length > 0) scopes.push(`write-like tools present (never called): ${writeLike.join(", ")}`);
      const sample: SourceRef[] = [];
      if (mapping.kind === "documents") {
        for await (const ref of list({})) {
          sample.push(ref);
          if (sample.length >= 3) break;
        }
      } else {
        const until = new Date(now()).toISOString();
        for await (const event of changes({ since: daysAgo(new Date(now()), 30), until })) {
          sample.push(event.ref);
          if (sample.length >= 3) break;
        }
      }
      return {
        ok: true,
        identity: `MCP server ${server?.name ?? "unknown"} ${server?.version ?? ""}`.trim(),
        scopes,
        writeScopesDetected: writeLike.length > 0,
        sample,
      };
    } catch (error) {
      return { ok: false, scopes, writeScopesDetected: false, error: errorMessage(error) };
    }
  }

  async function close(): Promise<void> {
    const c = client;
    client = undefined;
    connecting = undefined;
    verified.clear();
    if (c) await c.close().catch(() => undefined);
  }

  const connector: McpConnector = { id: options.id, kind: mapping.kind, mapping, test, close };
  if (mapping.kind === "documents") {
    connector.list = list;
    connector.fetch = fetchDocument;
  } else {
    connector.changes = changes;
  }
  return connector;
}
