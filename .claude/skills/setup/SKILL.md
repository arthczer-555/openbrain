---
name: setup
description: Set up a new OpenBrain instance with the operator, step by step - company and language, Notion root page and token, input tools (connectors of Claude Code, built-in inputs, or any MCP server or REST API) and their scope, chat model, first sync, registry, deployment. Use when the operator types /setup or asks to install, configure or connect OpenBrain.
---

# Setup of an OpenBrain instance

Goal: in about 15 minutes, a configured instance with its Notion mirror, its inputs tested, a chat model
chosen, and the deploy command ready. Ask one short question at a time, propose defaults, do the work
yourself. Secrets are never pasted in this conversation: the operator writes them in `.env` themselves.

Run `npm run openbrain -- init --yes --company "<name>" --language <code> --root-page <id or url>` to create the
instance files (config, core prompt, empty registry and evals), then refine them with the operator.

## 1. Interview (short)
- Company name, language of the knowledge base (`kb_language`), name of the assistant, accent color.
- Is the repo private? (`gh repo view --json visibility`). An instance repo must be private as soon as it
  holds the mirror: refuse to continue on a public repo with company data.
- Which tools hold knowledge (Notion, Drive, Slack, GitHub, websites, files, CRM, tickets, any MCP server or
  REST API)?

## 2. Notion first (the single source of truth)
1. The operator creates an internal integration in Notion with the "Read content" capability only (writes go
   through the operator's Notion MCP connector in this session), shares ONLY the root page with it, and puts
   `NOTION_TOKEN=` in `.env`. Check that the Notion MCP connector is connected in Claude Code: `/init`,
   `/weekly` and `/write` write through it.
2. Write `notion.root_page` in `openbrain.config.yaml`.
3. `npm run openbrain -- sync notion --dry-run`, then without `--dry-run`. Show the tree (sections = pages
   right under the root).

## 3. Inputs (read-only)
List the tools that hold knowledge, then connect each one the simplest way (README, "Connect your tools").
Never point an input at a whole workspace: every input gets a whitelist scope (channels, folders, repos,
pipelines, URL prefixes). Nothing is ever written through an input.

1. **A connector of Claude Code** (first choice when it exists). Check the MCP tools available in this
   session. If the tool has a claude.ai connector that is not enabled, ask the operator to enable it on
   claude.ai (Settings > Connectors). If it has an MCP server, give the command to run in the repo folder
   (`claude mcp add --transport http <name> <url>`, or `claude mcp add <name> -- <command>` for a local
   server) and ask them to sign in with `/mcp`. Then call one read tool on a small window to confirm access,
   and declare it with its scope:
   ```yaml
   inputs:
     claude:
       slack: { scope: "channels #product, #sales, threads included" }
   ```
   `/init` and `/weekly` read it within that scope only. For large document stores (thousands of Drive
   files), suggest way 2 or 3 instead: free and reproducible.
2. **A built-in input**: `files`, `web`, `github`, `gdrive`. Follow `packages/connectors/src/<id>/SETUP.md`
   for a read-only token, written by the operator in `.env`.
3. **Any other MCP server or REST API, collected by the CLI**: `inputs.mcp.<name>` (see `mcp/SETUP.md`) or
   `inputs.api.<name>` (see `api/SETUP.md`). Draft the mapping yourself in `connectors/<name>.mapping.yaml`:
   list the server's tools (`connectors test` prints them) or read the API reference, call one read
   endpoint to see the shape of the response, then propose `list` (tool or path, items, pagination) and
   `map` (id, title, url, modifiedAt, text). Only read tools or GET endpoints; the operator approves.

Then, for ways 2 and 3:

```bash
npm run openbrain -- connectors list
npm run openbrain -- connectors test <id>
npm run openbrain -- collect --dry-run
```

Warn when a token has write scopes (`writeScopesDetected`) and ask for a read-only key. End with a table:
tool, way, scope, status.

## 4. Chat model
Explain: any provider, one model per role, changeable later from `/admin/models` without redeploy. Default
`anthropic:claude-opus-5-5` at low effort, with a fallback. `npm run openbrain -- models list` shows what the
operator's keys can use, with prices. Write `models.chat` (and `models.fallback`) in the config.

## 5. Registry and guide
Every mirrored page needs an entry in `brain/registry.yaml` (when to open it, aliases, warnings, status) and
every section a description and routing rules. Draft them from the pages, show the table to the operator,
apply after approval, then:

```bash
npm run openbrain -- lint
npm run openbrain -- guide build
npm run openbrain -- eval --no-llm
npm run openbrain -- ask "<a real question>"
```

Write `brain/core.md` (identity and golden rules, 1,200-token budget): start from the template one, add at
most 10 instance rules.

## 6. Guard and deploy
`git config core.hooksPath .githooks` enables the pre-push guard (`openbrain doctor` before every push).
`npm run openbrain -- doctor` lists what is left before production.

Then `npm run openbrain -- deploy` shows the plan (checks, secrets, Netlify variables); `--yes` runs it, writes
`OPENBRAIN_URL` and `ADMIN_TOKEN` to `.env`, and prints the access code once. Remind the operator of the
weekly routine: `claude` then `/weekly`, once a week.
