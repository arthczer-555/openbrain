---
title: Inputs overview
description: Connectors of Claude Code, files, websites, GitHub, Google Drive, any MCP server or REST API, read-only, consolidated into Notion after your approval.
---

An **input** is a tool OpenBrain reads to keep Notion complete. Inputs are **read-only**, they are read only during
`/init` and the weekly update, and what they contain reaches the chatbot only after it has been written into Notion
with your go-ahead. The chatbot never queries an input.

## Three ways to connect a tool

| Way | Best for | Declared as |
|---|---|---|
| **A connector of Claude Code** | Any tool with a claude.ai connector or an MCP server (Slack, Drive, Gmail, HubSpot, Linear, Jira...): no token in the repo, Claude queries it during `/init` and `/weekly` | `inputs.claude.<name>`, with a scope |
| **A built-in input** | Local files, websites, GitHub, Google Drive | `inputs.files`, `web`, `github`, `gdrive` |
| **A generic adapter** | Any other MCP server or REST API, collected by the CLI: free and reproducible | `inputs.mcp.<name>`, `inputs.api.<name>` |

To connect a tool to Claude Code, enable its connector on claude.ai (*Customize* → *Connectors*), or add its MCP server
from the repo folder and sign in with `/mcp`:

```bash
claude mcp add --transport http tracker https://tracker.acme.example/mcp   # remote server
claude mcp add wiki -- npx -y @acme/wiki-mcp                               # local server (stdio)
```

## Two kinds of input

| Kind | Examples | What Claude does with it |
|---|---|---|
| **Documents** | Files, web pages, repository docs, Google Docs, Sheets and Slides | The useful content is **merged into a Notion page** (new or existing), rewritten in the language of the base, with its provenance. Never copied as is if it duplicates Notion. |
| **Streams** | Commits, merged pull requests, tickets, messages | **Distilled**: only durable, verifiable facts are proposed. Never a transcript, never personal data, never an author's name. |

## Available inputs

| Input | Kind | What it reads | Status |
|---|---|---|---|
| `files` | documents | Local folders: `.md`, `.txt`, `.csv`, `.html`, `.json`, `.docx`, `.pptx`. PDFs and other formats are listed as skipped. No token. | v0.1 |
| `web` | documents | A sitemap and a list of URLs, main content only, `robots.txt` respected, a delay between requests. | v0.1 |
| `github` | documents + stream | Markdown docs of the repositories, plus commits and merged pull requests as a stream. `GITHUB_TOKEN`, read-only. | v0.1 |
| `gdrive` | documents | Folders shared with a service account: Docs as Markdown, Sheets (first tab) as a table, Slides as text. PDFs skipped. `GDRIVE_SA_JSON`. | v0.1 |
| `mcp` | documents or stream | Any MCP server, over stdio or Streamable HTTP, through a YAML mapping. Write-like tools are refused. | v0.1 |
| `api` | documents or stream | Any REST API that answers JSON, through the same YAML mapping. `GET` only, and only to the host of `base_url`. | v0.1 |
| `claude` | documents or stream | A tool read by Claude through its connector in Claude Code, within the scope you write. Not collected by the CLI. | v0.1 |
| `slack` | stream | A built-in Slack input. Meanwhile, use the Slack connector of Claude Code or a Slack MCP server. | planned |

Each connector has a `SETUP.md` with the step-by-step setup, in `packages/connectors/src/<id>/`.

:::note[Status]
The inputs are implemented and covered by tests on fixtures. Runs against real accounts are being validated.
:::

## Configuration

Inputs are declared under `inputs:` in `openbrain.config.yaml`. **Allow-lists everywhere**: no input reads "the whole
workspace".

```yaml
inputs:
  files:
    enabled: true
    paths: ["./docs-export"]
    include: ["**/*.md", "**/*.docx"]
  web:
    enabled: true
    sitemap: "https://acme.example/sitemap.xml"
    include: ["/docs/", "/help/"]
    max_pages: 200
  github:
    enabled: true
    repos: ["acme/desk"]
    docs_globs: ["README.md", "docs/**/*.md"]
    commits: true
    pull_requests: true
  gdrive:
    enabled: true
    folders: ["<folder-id>"]
    mime: [doc, sheet, slides, text]
  mcp:
    tracker:
      enabled: true
      transport: http
      url: "https://tracker.acme.example/mcp"
      auth_env: ACME_TRACKER_TOKEN
      mapping: ./connectors/tracker.mapping.yaml
  api:
    crm:
      enabled: true
      base_url: "https://api.crm.acme.example/v2"
      auth: { type: bearer, env: ACME_CRM_TOKEN }   # or header, basic, query
      mapping: ./connectors/crm.mapping.yaml
  claude:
    slack: { scope: "channels #product, #sales and #announcements, threads included" }
```

Tokens go to `.env` on your machine. Every key is listed in the [config reference](/docs/reference/config/#inputs).

## Commands

```bash
npm run openbrain -- connectors list            # Notion and the inputs, with their status
npm run openbrain -- connectors test gdrive     # identity, granted scopes, write-scope alert, sample items
npm run openbrain -- collect                    # read-only collection into .openbrain/weekly/<date>/inputs/
npm run openbrain -- collect --only github --since 2026-10-01 --dry-run
```

`collect` options: `--since` and `--until` (the window), `--only <id,id>`, `--out <dir>` (under `.openbrain/`), `--full`
(every document, not only the changed ones, for the first consolidation), `--dry-run`. It writes only under
`.openbrain/`, which git ignores. The weekly update runs it for you (`weekly prepare`).

## The generic MCP adapter

One adapter plugs into any MCP server and maps its tools to the input interface with a small YAML file
(`examples/acme/connectors/tracker.mapping.yaml` is a complete example):

```yaml
kind: stream                 # stream (events, distilled) or documents (mirrored content)
list:
  tool: list_issues          # a read tool of the server
  args: { updatedAfter: "{{since}}", limit: 50 }
  items: "$.issues[*]"
  paginate: { cursor_arg: after, next: "$.pageInfo.endCursor", max_pages: 20 }
map:
  id: "$.identifier"
  title: "{{$.identifier}}: {{$.title}}"
  url: "$.url"
  modifiedAt: "$.updatedAt"
  text: "{{$.description}}\n\nStatus: {{$.state.name}}"
event_kind: ticket
```

- **Read-only is enforced** before any call: a tool whose name contains a write verb (`create`, `update`, `delete`,
  `send`, `post`, `write`, `set`...), whose description applies one, or that is annotated as destructive, is refused.
- **Two transports**: `stdio` (a server started locally, for example with `npx`) and Streamable HTTP (a remote server).
- `connectors test mcp:<name>` lists the server's tools, which helps you write the mapping. In `/setup`, Claude drafts
  it for you.

## The generic REST adapter

`inputs.api.<name>` reads any HTTP API that answers JSON, with the same mapping format and an endpoint instead of a
tool (`examples/acme/connectors/crm.mapping.yaml` is a complete example):

```yaml
kind: stream
list:
  path: /deals                       # relative to base_url
  query: { updated_since: "{{since_date}}", limit: 100 }
  items: "$.results[*]"
  paginate: { cursor_param: after, next: "$.paging.next.after" }   # or next_url, page_param, offset_param
map:
  id: "$.id"
  title: "{{$.properties.name}}"
  modifiedAt: "$.updatedAt"
  text: "Deal {{$.properties.name}} moved to {{$.properties.stage}}"
event_kind: deal_change
```

- **Read-only by construction**: only `GET` requests, only to the host of `base_url` (a pagination link to another
  host is refused), and the key is masked in every error.
- **Auth**: `bearer` (default), `header` (`auth.name: X-Api-Key`), `basic` (the variable holds `user:password`) or
  `query`.
- **Dates**: `{{since}}` / `{{until}}` (ISO), `{{since_date}}` / `{{until_date}}` (`YYYY-MM-DD`), `{{since_unix}}` /
  `{{until_unix}}` (seconds).

## Sensitive content

During collection, secrets (private keys, cloud and API tokens) and personal data (emails, phone numbers, IBANs, card
numbers, social security numbers) are detected and reported in the collection summary and the briefing. They are
**never proposed for writing** into Notion.
