import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Knowledge mirror format. knowledge/ is a GENERATED mirror of Notion, the single source of truth:
// every file is one Notion page, rewritten by `openbrain sync notion`, never edited by hand.
// Routing metadata (when_to_open, aliases, warnings, status) lives in brain/registry.yaml.

/** Notion last_edited_time (ISO date-time) or a plain YYYY-MM-DD date. YAML may hand us a Date. */
const timestampString = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/, "must be an ISO date or date-time"),
);

export const MirrorSourceSchema = z
  .object({
    connector: z.enum(["notion"]),
    page_id: z.string().min(1),
    url: z.url(),
  })
  .strict();

export const MirrorFrontmatterSchema = z
  .object({
    /** Path of the file inside knowledge/, without extension. */
    id: z.string().min(1),
    title: z.string().min(1),
    /** First-level child of the Notion root page. */
    section: z.string().min(1),
    source: MirrorSourceSchema,
    /** Notion last_edited_time. */
    updated_at: timestampString,
    lang: z.string().min(2).optional(),
  })
  .strict();

export type MirrorSource = z.infer<typeof MirrorSourceSchema>;
export type MirrorFrontmatter = z.infer<typeof MirrorFrontmatterSchema>;

export interface SplitResult {
  data: unknown;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Splits a Markdown file into its YAML frontmatter and body. Throws when there is no frontmatter. */
export function splitFrontmatter(raw: string): SplitResult {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new Error("missing YAML frontmatter (the file must start with ---)");
  }
  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  return { data: parseYaml(yamlText) ?? {}, body };
}

export type ParseResult<T> = { ok: true; value: T; body: string } | { ok: false; errors: string[] };

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

export function parseMirrorFrontmatter(raw: string): ParseResult<MirrorFrontmatter> {
  let split: SplitResult;
  try {
    split = splitFrontmatter(raw);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const result = MirrorFrontmatterSchema.safeParse(split.data);
  if (!result.success) {
    return { ok: false, errors: formatIssues(result.error) };
  }
  return { ok: true, value: result.data, body: split.body };
}
