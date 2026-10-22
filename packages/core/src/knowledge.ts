import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseMirrorFrontmatter, type MirrorFrontmatter } from "./frontmatter.ts";
import {
  loadRoutingRegistry,
  ROUTING_FILE,
  type DocRouting,
  type DocStatus,
  type RoutingRegistry,
} from "./routing.ts";

// Loads an instance knowledge base: the Notion mirror in knowledge/ merged with the routing registry
// brain/registry.yaml. Layout of the mirror:
//   knowledge/<section>/index.md            the section page (first-level child of the Notion root page)
//   knowledge/<section>/<page>.md           its child pages
//   knowledge/<section>/<page>/<child>.md   deeper pages
// Files and folders starting with "_" or "." are ignored.

export const KNOWLEDGE_DIR = "knowledge";
export const SECTION_INDEX = "index.md";

/** Merged view of a document: mirror metadata (from Notion) + routing metadata (from the registry). */
export interface DocMeta {
  id: string;
  title: string;
  section: string;
  url: string;
  updated_at: string;
  lang: string | undefined;
  when_to_open: string;
  aliases: string[];
  warnings: string[];
  status: DocStatus;
}

export interface KnowledgeDoc {
  /** Path relative to knowledge/ without extension, for example "product/booking". */
  pathId: string;
  /** Path relative to the instance root, for example "knowledge/product/booking.md". */
  file: string;
  mirror: MirrorFrontmatter;
  body: string;
  /** Entry of brain/registry.yaml, null when the page is not registered yet. */
  routing: DocRouting | null;
  meta: DocMeta;
  /** True for the section page (knowledge/<section>/index.md). */
  isSectionIndex: boolean;
  /** True when the page holds no knowledge of its own (only headings and links to child pages). */
  structural: boolean;
}

export interface SectionInfo {
  id: string;
  /** Title of the Notion section page, or the folder name when the index page is missing. */
  title: string;
  description: string;
  rules: string[];
  /** Doc id of knowledge/<section>/index.md, when present. */
  indexDocId: string | null;
  /** True when brain/registry.yaml has an entry for this section. */
  registered: boolean;
}

export interface LoadError {
  file: string;
  errors: string[];
}

export interface RoutingStatus {
  file: string;
  present: boolean;
  errors: string[];
  /** Registry doc entries without a mirrored page. */
  orphanDocIds: string[];
  /** Registry section entries without a folder in knowledge/. */
  orphanSectionIds: string[];
}

export interface KnowledgeBase {
  root: string;
  sections: SectionInfo[];
  docs: KnowledgeDoc[];
  errors: LoadError[];
  routing: RoutingStatus;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

const STRUCTURAL_LINE = /^\s*(#{1,6}\s.*|[-*]\s+\[[^\]]*\]\([^)]*\)\s*|\[[^\]]*\]\([^)]*\)\s*|-{3,}|\*{3,})$/;

/** A page is structural when, once headings, separators and child-page links are removed, nothing is left. */
export function isStructuralBody(body: string): boolean {
  return body.split(/\r?\n/).every((line) => line.trim() === "" || STRUCTURAL_LINE.test(line));
}

function buildMeta(mirror: MirrorFrontmatter, routing: DocRouting | null): DocMeta {
  return {
    id: mirror.id,
    title: mirror.title,
    section: mirror.section,
    url: mirror.source.url,
    updated_at: mirror.updated_at,
    lang: mirror.lang,
    when_to_open: routing?.when_to_open ?? "",
    aliases: routing?.aliases ?? [],
    warnings: routing?.warnings ?? [],
    status: routing?.status ?? "validated",
  };
}

export async function loadKnowledgeBase(root: string): Promise<KnowledgeBase> {
  const absoluteRoot = path.resolve(root);
  const knowledgeDir = path.join(absoluteRoot, KNOWLEDGE_DIR);
  if (!(await exists(knowledgeDir))) {
    throw new Error(`no ${KNOWLEDGE_DIR}/ folder in ${absoluteRoot}`);
  }

  const routingLoad = await loadRoutingRegistry(absoluteRoot);
  const registry: RoutingRegistry = routingLoad.registry ?? { version: 1, sections: {}, docs: {} };

  const docs: KnowledgeDoc[] = [];
  const errors: LoadError[] = [];
  const sectionIds = new Set<string>();

  for (const absoluteFile of await walkMarkdown(knowledgeDir)) {
    const relToKnowledge = toPosix(path.relative(knowledgeDir, absoluteFile));
    const file = `${KNOWLEDGE_DIR}/${relToKnowledge}`;
    const segments = relToKnowledge.split("/");
    if (segments.length < 2) {
      errors.push({ file, errors: ["pages must live inside a section folder (knowledge/<section>/...)"] });
      continue;
    }
    const sectionId = segments[0] ?? "";
    sectionIds.add(sectionId);
    const parsed = parseMirrorFrontmatter(await readFile(absoluteFile, "utf8"));
    if (!parsed.ok) {
      errors.push({ file, errors: parsed.errors });
      continue;
    }
    const pathId = relToKnowledge.replace(/\.md$/, "");
    const routing = registry.docs[parsed.value.id] ?? null;
    docs.push({
      pathId,
      file,
      mirror: parsed.value,
      body: parsed.body,
      routing,
      meta: buildMeta(parsed.value, routing),
      isSectionIndex: segments.length === 2 && segments[1] === SECTION_INDEX,
      structural: isStructuralBody(parsed.body),
    });
  }
  docs.sort((a, b) => a.pathId.localeCompare(b.pathId));

  const sections: SectionInfo[] = [...sectionIds].sort().map((id) => {
    const indexDoc = docs.find((d) => d.isSectionIndex && d.pathId === `${id}/index`);
    const entry = registry.sections[id];
    return {
      id,
      title: indexDoc?.mirror.title ?? id,
      description: entry?.description ?? "",
      rules: entry?.rules ?? [],
      indexDocId: indexDoc?.mirror.id ?? null,
      registered: entry !== undefined,
    };
  });

  const docIds = new Set(docs.map((d) => d.mirror.id));
  return {
    root: absoluteRoot,
    sections,
    docs,
    errors,
    routing: {
      file: ROUTING_FILE,
      present: routingLoad.present,
      errors: routingLoad.errors,
      orphanDocIds: Object.keys(registry.docs).filter((id) => !docIds.has(id)).sort(),
      orphanSectionIds: Object.keys(registry.sections).filter((id) => !sectionIds.has(id)).sort(),
    },
  };
}
