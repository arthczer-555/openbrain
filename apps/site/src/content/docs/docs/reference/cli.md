---
title: CLI reference
description: Every openbrain command and its options.
---

Run every command from the root of your instance as `npm run openbrain -- <command>`. The CLI loads `.env` from the
instance folder and the current folder; variables already set in your terminal win.

```bash
alias openbrain="npm run -s openbrain --"     # optional shortcut
```

Claude drives most of these during `/setup`, `/init` and `/weekly`. You mainly run `search`, `ask`, `serve`, `eval`,
`doctor`, `deploy` and `reports`. Every command accepts `--root <path>` (instance folder, default: the current folder),
and most accept `--json` for machine-readable output.

:::note[Status]
All the commands below are implemented and covered by tests. Runs against real LLM APIs and real Netlify deployments
are still being validated.
:::

## Overview

| Command | What it does |
|---|---|
| `init` | Creates the instance files, never overwriting one (run by `/setup`). |
| `sync notion` | Mirrors the Notion tree into `knowledge/`, read-only. |
| `connectors list` / `connectors test <id>` | Lists Notion and the input tools / runs a read-only health check. |
| `collect` | Collects the enabled input tools into `.openbrain/weekly/<date>/inputs/`. |
| `lint` | Checks the mirror and the registry. |
| `guide build` / `guide check` | Generates `brain/catalog.md` and `brain/registry.json`, checks the budgets / fails if they are out of date. |
| `index` | Builds the passage index into `.openbrain/index.json`. |
| `search "<question>"` | Searches without any LLM: passages, warnings, section rules. |
| `demo` | The Acme brain with the demo model, no key needed. |
| `serve` | Runs the chatbot of the instance locally (API and UI). |
| `ask ["<question>"]` | Answers in the terminal; without a question, a conversation. |
| `eval` | Scores `evals/golden.yaml` and exits with an error under the thresholds. |
| `models list` / `models refresh` | Models your keys can use, with capabilities and prices / refreshes the catalog. |
| `bundle` | Builds the runtime bundle of the chatbot (run by the Netlify build). |
| `doctor` | Before-production checklist, exits with an error on a blocking problem. |
| `deploy` | Plan of the Netlify deployment; `--yes` to deploy. |
| `reports` / `reports mark done <ids>` | Questions flagged by the deployed chatbot / marks them handled. |
| `auth hash-code [<code>]` | Hashes an access code for `ACCESS_CODE_HASH` or `ADMIN_CODE_HASH`. |
| `weekly` / `weekly prepare` / `weekly finish` | Opens Claude Code on `/weekly` / prepares the packet / finishes after the go-ahead. |
| `upgrade` | Updates the engine files from a release, never the instance files. |

## Set up

### `init`

```bash
npm run openbrain -- init
npm run openbrain -- init --yes --company "Acme" --root-page <id> --auth google --domains acme.example --model anthropic:claude-opus-5-5
```

Run by `/setup`, which passes your answers as flags. It writes `openbrain.config.yaml`, `brain/core.md` (from the
template, with your company name), an empty `brain/registry.yaml` and an empty `evals/golden.yaml`, and never
overwrites an existing file. Without `--yes`, it asks for the company name, the Notion root page (id or URL), the
sign-in mode and the chat model.

### `sync notion`

```bash
npm run openbrain -- sync notion [--root-page <id>] [--dry-run] [--full]
```

| Option | Meaning |
|---|---|
| `--root-page <id>` | Overrides `notion.root_page` from the config. |
| `--dry-run` | Shows what would be written, writes nothing. |
| `--full` | Refetches every page, not only the edited ones. |

Needs `NOTION_TOKEN`. After the sync, it lists the pages and sections still missing from the registry and the entries
whose page is gone. See [the Notion connector](/docs/connectors/notion/).

### `connectors`

```bash
npm run openbrain -- connectors list
npm run openbrain -- connectors test notion
npm run openbrain -- connectors test gdrive
```

`list` shows Notion and the inputs declared in the config, with their status. `test <id>` is a read-only health check:
identity, granted scopes, a warning on any write scope, and a few sample items. For Notion, it also warns about every
page the integration can see **outside** the root tree. For an MCP server, it lists the server's tools.

### `collect`

```bash
npm run openbrain -- collect [--since <iso>] [--until <iso>] [--only <id,id>] [--out <dir>] [--full] [--dry-run]
```

Reads the enabled inputs, read-only and without any LLM, into `.openbrain/weekly/<date>/inputs/` (or another folder
under `.openbrain/` with `--out`, for example `.openbrain/init` with `--full` for the first consolidation). Documents
changed since the start of the window, stream events of the window. Personal data and secrets found on the way are
reported. See [inputs](/docs/connectors/inputs/).

## Build and search

### `lint`, `guide build`, `guide check`, `index`

```bash
npm run openbrain -- lint
npm run openbrain -- guide build
npm run openbrain -- guide check
npm run openbrain -- index
```

`lint` exits with an error code on any error, warnings never block. `guide check` fails when the generated guide is out
of date or a budget is exceeded: run it in CI and in the Netlify build. See [troubleshooting](/docs/operate/troubleshooting/)
for the rules.

### `search`

```bash
npm run openbrain -- search "How long do we keep ticket data?" --k 4
```

| Option | Meaning |
|---|---|
| `--section <id>` | Only this section. |
| `--k <n>` | Number of passages (default 6, max 10). |
| `--full` | Print full passages instead of a preview. |

`search` reads the last index you built: run `index` again after any change.

## Chat

### `demo`

```bash
npm run demo                          # same as: npm run openbrain -- demo
npm run openbrain -- demo --llm       # the model of the config instead of the demo model
```

Serves the Acme brain at `http://127.0.0.1:8787` with the demo model (`demo:extractive`, no LLM, no key).

### `serve`

```bash
npm run openbrain -- serve [--port <n>] [--model provider:model] [--with-auth]
```

Runs the chatbot of your instance locally at `http://127.0.0.1:8787`, with the chat model of the config (or `--model`).
Locally the chat is open; `--with-auth` turns the sign-in on, as on Netlify.

### `ask`

```bash
npm run openbrain -- ask "How do I give a colleague access to Acme Billing?"
npm run openbrain -- ask                                   # a conversation in the terminal
npm run openbrain -- ask "..." --model mistral:<model> --mode retrieval_first
```

Prints the answer, its citations, the tool rounds, the token usage and the cost. `--model` tries another model
without touching the config, `--mode agent|retrieval_first` forces the answering mode.

### `eval`

```bash
npm run openbrain -- eval --no-llm
npm run openbrain -- eval [--model provider:model] [--judge provider:model] [--effort low|medium|high]
npm run openbrain -- eval --matrix anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5
```

| Option | Meaning |
|---|---|
| `--no-llm` | Retrieval only, free: are the right pages found? |
| `--model provider:model` | Another chat model than the config. |
| `--matrix a,b` | Several models in one table. |
| `--judge provider:model` | Adds an LLM judge for citation precision and groundedness. |
| `--effort low\|medium\|high` | Compares reasoning efforts. |
| `--only <ids>` | A subset of the questions. |
| `--k <n>` | Passages per search for the retrieval scores. |

Exits with an error under the thresholds. Each run is saved in `.openbrain/evals/`. See [Evals](/docs/operate/evals/).

### `models`

```bash
npm run openbrain -- models list           # models your keys can use
npm run openbrain -- models list --all     # every model of the catalog
npm run openbrain -- models refresh        # refresh capabilities and prices
```

See [Models](/docs/models/).

## Deploy and operate

### `doctor`

```bash
npm run openbrain -- doctor [--json]
```

The before-production checklist: Node version, `.env` not tracked by git, private repo, no secret pattern in
`knowledge/` or `brain/`, sign-in mode, spending cap, lint and guide, the chat model (capabilities, price, local key),
whether that model passed your evals, the date of the last weekly update. Exits with an error on a blocking problem,
which makes it a pre-push hook: `git config core.hooksPath .githooks` enables `.githooks/pre-push` once per clone.

### `bundle`

```bash
npm run openbrain -- bundle [--out <file>]
```

Builds the runtime bundle of the chatbot (passages, registry, prompt, eval questions, and vectors when hybrid search is
on). The Netlify build runs it; you rarely need it by hand.

### `deploy`

```bash
npm run openbrain -- deploy                  # plan only, nothing leaves the machine
npm run openbrain -- deploy --yes [--site <name>]
```

See [Deploy on Netlify](/docs/deploy/netlify/).

### `reports`

```bash
npm run openbrain -- reports                       # open flags of the deployed chatbot, re-tested on the local mirror
npm run openbrain -- reports mark done <id> <id>   # or: mark open <id>
```

Needs `OPENBRAIN_URL` and `ADMIN_TOKEN` in `.env` (`deploy` writes them).

### `auth hash-code`

```bash
npm run openbrain -- auth hash-code               # generates a code and prints it with its hash
npm run openbrain -- auth hash-code "4h7k-9q2m-xp3d"
```

Prints the hash (PBKDF2-SHA256) to put in `ACCESS_CODE_HASH` or `ADMIN_CODE_HASH` on Netlify. Codes need at least 8
characters. The code itself is never stored: share it by hand.

### `weekly`

```bash
npm run openbrain -- weekly                                  # opens Claude Code on /weekly
npm run openbrain -- weekly prepare [--since <iso>] [--no-sync] [--no-collect] [--no-reports]
npm run openbrain -- weekly finish [--reports all|<id,id>]
```

`prepare` writes `.openbrain/weekly/<date>/packet.md`. `finish` rebuilds the guide, lints, re-tests the flagged
questions, marks the reports done and records the update in `state/sync.json`. See
[Weekly update](/docs/concepts/weekly-update/).

### `upgrade`

```bash
npm run openbrain -- upgrade --repo arthczer-555/openbrain                 # dry run: what would change
npm run openbrain -- upgrade --repo arthczer-555/openbrain --yes           # latest release; --version vX.Y.Z to pin
npm run openbrain -- upgrade --from <release.tar.gz|folder> --yes
```

Replaces only the engine files (a fixed allow-list). It never touches `knowledge/`, `brain/`, `evals/`, `state/`,
`openbrain.config.yaml`, `.env` or `CLAUDE.md`.
