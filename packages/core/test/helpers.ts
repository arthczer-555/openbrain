import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";

export const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

/** Creates a throwaway instance root from a map of relative path -> content. */
export async function makeInstance(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

export interface MirrorOverrides {
  /** Defaults to the id itself. */
  id?: string;
  title?: string;
  section?: string;
  updated_at?: string;
  /** Raw extra frontmatter line, used to test the strict schema. */
  extra?: string;
}

/** A page of the Notion mirror, as `openbrain sync notion` writes it. */
export function mirrorDoc(pathId: string, body: string, overrides: MirrorOverrides = {}): string {
  const id = overrides.id ?? pathId;
  const sectionId = overrides.section ?? pathId.split("/")[0] ?? "";
  const pageId = `00000000-0000-0000-0000-${String(Math.abs(hash(pathId))).padStart(12, "0").slice(0, 12)}`;
  return [
    "---",
    `id: ${id}`,
    `title: "${overrides.title ?? id}"`,
    `section: ${sectionId}`,
    "source:",
    "  connector: notion",
    `  page_id: ${pageId}`,
    `  url: https://www.notion.so/test/${pageId.replace(/-/g, "")}`,
    `updated_at: "${overrides.updated_at ?? "2026-10-01T09:00:00.000Z"}"`,
    "lang: en",
    ...(overrides.extra ? [overrides.extra] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) | 0;
  return h;
}

export interface DocEntry {
  when_to_open?: string;
  aliases?: string[];
  warnings?: string[];
  status?: string;
}

export interface SectionEntry {
  description: string;
  rules?: string[];
}

/** brain/registry.yaml content. A doc mapped to `true` gets a default when_to_open. */
export function registryYaml(
  sections: Record<string, SectionEntry>,
  docs: Record<string, DocEntry | true>,
): string {
  const docEntries: Record<string, DocEntry> = {};
  for (const [id, entry] of Object.entries(docs)) {
    docEntries[id] =
      entry === true ? { when_to_open: `Open for questions about ${id.replace(/[^a-z]+/g, " ").trim()}.` } : entry;
  }
  return stringifyYaml({ version: 1, sections, docs: docEntries });
}
