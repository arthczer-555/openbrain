# OpenBrain

**Turn your company's Notion into a lean internal assistant that cites its sources and improves every week.**

Your team asks questions in plain language. OpenBrain finds the right passages in your company knowledge, answers
with clickable citations to the original Notion pages, and says *"This is not documented yet"* instead of
inventing. Every unanswered question is captured and fixed by the next weekly update.

> **Status: early development (v0.1 in progress).** Everything on this page is implemented and tested locally;
> runs against real LLM APIs and real Netlify deployments are still being validated. Items marked 🔜 are planned.
>
> OpenBrain is a personal open source project by Arthur Czernichow, developed and tested on his own time
> and accounts.

## Contents

- [How it works](#how-it-works)
- [Try it in 2 minutes](#try-it-in-2-minutes)
- [Set up your brain](#set-up-your-brain): 6 steps with Claude Code · [Upgrade the engine](#upgrade-the-engine)
- [Connect your tools](#connect-your-tools): any MCP server or REST API, read-only
- [Reference](#reference): files, registry, config, lint rules, CLI, Claude Code commands, environment
- [Security and privacy](#security-and-privacy)
- [Roadmap](#roadmap) · [Contributing](#contributing) · [License](#license)

## How it works

```
 Notion (source of truth)          your private repo                            your team
 ────────────────────────          ─────────────────                            ─────────
 Root page               sync      knowledge/           mirror, 1 file/page    deploy    chatbot on Netlify
 ├─ Section page  ───────────────▶ brain/registry.yaml  when to open a page  ─────────▶  cited answers
 │  └─ Pages                       brain/core.md        identity, rules                  "not documented yet"
 └─ Section page                   evals/golden.yaml    test questions                   gaps reported
       ▲                                                                                       │
       └────────────── weekly update: Claude proposes fixes, you approve ◀─────────────────────┘
```

Three ideas make it different from "yet another RAG":

1. **One source of truth.** Notion holds the knowledge. The repo keeps a read-only Markdown mirror of it
   (`knowledge/`), so the chatbot never needs your Notion token and git keeps the history.
2. **The agent guide is compiled, not hand-written.** Claude writes *when* each page should be opened
   (`brain/registry.yaml`) and you approve it. The map the agent reads is generated from it, and the build
   fails if the registry and Notion drift apart.
3. **Lean by design.** A small fixed prompt (identity ≤ 1,200 tokens, section map ≤ 700 tokens), passages
   instead of whole pages, and warnings that travel with the passage they apply to.

## Try it in 2 minutes

The repo ships with **Acme**, a fictional company full of real-world traps. No API key needed.

```bash
git clone https://github.com/arthczer-555/openbrain.git openbrain && cd openbrain
npm install                 # Node 24 or newer
npm run demo                # open http://127.0.0.1:8787
```

The demo serves the Acme brain with a built-in demo model, so it runs without any LLM. Add `--llm` to use the
model of the config instead (`npm run openbrain -- demo --llm`, with a provider key in `.env`).

You can also query the knowledge directly, without any model:

```bash
npm run -s openbrain -- search "How do I add a user in the internal tool?" --root examples/acme --k 1
```

```
[1] 5.896  internal-tools/accounts  (Acme Hub accounts: give a colleague access > Add a colleague)
    Only a Hub admin can add an account. Go to Settings then Team, click Add teammate and enter the colleague's work email. ...
    warning: These are Acme Hub accounts only: access to Acme Billing is internal-tools/billing-overview.
    source: https://www.notion.so/acme/Acme-Hub-accounts-give-a-colleague-access-0be3250b872e5be3c22165f4e4d34c4b

section rules (internal-tools):
  - A "user" or an "account" in Acme Hub is an Acme employee using the tool, never a client.
  - In Acme Billing, a "billing account" is the billing record of a client company; a colleague with access is a "member".
  - Reports here are internal figures about Acme, never the reports clients see in Acme Desk.
```

The question says *user*, and Acme also has a page about creating *client* users. The registry and the
section rules route it to the right page anyway. That is what Claude builds for your company below.

## Set up your brain

Claude builds your brain and keeps it up to date: it consolidates your tools into Notion, writes the routing
registry and the test questions, and runs the weekly update. You answer its questions and approve before
anything is written. There is no manual path: a usable registry for a real company takes judgment on every
page, and the weekly update needs Claude anyway.

**Prerequisites**

- Node 24 or newer.
- [Claude Code](https://claude.com/claude-code) on a Claude subscription (the setup and the weekly update run
  on it, with no API bill), with the **Notion connector** enabled: Claude writes approved changes into Notion
  through it. The connectors of your other tools are optional, see [Connect your tools](#connect-your-tools).
- A Notion workspace, a Netlify account, and an API key for the chat model (any provider).

### 1. Create your private repo

Create a **private** copy of this repository (GitHub *Use this template* → *Private*, or clone and push to a
new private repo), then run `npm install`.

> Keep it private. `knowledge/` contains a copy of your internal documentation. `/setup`, the CI and `deploy`
> refuse to go further on a public repo.

Your brain lives at the root of that repo:

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

### 2. Run `/setup` (about 15 minutes)

Open the repo in Claude Code (`claude`) and type `/setup`. Claude asks one question at a time and does the
work:

1. **Company**: name, language of your Notion, name and color of the assistant.
2. **Notion**: you do three things yourself, Claude does the rest.
   - Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
     with the capability *Read content* (the mirror is read-only).
   - On your root page: `•••` → *Connections* → add the integration. Share **only** the root page.
   - `cp .env.example .env` and set `NOTION_TOKEN` in it. Never paste a secret in the conversation.

   Claude then checks the connection (it warns about any page shared outside the root tree) and mirrors the
   tree into `knowledge/`.
3. **Input tools** (Slack, Drive, GitHub, a CRM, websites, files, any MCP server or REST API): for each one,
   Claude picks the simplest of the [three ways to connect it](#connect-your-tools), tests it read-only, and
   writes its whitelist scope in the config.
4. **Chat model**: any provider (Anthropic, OpenAI, Google, Mistral, OpenRouter, DeepSeek, Groq, xAI, or any
   OpenAI-compatible endpoint such as Ollama or vLLM), with a fallback. Changeable later without redeploying.
5. **Registry and identity**: Claude drafts `brain/registry.yaml` from your pages and `brain/core.md`, shows
   them to you, and writes them after your go-ahead.
6. **Guard and deploy plan**: pre-push guard, `doctor`, then the deployment plan (step 5).

If your Notion already holds your company knowledge, `/setup` is enough: go to step 4.

### 3. Run `/init` if your knowledge is spread across tools

`/init` fills Notion from your other tools, once:

1. Inventory of the existing Notion tree and of every input tool, with the estimated volume and number of
   batches.
2. Clean-up: empty pages, templates, duplicates; sensitive items are flagged and never copied.
3. Proposal: a tree of 5 to 12 sections, then page by page what will be created or updated and from which
   sources. **Contradictions come first**: nothing is written until you settle them.
4. Your approval, batch by batch, in the conversation.
5. Writing into Notion, only under the root page, with a "Sources" block at the bottom of each page.
6. Sync, registry, about 30 test questions drafted from the base plus your own, retrieval evals, commit and
   push.

It works in batches and resumes where it stopped. What a good tree looks like, to review Claude's proposal:

```
Company Brain                 ← root page
├─ Product                    ← section (first-level child)
│  ├─ Roles and permissions   ← page
│  └─ Data retention
├─ Sales
│  └─ Pricing
└─ People & HR
   └─ Remote work
```

- **5 to 12 sections**, split by audience or tool. A section page can be a simple list of links.
- **One topic per page**, with H2 / H3 headings: each heading becomes a passage (about 500 tokens at most) that
  the assistant can find and cite on its own.
- **Facts written in the page.** Attachments (PDF, images) are not indexed.
- **No contradictions.** The assistant cites, it does not arbitrate.

### 4. Review and try

```bash
npm run openbrain -- search "How long do we keep client data?"   # which passages come up, no model needed
npm run openbrain -- ask "How long do we keep client data?"      # full answer (no question: a conversation)
npm run openbrain -- serve                                       # the chatbot on http://127.0.0.1:8787
```

Ask the questions your colleagues really ask, in their words and in every language they use. When the wrong
page comes first or an answer is off, tell Claude in the conversation (or type `/write`): the fix is usually in
the registry (an alias, a sharper "when to open", a warning, a section rule) or in the Notion page itself.
[What the registry holds](#brainregistryyaml) helps you review Claude's draft.

Then measure:

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

### 5. Deploy the chatbot on Netlify

```bash
npm run openbrain -- doctor          # before-production checklist, exits with an error on a blocking problem
npm run openbrain -- deploy          # checks (lint, guide, auth, private repo, model key, Netlify CLI), then the plan
npm run openbrain -- deploy --yes    # creates the site, sets the secrets, deploys
```

`doctor` checks Node, that `.env` is not tracked by git, that the repo is private, that no secret pattern sits in
`knowledge/` or `brain/`, that `brain/core.md` has no placeholder left, the sign-in mode, the spending cap, lint
and guide, the chat model (capabilities, price, local key), whether that model passed your evals, and the date of
the last weekly update.

With `--yes`, `deploy` creates the Netlify site (`--site <name>` to choose it), generates and sets the secrets,
runs the first deploy, writes `OPENBRAIN_URL` and `ADMIN_TOKEN` in your local `.env` for the weekly update, and
prints the URL, the access code and the admin code **once**. Share the URL and the access code with your team.

The chatbot streams its answers with clickable citations, has a knowledge browser (`/kb`) and an admin page
(`/admin`: flagged questions, feedback, usage, model choice). Sign-in modes (`auth.mode`):

| Mode | For | Setup |
|---|---|---|
| `passcode` | Default, works on the free Netlify plan | One shared access code (`deploy` generates it; `auth hash-code` makes a new hash). |
| `google` | Companies on Google Workspace | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`. |
| `netlify` | Sites already protected by Netlify | Set `OPENBRAIN_EDGE_GUARD=off`. |

The Netlify build never calls Notion: it compiles the committed mirror. The provided CI
(`.github/workflows/ci.yml`) checks that the repo is private, that the guide is up to date and that the
retrieval evals pass, without any LLM. The pre-push guard (`git config core.hooksPath .githooks`, enabled by
`/setup`) runs `doctor` before every push.

### 6. Every week: `/weekly`

Once a week, open the repo in Claude Code and type `/weekly` (or `/hebdo`), or run
`npm run openbrain -- weekly`, which opens Claude Code on it.

1. The CLI prepares the week without any LLM: syncs Notion, collects what changed in your input tools, fetches
   the questions the chatbot flagged, and writes a packet.
2. Claude reads it, distills the durable facts, diagnoses each unanswered question and writes a short briefing.
   Contradictions come first: nothing is written until you settle them.
3. After your go-ahead, Claude writes into Notion, re-syncs the mirror, updates the registry and the test
   questions, rebuilds the guide, re-tests, commits with the briefing as message and pushes. Netlify redeploys
   in a minute or two.

It runs on your Claude subscription, with no API bill. Between two updates, `/write` adds or fixes one piece of
knowledge, and `npm run openbrain -- reports` lists what the chatbot flagged. The provided
`.github/workflows/reminder.yml` checks every Monday and opens an issue when the last update is more than 8 days
old (or none was recorded).

### Upgrade the engine

```bash
npm run openbrain -- upgrade --repo arthczer-555/openbrain           # dry run: lists what would change
npm run openbrain -- upgrade --repo arthczer-555/openbrain --yes     # latest release; --version vX.Y.Z to pin
```

`upgrade` replaces only the engine files (a fixed allow-list). It never touches `knowledge/`, `brain/`,
`evals/`, `state/`, `openbrain.config.yaml`, `.env` or `CLAUDE.md`. `--from <archive.tar.gz|folder>` upgrades
from a downloaded release.

## Connect your tools

Notion is the only source the chatbot answers from. Every other tool is an **input**: Claude reads it during
`/init` and `/weekly` and proposes what is worth keeping in Notion, for your approval. Inputs are always
read-only, always limited to a whitelist (folders, channels, repos, URL prefixes...), and the chatbot never
reads them. `/setup` asks which tools hold knowledge and picks the simplest way for each:

| Way | Best for | What you do | Declared in the config as |
|---|---|---|---|
| **1. A connector of Claude Code** | Any tool with a claude.ai connector or an MCP server: Slack, Google Drive, Gmail, HubSpot, Linear, Jira... | Connect it once in Claude Code. No token in the repo. | `inputs.claude.<name>`, with a scope |
| **2. A built-in input** | Local files, websites, GitHub, Google Drive | A read-only token in `.env` (none for files and websites) | `inputs.files`, `web`, `github`, `gdrive` |
| **3. A generic adapter** | Any other MCP server or REST API | A read-only key in `.env` and a YAML mapping, drafted by Claude | `inputs.mcp.<name>`, `inputs.api.<name>` |

Way 1 is the fastest to set up: Claude queries the tool itself during the update. Ways 2 and 3 are collected
by the CLI (`collect`, run by `/weekly`): free, reproducible, and they don't use your Claude subscription,
which matters for large tools (thousands of Drive files).

### Every connector

| Connector | Reads | Credential | Guide |
|---|---|---|---|
| `notion` (knowledge store, required) | The page tree under your root page, mirrored into `knowledge/` | `NOTION_TOKEN` (integration with *Read content*); approved writes go through the Notion connector of Claude Code | [Step 2](#2-run-setup-about-15-minutes) |
| `claude:<name>` | What the Claude Code connector exposes, within the scope you write | Your own sign-in in the tool | [Below](#connect-a-tool-to-claude-code) |
| `files` | Folders on your machine: `.md`, `.txt`, `.csv`, `.html`, `.json`, `.docx`, `.pptx` (exports of Confluence, SharePoint, Drive...) | None | [files](packages/connectors/src/files/SETUP.md) |
| `web` | Public pages of a site, help center or docs, from a sitemap or a list of URLs; `robots.txt` respected | None | [web](packages/connectors/src/web/SETUP.md) |
| `github` | Docs (`README.md`, `docs/**/*.md`), commits and merged pull requests of the listed repos | `GITHUB_TOKEN`, fine-grained, read-only | [github](packages/connectors/src/github/SETUP.md) |
| `gdrive` | Google Docs, Sheets, Slides and uploaded Office files of shared folders, shared drives included | `GDRIVE_SA_JSON`, service account, `drive.readonly` | [gdrive](packages/connectors/src/gdrive/SETUP.md) |
| `mcp:<name>` | Any MCP server (local stdio or remote Streamable HTTP), through its read tools only | The server's key, if any | [mcp](packages/connectors/src/mcp/SETUP.md) |
| `api:<name>` | Any REST API that answers JSON, `GET` requests only | An API key: bearer, custom header, basic or query parameter | [api](packages/connectors/src/api/SETUP.md) |

### Connect a tool to Claude Code

- **claude.ai connectors** (Slack, Google Drive, Gmail, Google Calendar, HubSpot, Linear, Notion...): enable
  them on claude.ai under *Settings* → *Connectors*, with the account you use in Claude Code. Claude Code sees
  them right away.
- **Any other MCP server**: add it from the repo folder, then sign in with `/mcp` inside Claude Code.

  ```bash
  claude mcp add --transport http tracker https://tracker.acme.example/mcp   # remote server
  claude mcp add wiki -- npx -y @acme/wiki-mcp                               # local server (stdio)
  ```

Then declare the tool with its scope: `/weekly` reads it on the week's window, and only within that scope.

```yaml
inputs:
  claude:
    slack: { scope: "channels #product, #sales and #announcements, threads included" }
    crm: { connector: hubspot, scope: "deals that changed stage, notes on won and lost deals" }
```

`connector` is the name of the connector in Claude Code, when it differs from the input name. Claude never
writes through an input: only the Notion connector writes, after your go-ahead.

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

## Reference

### Mirror page header

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

### `brain/registry.yaml`

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

### `openbrain.config.yaml`

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
| `inputs` | Tools read by `/init` and `/weekly`: `claude`, `files`, `web`, `github`, `gdrive`, `mcp`, `api`. See [Connect your tools](#connect-your-tools). |
| `pricing` | `"provider/model": { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok }` to override the built-in price table. |

Unknown top-level and section keys are kept, so the file can grow with new features. Model entries
(`models.chat`, `models.fallback`), `pricing` and `providers.openai_compatible` entries are strict: a typo there
fails with a clear message.

### Lint rules

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

### CLI

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
| `ask ["<question>"]` | Answers in the terminal; without a question, a conversation. `--model provider:model`, `--mode agent\|retrieval_first`. |
| `serve` | Runs the chatbot of the instance locally (API + UI). `--port`, `--model`, `--with-auth` (open locally otherwise). |
| `demo` | The Acme brain with a demo model, no key needed. `--llm` to use the configured model. |
| `eval` | Scores `evals/golden.yaml`. `--no-llm`, `--model`, `--matrix a,b`, `--judge provider:model`, `--effort <level>`, `--only <ids>`, `--k <n>`. |
| `models list` / `models refresh` | Models your keys can use, with capabilities and prices (`--all` for every model) / refreshes the price table. |
| `doctor` | Before-production checklist; exits with an error on a blocking problem. |
| `deploy` | Plan of the Netlify deployment; `--yes` to deploy, `--site <name>`. |
| `bundle` | Builds the runtime bundle of the chatbot (run by the Netlify build). |
| `reports` / `reports mark done <ids>` | Questions flagged by the deployed chatbot, re-tested on the local mirror / marks them as handled. |
| `auth hash-code [<code>]` | Hashes an access code for `ACCESS_CODE_HASH` / `ADMIN_CODE_HASH`. |
| `connectors list` / `connectors test <id>` | Lists Notion and the input tools / read-only health check. |
| `collect` | Collects the enabled input tools into `.openbrain/weekly/<date>/inputs/`. `--since`, `--until`, `--only`, `--out`, `--full`, `--dry-run`. |
| `weekly` / `weekly prepare` / `weekly finish` | Opens Claude Code on `/weekly` / prepares the week's packet / finishes after the go-ahead. |
| `upgrade` | Updates the engine files from a release, never the instance files. `--repo <owner>/<repo>`, `--version`, `--from`, `--yes`. |

### Claude Code commands

Defined in [`.claude/skills/`](.claude/skills/), available when the repo is open in Claude Code.

| Command | What it does |
|---|---|
| `/setup` | Configures the instance step by step, up to the deployment. |
| `/init` | First consolidation of your tools into Notion, then sync and registry. |
| `/weekly` (alias `/hebdo`) | The weekly update, with your go-ahead before anything is written. `--resume` continues an interrupted run. |
| `/write` | Adds or fixes one piece of knowledge in Notion between two updates. |

### Environment

Copy `.env.example` to `.env` and fill only what you use. The CLI loads `.env` from the instance folder and the
current folder; variables already set in your terminal win.

| Variable | Where | Used for |
|---|---|---|
| `NOTION_TOKEN` | your machine only | Notion sync, `/init`, weekly update. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` | Netlify and your machine | The chat model (at least one). |
| `SESSION_SECRET`, `ACCESS_CODE_HASH`, `ADMIN_CODE_HASH` | Netlify | Sign-in and admin. `deploy` generates them. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS` | Netlify | `google` sign-in. |
| `OPENBRAIN_ROOT` | Netlify | Instance folder when it is not the repo root. |
| `OPENBRAIN_EDGE_GUARD` | Netlify | `off` when Netlify itself protects the site. |
| `OPENBRAIN_URL` | your machine only | Weekly update and `reports`. `deploy` writes it. |
| `ADMIN_TOKEN` | Netlify and your machine | Lets the weekly update and `reports` fetch the flagged questions. `deploy` sets it on both sides. |
| `OPENBRAIN_UPSTREAM_REPO` | your machine only | Default `<owner>/<repo>` of `upgrade`. |
| `GDRIVE_SA_JSON`, `GITHUB_TOKEN`, and the keys named in `inputs.mcp` / `inputs.api` | your machine only | Input tools collected by the CLI (a connector of Claude Code needs none). |
| `VOYAGE_API_KEY` (or the key of your embeddings provider) | Netlify | Optional hybrid search. |

## Security and privacy

- Your instance repo must stay **private**: it contains a copy of your knowledge. The CI and `deploy` check it.
- Tool tokens (Notion, Drive, GitHub...) never leave your machine. The chatbot only reads the compiled mirror,
  so a leak on the hosting side exposes neither Notion nor your tools.
- Access codes are stored as hashes only, and `deploy` shows the codes once.
- The assistant is read-only: it never sends, creates or changes anything outside the chat.
- Changes to Notion only happen during `/init`, `/weekly` or `/write`, after your explicit go-ahead.
- Never commit `.env`.

## Roadmap

- 🔜 A built-in Slack input (today: the Slack connector of Claude Code or a Slack MCP server), the weekly
  update without Claude Code (any provider), public landing page and docs (code in `apps/site`).
- 🔜 Later: Slack bot, per-group access control.

## Contributing

```bash
npm install
npm test             # unit tests (vitest)
npm run typecheck    # strict TypeScript
npm run e2e          # end to end: demo + headless Chrome (question, citation, feedback, admin, mobile)
```

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

## License

MIT, see [LICENSE](LICENSE).
