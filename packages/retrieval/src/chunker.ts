import { estimateTokens } from "@openbrain/core";

// Splits a Markdown document into passages along H2/H3 headings.
// Each passage is prefixed with "Doc title > heading path" so it stays understandable on its own.
// Tables and code blocks are atomic: they are never cut, even when they exceed the target size.

export interface ChunkOptions {
  /** A passage is closed before it grows past this size (estimated tokens). */
  maxTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 500 };

export interface ChunkInput {
  docId: string;
  title: string;
  body: string;
}

export interface Chunk {
  id: string;
  docId: string;
  ordinal: number;
  headingPath: string[];
  /** Passage content without the prefix. */
  content: string;
  /** Prefix + content: what the model reads. */
  text: string;
  tokens: number;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "content"; text: string; atomic: boolean };

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_RE = /^\s*\|/;

function parseBlocks(body: string): Block[] {
  const lines = body.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "content", text: paragraph.join("\n"), atomic: false });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const code = [line];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        code.push(next);
        if (next.trim().startsWith(marker)) break;
        i++;
      }
      blocks.push({ kind: "content", text: code.join("\n"), atomic: true });
      continue;
    }
    if (TABLE_RE.test(line)) {
      flushParagraph();
      const table = [line];
      while (i + 1 < lines.length && TABLE_RE.test(lines[i + 1] ?? "")) {
        i++;
        table.push(lines[i] ?? "");
      }
      blocks.push({ kind: "content", text: table.join("\n"), atomic: true });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading && (heading[1]?.length ?? 0) <= 3) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export function chunkDocument(input: ChunkInput, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];
  let path: string[] = [];
  let parts: string[] = [];
  let partsTokens = 0;

  const flush = (): void => {
    if (parts.length === 0) return;
    const content = parts.join("\n\n");
    const prefix = [input.title, ...path].join(" > ");
    const text = `${prefix}\n\n${content}`;
    chunks.push({
      id: `${input.docId}#${chunks.length}`,
      docId: input.docId,
      ordinal: chunks.length,
      headingPath: [...path],
      content,
      text,
      tokens: estimateTokens(text),
    });
    parts = [];
    partsTokens = 0;
  };

  for (const block of parseBlocks(input.body)) {
    if (block.kind === "heading") {
      flush();
      if (block.level === 1) path = [];
      else if (block.level === 2) path = [block.text];
      else path = [path[0] ?? block.text, block.text].filter((v, i, arr) => arr.indexOf(v) === i);
      continue;
    }
    const blockTokens = estimateTokens(block.text);
    if (parts.length > 0 && partsTokens + blockTokens > options.maxTokens) flush();
    parts.push(block.text);
    partsTokens += blockTokens;
  }
  flush();
  return chunks;
}
