# Public API (core + retrieval + connectors/notion), frozen 2026-10-22

- `loadKnowledgeBase(root) -> KnowledgeBase { root, sections: SectionInfo[], docs: KnowledgeDoc[], errors, routing }`: Notion mirror (`knowledge/`) merged with `brain/registry.yaml`.
- `KnowledgeDoc { pathId, file, mirror: MirrorFrontmatter, body, routing: DocRouting | null, meta: DocMeta, isSectionIndex, structural }`.
- `DocMeta { id, title, section, url (Notion page), updated_at, lang, when_to_open, aliases[], warnings[], status: "validated" | "to_confirm" | "stale" }`.
- `servableDocs(kb)`: docs with knowledge and a registry entry (the only ones indexed). `lintKnowledgeBase(kb) -> LintIssue[]`, `hasErrors(issues)`.
- `prepareGuide(kb) -> { guide: { catalog, registry, registryJson }, budgets, problems }`, `writeGuide(root, guide)`, `checkGuide(root, guide)`.
- `loadInstanceConfig(root) -> InstanceConfig` (`notion.root_page`, `models.chat: ModelConfig`, `pricing`), `ModelConfigSchema` unchanged.
- `estimateTokens(text)`, `DEFAULT_BUDGETS { core: 1200, catalog: 700 }`.
- `buildIndex(kb) -> SerializedIndex`, `saveIndex(root, index)`, `loadIndex(root) -> SerializedIndex | null` (file `.openbrain/index.json`).
- `search(index, query, { section?, k? (6, max 10), maxPerDoc? (2), maxTokens? (4000), exclude?: Set<chunkId> }) -> { query, results: SearchResultItem[], sectionRules: Record<section, string[]>, truncated }`.
- `SearchResultItem { rank, chunkId, docId, title, section, headingPath[], text, url, status, updatedAt, score, warnings? (first passage of a doc only) }`.
- `readDocument(index, docId, { heading?, page?, maxTokens? (3000) }) -> ReadResult | null` (`{ docId, title, url, text, page, pages, chunkIds, warnings, headingNotFound, ... }`), `readCost(result)`.
- `@openbrain/connectors`: `new NotionClient({ token })`, `syncNotion({ root, rootPageId, client, full?, dryRun? }) -> SyncReport`, `checkNotion(client, rootPageId?) -> HealthReport`.
- CLI plugins: `packages/cli/src/commands/index.ts` exports `commands: CommandDefinition[]` (`{ name, help, booleanFlags?, run(args) }`); add one import and one array entry.
