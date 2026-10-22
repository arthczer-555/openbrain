import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBase, KnowledgeDoc } from "./knowledge.ts";
import type { DocStatus } from "./routing.ts";
import { checkBudgets, type BudgetLimits, type BudgetReport, DEFAULT_BUDGETS } from "./tokens.ts";

// The agent guide is compiled from the Notion mirror + the routing registry, never written by hand.
// catalog.md is always in the prompt (one line per section); registry.json is one entry per page.
// Output is deterministic: no timestamps, stable ordering, so the prompt cache and `guide check` stay stable.

export const BRAIN_DIR = "brain";
export const CORE_FILE = `${BRAIN_DIR}/core.md`;
export const CATALOG_FILE = `${BRAIN_DIR}/catalog.md`;
export const REGISTRY_FILE = `${BRAIN_DIR}/registry.json`;

export interface RegistrySection {
  id: string;
  title: string;
  description: string;
  rules: string[];
  doc_count: number;
}

export interface RegistryEntry {
  id: string;
  title: string;
  section: string;
  when_to_open: string;
  aliases: string[];
  warnings: string[];
  status: DocStatus;
  url: string;
  updated_at: string;
}

export interface Registry {
  version: 1;
  sections: RegistrySection[];
  docs: RegistryEntry[];
}

export interface Guide {
  catalog: string;
  registry: Registry;
  registryJson: string;
}

/** Pages the chatbot may serve: pages holding knowledge, with a routing entry. */
export function servableDocs(kb: KnowledgeBase): KnowledgeDoc[] {
  return kb.docs.filter((doc) => !doc.structural && doc.routing !== null);
}

export function docUrl(doc: KnowledgeDoc): string {
  return doc.meta.url;
}

export function buildGuide(kb: KnowledgeBase): Guide {
  const docs = servableDocs(kb);
  const counts = new Map<string, number>();
  for (const doc of docs) {
    counts.set(doc.meta.section, (counts.get(doc.meta.section) ?? 0) + 1);
  }

  const sections: RegistrySection[] = kb.sections
    .filter((s) => (counts.get(s.id) ?? 0) > 0)
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      rules: s.rules,
      doc_count: counts.get(s.id) ?? 0,
    }));

  const entries: RegistryEntry[] = docs.map((doc) => ({
    id: doc.meta.id,
    title: doc.meta.title,
    section: doc.meta.section,
    when_to_open: doc.meta.when_to_open,
    aliases: doc.meta.aliases,
    warnings: doc.meta.warnings,
    status: doc.meta.status,
    url: doc.meta.url,
    updated_at: doc.meta.updated_at,
  }));

  const lines = [
    "Knowledge base sections (search_knowledge can be filtered by section id):",
    ...sections.map((s) => {
      const plural = s.doc_count === 1 ? "page" : "pages";
      return `- ${s.id} (${s.title}): ${s.description} [${s.doc_count} ${plural}]`;
    }),
  ];
  const catalog = `${lines.join("\n")}\n`;
  const registry: Registry = { version: 1, sections, docs: entries };
  return { catalog, registry, registryJson: `${JSON.stringify(registry, null, 2)}\n` };
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export interface GuideBuildResult {
  guide: Guide;
  budgets: BudgetReport[];
  /** Problems that must stop the build (missing core, budgets exceeded). */
  problems: string[];
}

export async function prepareGuide(
  kb: KnowledgeBase,
  limits: BudgetLimits = DEFAULT_BUDGETS,
): Promise<GuideBuildResult> {
  const guide = buildGuide(kb);
  const core = await readOptional(path.join(kb.root, CORE_FILE));
  const problems: string[] = [];
  if (core === null) problems.push(`missing ${CORE_FILE}`);
  const budgets = checkBudgets({ core: core ?? "", catalog: guide.catalog }, limits);
  for (const report of budgets) {
    if (!report.ok) {
      problems.push(`${report.name} is ~${report.tokens} tokens, over its budget of ${report.limit}`);
    }
  }
  return { guide, budgets, problems };
}

export async function writeGuide(root: string, guide: Guide): Promise<string[]> {
  await mkdir(path.join(root, BRAIN_DIR), { recursive: true });
  await writeFile(path.join(root, CATALOG_FILE), guide.catalog, "utf8");
  await writeFile(path.join(root, REGISTRY_FILE), guide.registryJson, "utf8");
  return [CATALOG_FILE, REGISTRY_FILE];
}

export interface GuideCheck {
  upToDate: boolean;
  /** Files whose committed content differs from what the knowledge base produces. */
  stale: string[];
}

export async function checkGuide(root: string, guide: Guide): Promise<GuideCheck> {
  const stale: string[] = [];
  const pairs: Array<[string, string]> = [
    [CATALOG_FILE, guide.catalog],
    [REGISTRY_FILE, guide.registryJson],
  ];
  for (const [file, expected] of pairs) {
    const actual = await readOptional(path.join(root, file));
    if (actual !== expected) stale.push(file);
  }
  return { upToDate: stale.length === 0, stale };
}
