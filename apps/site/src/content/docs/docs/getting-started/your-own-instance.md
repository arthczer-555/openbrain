---
title: Your own instance
description: Private repo, /setup, /init if needed, review and try, deploy, then /weekly every week.
---

Claude builds your brain and keeps it up to date: it consolidates your tools into Notion, writes the routing registry
and the test questions, and runs the weekly update. You answer its questions and approve before anything is written.
See [why Claude Code is required](/docs/getting-started/claude-code/).

**Prerequisites**: Node 24 or newer, [Claude Code](https://claude.com/claude-code) on a Claude subscription with the
**Notion connector** enabled, a Notion workspace, a Netlify account, and an API key for the chat model (any provider).

## 1. Create a private repo

Create a **private** copy of the repository (GitHub *Use this template*, then *Private*, or clone and push to a new
private repo), then run `npm install`.

:::caution[Keep it private]
`knowledge/` holds a copy of your internal documentation. `/setup`, the CI, `doctor` and `deploy` refuse to go further
on a public repo.
:::

Your brain lives at the root of that repo:

```text
openbrain.config.yaml     instance settings
.env                      secrets, local only (never committed)
knowledge/                Notion mirror, generated, never edited
brain/core.md             the assistant's identity and golden rules (written by /setup)
brain/registry.yaml       when to open each page, per-section rules (written by /setup and /init, kept up to date by /weekly)
brain/catalog.md          generated
brain/registry.json       generated
evals/golden.yaml         test questions (drafted by /init, completed by /weekly)
state/                    sync and weekly update state (generated)
```

## 2. Run `/setup` (about 15 minutes)

Open the repo in Claude Code (`claude`) and type `/setup`. Claude asks one question at a time and does the work:

1. **Company**: name, language of your Notion, name and color of the assistant. Claude runs `openbrain init` to create
   the instance files.
2. **Notion**: you do three things yourself, Claude does the rest.
   - Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
     with the capability **Read content only**: the mirror is read-only.
   - On your root page: `•••`, *Connections*, add the integration. Share **only** the root page.
   - `cp .env.example .env` and set `NOTION_TOKEN` in it. Never paste a secret in the conversation.

   Claude then checks the connection (it warns about any page shared outside the root tree) and mirrors the tree into
   `knowledge/`. See [the Notion connector](/docs/connectors/notion/).
3. **Input tools** (Slack, Drive, GitHub, a CRM, websites, files, any MCP server or REST API): for each one, Claude
   picks the simplest way (a connector of Claude Code, a built-in input, or the generic MCP / REST adapter), tests it
   read-only and writes its allow-listed scope. See [inputs](/docs/connectors/inputs/).
4. **Chat model**: any provider, with a fallback. Changeable later without redeploying. See [Models](/docs/models/).
5. **Registry and identity**: Claude drafts `brain/registry.yaml` from your pages and `brain/core.md`, shows them to
   you, and writes them after your go-ahead.
6. **Guard and deploy plan**: pre-push guard, `doctor`, then the deployment plan (step 5).

If your Notion already holds your company knowledge, `/setup` is enough: go to step 4.

## 3. Run `/init` if your knowledge is spread across tools

`/init` fills Notion from your other tools, once:

1. Inventory of the existing Notion tree and of every input tool, with the estimated volume and number of batches.
2. Clean-up: empty pages, templates, duplicates; sensitive items are flagged and never copied.
3. Proposal: a tree of 5 to 12 sections, then page by page what will be created or updated and from which sources.
   **Contradictions come first**: nothing is written until you settle them.
4. Your approval, batch by batch, in the conversation.
5. Writing into Notion through your Notion connector, only under the root page, with a *Sources* block at the bottom of
   each page.
6. Sync, registry, test questions drafted from the base plus your own, retrieval evals, commit and push.

It works in batches and resumes where it stopped. What a good tree looks like, to review Claude's proposal:

```text
Company Brain                 <- root page
├─ Product                    <- section (first-level child)
│  ├─ Roles and permissions   <- page
│  └─ Data retention
├─ Sales
│  └─ Pricing
└─ People & HR
   └─ Remote work
```

- **5 to 12 sections**, split by audience or tool. Section ids come from the titles (*People & HR* becomes `people-hr`).
- **One topic per page**, with H2 and H3 headings: each heading becomes a passage the assistant can find and cite.
- **Facts written in the page.** Attachments (PDF, images) are not indexed.
- **No contradictions.** The assistant cites, it does not arbitrate.

## 4. Review and try

```bash
npm run openbrain -- search "How long do we keep client data?"   # which passages come up, no model needed
npm run openbrain -- ask "How long do we keep client data?"      # full answer (no question: a conversation)
npm run openbrain -- serve                                       # the chatbot on http://127.0.0.1:8787
```

Ask the questions your colleagues really ask, in their words and in every language they use. When the wrong page comes
first or an answer is off, tell Claude in the conversation (or type `/write`): the fix is usually in the registry (an
alias, a sharper `when_to_open`, a warning, a section rule) or in the Notion page itself.
[The routing registry](/docs/concepts/registry/) helps you review Claude's draft.

Then measure:

```bash
npm run openbrain -- eval --no-llm     # retrieval only, free: are the right pages found?
npm run openbrain -- eval              # full answers: behavior, citations, language, tokens, cost, latency
```

See [Evals](/docs/operate/evals/). Optionally, turn on [hybrid search](/docs/concepts/lean-brain/#hybrid-search).

## 5. Deploy

```bash
npm run openbrain -- doctor          # before-production checklist
npm run openbrain -- deploy          # plan only
npm run openbrain -- deploy --yes    # creates the site, sets the secrets, deploys
```

The provided CI checks that the repo is private, that the guide is up to date and that the retrieval evals pass, without
any LLM, and the pre-push guard enabled by `/setup` runs `doctor` before every push. See
[Deploy on Netlify](/docs/deploy/netlify/).

## 6. Every week: `/weekly`

Open the repo in Claude Code and type `/weekly` (or `/hebdo`), or run `npm run openbrain -- weekly`, which opens Claude
Code on it. See [Weekly update](/docs/concepts/weekly-update/). Between two updates, `/write` adds or fixes one piece
of knowledge.

## Upgrade the engine

```bash
npm run openbrain -- upgrade --repo arthczer-555/openbrain          # dry run: what would change
npm run openbrain -- upgrade --repo arthczer-555/openbrain --yes    # latest release; --version vX.Y.Z to pin
```

`upgrade` replaces only the engine files. It never touches `knowledge/`, `brain/`, `evals/`, `state/`,
`openbrain.config.yaml`, `.env` or `CLAUDE.md`.
