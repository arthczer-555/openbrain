import type { ChangesOptions, HealthReport, ListOptions, SourceDocument, SourceRef, StreamEvent } from "@openbrain/core";
import type { FetchLike } from "../notion/client.ts";
import { asRecord } from "../notion/types.ts";
import { mapItem, renderArgs, windowVars, type MappedItem, type TemplateVars } from "../mcp/mapping.ts";
import { interpolateEnv, isEnvSet, type EnvMap } from "../shared/env.ts";
import { ReadOnlyHttp } from "../shared/http.ts";
import { firstJsonPath, queryJsonPath, renderTemplate, resolveMappingValue, stringifyValue } from "../shared/jsonpath.ts";
import { daysAgo, inWindow, isAfter, toIso } from "../shared/time.ts";
import { errorMessage, type InputConnector } from "../shared/types.ts";
import type { ApiMapping } from "./mapping.ts";

export { API_MANIFEST } from "./manifest.ts";
export { ApiMappingSchema, loadApiMapping, parseApiMapping, type ApiMapping } from "./mapping.ts";

// Generic REST input: any HTTP API that answers JSON, through the same YAML mapping as the MCP adapter
// (an endpoint instead of a tool). Read-only by construction: every request goes through ReadOnlyHttp,
// which refuses any method other than GET. The credential is only ever sent to the host of base_url,
// and it is masked in error messages.

export interface ApiAuth {
  /** bearer: Authorization: Bearer; header: <name>: <token>; query: ?<name>=<token>; basic: env holds "user:password". */
  type: "bearer" | "header" | "query" | "basic";
  /** Name of the environment variable holding the credential. */
  env: string;
  /** Header or query parameter name (header and query only). */
  name?: string;
}

export interface ApiConnectorOptions {
  /** "api:crm" */
  id: string;
  baseUrl: string;
  mapping: ApiMapping;
  auth?: ApiAuth;
  /** Sent with every request; values may reference the environment: { "X-Org": "${CRM_ORG}" }. */
  headers?: Record<string, string>;
  env?: EnvMap;
  /** Pause between two requests (default 200 ms). */
  delayMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ApiConnector extends InputConnector {
  readonly mapping: ApiMapping;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`api input: base_url is not a URL: ${value}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`api input: base_url must use https (plain http only for localhost): ${value}`);
  }
  return url;
}

/** Template variables encoded for a URL path ("/notes/{{id}}"). */
function encodeVars(vars: TemplateVars): TemplateVars {
  const out: TemplateVars = {};
  for (const [name, value] of Object.entries(vars)) out[name] = value === undefined ? undefined : encodeURIComponent(value);
  return out;
}

export function createApiConnector(options: ApiConnectorOptions): ApiConnector {
  const { mapping } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const base = parseBaseUrl(options.baseUrl);
  const auth = options.auth;
  if (auth && (auth.type === "header" || auth.type === "query") && !auth.name) {
    throw new Error(`api input: auth.type ${auth.type} needs auth.name (header or query parameter name)`);
  }
  const http = new ReadOnlyHttp({
    minIntervalMs: options.delayMs ?? 200,
    headers: { "User-Agent": "OpenBrain (read-only collector)" },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now,
  });
  const items = new Map<string, MappedItem>();

  function credential(): string | undefined {
    if (!auth) return undefined;
    if (!isEnvSet(env, auth.env)) throw new Error(`${auth.env} is not set: put it in .env (see packages/connectors/src/api/SETUP.md)`);
    return (env[auth.env] ?? "").trim();
  }

  function requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name] = interpolateEnv(value, env);
    const secret = credential();
    if (auth && secret !== undefined) {
      if (auth.type === "bearer") headers.Authorization = `Bearer ${secret}`;
      else if (auth.type === "basic") headers.Authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
      else if (auth.type === "header") headers[auth.name ?? ""] = secret;
    }
    return headers;
  }

  /** A path relative to base_url, or an absolute URL that must stay on its host (the credential goes there). */
  function resolveUrl(pathOrUrl: string, query: Record<string, string> = {}): URL {
    let url: URL;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      url = new URL(pathOrUrl);
      if (url.origin !== base.origin) throw new Error(`api input: refused ${url.origin}, only ${base.origin} is allowed (base_url)`);
    } else {
      const prefix = base.href.replace(/[?#].*$/, "").replace(/\/+$/, "");
      url = new URL(`${prefix}/${pathOrUrl.replace(/^\/+/, "")}`);
    }
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  function renderQuery(query: Record<string, unknown>, vars: TemplateVars): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(renderArgs(query, vars))) out[name] = stringifyValue(value);
    return out;
  }

  async function getJson(url: URL): Promise<unknown> {
    const secret = credential();
    const target = new URL(url);
    if (auth?.type === "query" && secret !== undefined) target.searchParams.set(auth.name ?? "", secret);
    try {
      return await http.getJson(target.toString(), requestHeaders());
    } catch (error) {
      const message = errorMessage(error);
      // Never let the credential reach a log, a report or the terminal.
      const masked = secret ? message.split(secret).join("***").split(encodeURIComponent(secret)).join("***") : message;
      throw new Error(masked);
    }
  }

  async function* listItems(vars: TemplateVars): AsyncGenerator<unknown> {
    const paginate = mapping.list.paginate;
    const query = renderQuery(mapping.list.query, vars);
    let page = paginate?.start ?? 1;
    let offset = paginate?.start ?? 0;
    if (paginate?.page_param && !(paginate.page_param in query)) query[paginate.page_param] = String(page);
    if (paginate?.offset_param && !(paginate.offset_param in query)) query[paginate.offset_param] = String(offset);
    let url = resolveUrl(renderTemplate(mapping.list.path, {}, encodeVars(vars)), query);
    const seen = new Set<string>([url.toString()]);
    for (let n = 1; ; n++) {
      const data = await getJson(url);
      const found = queryJsonPath(data, mapping.list.items);
      yield* found;
      if (!paginate || n >= paginate.max_pages) return;
      let next: URL | undefined;
      if (paginate.next_url) {
        const value = stringifyValue(firstJsonPath(data, paginate.next_url));
        if (value) next = /^https?:\/\//i.test(value) ? resolveUrl(value) : new URL(value, url);
        if (next && next.origin !== base.origin) throw new Error(`api input: refused next page on ${next.origin}, only ${base.origin} is allowed`);
      } else if (paginate.cursor_param && paginate.next) {
        const cursor = stringifyValue(firstJsonPath(data, paginate.next));
        if (cursor) {
          next = new URL(url);
          next.searchParams.set(paginate.cursor_param, cursor);
        }
      } else if (found.length > 0) {
        next = new URL(url);
        if (paginate.page_param) next.searchParams.set(paginate.page_param, String(++page));
        else if (paginate.offset_param) next.searchParams.set(paginate.offset_param, String((offset += found.length)));
      }
      if (!next || seen.has(next.toString())) return;
      seen.add(next.toString());
      url = next;
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
      const url = resolveUrl(renderTemplate(mapping.fetch.path, {}, encodeVars(vars)), renderQuery(mapping.fetch.query, vars));
      const data = await getJson(url);
      const spec = mapping.fetch.text;
      const record = asRecord(data);
      markdown = spec
        ? stringifyValue(resolveMappingValue(spec, data, vars))
        : typeof record.text === "string"
          ? record.text
          : `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    } else {
      const item = items.get(ref.id);
      if (!item) throw new Error(`API item ${ref.id} was not listed in this run`);
      markdown = item.text ?? "";
    }
    return { ...ref, markdown: markdown.trim(), metadata: { api_endpoint: mapping.fetch?.path ?? mapping.list.path } };
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
    const scopes = [
      `GET only on ${base.origin}, endpoint ${mapping.list.path}${mapping.fetch ? ` (+ ${mapping.fetch.path})` : ""}`,
      auth ? `auth ${auth.type} from ${auth.env}: the key's permissions cannot be read, prefer a read-only key` : "no auth",
    ];
    try {
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
      return { ok: true, identity: `REST API ${base.host}`, scopes, writeScopesDetected: false, sample };
    } catch (error) {
      return { ok: false, scopes, writeScopesDetected: false, error: errorMessage(error) };
    }
  }

  const connector: ApiConnector = { id: options.id, kind: mapping.kind, mapping, test };
  if (mapping.kind === "documents") {
    connector.list = list;
    connector.fetch = fetchDocument;
  } else {
    connector.changes = changes;
  }
  return connector;
}
