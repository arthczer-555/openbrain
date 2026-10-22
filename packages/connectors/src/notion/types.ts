// Minimal shapes of the Notion REST API objects OpenBrain reads (pages, blocks, rich text, databases).
// Only the fields we use are typed; the per-type payload of a block is read through narrow helpers.

export interface NotionAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
}

export interface NotionRichText {
  type: string;
  plain_text: string;
  href: string | null;
  annotations?: NotionAnnotations;
}

/** Where an object lives: a page, a database, a block (columns, toggles) or the workspace root. */
export interface NotionParent {
  type: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  block_id?: string;
  workspace?: boolean;
}

export interface NotionBlock {
  object: "block";
  id: string;
  parent?: NotionParent;
  type: string;
  has_children: boolean;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time?: string;
  /** The payload lives under the key named by `type` (block.paragraph, block.heading_1...). */
  [key: string]: unknown;
}

export interface NotionProperty {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionPage {
  object: "page";
  id: string;
  parent?: NotionParent;
  url: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, NotionProperty>;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  parent?: NotionParent;
  url?: string;
  title: NotionRichText[];
  properties: Record<string, NotionProperty>;
}

export interface NotionList<T> {
  object: "list";
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionUser {
  object: "user";
  id: string;
  type?: string;
  name?: string | null;
  bot?: { workspace_name?: string | null };
}

// Narrow helpers: API payloads arrive as unknown and are read defensively.

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isRichText(value: unknown): value is NotionRichText {
  const record = asRecord(value);
  return typeof record.plain_text === "string" && typeof record.type === "string";
}

export function richTextArray(value: unknown): NotionRichText[] {
  return asArray(value).filter(isRichText);
}

/** The payload of a block, for example `{ rich_text: [...] }` for a paragraph. */
export function payloadOf(block: NotionBlock): Record<string, unknown> {
  return asRecord(block[block.type]);
}

/** Notion ids are accepted with or without dashes; the API returns them dashed. */
export function normalizeId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Plain title of a page: the property of type "title", whatever its name. */
export function pageTitle(page: NotionPage): string {
  for (const property of Object.values(page.properties)) {
    if (property.type === "title") {
      return richTextArray(property.title)
        .map((t) => t.plain_text)
        .join("")
        .trim();
    }
  }
  return "";
}
