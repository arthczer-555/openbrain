---
name: init
description: Initial consolidation of an OpenBrain instance - read what already exists in Notion and in the input tools, propose a Notion tree (5 to 12 sections) and the pages to create or update, settle duplicates and contradictions with the operator, write into Notion after approval, then sync and build the registry. Use when the operator types /init or wants to fill Notion from Drive, Slack and other tools for the first time.
---

# Initial consolidation into Notion

Same rules as `/weekly` (`.claude/skills/weekly/SKILL.md`, section 0): nothing written without the go,
zero invention, contradictions settled before writing, provenance on every page, language of the base.
Work in batches and keep `.openbrain/init/progress.json` up to date so the work can resume.

1. Inventory (CLI, no LLM): `npm run openbrain -- sync notion` (existing tree) and
   `npm run openbrain -- collect --full --out .openbrain/init` (every input collected by the CLI, whole
   scope). For the tools under `inputs.claude` (`connectors list` shows them "via Claude"), query their MCP
   connector within their scope. Read the estimated volume and tell the operator how many batches it will
   take.
2. Clean-up: empty pages and templates, obvious duplicates, sensitive items flagged in the manifest (never
   copied to Notion).
3. Proposal: a target tree of 5 to 12 sections (the pages right under the Notion root), and page by page what
   will be created or updated, from which sources, with duplicates merged and contradictions listed first.
4. Approval by batches, in the conversation; contradictions settled.
5. Writing through the Notion MCP connector, only under the root page, with the pre-write barrier and a
   "Sources" block at the bottom of each page.
6. `npm run openbrain -- sync notion`, then the registry `brain/registry.yaml` (sections with description
   and routing rules, one entry per page), reviewed by the operator.
7. `npm run openbrain -- guide build`, `npm run openbrain -- index`, then 30 eval questions drafted from the
   base plus the operator's own in `evals/golden.yaml`, and `npm run openbrain -- eval --no-llm`.
8. Commit and push; the deploy picks up the new mirror.
