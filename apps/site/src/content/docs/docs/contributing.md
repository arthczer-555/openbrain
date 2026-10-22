---
title: Contributing
description: Set up the monorepo, run the tests, and the rules every contribution follows.
---

OpenBrain is an npm workspaces monorepo in strict TypeScript, run with `tsx` (no build step for the packages).

```bash
git clone https://github.com/arthczer-555/openbrain.git openbrain && cd openbrain
npm install          # Node 24 or newer
npm test             # unit tests (vitest)
npm run typecheck    # strict TypeScript
npm run e2e          # end to end: demo + headless Chrome (question, citation, feedback, admin, mobile)
npm run lint         # lint the Acme example
```

## Layout

| Folder | Content |
|---|---|
| `packages/core` | Knowledge format, loader, registry, lint, guide, budgets, config. |
| `packages/retrieval` | Markdown chunker and dependency-free BM25F search. |
| `packages/connectors` | Notion sync and the inputs (files, web, GitHub, Google Drive, MCP). |
| `packages/llm` | Model layer: providers, catalog, costs, fallbacks, demo model. |
| `packages/agent` | Prompt assembly, agent loop, the three tools. |
| `packages/server` | Chat API, used by `serve`, `demo` and the Netlify functions. |
| `packages/cli` | The `openbrain` command. |
| `apps/web` | Chat, knowledge browser and admin UI. |
| `apps/site` | This site: landing page and docs (Astro + Starlight). |
| `netlify/`, `netlify.toml` | Functions, edge sign-in guard and build. |
| `.claude/skills/` | `/setup`, `/init`, `/weekly` (and `/hebdo`), `/write`. |
| `.github/workflows/` | `ci.yml`, `reminder.yml`, `pages.yml`, `release.yml`. |
| `examples/acme` | The fictional company used for the demo, the tests and the evals. |

## Rules

- **Never put real company data in this repo.** Examples use the fictional Acme: Acme Desk (the client-facing helpdesk
  app), Acme Hub (the internal tool), Acme Console (the admin back-office).
- **Keep it lean.** A change that adds tokens to every prompt needs a reason and a measurement. Budgets are enforced by
  `guide build`.
- **A new trap is a new test.** If you fix a routing or answering problem, add the question to
  `examples/acme/evals/golden.yaml` (40 questions today, retrieval recall@k 100% without any LLM: keep it there).
- **Inputs are read-only**, proven by a test. See [Write your own input](/docs/connectors/write-your-own/).
- **Match the style of the file you edit**: 2-space indentation, strict TypeScript, no `any`.
- **No secret in code, fixtures or issues.**

## Upstream and instances

The same workflows run in the public repository and in every instance made from the template. The repository
variable `OPENBRAIN_UPSTREAM=true`, set only on the public repository, turns on the engine tests, the end-to-end test
and the publication of this site; an instance runs its own checks and never publishes anything.

## Working on this site

```bash
cd apps/site
npx astro dev
```

The landing page is `src/pages/index.astro` with its sections in `src/components/landing/`; the docs are Markdown files
in `src/content/docs/docs/`. Write internal links root-relative (`/docs/models/`): the base path of GitHub Pages is
added at build.

## Proposing a connector

Open an issue with the `connector-request` label: the most requested inputs come next.
