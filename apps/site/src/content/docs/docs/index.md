---
title: OpenBrain documentation
description: What OpenBrain is, how its pieces fit together, and where to start.
---

OpenBrain turns your company's Notion into a lean internal assistant. Your team asks questions in plain language,
the chatbot answers from Notion only, cites the Notion page behind every fact, and says *"This is not documented
yet"* instead of inventing. Every unanswered question and every thumbs down comes back at the next weekly update,
where it becomes a fix in Notion and a test.

## The idea in five lines

1. **Notion is the single source of truth.** Files, websites, GitHub, Google Drive and any MCP server are read-only
   inputs: what matters in them is consolidated into Notion, after your approval, with conflicts settled first.
2. **The chatbot reads a compiled mirror.** `openbrain sync notion` copies one Notion page tree into Markdown
   (`knowledge/`), and the build turns it into a passage index. The chatbot never needs your Notion token.
3. **A routing registry tells the agent when to open each page** (`brain/registry.yaml`). The build fails if the
   registry and Notion drift apart.
4. **Lean by design.** About 2,500 tokens of fixed prompt, passages instead of whole pages, 3 tools. The budgets are
   checked at build and enforced in code.
5. **It improves every week.** You run `/weekly` in Claude Code, on your Claude subscription: it reads what changed,
   reviews the flagged questions, proposes Notion updates and waits for your go-ahead.

## Three loops

| Loop | When | What happens |
|---|---|---|
| Question | seconds | UI, then the `chat` function searches the index and answers with citations to Notion. Nothing found: the question is flagged. |
| Weekly | every 7 days, `/weekly` in Claude Code | Inputs + Notion + flags, then a briefing with the conflicts to settle, your go-ahead, writes to Notion, sync, registry, rebuild, deploy. |
| Setup | once, then per new tool | `/setup` in Claude Code connects Notion and your tools; `/init` runs the first consolidation into Notion. |

## Status

OpenBrain v0.1 is implemented and tested locally: unit tests, typecheck, and an end-to-end run of the chatbot in a
headless browser. Runs against real LLM APIs and real Netlify deployments are being validated.

| Piece | Status |
|---|---|
| Knowledge format, `lint`, `guide`, `index`, `search`, `sync notion` | implemented and tested |
| Chatbot (`demo`, `serve`, Netlify), `/admin`, `/kb`, `ask`, `eval`, `models`, `doctor`, `deploy`, `reports` | implemented, being validated on real APIs and deployments |
| Inputs (`files`, `web`, `github`, `gdrive`, `mcp`), `connectors`, `collect` | implemented, being validated on real accounts |
| Claude Code skills `/setup`, `/init`, `/weekly` (alias `/hebdo`), `/write`, and `weekly prepare` / `finish` | implemented |
| Optional hybrid search (embeddings fused with BM25) | implemented |
| Slack input, Notion CLI writer, *Deploy to Netlify* button, measured benchmark, headless weekly update | planned |

## Where to start

- **See it run in a few minutes** on the fictional Acme company: [Quickstart](/docs/getting-started/quickstart/).
- **Set up your own brain**: [Your own instance](/docs/getting-started/your-own-instance/).
- **Understand the design**: [Notion and the mirror](/docs/concepts/notion-and-the-mirror/), then
  [the lean brain](/docs/concepts/lean-brain/).
- **Look something up**: [CLI](/docs/reference/cli/), [openbrain.config.yaml](/docs/reference/config/),
  [environment variables](/docs/reference/environment/).
