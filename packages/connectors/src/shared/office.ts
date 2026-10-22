import { markdownTable } from "../notion/render.ts";
import { childElements, findAll, findFirst, parseXml, type MarkupElement, type MarkupNode } from "./markup.ts";
import { readZip, ZipFormatError, type ZipOptions } from "./zip.ts";

// Text of Office Open XML files: .docx (word/document.xml) and .pptx (ppt/slides/slideN.xml).
// Paragraph text, headings, simple lists and tables; formatting, images and comments are left out.

/** Word heading style ids, localized ("Heading1", "Titre1", "berschrift1"...). */
const HEADING_STYLE = /^(?:heading|titre|berschrift|titolo|encabezado|kop|rubrik)\s?([1-6])$/i;
const TITLE_STYLE = /^(?:title|titre|titel|titolo|t[i\u00ed]tulo)$/i;

function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** Visible text of a run container: w:t / a:t, tabs and breaks; deleted text and field codes are skipped. */
function runText(node: MarkupNode): string {
  if (node.type === "text") return "";
  switch (node.name) {
    case "w:t":
    case "a:t":
      return node.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    case "w:tab":
      return "\t";
    case "w:br":
    case "w:cr":
    case "a:br":
      return "\n";
    case "w:delText":
    case "w:instrText":
    case "w:pPr":
    case "w:rPr":
    case "a:pPr":
    case "a:rPr":
      return "";
    default:
      return node.children.map(runText).join("");
  }
}

function attr(element: MarkupElement | undefined, name: string): string | undefined {
  return element?.attrs[name];
}

function docxParagraph(paragraph: MarkupElement): string {
  const text = runText(paragraph).replace(/[ \t]+$/gm, "").trim();
  if (!text) return "";
  const properties = childElements(paragraph, "w:pPr")[0];
  const style = attr(properties ? childElements(properties, "w:pStyle")[0] : undefined, "w:val") ?? "";
  const heading = HEADING_STYLE.exec(style);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text.replace(/\n/g, " ")}`;
  if (TITLE_STYLE.test(style)) return `# ${text.replace(/\n/g, " ")}`;
  const numbering = properties ? childElements(properties, "w:numPr")[0] : undefined;
  if (numbering) {
    const level = Number.parseInt(attr(childElements(numbering, "w:ilvl")[0], "w:val") ?? "0", 10) || 0;
    return `${"  ".repeat(level)}- ${text.replace(/\n/g, " ")}`;
  }
  return text;
}

function docxTable(table: MarkupElement): string {
  const rows = childElements(table, "w:tr").map((row) =>
    childElements(row, "w:tc").map((cell) =>
      escapeCell(
        findAll(cell, "w:p")
          .map((p) => runText(p).trim())
          .filter(Boolean)
          .join(" "),
      ),
    ),
  );
  const filled = rows.filter((cells) => cells.some((c) => c !== ""));
  return filled.length > 0 ? markdownTable(filled) : "";
}

function docxBlocks(nodes: MarkupNode[]): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.name === "w:p") blocks.push(docxParagraph(node));
    else if (node.name === "w:tbl") blocks.push(docxTable(node));
    else if (node.name === "w:sdt") blocks.push(...docxBlocks(childElements(node, "w:sdtContent").flatMap((c) => c.children)));
  }
  return blocks.filter(Boolean);
}

/** Consecutive list items stay together, other blocks are separated by a blank line. */
function joinBlocks(blocks: string[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    const previous = blocks[i - 1];
    const tight = previous !== undefined && /^\s*- /.test(previous) && /^\s*- /.test(block);
    out += i === 0 ? block : `${tight ? "\n" : "\n\n"}${block}`;
  });
  return out;
}

export function docxToMarkdown(buffer: Buffer, options: ZipOptions = {}): string {
  const xml = readZip(buffer, options).read("word/document.xml");
  if (!xml) throw new ZipFormatError("not a .docx file (word/document.xml is missing)");
  const body = findFirst(parseXml(xml.toString("utf8")), "w:body");
  return body ? joinBlocks(docxBlocks(body.children)) : "";
}

function slideParagraphs(shape: MarkupElement): string[] {
  return findAll(shape, "a:p")
    .map((p) => {
      const text = runText(p).replace(/\s*\n\s*/g, " ").trim();
      if (!text) return "";
      const level = Number.parseInt(attr(childElements(p, "a:pPr")[0], "lvl") ?? "0", 10) || 0;
      return `${"  ".repeat(level)}- ${text}`;
    })
    .filter(Boolean);
}

function slideTable(table: MarkupElement): string {
  const rows = findAll(table, "a:tr").map((row) =>
    findAll(row, "a:tc").map((cell) =>
      escapeCell(
        findAll(cell, "a:p")
          .map((p) => runText(p).trim())
          .filter(Boolean)
          .join(" "),
      ),
    ),
  );
  const filled = rows.filter((cells) => cells.some((c) => c !== ""));
  return filled.length > 0 ? markdownTable(filled) : "";
}

function renderSlide(xml: string, number: number): string {
  const doc = parseXml(xml);
  let title = "";
  const lines: string[] = [];
  for (const shape of findAll(doc, "p:sp")) {
    const placeholder = findFirst(shape, "p:ph");
    const type = attr(placeholder, "type");
    if (!title && (type === "title" || type === "ctrTitle")) {
      title = findAll(shape, "a:p")
        .map((p) => runText(p).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");
      continue;
    }
    lines.push(...slideParagraphs(shape));
  }
  const tables = findAll(doc, "a:tbl").map(slideTable).filter(Boolean);
  const body = [lines.join("\n"), ...tables].filter(Boolean).join("\n\n");
  return `## Slide ${number}${title ? `: ${title}` : ""}${body ? `\n\n${body}` : ""}`;
}

/** Slide files in presentation order (ppt/presentation.xml), falling back to the file numbers. */
function slideFiles(zip: ReturnType<typeof readZip>): string[] {
  const presentation = zip.read("ppt/presentation.xml");
  const rels = zip.read("ppt/_rels/presentation.xml.rels");
  if (presentation && rels) {
    const targets = new Map(
      findAll(parseXml(rels.toString("utf8")), "Relationship").map((r) => [r.attrs.Id ?? "", r.attrs.Target ?? ""]),
    );
    const ordered = findAll(parseXml(presentation.toString("utf8")), "p:sldId")
      .map((slide) => targets.get(slide.attrs["r:id"] ?? "") ?? "")
      .filter(Boolean)
      .map((target) => (target.startsWith("/") ? target.slice(1) : `ppt/${target}`));
    if (ordered.length > 0) return ordered;
  }
  return zip.entries
    .map((entry) => ({ name: entry.name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name)?.[1] ?? Number.NaN) }))
    .filter((s) => Number.isFinite(s.number))
    .sort((a, b) => a.number - b.number)
    .map((s) => s.name);
}

export function pptxToMarkdown(buffer: Buffer, options: ZipOptions = {}): string {
  const zip = readZip(buffer, options);
  const files = slideFiles(zip);
  if (files.length === 0) throw new ZipFormatError("not a .pptx file (no ppt/slides/slideN.xml)");
  return files.map((name, i) => renderSlide(zip.read(name)?.toString("utf8") ?? "", i + 1)).join("\n\n");
}
