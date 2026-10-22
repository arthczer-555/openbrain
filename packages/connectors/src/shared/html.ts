import { markdownTable } from "../notion/render.ts";
import {
  childElements,
  createElement,
  findFirst,
  textContent,
  tokenizeMarkup,
  type MarkupElement,
  type MarkupNode,
} from "./markup.ts";

// HTML to Markdown for web pages, exported docs and .html files. Keeps headings, paragraphs, lists, tables,
// links, emphasis and code; drops chrome (nav, header, footer, aside, forms), scripts, styles and images.
// The main content is preferred: <main>, [role=main], then <article>, then <body>.

const RAW_TEXT = new Set(["script", "style", "noscript", "textarea", "title", "template"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DROPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "aside",
  "form",
  "button",
  "select",
  "input",
  "dialog",
  "img",
  "picture",
  "video",
  "audio",
  "map",
  "head",
  "footer",
]);
const BLOCK = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);
/** Opening one of these closes an open <p> (HTML implied end tags). */
const CLOSES_P = new Set([...BLOCK].filter((name) => !["body", "html", "li", "dd", "dt", "summary"].includes(name)));

export interface HtmlToMarkdownOptions {
  /** Resolves relative links. */
  baseUrl?: string;
  /** Convert the whole body instead of the main content (default false). */
  wholePage?: boolean;
}

export interface HtmlConversion {
  title: string;
  markdown: string;
}

function closeUpTo(stack: MarkupElement[], names: ReadonlySet<string>, stopAt: ReadonlySet<string>): void {
  for (let i = stack.length - 1; i > 0; i--) {
    const name = stack[i]?.name ?? "";
    if (stopAt.has(name)) return;
    if (names.has(name)) {
      stack.length = i;
      return;
    }
  }
}

const LIST_SCOPE = new Set(["ul", "ol", "table", "body"]);
const CELL_SCOPE = new Set(["tr", "table"]);
const ROW_SCOPE = new Set(["table", "thead", "tbody", "tfoot"]);
const DL_SCOPE = new Set(["dl", "body"]);

/** Tolerant tree builder: implied end tags for p, li, dt/dd, td/th, tr, option. */
export function parseHtml(html: string): MarkupElement {
  const root = createElement("#document");
  const stack: MarkupElement[] = [root];
  for (const token of tokenizeMarkup(html, { lowerCase: true, rawText: RAW_TEXT })) {
    if (token.type === "text") {
      (stack[stack.length - 1] ?? root).children.push({ type: "text", text: token.text });
      continue;
    }
    if (token.type === "close") {
      const index = stack.map((e) => e.name).lastIndexOf(token.name);
      if (index > 0) stack.length = index;
      continue;
    }
    const name = token.name;
    if (CLOSES_P.has(name)) closeUpTo(stack, new Set(["p"]), new Set(["button", "table", "li", "td", "th"]));
    if (name === "li") closeUpTo(stack, new Set(["li"]), LIST_SCOPE);
    if (name === "dt" || name === "dd") closeUpTo(stack, new Set(["dt", "dd"]), DL_SCOPE);
    if (name === "td" || name === "th") closeUpTo(stack, new Set(["td", "th"]), CELL_SCOPE);
    if (name === "tr") closeUpTo(stack, new Set(["tr", "td", "th"]), ROW_SCOPE);
    if (name === "option") closeUpTo(stack, new Set(["option"]), new Set(["select"]));
    const element = createElement(name, token.attrs);
    (stack[stack.length - 1] ?? root).children.push(element);
    if (!token.selfClosing && !VOID.has(name)) stack.push(element);
  }
  return root;
}

function findWhere(element: MarkupElement, predicate: (e: MarkupElement) => boolean): MarkupElement | undefined {
  for (const child of childElements(element)) {
    if (predicate(child)) return child;
    const nested = findWhere(child, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function isHidden(element: MarkupElement): boolean {
  return "hidden" in element.attrs || element.attrs["aria-hidden"] === "true" || /display\s*:\s*none/i.test(element.attrs.style ?? "");
}

function mainContent(doc: MarkupElement): { root: MarkupElement; isBody: boolean } {
  const main = findWhere(doc, (e) => e.name === "main" || e.attrs.role === "main");
  if (main) return { root: main, isBody: false };
  const article = findFirst(doc, "article");
  if (article) return { root: article, isBody: false };
  return { root: findFirst(doc, "body") ?? doc, isBody: true };
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0]+/g, " ");
}

interface RenderState {
  baseUrl?: string;
  /** Inside the page body (not a main / article): page headers are chrome too. */
  dropHeaders: boolean;
}

function resolveHref(href: string, baseUrl: string | undefined): string | undefined {
  const value = href.trim();
  if (!value || value.startsWith("#") || /^(javascript|data|vbscript):/i.test(value)) return undefined;
  try {
    return baseUrl ? new URL(value, baseUrl).href : value;
  } catch {
    return value;
  }
}

function wrapInline(marker: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  const lead = inner.startsWith(" ") ? " " : "";
  const trail = inner.endsWith(" ") ? " " : "";
  return `${lead}${marker}${trimmed}${marker}${trail}`;
}

function isDropped(element: MarkupElement, state: RenderState): boolean {
  return DROPPED.has(element.name) || isHidden(element) || (state.dropHeaders && element.name === "header");
}

function renderInline(nodes: MarkupNode[], state: RenderState): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += collapse(node.text);
      continue;
    }
    if (isDropped(node, state)) continue;
    const inner = (): string => renderInline(node.children, state);
    switch (node.name) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b":
        out += wrapInline("**", inner());
        break;
      case "em":
      case "i":
        out += wrapInline("*", inner());
        break;
      case "del":
      case "s":
      case "strike":
        out += wrapInline("~~", inner());
        break;
      case "code":
      case "kbd":
      case "samp": {
        const code = collapse(textContent(node)).trim();
        if (code) out += code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
        break;
      }
      case "a": {
        const text = inner();
        const href = resolveHref(node.attrs.href ?? "", state.baseUrl);
        if (href && text.trim()) {
          const lead = text.startsWith(" ") ? " " : "";
          const trail = text.endsWith(" ") ? " " : "";
          out += `${lead}[${text.trim()}](${href.replace(/\)/g, "%29").replace(/ /g, "%20")})${trail}`;
        } else {
          out += text;
        }
        break;
      }
      default:
        out += inner();
    }
  }
  return out;
}

function cleanInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function containsBlock(element: MarkupElement): boolean {
  return element.children.some((child) => child.type === "element" && (BLOCK.has(child.name) || containsBlock(child)));
}

function renderList(element: MarkupElement, state: RenderState): string {
  const ordered = element.name === "ol";
  let counter = Number.parseInt(element.attrs.start ?? "1", 10);
  if (!Number.isFinite(counter)) counter = 1;
  const items: string[] = [];
  for (const child of childElements(element)) {
    if (isDropped(child, state)) continue;
    const marker = ordered ? `${counter++}. ` : "- ";
    const body = child.name === "li" ? renderBlocks(child.children, state, "\n") : renderBlocks([child], state, "\n");
    if (!body) continue;
    const indent = " ".repeat(marker.length);
    items.push(
      body
        .split("\n")
        .map((line, i) => (i === 0 ? `${marker}${line}` : line ? `${indent}${line}` : line))
        .join("\n"),
    );
  }
  return items.join("\n");
}

function tableRows(element: MarkupElement): MarkupElement[] {
  const rows: MarkupElement[] = [];
  for (const child of childElements(element)) {
    if (child.name === "tr") rows.push(child);
    else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") rows.push(...tableRows(child));
  }
  return rows;
}

function renderTable(element: MarkupElement, state: RenderState): string {
  const rows = tableRows(element)
    .map((row) =>
      childElements(row)
        .filter((cell) => cell.name === "td" || cell.name === "th")
        .map((cell) => cleanInline(renderInline(cell.children, state)).replace(/\n/g, " ").replace(/\|/g, "\\|")),
    )
    .filter((cells) => cells.some((cell) => cell !== ""));
  if (rows.length === 0) return "";
  const caption = findFirst(element, "caption");
  const title = caption ? `**${cleanInline(renderInline(caption.children, state))}**\n\n` : "";
  return `${title}${markdownTable(rows)}`;
}

function renderPre(element: MarkupElement): string {
  const code = findFirst(element, "code");
  const language = /(?:language|lang)-([\w+-]+)/.exec(code?.attrs.class ?? element.attrs.class ?? "")?.[1] ?? "";
  const text = textContent(element).replace(/^\n/, "").replace(/\s+$/, "");
  if (!text) return "";
  const fence = text.includes("```") ? "~~~~" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderElementBlock(element: MarkupElement, state: RenderState): string {
  const name = element.name;
  const heading = /^h([1-6])$/.exec(name);
  if (heading) {
    const text = cleanInline(renderInline(element.children, state)).replace(/\n/g, " ");
    return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
  }
  switch (name) {
    case "p":
    case "dd":
    case "figcaption":
    case "address":
      return cleanInline(renderInline(element.children, state));
    case "dt":
    case "summary": {
      const text = cleanInline(renderInline(element.children, state));
      return text ? `**${text}**` : "";
    }
    case "ul":
    case "ol":
      return renderList(element, state);
    case "pre":
      return renderPre(element);
    case "table":
      return renderTable(element, state);
    case "hr":
      return "---";
    case "blockquote": {
      const inner = renderBlocks(element.children, state);
      return inner
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }
    default:
      return renderBlocks(element.children, state);
  }
}

/** Renders a mixed list of nodes: runs of inline content become paragraphs. */
function renderBlocks(nodes: MarkupNode[], state: RenderState, separator = "\n\n"): string {
  const blocks: string[] = [];
  let inline: MarkupNode[] = [];
  const flush = (): void => {
    const text = cleanInline(renderInline(inline, state));
    if (text) blocks.push(text);
    inline = [];
  };
  for (const node of nodes) {
    if (node.type === "element" && isDropped(node, state)) continue;
    if (node.type === "element" && (BLOCK.has(node.name) || containsBlock(node))) {
      flush();
      const block = renderElementBlock(node, state);
      if (block) blocks.push(block);
    } else {
      inline.push(node);
    }
  }
  flush();
  return blocks.join(separator);
}

function pageTitleOf(doc: MarkupElement, content: MarkupElement): string {
  const title = findFirst(doc, "title");
  const text = title ? collapse(textContent(title)).trim() : "";
  if (text) return text;
  const h1 = findFirst(content, "h1") ?? findFirst(doc, "h1");
  return h1 ? collapse(textContent(h1)).trim() : "";
}

export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): HtmlConversion {
  const doc = parseHtml(html);
  const { root, isBody } = options.wholePage ? { root: findFirst(doc, "body") ?? doc, isBody: true } : mainContent(doc);
  const state: RenderState = { dropHeaders: isBody, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
  const markdown = renderBlocks(root.children, state)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: pageTitleOf(doc, root), markdown };
}
