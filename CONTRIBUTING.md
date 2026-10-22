# Contributing to OpenBrain

Thanks for helping. OpenBrain is a small engine with strong opinions: Notion is the single source of truth,
the chatbot reads a compiled index only, nothing is written without a human's go, and the prompt stays lean.
Contributions that keep these properties are very welcome.

## Set up

```bash
npm install
npm test               # unit tests (vitest), no network, no API key
npm run typecheck      # TypeScript strict, packages and the web app
npm run demo           # the fictional Acme brain at http://127.0.0.1:8787, demo model, no key
```

Node 24 or newer. No build step for the packages: the CLI runs TypeScript through tsx.

## Where things live

| Folder | What |
|---|---|
| `packages/core` | Knowledge format: Notion mirror, routing registry, lint, guide, budgets, config |
| `packages/retrieval` | Passages, BM25F index, search, paginated reading |
| `packages/connectors` | Notion (mirror sync) and read-only inputs: files, web, GitHub, Google Drive, any MCP server |
| `packages/llm` | Every provider through the Vercel AI SDK, model catalog, effort, cache, fallbacks, demo model |
| `packages/agent` | Prompt assembly, the 3-tool loop, budgets, citations, evals and judge |
| `packages/server` | HTTP handlers of the chatbot (Netlify or local), auth, quotas, reports, stores |
| `packages/cli` | The `openbrain` command, one file per command in `src/commands/` |
| `apps/web` | Chat, sources, knowledge browser and admin (Vite + React) |
| `apps/site` | Landing page and documentation (Astro + Starlight) |
| `netlify/` | Functions and edge guard |
| `examples/acme` | The fictional company used by the demo, the docs and the regression tests |

## Rules of the code

- TypeScript strict, no `any`, explicit types at module boundaries.
- Match the style of the file you edit: naming, comment density, small functions.
- No new dependency without a reason written in the pull request (the chatbot function must stay small).
- Tests next to the code (`packages/*/test`), with fixtures and injected `fetch`: no network in tests.
- Connectors are read-only. A test must prove that no method other than GET is sent (token exchange and
  search endpoints excepted, explicitly listed).
- Never put real company data anywhere: examples use Acme (Acme Desk, Acme Hub, Acme Console).
- No long dash characters in code, docs or copy: commas, periods, parentheses or a hyphen.

## Quality gates

Every pull request runs `.github/workflows/ci.yml`: typecheck, tests, lint and guide check of Acme, and the
retrieval evals without LLM (recall@k at least 0.9). A change to the agent, the retrieval or the prompt
should also be measured with a real model:

```bash
npm run openbrain -- eval --root examples/acme --model anthropic:claude-opus-5-5 --judge google:<model>
```

Paste the summary in the pull request (quality, tokens per question, cost).

## A new connector

Copy the structure of an existing input in `packages/connectors/src/<id>/`: `index.ts`, `manifest.ts`,
`SETUP.md` (step by step, read-only token), fixtures and tests, incremental collection with `since`. Label the
issue `connector-request` to collect votes first.

## Security

Do not open a public issue for a vulnerability: see [SECURITY.md](SECURITY.md).
