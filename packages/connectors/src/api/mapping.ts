import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatIssues } from "@openbrain/core";
import { EventKindSchema, ItemMapSchema, JsonPathString } from "../mcp/mapping.ts";

// Mapping of a REST API onto the Connector contract, in connectors/<name>.mapping.yaml. Same format as an
// MCP mapping, with an endpoint (`path` + `query`) instead of a tool (`tool` + `args`):
//
//   kind: stream
//   list:
//     path: /deals
//     query: { updated_since: "{{since}}", limit: 100 }
//     items: "$.results[*]"
//     paginate: { cursor_param: after, next: "$.paging.next.after" }
//   map:
//     id: "$.id"
//     title: "$.name"
//     modifiedAt: "$.updatedAt"
//     text: "Stage: {{$.stage}}"
//   event_kind: deal_change
//
// Pagination, one mode: cursor (`cursor_param` + `next`), next page URL (`next_url`), page number
// (`page_param`) or offset (`offset_param`, incremented by the number of items received).

const Query = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});

const PaginateSchema = z
  .object({
    cursor_param: z.string().min(1).optional(),
    next: JsonPathString.optional(),
    next_url: JsonPathString.optional(),
    page_param: z.string().min(1).optional(),
    offset_param: z.string().min(1).optional(),
    /** First page number (default 1) or first offset (default 0). */
    start: z.number().int().nonnegative().optional(),
    max_pages: z.number().int().positive().default(20),
  })
  .strict()
  .refine((p) => Boolean(p.cursor_param) === Boolean(p.next), {
    message: "cursor pagination needs both cursor_param and next",
    path: ["cursor_param"],
  })
  .refine((p) => [p.cursor_param, p.next_url, p.page_param, p.offset_param].filter(Boolean).length === 1, {
    message: "set exactly one pagination mode: cursor_param + next, next_url, page_param or offset_param",
  });

export const ApiMappingSchema = z
  .object({
    kind: z.enum(["documents", "stream"]),
    list: z
      .object({
        /** Relative to base_url ("/deals"), or an absolute URL on the same host. */
        path: z.string().min(1),
        query: Query,
        items: JsonPathString,
        paginate: PaginateSchema.optional(),
      })
      .strict(),
    /** Optional second request for documents whose list items do not carry the content. */
    fetch: z
      .object({
        path: z.string().min(1),
        query: Query,
        /** JSONPath or template on the response (default: its `text`, else the JSON). */
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

export type ApiMapping = z.infer<typeof ApiMappingSchema>;

export function parseApiMapping(value: unknown, source = "mapping"): ApiMapping {
  const result = ApiMappingSchema.safeParse(value ?? {});
  if (!result.success) throw new Error(`invalid API ${source}:\n${formatIssues(result.error).join("\n")}`);
  return result.data;
}

export async function loadApiMapping(file: string): Promise<ApiMapping> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`API mapping not found: ${file}`);
  }
  return parseApiMapping(parseYaml(text) as unknown, file);
}
