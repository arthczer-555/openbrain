import { existsSync } from "node:fs";
import path from "node:path";
import { KNOWLEDGE_DIR, type KnowledgeBase, type KnowledgeDoc } from "./knowledge.ts";
import { ROUTING_FILE } from "./routing.ts";

// Lint of the mirror + routing registry pair. Errors block the guide and the index, warnings are reported.
// The registry must cover the mirror exactly: every page holding knowledge has an entry, no entry is orphan.

export type LintLevel = "error" | "warning";

export interface LintIssue {
  level: LintLevel;
  rule: string;
  file: string;
  message: string;
}

export const WHEN_TO_OPEN_MAX = 220;

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre";

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}(-\d{2})?\b/, // 2026-10 or 2026-10-16
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/, // 16/10/2026
  new RegExp(`\\b(${MONTHS})\\s+\\d{4}\\b`, "i"), // October 2026
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTHS})\\b`, "i"), // 16 October
];

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function registryRef(docId: string): string {
  return `${ROUTING_FILE} (docs.${docId})`;
}

function lintWhenToOpen(doc: KnowledgeDoc, issues: LintIssue[]): void {
  const text = doc.routing?.when_to_open ?? "";
  const file = registryRef(doc.mirror.id);
  if (text.length > WHEN_TO_OPEN_MAX) {
    issues.push({
      level: "error",
      rule: "when-to-open-length",
      file,
      message: `when_to_open is ${text.length} characters (max ${WHEN_TO_OPEN_MAX}): it says when to open the page, not what it contains`,
    });
  }
  if (DATE_PATTERNS.some((re) => re.test(text))) {
    issues.push({
      level: "error",
      rule: "when-to-open-date",
      file,
      message: "when_to_open contains a date: dates belong in the page, a copy in the registry goes stale silently",
    });
  } else if (/\d/.test(text)) {
    // Digits are a warning, not an error: some names legitimately contain them (ISO 27001, SCIM 2.0).
    issues.push({
      level: "warning",
      rule: "when-to-open-number",
      file,
      message: "when_to_open contains a number: keep figures in the page unless it is part of a name",
    });
  }
}

function lintLinks(kb: KnowledgeBase, doc: KnowledgeDoc, issues: LintIssue[]): void {
  const docDir = path.dirname(path.join(kb.root, doc.file));
  for (const match of doc.body.matchAll(LINK_RE)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) continue;
    const withoutAnchor = target.split("#")[0] ?? "";
    if (!withoutAnchor.endsWith(".md")) continue;
    const resolved = path.resolve(docDir, decodeURIComponent(withoutAnchor));
    if (!existsSync(resolved)) {
      issues.push({
        level: "error",
        rule: "broken-link",
        file: doc.file,
        message: `internal link to ${target} points to a missing file`,
      });
    }
  }
}

export function lintKnowledgeBase(kb: KnowledgeBase): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const loadError of kb.errors) {
    for (const message of loadError.errors) {
      issues.push({ level: "error", rule: "invalid-file", file: loadError.file, message });
    }
  }

  if (!kb.routing.present) {
    issues.push({
      level: "error",
      rule: "missing-registry",
      file: ROUTING_FILE,
      message: "no routing registry: create it with one entry per page and per section",
    });
  }
  for (const message of kb.routing.errors) {
    issues.push({ level: "error", rule: "invalid-registry", file: ROUTING_FILE, message });
  }
  for (const id of kb.routing.orphanDocIds) {
    issues.push({
      level: "error",
      rule: "orphan-registry-entry",
      file: registryRef(id),
      message: `the registry routes to "${id}" but no mirrored page has this id (renamed, moved or deleted in Notion?)`,
    });
  }
  for (const id of kb.routing.orphanSectionIds) {
    issues.push({
      level: "error",
      rule: "orphan-section-entry",
      file: `${ROUTING_FILE} (sections.${id})`,
      message: `the registry describes section "${id}" but knowledge/ has no such folder`,
    });
  }

  const docsBySection = new Map<string, KnowledgeDoc[]>();
  for (const doc of kb.docs) {
    const list = docsBySection.get(doc.mirror.section) ?? [];
    list.push(doc);
    docsBySection.set(doc.mirror.section, list);
  }
  for (const section of kb.sections) {
    const hasKnowledge = (docsBySection.get(section.id) ?? []).some((d) => !d.structural);
    if (hasKnowledge && !section.registered) {
      issues.push({
        level: "error",
        rule: "missing-section-entry",
        file: `${ROUTING_FILE} (sections.${section.id})`,
        message: `section "${section.id}" has no entry in the registry (description + routing rules)`,
      });
    }
    if (!section.indexDocId) {
      issues.push({
        level: "warning",
        rule: "missing-section-index",
        file: `${KNOWLEDGE_DIR}/${section.id}/`,
        message: `section "${section.id}" has no index.md: its title falls back to the folder name (run openbrain sync notion)`,
      });
    }
  }

  const titles = new Map<string, string>();
  for (const doc of kb.docs) {
    const mirror = doc.mirror;
    if (mirror.id !== doc.pathId) {
      issues.push({
        level: "error",
        rule: "id-matches-path",
        file: doc.file,
        message: `id "${mirror.id}" must equal the file path "${doc.pathId}"`,
      });
    }
    const pathSection = doc.pathId.split("/")[0] ?? "";
    if (mirror.section !== pathSection) {
      issues.push({
        level: "error",
        rule: "section-matches-folder",
        file: doc.file,
        message: `section "${mirror.section}" must equal the folder "${pathSection}"`,
      });
    }

    // Same title in two places happens in a real Notion tree ("Overview" under two hubs): a warning only.
    const titleKey = mirror.title.trim().toLowerCase();
    const previous = titles.get(titleKey);
    if (previous) {
      issues.push({
        level: "warning",
        rule: "duplicate-title",
        file: doc.file,
        message: `title "${mirror.title}" is also used by ${previous}: make when_to_open tell them apart`,
      });
    } else {
      titles.set(titleKey, doc.file);
    }

    lintLinks(kb, doc, issues);

    if (!doc.structural && !doc.routing) {
      issues.push({
        level: "error",
        rule: "missing-registry-entry",
        file: doc.file,
        message: `page "${mirror.id}" has no entry in ${ROUTING_FILE}: add when_to_open (and aliases) so the agent can find it`,
      });
    }
    if (doc.routing) lintWhenToOpen(doc, issues);
    if (doc.structural && !doc.isSectionIndex && doc.body.trim() === "") {
      issues.push({ level: "warning", rule: "empty-page", file: doc.file, message: "the Notion page is empty" });
    }
  }

  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

export function hasErrors(issues: LintIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}
