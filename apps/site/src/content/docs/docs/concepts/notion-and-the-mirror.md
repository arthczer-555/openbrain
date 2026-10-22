---
title: Notion as the single source of truth
description: Why the knowledge lives in Notion, what the mirror is, and how other tools feed it.
---

There is exactly one place where a fact about your company can be true: **Notion**, under one root page. The chatbot
reads Notion only, so it can never serve two versions of the same information.

## Three pieces

| Piece | Where | Written by | Role |
|---|---|---|---|
| **The knowledge** | Notion, under the root page | Your team, as today, plus Claude during setup and weekly updates, after your go-ahead | The truth. A correction is made here. |
| **The mirror** | `knowledge/` in your private repo | `openbrain sync notion`, automatically, no LLM | A faithful Markdown copy, split into passages and indexed without any Notion token on the server. Never edited by hand. |
| **The registry** | `brain/registry.yaml` in your private repo | Claude, during `/setup`, `/init` and `/weekly`, after your review | When to open each page, its aliases and warnings, and short rules per section. See [the routing registry](/docs/concepts/registry/). |

## Why a mirror instead of reading Notion live

- **Lean answers.** A mirror can be split into passages and searched in milliseconds. Fetching whole Notion pages at
  question time costs thousands of tokens per page.
- **No Notion token on the server.** Netlify builds the index from the committed mirror. A leak on the hosting side
  exposes neither Notion nor your other tools.
- **History for free.** Git keeps every version: "what did the chatbot know on March 3rd?" is a `git log` away, and a
  flag records the commit that answered.

## One file per page

```markdown
---
id: product/data-retention              # path inside knowledge/, without .md
title: "Data retention"
section: product                        # first-level page it belongs to
source:
  connector: notion
  page_id: 0ebc1b5d-75e2-6e73-8cd5-88a096d5fa5f
  url: https://www.notion.so/yourco/Data-retention-0ebc1b5d75e26e738cd588a096d5fa5f
updated_at: 2026-10-20T09:00:00.000Z    # Notion "last edited" time
lang: en
---

# Data retention

## How long we keep ticket data
...
```

- The section page goes to `knowledge/<section>/index.md`, its children to `knowledge/<section>/<page>.md`, deeper
  pages to sub-folders. Ids come from the titles: *People & HR* becomes the section `people-hr`.
- Citations point to `source.url`: your colleagues land on the real Notion page.
- A renamed page keeps its file path, so the registry still matches. A deleted, archived or unshared page leaves the
  mirror at the next sync, and `guide check` then reports its orphan registry entry.
- Files and folders starting with `_` or `.` are ignored.

## Other tools feed Notion, they never answer

Files, websites, GitHub, Google Drive and any MCP server are **inputs** (Slack through your Slack MCP connector until
its input ships). They are read, read-only, during `/init` and each weekly update; what deserves to be known is written
into Notion by Claude, through the Notion connector of your Claude Code, after your go-ahead, with a *Sources* block at
the bottom of the page. See [inputs](/docs/connectors/inputs/).

Before anything is written, Claude runs a **pre-write check**:

1. **No duplicate.** If a page covers the topic, it is edited, not doubled.
2. **Up to date.** A newer source updates the page; two versions are never juxtaposed.
3. **Correct.** Faithful to the source, nothing filled in. What is not confirmed is marked *to confirm*.
4. **No contradiction**, with another page or between the sources used.
5. **In the language of the base** (`kb_language`).
6. **Provenance**: tool, link and collection date in a *Sources* block.

## Conflicts are settled before writing

When the Drive deck says one price and the Notion page another, the update does not pick. The point goes to the top
of the briefing with both values, their sources and their dates, and **nothing is written on that point** until you
decide. An unsettled conflict stays in `state/pending.json` and comes back at the top of every briefing.

As a safety net, if the chatbot ever finds two incompatible passages, it says so, cites both and flags the question
with the reason `contradiction`.

## Notion is required in v1

A `KnowledgeStore` interface (list, read, write, move) keeps the door open for other stores, such as plain Markdown
or Confluence. They are planned, not part of v1.
