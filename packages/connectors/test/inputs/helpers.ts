import { readFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";
import { expect } from "vitest";
import type { FetchLike } from "../../src/index.ts";

// Test helpers for the input connectors: a recording fetch (no network), fixture loading, and a tiny ZIP
// writer that builds .docx / .pptx files at runtime (no binary fixture in the repo).

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type RouteHandler = (url: URL, call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function text(body: string | Uint8Array, contentType = "text/plain", status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...headers } });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Routes are matched in order: a string matches the URL without its query, a RegExp the full URL. */
export class RecordingFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Array<{ match: string | RegExp; handler: RouteHandler }> = [];

  on(match: string | RegExp, handler: RouteHandler | Response): this {
    let fn: RouteHandler;
    if (handler instanceof Response) {
      // A fresh response per call (cloning would tee the body, and a tee'd body never finishes cancelling).
      const bytes = handler.arrayBuffer();
      fn = async () => new Response(await bytes, { status: handler.status, headers: handler.headers });
    } else {
      fn = handler;
    }
    this.routes.push({ match, handler: fn });
    return this;
  }

  fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: input,
      headers: headersOf(init),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    this.calls.push(call);
    const url = new URL(input);
    const bare = `${url.origin}${url.pathname}`;
    for (const route of this.routes) {
      const hit = typeof route.match === "string" ? route.match === bare : route.match.test(input);
      if (hit) return route.handler(url, call);
    }
    return json({ message: `no fixture for ${input}` }, 404);
  };

  urls(): string[] {
    return this.calls.map((c) => c.url);
  }
}

/** The read-only contract: every request is a GET, except a POST to an allowed token endpoint. */
export function expectReadOnly(calls: RecordedCall[], allowedPosts: string[] = []): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    if (call.method === "GET") continue;
    const bare = (() => {
      const u = new URL(call.url);
      return `${u.origin}${u.pathname}`;
    })();
    expect({ method: call.method, url: bare, allowed: allowedPosts.includes(bare) && call.method === "POST" }).toEqual({
      method: "POST",
      url: bare,
      allowed: true,
    });
  }
}

export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/inputs/${name}`, import.meta.url), "utf8");
}

export async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await fixture(name)) as unknown;
}

export const noSleep = async (): Promise<void> => undefined;

/** Minimal ZIP writer (deflate), enough to build Office files for the reader tests. */
export function buildZip(files: Record<string, string | Buffer>, options: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = options.store ? data : deflateRawSync(data);
    const method = options.store ? 0 : 8;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function wPara(content: string, style?: string, list?: number): string {
  const props = [style ? `<w:pStyle w:val="${style}"/>` : "", list !== undefined ? `<w:numPr><w:ilvl w:val="${list}"/><w:numId w:val="1"/></w:numPr>` : ""].join("");
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${content}</w:t></w:r></w:p>`;
}

export function buildDocx(bodyXml: string): Buffer {
  return buildZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
  });
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function slideXml(title: string, bullets: string[]): string {
  const titleShape = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const body = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${bullets
    .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree>${titleShape}${body}</p:spTree></p:cSld></p:sld>`;
}

/** Slides are stored as slide1..N but presented in `order` (indexes into `slides`). */
export function buildPptx(slides: string[], order?: number[]): Buffer {
  const files: Record<string, string> = {};
  slides.forEach((xml, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = xml;
  });
  const sequence = order ?? slides.map((_, i) => i);
  files["ppt/presentation.xml"] = `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${sequence
    .map((i, n) => `<p:sldId id="${256 + n}" r:id="rId${i + 1}"/>`)
    .join("")}</p:sldIdLst></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join("")}</Relationships>`;
  return buildZip(files);
}

export async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
