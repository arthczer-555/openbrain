import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatIssues } from "@openbrain/core";
import { parseJsonPath, renderTemplate, resolveMappingValue, stringifyValue } from "../shared/jsonpath.ts";

// Mapping of an MCP server onto the Connector contract, written by the operator
// (or proposed by Claude during /setup) in connectors/<name>.mapping.yaml:
//
//   kind: stream
//   list:
//     tool: list_issues
//     args: { updatedAfter: "{{since}}", limit: 100 }
//     items: "$.issues[*]"
//     paginate: { cursor_arg: after, next: "$.pageInfo.endCursor" }
//   map:
//     id: "$.id"
//     title: "$.title"
//     url: "$.url"
//     modifiedAt: "$.updatedAt"
//     text: "{{$.description}}\n\nStatus: {{$.state.name}}"
//
// Variables in args: {{since}}, {{until}} (ISO dates, see windowVars for other formats); in fetch args:
// {{id}}, {{url}}, {{title}}.
// An argument whose whole value is a variable that has no value (no since on a full collection) is omitted.

export const JsonPathString = z.string().refine(
  (value) => {
    try {
      parseJsonPath(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "expected a JSONPath like $.items[*]" },
);

const ToolArgs = z.record(z.string(), z.unknown()).default({});

/** How an item becomes a document or an event. Shared with the `api` input (same mapping format). */
export const ItemMapSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    url: z.string().optional(),
    modifiedAt: z.string().min(1),
    occurredAt: z.string().optional(),
    text: z.string().optional(),
    /** Kept in StreamEvent.author for triage, never written to the knowledge base. */
    author: z.string().optional(),
    /** A JSONPath to an array of names, or a template joined with " / ". */
    path: z.string().optional(),
  })
  .strict();

export const EventKindSchema = z.enum(["message", "thread", "deal_change", "note", "meeting", "commit", "ticket"]).default("ticket");

export type ItemMap = z.infer<typeof ItemMapSchema>;

export const McpMappingSchema = z
  .object({
    kind: z.enum(["documents", "stream"]),
    list: z
      .object({
        tool: z.string().min(1),
        args: ToolArgs,
        items: JsonPathString,
        paginate: z
          .object({
            cursor_arg: z.string().min(1),
            next: JsonPathString,
            max_pages: z.number().int().positive().default(20),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** Optional second call for documents whose list items do not carry the content. */
    fetch: z
      .object({
        tool: z.string().min(1),
        args: ToolArgs,
        /** JSONPath or template on the fetch result (default: the text of the result). */
        text: z.string().optional(),
      })
      .strict()
      .optional(),
    map: ItemMapSchema,
    event_kind: EventKindSchema,
  })
  .strict()
  .refine((m) => m.map.text !== undefined || m.fetch !== undefined, {
    message: "map.text or fetch is required: the adapter needs the content of each item",
    path: ["map", "text"],
  });

export type McpMapping = z.infer<typeof McpMappingSchema>;

export function parseMcpMapping(value: unknown, source = "mapping"): McpMapping {
  const result = McpMappingSchema.safeParse(value ?? {});
  if (!result.success) throw new Error(`invalid MCP ${source}:\n${formatIssues(result.error).join("\n")}`);
  return result.data;
}

export async function loadMcpMapping(file: string): Promise<McpMapping> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`MCP mapping not found: ${file}`);
  }
  return parseMcpMapping(parseYaml(text) as unknown, file);
}

export type TemplateVars = Record<string, string | undefined>;

/**
 * Variables of a collection window: {{since}} / {{until}} (ISO), {{since_date}} / {{until_date}}
 * (YYYY-MM-DD) and {{since_unix}} / {{until_unix}} (seconds), for APIs that want another date format.
 */
export function windowVars(since: string | undefined, until: string | undefined): TemplateVars {
  const vars: TemplateVars = { since, until };
  for (const [name, value] of [["since", since], ["until", until]] as const) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(time)) continue;
    vars[`${name}_date`] = new Date(time).toISOString().slice(0, 10);
    vars[`${name}_unix`] = String(Math.floor(time / 1000));
  }
  return vars;
}

/** Args with {{variables}} rendered; an argument that is only an unset variable is dropped. */
export function renderArgs(args: Record<string, unknown>, vars: TemplateVars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const rendered = renderArgValue(value, vars);
    if (rendered !== undefined) out[key] = rendered;
  }
  return out;
}

function renderArgValue(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === "string") {
    const only = /^\{\{\s*([A-Za-z_][\w]*)\s*\}\}$/.exec(value);
    if (only) return vars[only[1] ?? ""];
    return renderTemplate(value, {}, vars);
  }
  if (Array.isArray(value)) return value.map((v) => renderArgValue(v, vars)).filter((v) => v !== undefined);
  if (typeof value === "object" && value !== null) return renderArgs(value as Record<string, unknown>, vars);
  return value;
}

export interface MappedItem {
  id: string;
  title: string;
  url?: string;
  modifiedAt?: string;
  occurredAt?: string;
  text?: string;
  author?: string;
  path?: string[];
}

function optionalText(spec: string | undefined, item: unknown, vars: TemplateVars): string | undefined {
  if (spec === undefined) return undefined;
  const text = stringifyValue(resolveMappingValue(spec, item, vars)).trim();
  return text === "" ? undefined : text;
}

export function mapItem(mapping: { map: ItemMap }, item: unknown, vars: TemplateVars = {}): MappedItem {
  const map = mapping.map;
  const id = optionalText(map.id, item, vars);
  if (!id) throw new Error(`item without an id (map.id = ${map.id})`);
  const mapped: MappedItem = { id, title: optionalText(map.title, item, vars) ?? id };
  const url = optionalText(map.url, item, vars);
  const modifiedAt = optionalText(map.modifiedAt, item, vars);
  const occurredAt = optionalText(map.occurredAt, item, vars);
  const text = optionalText(map.text, item, vars);
  const author = optionalText(map.author, item, vars);
  if (url) mapped.url = url;
  if (modifiedAt) mapped.modifiedAt = modifiedAt;
  if (occurredAt) mapped.occurredAt = occurredAt;
  if (text) mapped.text = text;
  if (author) mapped.author = author;
  if (map.path) {
    const value = resolveMappingValue(map.path, item, vars);
    const segments = Array.isArray(value) ? value.map(stringifyValue) : stringifyValue(value).split(" / ");
    const clean = segments.map((s) => s.trim()).filter(Boolean);
    if (clean.length > 0) mapped.path = clean;
  }
  return mapped;
}
