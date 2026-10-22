# OpenBrain reference

The details behind the [README](README.md): files, settings, commands and checks. You rarely need this page:
Claude reads it for you during `/setup`, `/init` and `/weekly`.

- [Files of your brain](#files-of-your-brain)
- [Test and measure](#test-and-measure)
- [Deploy](#deploy) · [Deploy by hand](#deploy-by-hand) · [Sign-in, admin, CI](#sign-in-admin-and-ci)
- [Upgrade the engine](#upgrade-the-engine)
- [Connectors](#connectors)
- [Mirror page header](#mirror-page-header) · [`brain/registry.yaml`](#brainregistryyaml) ·
  [`openbrain.config.yaml`](#openbrainconfigyaml) · [Lint rules](#lint-rules)
- [CLI](#cli) · [Claude Code commands](#claude-code-commands) · [Environment](#environment)
- [Code layout](#code-layout)

## Files of your brain

Your brain lives at the root of your private repo:

```
openbrain.config.yaml     instance settings
.env                      secrets, local only (never committed)
knowledge/                Notion mirror, generated, never edited
brain/core.md             the assistant's identity and golden rules (written by /setup)
brain/registry.yaml       when to open each page, per-section rules (written by /setup and /init, kept up to date by /weekly)
brain/catalog.md          generated
brain/registry.json       generated
connectors/               mappings of the MCP servers and REST APIs you read (optional)
evals/golden.yaml         test questions (drafted by /init, completed by /weekly)
state/                    sync and weekly update state (generated)
```

## Test and measure

`search` shows which passages come up for a question, without any AI. `ask` and `eval` use the chat model of
the config when its key is in `.env`; without a key, they answer through Claude Code on your subscription
(`claude-code:sonnet`). Force it with `--model claude-code:sonnet` (or `opus`, `haiku`). Claude Code answers without
tools, so the assistant runs in its retrieval-first mode (passages found first, then one answer). It only works on
your computer, never on Netlify. `serve --model claude-code:sonnet` opens the chat page locally with it.

```bash
npm run openbrain -- eval --no-llm                        # retrieval only, free: are the right pages found?
npm run openbrain -- eval                                 # full answers: behavior, citations, language, tokens, cost, latency
npm run openbrain -- eval --matrix anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5   # compare models
```

`eval` exits with an error under the thresholds (recall@k 90 %, correct abstention 100 %, answer language
100 %) and saves each run in `.openbrain/evals/`. `--only <ids>` runs a subset, `--effort low|medium|high`
compares reasoning efforts, and `--judge provider:model` adds an LLM judge for citation precision and grounding
(thresholds 90 % and 95 %; pick a judge from another provider than the chat model).

**Optional: hybrid search.** Keyword search (BM25) is enough to start. To add semantic search, set
`models.embeddings` in the config, for example `{ provider: voyage, model: voyage-4-lite, dimensions: 512 }`
(OpenAI, Google, Mistral and OpenAI-compatible endpoints work too), and the matching key (`VOYAGE_API_KEY`...).
The vectors are built with the chatbot bundle and fused with keyword results. Without a key, nothing changes.

## Deploy

```bash
npm run openbrain -- doctor          # before-production checklist, exits with an error on a blocking problem
```

`doctor` checks Node, that `.env` is not tracked by git, that the repo is private, that no secret pattern sits in
`knowledge/` or `brain/`, that `brain/core.md` has no placeholder left, the sign-in mode, the spending cap, lint
and guide, the chat model (capabilities, price, local key), whether that model passed your evals, and the date of
the last weekly update.

> Netlify's free plan deploys private repos from a **personal** GitHub account. A private repo owned by a GitHub
> organization needs a paid Netlify plan, and on the free plan commits pushed by someone else may not deploy.

**From the terminal.** Needs the Netlify CLI (`npm i -g netlify-cli`, then `netlify login`). Without it, see
[Deploy by hand](#deploy-by-hand).

```bash
npm run openbrain -- deploy          # checks (lint, guide, auth, private repo, model key, Netlify CLI), then the plan
npm run openbrain -- deploy --yes    # asks for the access code, creates the site, sets the secrets, deploys
```

With `--yes`, `deploy` asks for the chat's **access code** (8 characters or more; empty = no code, after a
confirmation), creates the Netlify site (`--site <name>` to choose it), generates and sets the other secrets, runs
the first deploy, writes `OPENBRAIN_URL` and `ADMIN_TOKEN` in your local `.env` for the weekly update, and prints the
URL, the access code and the admin code **once**. Share the URL and the access code with your team. Without a
terminal to answer in (Claude Code, CI), pass `--password <code>` or `--no-password`.

Without an access code (`OPENBRAIN_OPEN_ACCESS=1`), the chat has no sign-in page: anyone with the link can use it
and read the knowledge base through it. `/admin` still asks for the admin code. The server stays closed if
`ACCESS_CODE_HASH` is simply missing, and a code, when set, always wins.

That first deploy is uploaded from your machine. Link the site to your repo once so that pushes redeploy it: in
Netlify, *Project configuration* → *Build & deploy* → *Continuous deployment* → *Link repository* → GitHub → your
private repo. Do not run `deploy --yes` again to publish: each run generates new secrets and codes, which signs
everyone out.


## Deploy by hand

No Netlify CLI needed: GitHub, then the Netlify website.

1. Push to your private repo, after checking that it is yours and private:

   ```bash
   gh repo view --json nameWithOwner,visibility    # your account, "PRIVATE"
   git push -u origin main
   ```

2. Generate the secrets on your machine (nothing leaves it):

   ```bash
   npm run openbrain -- auth hash-code    # access code for your team, and its hash (skip for no code)
   npm run openbrain -- auth hash-code    # admin code for /admin, and its hash
   openssl rand -hex 32                   # SESSION_SECRET
   openssl rand -hex 24                   # ADMIN_TOKEN
   ```

   Keep the two codes: they are shown once, and only their hashes go to Netlify. In `google` mode, skip the
   codes and use the Google variables instead.

3. In Netlify: *Add new project* → *Import an existing project* → *GitHub*. When GitHub asks for access, choose
   **Only select repositories** and pick your brain repo. Keep the build settings Netlify shows: they come from
   `netlify.toml`.

4. Before deploying, add the environment variables (on the import screen, or later in *Project configuration* →
   *Environment variables*), marked as secret:
   - the key of each chat model in your config, for example `ANTHROPIC_API_KEY`;
   - `SESSION_SECRET` and `ADMIN_TOKEN`: the two random values;
   - `passcode` mode: `ACCESS_CODE_HASH` (or, for a chat without code, `OPENBRAIN_OPEN_ACCESS=1`) and
     `ADMIN_CODE_HASH`; `netlify` mode: `ADMIN_CODE_HASH` and
     `OPENBRAIN_EDGE_GUARD=off`; `google` mode: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`;
   - `OPENBRAIN_ROOT`, only when the instance is not at the repo root.

   Never add `NOTION_TOKEN` or the tokens of your tools: the chatbot does not use them. A variable added after
   a deploy takes effect at the next one (*Deploys* → *Trigger deploy*).

5. Deploy, then add the site URL and the same admin token to your local `.env`, for the weekly update and
   `reports`:

   ```bash
   OPENBRAIN_URL=https://<your-project>.netlify.app
   ADMIN_TOKEN=<the value set on Netlify>
   ```

   Share the URL and the access code with your team.


## Sign-in, admin and CI

The chatbot streams its answers with clickable citations, has a knowledge browser (`/kb`) and an admin page
(`/admin`: flagged questions, feedback, usage, model choice). Sign-in modes (`auth.mode`):

| Mode | For | Setup |
|---|---|---|
| `passcode` | Default, works on the free Netlify plan | One shared access code chosen at `deploy` (`auth hash-code` makes a new hash), or none: `OPENBRAIN_OPEN_ACCESS=1`, no sign-in page. |
| `google` | Companies on Google Workspace | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`. |
| `netlify` | Sites already protected by Netlify | Set `OPENBRAIN_EDGE_GUARD=off`. |

The Netlify build never calls Notion: it compiles the committed mirror. The provided CI
(`.github/workflows/ci.yml`) checks that the repo is private, that the guide is up to date and that the
retrieval evals pass, without any LLM. The pre-push guard (`git config core.hooksPath .githooks`, enabled by
`/setup`) runs `doctor` before every push.

## Upgrade the engine

```bash
npm run openbrain -- upgrade --repo arthczer-555/openbrain           # dry run: lists what would change
npm run openbrain -- upgrade --repo arthczer-555/openbrain --yes     # latest release; --version vX.Y.Z to pin
```

`upgrade` replaces only the engine files (a fixed allow-list). It never touches `knowledge/`, `brain/`,
`evals/`, `state/`, `openbrain.config.yaml`, `.env` or `CLAUDE.md`. `--from <archive.tar.gz|folder>` upgrades
from a downloaded release.

## Connectors

### Every connector

| Connector | Reads | Credential | Guide |
|---|---|---|---|
| `notion` (knowledge store, required) | The page tree under your root page, mirrored into `knowledge/` | `NOTION_TOKEN` (integration with *Read content*); approved writes go through the Notion connector of Claude Code | [README, step 2](README.md#step-2-run-setup-in-claude-code-about-15-minutes) |
| `claude:<name>` | What the Claude Code connector exposes, within the scope you write | Your own sign-in in the tool | [Below](#connect-a-tool-to-claude-code) |
| `files` | Folders on your machine: `.md`, `.txt`, `.csv`, `.html`, `.json`, `.docx`, `.pptx` (exports of Confluence, SharePoint, Drive...) | None | [files](packages/connectors/src/files/SETUP.md) |
| `web` | Public pages of a site, help center or docs, from a sitemap or a list of URLs; `robots.txt` respected | None | [web](packages/connectors/src/web/SETUP.md) |
| `github` | Docs (`README.md`, `docs/**/*.md`), commits and merged pull requests of the listed repos | `GITHUB_TOKEN`, fine-grained, read-only | [github](packages/connectors/src/github/SETUP.md) |
| `gdrive` | Google Docs, Sheets, Slides and uploaded Office files of shared folders, shared drives included | `GDRIVE_SA_JSON`, service account, `drive.readonly` | [gdrive](packages/connectors/src/gdrive/SETUP.md) |
| `mcp:<name>` | Any MCP server (local stdio or remote Streamable HTTP), through its read tools only | The server's key, if any | [mcp](packages/connectors/src/mcp/SETUP.md) |
| `api:<name>` | Any REST API that answers JSON, `GET` requests only | An API key: bearer, custom header, basic or query parameter | [api](packages/connectors/src/api/SETUP.md) |

### Connect a tool to Claude Code

- **claude.ai connectors** (Slack, HubSpot, Google Drive, Gmail, Microsoft 365, Linear, Notion...): enable them on
  claude.ai under *Customize* → *Connectors* ([claude.ai/customize/connectors](https://claude.ai/customize/connectors)),
  with the account you use in Claude Code. Claude Code loads them by itself when it is signed in with that claude.ai
  account, not when it runs on an API key (`ANTHROPIC_API_KEY`, `apiKeyHelper`): check with `/status`. On Team and
  Enterprise plans, an owner enables a connector first. They appear in `/mcp`.
- **Any other MCP server**: add it from the repo folder, then sign in with `/mcp` inside Claude Code (or
  `claude mcp login <name>`). The [README](README.md#connect-your-tools) lists the addresses of popular tools.

  ```bash
  claude mcp add --transport http claap https://api.claap.io/mcp                  # remote server, sign-in in the browser
  claude mcp add --transport http github https://api.githubcopilot.com/mcp/readonly \
    --header "Authorization: Bearer <read-only token>"                           # remote server with a key
  claude mcp add --transport stdio wiki -- npx -y @acme/wiki-mcp                  # local server
  ```

  `--scope project` writes the server in `.mcp.json` at the repo root, to share it with the people who run the
  updates (never put a key in it: use `${VAR}`). `claude mcp list` shows what is connected.

Then declare the tool with its scope: `/weekly` reads it on the week's window, and only within that scope.

```yaml
inputs:
  claude:
    slack: { scope: "channels #product, #sales and #announcements, threads included" }
    crm: { connector: hubspot, scope: "deals that changed stage, notes on won and lost deals" }
```

`connector` is the name of the connector in Claude Code, when it differs from the input name. Claude never
writes through an input: only the Notion connector writes, after your go-ahead.

### Read-only connectors

The `/init`, `/weekly` and `/write` commands only read your tools, but most connectors can also write. Three ways
to make writing impossible, from the simplest:

1. **A read-only address or key**, when the tool offers one: Linear `https://mcp.linear.app/mcp/readonly`, GitHub
   `https://api.githubcopilot.com/mcp/readonly`, Airtable tokens with `:read` scopes only. Gong, Pennylane and
   Microsoft 365 (by default) are read-only already.
2. **Block the write tools in Claude Code**, in `.claude/settings.json` of your repo. A blocked tool disappears for
   Claude. The names are listed by `/mcp`; claude.ai connectors are named `mcp__claude_ai_<Tool>__<tool>`:

   ```json
   {
     "permissions": {
       "deny": [
         "mcp__claude_ai_Slack__slack_send_message",
         "mcp__claude_ai_Slack__slack_schedule_message",
         "mcp__claude_ai_Slack__slack_create_canvas",
         "mcp__claude_ai_Slack__slack_update_canvas",
         "mcp__claude_ai_HubSpot__manage_crm_objects"
       ]
     }
   }
   ```

   Never block the Notion connector: approved changes are written through it.
3. **Collect with the CLI instead** (`inputs.mcp` or `inputs.api` below): the adapters refuse write tools and
   non-`GET` requests in code.

### Connect any MCP server or REST API to the CLI

For a collection that is reproducible and does not use your Claude subscription:

```yaml
inputs:
  mcp:
    tracker:
      transport: http                               # or stdio, with command and args
      url: "https://tracker.acme.example/mcp"
      auth_env: ACME_TRACKER_TOKEN                  # the key itself stays in .env
      mapping: ./connectors/tracker.mapping.yaml
  api:
    crm:
      base_url: "https://api.crm.acme.example/v2"
      auth: { type: bearer, env: ACME_CRM_TOKEN }   # or header, basic, query
      mapping: ./connectors/crm.mapping.yaml
```

The mapping says which tool or endpoint lists the items, where they are in the response, how to paginate,
and which fields become the title, date, link and text ([MCP example](examples/acme/connectors/tracker.mapping.yaml),
[REST example](examples/acme/connectors/crm.mapping.yaml)). You don't write it by hand: in `/setup`, Claude
lists the server's tools or reads the API reference, calls one read endpoint with your key and drafts the
mapping for your approval. Both adapters are read-only in code: the MCP adapter refuses any tool that looks
like a write, the REST adapter only sends `GET` requests, and only to the host of `base_url`.

```bash
npm run openbrain -- connectors list          # every connector, its status and missing credentials
npm run openbrain -- connectors test <id>     # read-only health check: identity, scopes, 3 samples
npm run openbrain -- collect --dry-run        # what the weekly update would read, without writing anything
```

### Which way for which tool

| Tool | Simplest | Free and reproducible |
|---|---|---|
| Slack | Claude connector | `mcp` with a Slack MCP server |
| Google Drive | Claude connector | `gdrive` |
| GitHub | `github` | `github` |
| Website, help center, public docs | `web` | `web` |
| Confluence, SharePoint, Notion exports | Export to a folder, then `files` | `api` (Confluence REST, basic auth) |
| CRM (HubSpot, Salesforce, Pipedrive...) | Claude connector | `api` |
| Tickets and projects (Linear, Jira, Zendesk, Intercom...) | Claude connector | `mcp` or `api` |
| Meeting notes, calls (Gong, Fireflies...) | Claude connector, if the tool has one | `api` |
| An internal tool | `mcp` or `api` | `mcp` or `api` |

## Mirror page header

Generated by `sync notion`. Strict: unknown keys are rejected.

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Path inside `knowledge/` without `.md`, e.g. `product/data-retention`. Used in citations and in the registry. |
| `title` | yes | Notion page title. |
| `section` | yes | Folder name, i.e. the first-level page it belongs to. |
| `source.connector` | yes | `notion`. |
| `source.page_id` | yes | Notion page id. |
| `source.url` | yes | Link to the Notion page, used for citations. |
| `updated_at` | yes | Notion last edited time (ISO date or date-time). |
| `lang` | no | Language of the page (`en`, `fr`...). |

Files and folders starting with `_` or `.` are ignored.

## `brain/registry.yaml`

| Key | Required | Default | Meaning |
|---|---|---|---|
| `version` | no | `1` | Format version. |
| `sections.<id>.description` | yes | | One line, shown in the section map of every prompt. |
| `sections.<id>.rules` | no | `[]` | Routing rules, sent with results from this section. |
| `docs.<page id>.when_to_open` | yes | | When to open the page (≤ 220 characters, no dates). |
| `docs.<page id>.aliases` | no | `[]` | Extra search terms. |
| `docs.<page id>.warnings` | no | `[]` | Binding notes returned with the page's passages. |
| `docs.<page id>.status` | no | `validated` | `validated`, `to_confirm` or `stale`. |

```yaml
version: 1
sections:
  product:
    description: "How the client-facing app works: roles, ticket channels, SLAs, data retention."
    rules:
      - A "user" in this section is a client's agent, never one of our employees.
docs:
  product/data-retention:
    when_to_open: "How long client data is kept, how it is deleted, and what to tell a client who asks."
    aliases: ["retention", "data deletion", "GDPR", "conservation des données"]
    warnings:
      - Security questionnaires quote this page: always answer from it, not from memory.
```

What to check when you review Claude's draft:

- `when_to_open` says **when** to open the page (the situation, the question), never what it contains: no
  figures, no dates, they would go stale silently. Look-alike pages say what they are *not* for.
- `aliases` are the words your colleagues actually type, including jargon and other languages.
- `warnings` cover false friends and scope (*"a user here is a client, not a colleague"*); the assistant must
  apply them.
- `to_confirm` makes the assistant say an answer is not confirmed yet; `stale` asks a human to review the page.

## `openbrain.config.yaml`

| Key | Meaning |
|---|---|
| `instance.name`, `instance.kb_language` | Company name, language your Notion is written in. |
| `notion.root_page` | Id of the root page. Only this tree is read. |
| `chatbot.assistant_name`, `accent`, `logo` | Name and look of the chatbot. |
| `chatbot.mode` | `auto` (default), `agent`, or `retrieval_first` for models without tool calling. |
| `auth.mode` | `passcode`, `google` or `netlify`. |
| `auth.allowed_domains` | `google` mode: email domains allowed to sign in. |
| `auth.identified` | `true`: flagged questions keep the user's email instead of a hash. |
| `budgets.monthly_usd` | Monthly spending cap of the chat (estimate). |
| `budgets.questions_per_user_per_day` | Per-user daily quota. |
| `models.chat` | `provider`, `model`, optional `effort` (`low`, `medium`, `high`), `base_url`, `api_key_env` (when the key is not in the provider's default variable), `max_output_tokens`. |
| `models.fallback` | Models with the same shape, tried in order when the chat model fails. |
| `models.embeddings` | Optional hybrid search: `{ provider, model, dimensions }`, plus `base_url` and `api_key_env` if needed (Voyage, OpenAI, Google, Mistral, OpenAI-compatible). |
| `user_choice.enabled`, `user_choice.allowed` | Let users pick a model in the chat, among `"provider:model"` entries. |
| `providers.openai_compatible` | Extra endpoints: `{ name, base_url, api_key_env }`. |
| `weekly.publish` | `push` (default) or `pr`: how `/weekly` publishes the approved update. |
| `inputs` | Tools read by `/init` and `/weekly`: `claude`, `files`, `web`, `github`, `gdrive`, `mcp`, `api`. See [Connectors](#connectors). |
| `pricing` | `"provider/model": { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok }` to override the built-in price table. |

Unknown top-level and section keys are kept, so the file can grow with new features. Model entries
(`models.chat`, `models.fallback`), `pricing` and `providers.openai_compatible` entries are strict: a typo there
fails with a clear message.

## Lint rules

`openbrain lint` exits with an error code when there is at least one error. Warnings never block. Claude
fixes these during `/setup`, `/init` and `/weekly`; the table helps you read the output.

| Rule | Level | Fix |
|---|---|---|
| `invalid-file` | error | Fix the page header, or re-run `sync notion`. |
| `missing-registry` / `invalid-registry` | error | Create `brain/registry.yaml` or fix its YAML. |
| `missing-registry-entry` | error | Add a `docs.<page id>` entry with a `when_to_open`. |
| `missing-section-entry` | error | Add a `sections.<id>` entry with a `description`. |
| `orphan-registry-entry` / `orphan-section-entry` | error | The page or section was renamed, moved or deleted in Notion: update or remove the entry. |
| `id-matches-path` / `section-matches-folder` | error | `id` must equal the file path, `section` the folder. |
| `when-to-open-length` | error | Shorten to 220 characters: say when to open, not what is inside. |
| `when-to-open-date` | error | Remove the date, it belongs in the page. |
| `when-to-open-number` | warning | Remove the figure unless it is part of a name (ISO 27001). |
| `broken-link` | error | An internal link points to a missing `.md` file. |
| `duplicate-title` | warning | Two pages share a title: make their `when_to_open` tell them apart. |
| `missing-section-index` | warning | The section page is missing from the mirror: re-run `sync notion`. |
| `empty-page` | warning | Fill or delete the page in Notion. |

## CLI

Claude drives most of these during `/setup`, `/init` and `/weekly`. You mainly use `search`, `ask`, `serve`,
`eval`, `doctor`, `deploy` and `reports`.

Run `npm run openbrain -- <command>`. Tip: `alias openbrain="npm run -s openbrain --"`.
Every command except `demo` accepts `--root <path>` (instance folder, default: current folder) and most accept
`--json`.

| Command | What it does |
|---|---|
| `init` | Creates the instance files without overwriting any (run by `/setup`). |
| `sync notion` | Mirrors the Notion tree into `knowledge/` (read-only). `--root-page <id>`, `--dry-run`, `--full`. |
| `lint` | Checks the mirror and the registry. |
| `guide build` / `guide check` | Generates `brain/catalog.md` and `brain/registry.json` and checks the budgets / fails if they are out of date. |
| `index` | Builds the passage index into `.openbrain/index.json`. |
| `search "<question>"` | Searches without any LLM. `--section <id>`, `--k <n>` (default 6, max 10), `--full`. |
| `ask ["<question>"]` | Answers in the terminal; without a question, a conversation. `--model provider:model`, `--mode agent\|retrieval_first`. Without any key, answers through Claude Code (`claude-code:sonnet`). |
| `serve` | Runs the chatbot of the instance locally (API + UI). `--port`, `--model` (`claude-code:sonnet` for your subscription), `--with-auth` (open locally otherwise). |
| `demo` | The Acme brain with a demo model, no key needed. `--llm` to use the configured model. |
| `eval` | Scores `evals/golden.yaml`. `--no-llm`, `--model`, `--matrix a,b`, `--judge provider:model`, `--effort <level>`, `--only <ids>`, `--k <n>`. Without any key, answers through Claude Code. |
| `models list` / `models refresh` | Models your keys can use, with capabilities and prices (`--all` for every model) / refreshes the price table. |
| `doctor` | Before-production checklist; exits with an error on a blocking problem. |
| `deploy` | Plan of the Netlify deployment; `--yes` to deploy (asks for the access code), `--site <name>`, `--password <code>` or `--no-password`. |
| `bundle` | Builds the runtime bundle of the chatbot (run by the Netlify build). |
| `reports` / `reports mark done <ids>` | Questions flagged by the deployed chatbot, re-tested on the local mirror / marks them as handled. |
| `auth hash-code [<code>]` | Hashes an access code for `ACCESS_CODE_HASH` / `ADMIN_CODE_HASH`. |
| `connectors list` / `connectors test <id>` | Lists Notion and the input tools / read-only health check. |
| `collect` | Collects the enabled input tools into `.openbrain/weekly/<date>/inputs/`. `--since`, `--until`, `--only`, `--out`, `--full`, `--dry-run`. |
| `weekly` / `weekly prepare` / `weekly finish` | Opens Claude Code on `/weekly` / prepares the week's packet / finishes after the go-ahead. |
| `upgrade` | Updates the engine files from a release, never the instance files. `--repo <owner>/<repo>`, `--version`, `--from`, `--yes`. |

## Claude Code commands

Defined in [`.claude/skills/`](.claude/skills/), available when the repo is open in Claude Code.

| Command | What it does |
|---|---|
| `/setup` | Configures the instance step by step, up to the deployment. |
| `/init` | First consolidation of your tools into Notion, then sync and registry. |
| `/weekly` (alias `/hebdo`) | The weekly update, with your go-ahead before anything is written. `--resume` continues an interrupted run. |
| `/write` | Adds knowledge on request between two updates: a fact, a document, a correction, or a whole topic gathered from your connected tools (codebase, product, sales, marketing...). Shows the pages before writing them in Notion. |

## Environment

Copy `.env.example` to `.env` and fill only what you use. The CLI loads `.env` from the instance folder and the
current folder; variables already set in your terminal win.

| Variable | Where | Used for |
|---|---|---|
| `NOTION_TOKEN` | your machine only | Notion sync, `/init`, weekly update. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` | Netlify and your machine | The chat model (at least one). |
| `SESSION_SECRET`, `ACCESS_CODE_HASH`, `ADMIN_CODE_HASH` | Netlify | Sign-in and admin. `deploy` generates them (by hand: [Deploy by hand](#deploy-by-hand)). |
| `OPENBRAIN_OPEN_ACCESS` | Netlify | `1`: no access code, no sign-in page (only when `ACCESS_CODE_HASH` is empty). `deploy --no-password` sets it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS` | Netlify | `google` sign-in. |
| `OPENBRAIN_ROOT` | Netlify | Instance folder when it is not the repo root. |
| `OPENBRAIN_EDGE_GUARD` | Netlify | `off` when Netlify itself protects the site. |
| `OPENBRAIN_URL` | your machine only | Weekly update and `reports`. `deploy` writes it (by hand: [Deploy by hand](#deploy-by-hand)). |
| `ADMIN_TOKEN` | Netlify and your machine | Lets the weekly update and `reports` fetch the flagged questions. `deploy` sets it on both sides (by hand: [Deploy by hand](#deploy-by-hand)). |
| `OPENBRAIN_UPSTREAM_REPO` | your machine only | Default `<owner>/<repo>` of `upgrade`. |
| `OPENBRAIN_CLAUDE_BIN` | your machine only | Path of the `claude` command used by `claude-code:<model>`, when it is not on the `PATH`. |
| `GDRIVE_SA_JSON`, `GITHUB_TOKEN`, and the keys named in `inputs.mcp` / `inputs.api` | your machine only | Input tools collected by the CLI (a connector of Claude Code needs none). |
| `VOYAGE_API_KEY` (or the key of your embeddings provider) | Netlify | Optional hybrid search. |

## Code layout

| Folder | Content |
|---|---|
| `packages/core` | Knowledge format, loader, registry, lint, guide, budgets, config. |
| `packages/retrieval` | Markdown chunker and dependency-free BM25F search. |
| `packages/connectors` | Notion sync and the input tools (files, web, GitHub, Google Drive, any MCP server, any REST API). |
| `packages/llm` | Model layer: every provider, catalog, prices, fallbacks. |
| `packages/agent` | Prompt assembly, agent loop, tools, budgets, citations. |
| `packages/server` | Chat API, used by `serve`, `demo` and the Netlify functions. |
| `packages/cli` | The `openbrain` command. |
| `apps/web` | Chat, knowledge browser and admin UI. |
| `apps/site` | Landing page and docs (Astro + Starlight), published from the upstream repo only. |
| `netlify/`, `netlify.toml` | Functions, edge sign-in guard and build. |
| `.claude/skills/` | `/setup`, `/init`, `/weekly`, `/write`. |
| `examples/acme` | Fictional company used for the demo, the tests and the evals. Never put real company data in this repo. |
