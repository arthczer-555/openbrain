import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { KNOWLEDGE_DIR, parseMirrorFrontmatter, type HealthReport } from "@openbrain/core";
import { NotionApiError, type NotionClient } from "./client.ts";
import { renderBlocks, renderDatabase, type RenderContext } from "./render.ts";
import { pagesOutsideTree } from "./scope.ts";
import { normalizeId, pageTitle, type NotionPage } from "./types.ts";

// `openbrain sync notion`: rewrites knowledge/ as a mirror of the tree under the Notion root page.
//   root page            -> not a document; its child pages are the sections
//   section page         -> knowledge/<section>/index.md
//   child of a section   -> knowledge/<section>/<page>.md
//   deeper child         -> knowledge/<section>/<parent>/<page>.md
// Paths are sticky: a page keeps its path when renamed, so brain/registry.yaml keeps matching it.
// Incremental: a page whose last_edited_time did not change is not fetched again (its blocks, its children
// list) unless --full. Pages gone from the tree, archived or no longer shared are removed from the mirror.

export const NOTION_STATE_FILE = "state/notion-sync.json";

export interface PageState {
  path: string;
  title: string;
  last_edited_time: string;
  /** Child page ids, in content order. */
  children: string[];
}

export interface NotionSyncState {
  version: 1;
  root_page_id: string;
  pages: Record<string, PageState>;
}

export interface SyncOptions {
  /** Instance root (the folder holding knowledge/ and state/). */
  root: string;
  rootPageId: string;
  client: NotionClient;
  /** Re-render every page even when unchanged. */
  full?: boolean;
  /** Compute the report without writing anything. */
  dryRun?: boolean;
  /** Rows rendered for an embedded database (default 200). */
  maxDatabaseRows?: number;
}

export interface SyncReport {
  rootPageId: string;
  pages: number;
  written: string[];
  unchanged: number;
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
  renamed: Array<{ path: string; from: string; to: string }>;
  warnings: string[];
  requests: number;
  dryRun: boolean;
}

interface Node {
  id: string;
  path: string;
  section: string;
  isSection: boolean;
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "page";
}

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function relativeLink(fromPath: string, toPath: string): string {
  return `${path.posix.relative(path.posix.dirname(fromPath), toPath)}.md`;
}

/** Folder (relative to knowledge/) holding the children of a node. */
function childFolder(node: Node): string {
  return node.isSection ? node.section : node.path;
}

async function readState(root: string): Promise<NotionSyncState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(root, NOTION_STATE_FILE), "utf8"));
    const state = parsed as NotionSyncState;
    return state && state.version === 1 && typeof state.pages === "object" ? state : null;
  } catch {
    return null;
  }
}

function sortedState(state: NotionSyncState): NotionSyncState {
  const pages: Record<string, PageState> = {};
  for (const id of Object.keys(state.pages).sort()) {
    const page = state.pages[id];
    if (page) pages[id] = page;
  }
  return { version: 1, root_page_id: state.root_page_id, pages };
}

async function walkMirror(dir: string, base = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walkMirror(path.join(dir, entry.name), rel)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(rel.replace(/\.md$/, ""));
  }
  return files;
}

async function removeEmptyDirs(dir: string, keep: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name), keep);
  }
  if (dir !== keep && (await readdir(dir)).length === 0) await rmdir(dir);
}

export function renderMirrorFile(node: Node, page: NotionPage, title: string, body: string): string {
  const frontmatter = stringifyYaml({
    id: node.path,
    title,
    section: node.section,
    source: { connector: "notion", page_id: normalizeId(page.id), url: page.url || notionUrl(page.id) },
    updated_at: page.last_edited_time,
  }).trimEnd();
  const content = body.trim();
  return `---\n${frontmatter}\n---\n\n# ${title}\n${content ? `\n${content}\n` : ""}`;
}

export async function syncNotion(options: SyncOptions): Promise<SyncReport> {
  const { client } = options;
  const root = path.resolve(options.root);
  const knowledgeDir = path.join(root, KNOWLEDGE_DIR);
  const rootPageId = normalizeId(options.rootPageId);
  const dryRun = options.dryRun === true;
  const requestsBefore = client.requestCount;

  const previous = await readState(root);
  const prevPages = previous && previous.root_page_id === rootPageId ? previous.pages : {};
  const full = options.full === true || Object.keys(prevPages).length === 0;

  const next: NotionSyncState = { version: 1, root_page_id: rootPageId, pages: {} };
  const report: SyncReport = {
    rootPageId,
    pages: 0,
    written: [],
    unchanged: 0,
    deleted: [],
    moved: [],
    renamed: [],
    warnings: [],
    requests: 0,
    dryRun,
  };
  const warn = (message: string): void => {
    if (!report.warnings.includes(message)) report.warnings.push(message);
  };

  const usedPaths = new Set<string>();
  const assigned = new Map<string, string>();
  const queue: Node[] = [];
  const visited = new Set<string>();

  const claim = (wanted: string, id: string): string => {
    let candidate = wanted;
    if (usedPaths.has(candidate)) candidate = `${wanted}-${id.replace(/-/g, "").slice(0, 6)}`;
    usedPaths.add(candidate);
    assigned.set(id, candidate);
    return candidate;
  };

  const enqueueChild = (parent: Node, childId: string, title: string): string => {
    const id = normalizeId(childId);
    const known = assigned.get(id);
    if (known) return known;
    const folder = childFolder(parent);
    const sticky = prevPages[id]?.path;
    let base = sticky && path.posix.dirname(sticky) === folder ? sticky : `${folder}/${slugify(title)}`;
    if (base === `${folder}/index`) base = `${folder}/index-page`;
    const childPath = claim(base, id);
    queue.push({ id, path: childPath, section: parent.section, isSection: false });
    return childPath;
  };

  // Sections: the child pages of the root page.
  const rootBlocks = await client.listChildren(rootPageId);
  for (const block of rootBlocks) {
    if (block.archived || block.in_trash) continue;
    if (block.type === "child_database") {
      warn("a database directly under the root page is not mirrored: put it inside a section page");
      continue;
    }
    if (block.type !== "child_page") continue;
    const id = normalizeId(block.id);
    const title = String((block.child_page as { title?: unknown } | undefined)?.title ?? "");
    const sticky = prevPages[id]?.path;
    const stickySection = sticky && sticky.endsWith("/index") ? sticky.split("/")[0] : undefined;
    let section = stickySection ?? slugify(title);
    if (usedPaths.has(`${section}/index`)) section = `${section}-${id.replace(/-/g, "").slice(0, 6)}`;
    const sectionPath = claim(`${section}/index`, id);
    queue.push({ id, path: sectionPath, section, isSection: true });
  }

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);

    let page: NotionPage;
    try {
      page = await client.getPage(node.id);
    } catch (error) {
      if (error instanceof NotionApiError && error.notFound) {
        warn(`page ${node.id} is not shared with the integration: skipped`);
        continue;
      }
      throw error;
    }
    if (page.archived || page.in_trash) continue;
    report.pages++;

    const title = pageTitle(page) || "Untitled";
    const prev = prevPages[node.id];
    if (prev && prev.path !== node.path) report.moved.push({ from: prev.path, to: node.path });
    if (prev && prev.title !== title) report.renamed.push({ path: node.path, from: prev.title, to: title });

    const file = path.join(knowledgeDir, `${node.path}.md`);
    let fileExists = false;
    try {
      await readFile(file);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    const unchanged =
      !full && prev !== undefined && prev.last_edited_time === page.last_edited_time && prev.path === node.path && fileExists;
    if (unchanged) {
      for (const childId of prev.children) enqueueChild(node, childId, prevPages[childId]?.title ?? "");
      next.pages[node.id] = { ...prev, title };
      report.unchanged++;
      continue;
    }

    const children: string[] = [];
    const ctx: RenderContext = {
      children: (blockId) => client.listChildren(blockId),
      childPage: (childId, childTitle) => {
        const childPath = enqueueChild(node, childId, childTitle);
        children.push(normalizeId(childId));
        return relativeLink(node.path, childPath);
      },
      pageLink: (pageId) => {
        const id = normalizeId(pageId);
        const target = assigned.get(id) ?? prevPages[id]?.path;
        return target ? relativeLink(node.path, target) : notionUrl(id);
      },
      database: async (databaseId, dbTitle) => {
        try {
          const database = await client.getDatabase(databaseId);
          const { rows, truncated } = await client.queryDatabase(databaseId, options.maxDatabaseRows ?? 200);
          const name = database.title.map((t) => t.plain_text).join("") || dbTitle;
          return renderDatabase(name, database.properties, rows, truncated);
        } catch (error) {
          if (error instanceof NotionApiError && error.notFound) {
            warn(`database "${dbTitle}" in ${node.path} is not shared with the integration`);
            return `_Database "${dbTitle}" is not shared with the integration._`;
          }
          throw error;
        }
      },
      warn: (message) => warn(`${node.path}: ${message}`),
    };

    const body = await renderBlocks(await client.listChildren(node.id), ctx);
    if (!dryRun) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, renderMirrorFile(node, page, title, body), "utf8");
    }
    report.written.push(node.path);
    next.pages[node.id] = { path: node.path, title, last_edited_time: page.last_edited_time, children };
  }

  // Remove mirror files that no longer match a page of the tree (deleted, archived, unshared or moved).
  const keep = new Set(Object.values(next.pages).map((p) => p.path));
  for (const rel of await walkMirror(knowledgeDir)) {
    if (keep.has(rel)) continue;
    const file = path.join(knowledgeDir, `${rel}.md`);
    const parsed = parseMirrorFrontmatter(await readFile(file, "utf8"));
    if (!parsed.ok || parsed.value.source.connector !== "notion") {
      warn(`${KNOWLEDGE_DIR}/${rel}.md is not a Notion mirror file: left untouched`);
      continue;
    }
    if (report.moved.some((m) => m.from === rel)) {
      if (!dryRun) await rm(file);
      continue;
    }
    report.deleted.push(rel);
    if (!dryRun) await rm(file);
  }

  if (!dryRun) {
    await mkdir(knowledgeDir, { recursive: true });
    await removeEmptyDirs(knowledgeDir, knowledgeDir);
    await mkdir(path.dirname(path.join(root, NOTION_STATE_FILE)), { recursive: true });
    await writeFile(path.join(root, NOTION_STATE_FILE), `${JSON.stringify(sortedState(next), null, 2)}\n`, "utf8");
  }

  report.written.sort();
  report.deleted.sort();
  report.requests = client.requestCount - requestsBefore;
  return report;
}

/** Connector health check: who the token is, and whether the root page is reachable. */
export async function checkNotion(client: NotionClient, rootPageId?: string): Promise<HealthReport> {
  try {
    const me = await client.me();
    const workspace = me.bot?.workspace_name ? ` in workspace ${me.bot.workspace_name}` : "";
    const report: HealthReport = {
      ok: true,
      identity: `${me.type === "bot" ? "integration" : "user"} ${me.name ?? me.id}${workspace}`,
      // The Notion API does not expose the capabilities of an internal integration.
      scopes: [],
      writeScopesDetected: false,
    };
    if (rootPageId) {
      const page = await client.getPage(rootPageId);
      report.sample = [{ id: normalizeId(page.id), url: page.url, title: pageTitle(page), modifiedAt: page.last_edited_time }];
      // Least privilege: the integration must see the root tree and nothing else.
      const scope = await pagesOutsideTree(client, rootPageId);
      const warnings: string[] = [];
      if (scope.outside.length > 0) {
        const names = scope.outside.slice(0, 5).map((p) => `"${p.title}"`).join(", ");
        warnings.push(
          `the integration also sees ${scope.outside.length} page(s) outside the root tree (${names}${scope.outside.length > 5 ? ", ..." : ""}): ` +
            "remove its access to them in Notion (page menu > Connections): the mirror only needs the root tree",
        );
      }
      if (scope.partial) warnings.push(`scope check partial: ${scope.visible} visible objects, not all parents could be resolved`);
      if (warnings.length > 0) report.warnings = warnings;
    }
    return report;
  } catch (error) {
    return {
      ok: false,
      scopes: [],
      writeScopesDetected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
