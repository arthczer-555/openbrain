// Minimal markup tokenizer shared by the HTML converter and the Office (docx, pptx) XML readers.
// Tolerant by design: unknown constructs become text, comments / doctypes / processing instructions are dropped.

export type MarkupToken =
  | { type: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; text: string };

export interface TokenizeOptions {
  /** HTML names are case-insensitive (lowercased); XML names are kept as is ("w:p"). */
  lowerCase: boolean;
  /** Elements whose content is raw text up to the closing tag (script, style...). */
  rawText?: ReadonlySet<string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
  euro: "\u20ac",
  eacute: "\u00e9",
  egrave: "\u00e8",
  ecirc: "\u00ea",
  agrave: "\u00e0",
  acirc: "\u00e2",
  ccedil: "\u00e7",
  ocirc: "\u00f4",
  ucirc: "\u00fb",
  ugrave: "\u00f9",
  icirc: "\u00ee",
  iuml: "\u00ef",
  euml: "\u00eb",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
  szlig: "\u00df",
  Eacute: "\u00c9",
  Egrave: "\u00c8",
  Agrave: "\u00c0",
  Ccedil: "\u00c7",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

const OPEN_NAME = /<([A-Za-z][^\s>/]*)/y;
const ATTRIBUTE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
const TAG_END = /\s*(\/?)>/y;
const CLOSE_TAG = /<\/\s*([A-Za-z][^\s>/]*)[^>]*>/y;

function readOpenTag(
  source: string,
  start: number,
  lowerCase: boolean,
): { token: MarkupToken & { type: "open" }; end: number } | undefined {
  OPEN_NAME.lastIndex = start;
  const nameMatch = OPEN_NAME.exec(source);
  if (!nameMatch) return undefined;
  const rawName = nameMatch[1] ?? "";
  const name = lowerCase ? rawName.toLowerCase() : rawName;
  const attrs: Record<string, string> = {};
  let i = OPEN_NAME.lastIndex;
  for (;;) {
    TAG_END.lastIndex = i;
    const end = TAG_END.exec(source);
    if (end) return { token: { type: "open", name, attrs, selfClosing: end[1] === "/" }, end: TAG_END.lastIndex };
    ATTRIBUTE.lastIndex = i;
    const attr = ATTRIBUTE.exec(source);
    if (!attr || ATTRIBUTE.lastIndex === i) {
      // Malformed tag: skip one character and keep reading attributes.
      if (i >= source.length) return { token: { type: "open", name, attrs, selfClosing: false }, end: source.length };
      i++;
      continue;
    }
    const attrName = lowerCase ? (attr[1] ?? "").toLowerCase() : (attr[1] ?? "");
    attrs[attrName] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
    i = ATTRIBUTE.lastIndex;
  }
}

export function tokenizeMarkup(source: string, options: TokenizeOptions): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  const lower = options.rawText && options.rawText.size > 0 ? source.toLowerCase() : source;
  const pushText = (text: string): void => {
    if (text) tokens.push({ type: "text", text: decodeEntities(text) });
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      pushText(source.slice(i));
      break;
    }
    pushText(source.slice(i, lt));
    i = lt;
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      const text = source.slice(i + 9, end < 0 ? source.length : end);
      if (text) tokens.push({ type: "text", text });
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[i + 1] === "!" || source[i + 1] === "?") {
      const end = source.indexOf(">", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[i + 1] === "/") {
      CLOSE_TAG.lastIndex = i;
      const close = CLOSE_TAG.exec(source);
      if (close) {
        const raw = close[1] ?? "";
        tokens.push({ type: "close", name: options.lowerCase ? raw.toLowerCase() : raw });
        i = CLOSE_TAG.lastIndex;
        continue;
      }
    }
    const open = readOpenTag(source, i, options.lowerCase);
    if (!open) {
      pushText("<");
      i++;
      continue;
    }
    tokens.push(open.token);
    i = open.end;
    if (options.rawText?.has(open.token.name) && !open.token.selfClosing) {
      const end = lower.indexOf(`</${open.token.name}`, i);
      const stop = end < 0 ? source.length : end;
      const text = source.slice(i, stop);
      if (text) tokens.push({ type: "text", text });
      tokens.push({ type: "close", name: open.token.name });
      const gt = end < 0 ? -1 : source.indexOf(">", end);
      i = gt < 0 ? source.length : gt + 1;
    }
  }
  return tokens;
}

// A small element tree, used as is for XML (strict nesting) and by the HTML builder.

export interface MarkupElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: MarkupNode[];
}

export interface MarkupText {
  type: "text";
  text: string;
}

export type MarkupNode = MarkupElement | MarkupText;

export function createElement(name: string, attrs: Record<string, string> = {}): MarkupElement {
  return { type: "element", name, attrs, children: [] };
}

/** XML tree: a close tag pops up to its matching open element; stray close tags are ignored. */
export function parseXml(source: string): MarkupElement {
  const root = createElement("#document");
  const stack: MarkupElement[] = [root];
  for (const token of tokenizeMarkup(source, { lowerCase: false })) {
    const parent = stack[stack.length - 1] ?? root;
    if (token.type === "text") {
      parent.children.push({ type: "text", text: token.text });
    } else if (token.type === "open") {
      const element = createElement(token.name, token.attrs);
      parent.children.push(element);
      if (!token.selfClosing) stack.push(element);
    } else {
      const index = stack.map((e) => e.name).lastIndexOf(token.name);
      if (index > 0) stack.length = index;
    }
  }
  return root;
}

export function childElements(element: MarkupElement, name?: string): MarkupElement[] {
  return element.children.filter(
    (child): child is MarkupElement => child.type === "element" && (name === undefined || child.name === name),
  );
}

/** Descendants named `name`, in document order, without descending into a match. */
export function findAll(element: MarkupElement, name: string): MarkupElement[] {
  const found: MarkupElement[] = [];
  for (const child of element.children) {
    if (child.type !== "element") continue;
    if (child.name === name) found.push(child);
    else found.push(...findAll(child, name));
  }
  return found;
}

export function findFirst(element: MarkupElement, name: string): MarkupElement | undefined {
  for (const child of element.children) {
    if (child.type !== "element") continue;
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return undefined;
}

export function textContent(node: MarkupNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(textContent).join("");
}
