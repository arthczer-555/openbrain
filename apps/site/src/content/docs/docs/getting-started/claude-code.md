---
title: Why Claude Code is required
description: Claude Code builds the base and keeps it fresh; the deployed chatbot does not need it.
---

OpenBrain has two kinds of work, and they run in different places.

| | Building and maintaining the base | Answering questions |
|---|---|---|
| What | Consolidating your tools into Notion, the routing registry, the test questions, the weekly update | The chatbot your team uses |
| Who runs it | Claude Code in your terminal, helped by the `openbrain` CLI | A Netlify function (or `openbrain serve` locally) |
| Model | The model you use in Claude Code | Any provider, set in the config or switched from the admin page |
| Billing | Your Claude subscription: no API bill for maintenance | Your provider's API, per question |
| Needs Claude Code? | **Yes** | **No** |

## Why there is no manual path

Building a base the chatbot can trust is judgment work, page by page: decide where a fact belongs in Notion, merge
duplicates, spot a conflict between a Drive deck and a Notion page, write *when* each page should be opened, its
aliases and the false friends to warn about, then turn every trap into a test. On a real company base, that is not
something to do by hand, and the weekly update needs the same judgment every week. So OpenBrain does not document a
manual path: Claude does the work, you answer its questions and approve before anything is written.

What you get in return:

- **No API bill for maintenance.** It runs on your Claude subscription.
- **Your MCP connectors work directly.** The Notion, Slack, Drive or HubSpot connectors you already use in Claude are
  available to the skills (declared under `inputs.claude` with a scope), so many tools need no token at all. Approved writes into Notion go through your **Notion
  connector**; the Notion integration token of OpenBrain stays read-only.
- **Secrets never leave your machine.** You paste tokens in `.env` yourself, never in the conversation.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) on a Claude subscription, with the **Notion connector** enabled.
- Node 24 or newer.
- A Notion workspace, a Netlify account, and an API key for the chat model (any provider).

## The skills

They live in `.claude/skills/` and are available as soon as the repo is open in Claude Code.

| Skill | When | What it does |
|---|---|---|
| `/setup` | Once, about 15 minutes | Company and language, Notion (read-only integration, check, first mirror), input tools, chat model, registry and identity, tests, pre-push guard, deployment plan. It runs `openbrain init` itself. |
| `/init` | Once, when your knowledge is spread over other tools | Fills Notion from your tools, by batches, with the duplicates and contradictions to settle first, then sync, registry and test questions. |
| `/weekly` (alias `/hebdo`) | Every week | The [weekly update](/docs/concepts/weekly-update/). `--resume` continues an interrupted run. |
| `/write` | Any time | Adds knowledge on request, with the same checks: a fact, a document, or a whole topic gathered from your connected tools (codebase, product, sales, marketing...). |

The CLI commands they call (`init`, `sync notion`, `collect`, `guide`, `weekly prepare`, `weekly finish`...) are listed
in the [CLI reference](/docs/reference/cli/). You mainly run `search`, `ask`, `serve`, `eval`, `doctor`, `deploy` and
`reports` yourself.

## The chatbot never needs Claude Code

Once deployed, the chatbot only needs the compiled bundle and a key for the provider you chose. Everything about it
(models, sign-in, budgets, flags) is configured in `openbrain.config.yaml` and on the [admin page](/docs/operate/admin/).
Claude Code also works with an API key instead of a subscription; the maintenance is then billed per use.
