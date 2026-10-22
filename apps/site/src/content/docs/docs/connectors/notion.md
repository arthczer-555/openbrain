---
title: Notion connector
description: Create a read-only integration, share one root page, check it, mirror it with openbrain sync notion.
---

Notion is the **knowledge store**: the only connector the chatbot depends on. Every other tool is a read-only
[input](/docs/connectors/inputs/).

- **Reading** (the mirror) goes through the CLI and a **read-only** integration token: `openbrain sync notion`.
- **Writing** approved changes happens only during `/init`, `/weekly` and `/write`, through the **Notion connector of
  your Claude Code**, after your go-ahead. The integration never writes, so it only gets the *Read content* capability.

`/setup` walks you through the steps below and runs the checks and the first sync for you.

## 1. Create an internal integration

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create an **internal**
   integration in your workspace.
2. Capabilities: **Read content** only. No *Insert content*, no *Update content*.
3. Copy the token.

## 2. Share only the root page

Open the root page of your knowledge in Notion, then `•••`, *Connections*, and add the integration. Notion limits an
integration to the pages shared with it: sharing **only** the root page keeps OpenBrain inside that tree.

## 3. Put the token in `.env`

```bash
cp .env.example .env
# then in .env:
NOTION_TOKEN=ntn_...
```

Paste it yourself in the file, never in a chat. The CLI loads `.env` on its own. The token stays on your machine:
neither Netlify nor GitHub ever needs it, because the chatbot reads the committed mirror.

The root page is set in `openbrain.config.yaml` (`/setup` asks for it; an id or the page URL):

```yaml
notion:
  root_page: "<root-page-id>"
```

## 4. Check the connection

```bash
npm run openbrain -- connectors test notion
```

It checks that the token is valid and the root page reachable, and it **warns about every page the integration can see
outside the root tree**: an integration shared too widely shows up here, before anything is synced.

## 5. Mirror the tree

```bash
npm run openbrain -- sync notion --dry-run      # what would be written, nothing changes
npm run openbrain -- sync notion
```

```text
71 pages under 3f1c2a...: wrote 71, unchanged 0, deleted 0 (164 API requests)
  wrote knowledge/product/index.md
  wrote knowledge/product/data-retention.md
  ...
to add to brain/registry.yaml (when_to_open, aliases), usually by the weekly update:
  - product/data-retention
```

| Option | Effect |
|---|---|
| `--root-page <id>` | Overrides `notion.root_page`. |
| `--dry-run` | Shows what would be written, writes nothing. |
| `--full` | Refetches every page, not only the edited ones. |
| `--json` | Machine-readable report. |

How it behaves:

- **Ids from titles.** The first-level pages are the sections; a section's id comes from its title (*People & HR*
  becomes `people-hr`), and so do page ids (`people-hr/remote-work`).
- **Incremental.** A page whose last edited time did not change is not fetched again. Cursors live in
  `state/notion-sync.json` (commit it).
- **Rate-limited.** Requests are queued around the Notion API average of 3 per second, with retries.
- **Faithful Markdown.** Headings, lists, toggles, callouts, tables and code blocks are rendered; databases become
  tables. Attachments are not indexed: write the facts in the page.
- **Stable paths.** A renamed page keeps its file path, so the registry still matches. Deleted, archived or unshared
  pages leave the mirror.
- **Registry follow-up.** After a sync, the command lists the pages and sections still missing from the registry and
  the entries whose page is gone.

Run the same command whenever Notion changes; the weekly update runs it for you. Never edit `knowledge/` by hand: fix
the page in Notion and sync.
