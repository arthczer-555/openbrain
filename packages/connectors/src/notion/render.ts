import type { NotionBlock, NotionPage, NotionProperty, NotionRichText } from "./types.ts";
import { asArray, asRecord, asString, payloadOf, richTextArray } from "./types.ts";

// Notion blocks -> Markdown. The page title is the document's "# Title", so Notion headings shift one level
// down (heading_1 -> ##), which is what the chunker splits on. Child pages become links to their mirror file.

export interface RenderContext {
  /** Children of a block whose has_children is true. */
  children(blockId: string): Promise<NotionBlock[]>;
  /** Registers a child page found in the content and returns the link to its mirror file. */
  childPage(pageId: string, title: string): string;
  /** Link to another page (link_to_page): its mirror file when known, else its Notion URL. */
  pageLink(pageId: string): string;
  /** A database embedded in the page, already rendered as Markdown (heading + table). */
  database(databaseId: string, title: string): Promise<string>;
  warn(message: string): void;
}

interface Segment {
  text: string;
  /** Consecutive list items are joined with a single newline, everything else with a blank line. */
  list: boolean;
}

const NODE_TYPES = new Set(["child_page", "child_database"]);
const SKIPPED_TYPES = new Set(["table_of_contents", "breadcrumb", "unsupported", "template"]);

export function richTextToMarkdown(texts: NotionRichText[]): string {
  return texts
    .map((t) => {
      if (!t.plain_text) return "";
      if (t.type === "equation") return `$${t.plain_text}$`;
      const a = t.annotations ?? {};
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(t.plain_text);
      const lead = match?.[1] ?? "";
      const trail = match?.[3] ?? "";
      let core = match?.[2] ?? t.plain_text;
      if (core) {
        if (a.code) core = `\`${core.replace(/`/g, "'")}\``;
        if (a.bold) core = `**${core}**`;
        if (a.italic) core = `*${core}*`;
        if (a.strikethrough) core = `~~${core}~~`;
        if (t.href) core = `[${core}](${t.href})`;
      }
      return `${lead}${core}${trail}`;
    })
    .join("");
}

export function plainText(texts: NotionRichText[]): string {
  return texts.map((t) => t.plain_text).join("");
}

function textOf(block: NotionBlock): string {
  return richTextToMarkdown(richTextArray(payloadOf(block).rich_text));
}

function captionOf(block: NotionBlock): string {
  return plainText(richTextArray(payloadOf(block).caption)).trim();
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

function joinSegments(segments: Segment[]): string {
  let out = "";
  segments.forEach((segment, i) => {
    if (i > 0) out += segment.list && segments[i - 1]?.list ? "\n" : "\n\n";
    out += segment.text;
  });
  return out;
}

function tableCell(texts: NotionRichText[]): string {
  return richTextToMarkdown(texts).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const [header = [], ...body] = rows;
  const lines = [
    `| ${pad(header).join(" | ")} |`,
    `|${Array.from({ length: width }, () => "---").join("|")}|`,
    ...body.map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

async function renderChildren(block: NotionBlock, ctx: RenderContext, indent: string): Promise<string> {
  if (!block.has_children) return "";
  return renderBlocks(await ctx.children(block.id), ctx, indent);
}

function mediaLine(block: NotionBlock, label: string): string {
  const payload = payloadOf(block);
  const caption = captionOf(block);
  const external = asString(asRecord(payload.external).url);
  if (external) return `[${label}${caption ? `: ${caption}` : ""}](${external})`;
  // Notion-hosted files have expiring URLs: keep only the mention.
  return `[${label}${caption ? `: ${caption}` : ""} (file in Notion)]`;
}

async function renderBlock(
  block: NotionBlock,
  ctx: RenderContext,
  indent: string,
  numberInList: number,
): Promise<Segment | null> {
  const payload = payloadOf(block);
  switch (block.type) {
    case "paragraph": {
      const text = textOf(block);
      const children = await renderChildren(block, ctx, indent);
      const all = [text, children].filter((s) => s.length > 0).join("\n\n");
      return all ? { text: indent ? prefixLines(all, indent) : all, list: false } : null;
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = Number(block.type.slice(-1)) + 1;
      const heading = `${"#".repeat(level)} ${textOf(block)}`;
      const children = await renderChildren(block, ctx, "");
      return { text: children ? `${heading}\n\n${children}` : heading, list: false };
    }
    case "bulleted_list_item":
    case "numbered_list_item":
    case "to_do": {
      let marker = "-";
      if (block.type === "numbered_list_item") marker = `${numberInList}.`;
      if (block.type === "to_do") marker = `- [${payload.checked === true ? "x" : " "}]`;
      const children = await renderChildren(block, ctx, `${indent}   `);
      const line = `${indent}${marker} ${textOf(block)}`;
      return { text: children ? `${line}\n${children}` : line, list: true };
    }
    case "toggle": {
      const children = await renderChildren(block, ctx, "");
      const summary = `**${textOf(block)}**`;
      const all = children ? `${summary}\n\n${children}` : summary;
      return { text: indent ? prefixLines(all, indent) : all, list: false };
    }
    case "quote":
    case "callout": {
      const icon = asRecord(payload.icon);
      const emoji = block.type === "callout" ? asString(icon.emoji) : "";
      const text = `${emoji ? `${emoji} ` : ""}${textOf(block)}`;
      const children = await renderChildren(block, ctx, "");
      const all = children ? `${text}\n\n${children}` : text;
      return { text: prefixLines(all, `${indent}> `), list: false };
    }
    case "code": {
      const language = asString(payload.language);
      const lang = language === "plain text" ? "" : language;
      const code = plainText(richTextArray(payload.rich_text));
      return { text: `${indent}\`\`\`${lang}\n${code}\n\`\`\``, list: false };
    }
    case "divider":
      return { text: "---", list: false };
    case "equation":
      return { text: `$$\n${asString(payload.expression)}\n$$`, list: false };
    case "table": {
      const rows = block.has_children ? await ctx.children(block.id) : [];
      const cells = rows
        .filter((row) => row.type === "table_row")
        .map((row) => asArray(payloadOf(row).cells).map((cell) => tableCell(richTextArray(cell))));
      return cells.length > 0 ? { text: markdownTable(cells), list: false } : null;
    }
    case "child_page":
      return { text: `${indent}- [${asString(payload.title) || "Untitled"}](${ctx.childPage(block.id, asString(payload.title))})`, list: true };
    case "child_database":
      return { text: await ctx.database(block.id, asString(payload.title)), list: false };
    case "link_to_page": {
      const pageId = asString(payload.page_id);
      if (!pageId) return null;
      return { text: `${indent}- [Linked page](${ctx.pageLink(pageId)})`, list: true };
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = asString(payload.url);
      if (!url) return null;
      return { text: `[${captionOf(block) || url}](${url})`, list: false };
    }
    case "image":
    case "video":
    case "file":
    case "pdf":
    case "audio":
      return { text: mediaLine(block, block.type), list: false };
    case "synced_block": {
      const from = asString(asRecord(payload.synced_from).block_id);
      const sourceId = from || block.id;
      if (!from && !block.has_children) return null;
      try {
        const text = await renderBlocks(await ctx.children(sourceId), ctx, indent);
        return text ? { text, list: false } : null;
      } catch {
        ctx.warn(`synced block ${block.id}: its original is not shared with the integration`);
        return null;
      }
    }
    case "column_list": {
      const columns = await ctx.children(block.id);
      const parts: string[] = [];
      for (const column of columns) parts.push(await renderChildren(column, ctx, indent));
      const text = parts.filter((p) => p.length > 0).join("\n\n");
      return text ? { text, list: false } : null;
    }
    case "column":
      return null;
    default:
      if (!SKIPPED_TYPES.has(block.type)) ctx.warn(`block type "${block.type}" is not rendered`);
      return null;
  }
}

/** Renders a list of sibling blocks. `indent` nests list children under their item. */
export async function renderBlocks(blocks: NotionBlock[], ctx: RenderContext, indent = ""): Promise<string> {
  const segments: Segment[] = [];
  let number = 0;
  for (const block of blocks) {
    if (block.archived || block.in_trash) continue;
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    const segment = await renderBlock(block, ctx, indent, number);
    if (segment && segment.text.trim().length > 0) segments.push(segment);
  }
  return joinSegments(segments);
}

export function isNodeBlock(block: NotionBlock): boolean {
  return NODE_TYPES.has(block.type);
}

// Database rows (embedded databases are rendered as one table inside their page).

const MAX_COLUMNS = 8;

function propertyValue(property: NotionProperty): string {
  const value = property[property.type];
  switch (property.type) {
    case "title":
    case "rich_text":
      return plainText(richTextArray(value));
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "select":
    case "status":
      return asString(asRecord(value).name);
    case "multi_select":
      return asArray(value)
        .map((v) => asString(asRecord(v).name))
        .filter(Boolean)
        .join(", ");
    case "date": {
      const date = asRecord(value);
      const start = asString(date.start);
      const end = asString(date.end);
      return end ? `${start} to ${end}` : start;
    }
    case "checkbox":
      return value === true ? "yes" : "no";
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return asString(value);
    case "people":
      return asArray(value)
        .map((p) => asString(asRecord(p).name))
        .filter(Boolean)
        .join(", ");
    case "relation":
      return `${asArray(value).length} linked`;
    case "formula": {
      const formula = asRecord(value);
      const inner = formula[asString(formula.type)];
      if (typeof inner === "string") return inner;
      if (typeof inner === "number" || typeof inner === "boolean") return String(inner);
      return asString(asRecord(inner).start);
    }
    case "files":
      return asArray(value)
        .map((f) => asString(asRecord(f).name))
        .filter(Boolean)
        .join(", ");
    default:
      return "";
  }
}

export function renderDatabase(
  title: string,
  schema: Record<string, NotionProperty>,
  rows: NotionPage[],
  truncated: boolean,
): string {
  const names = Object.keys(schema);
  const titleName = names.find((n) => schema[n]?.type === "title");
  const columns = [...(titleName ? [titleName] : []), ...names.filter((n) => n !== titleName)].slice(0, MAX_COLUMNS);
  const header = columns;
  const body = rows.map((row) =>
    columns.map((name) => {
      const property = row.properties[name];
      return property ? propertyValue(property).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim() : "";
    }),
  );
  const heading = `### ${title || "Database"}`;
  if (rows.length === 0) return `${heading}\n\n_(empty database)_`;
  const note = truncated ? `\n\n_(first ${rows.length} rows only)_` : "";
  return `${heading}\n\n${markdownTable([header, ...body])}${note}`;
}
