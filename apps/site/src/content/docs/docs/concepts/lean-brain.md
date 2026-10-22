---
title: The lean brain
description: What the agent reads per question, the four context layers, their budgets and the three tools.
---

Most company assistants pay for **the whole map** (a large registry or routing guide) and **whole pages** (thousands
of tokens each) to use a few lines. OpenBrain serves only what is relevant, when it is relevant: passages instead of
pages, warnings attached to the passages instead of a global registry in the prompt.

## Four layers, each with a budget

| Layer | Content | Budget (tokens) | When | Cached |
|---|---|---|---|---|
| **L0, stable prefix** | 3 tool definitions + `brain/core.md` + `brain/catalog.md` | **2,500** in total (tools 600, core 1,200, catalog 700) | Every call | Yes |
| **L1, section context** | Routing rules of the sections touched (from `brain/registry.yaml`) | 300 per section | Only when a result falls in that section | No |
| **L2, passages** | `search_knowledge` results: top passages, title, Notion link, page warnings | 4,000 per call, 10,000 per question | When the model asks | No |
| **L3, targeted read** | `read_document` on one section of a page, paginated | 3,000 per call | When a passage is not enough | No |

The budgets are **checked at build** (`guide build` fails if `core.md` or `catalog.md` exceeds its budget) and
**enforced in code** at question time: results are truncated cleanly and marked `truncated`, with a next page. The
guide cannot grow back in silence.

:::note
Token counts at build use a conservative estimate (characters divided by 3.5, plus 15%). Exact counting per provider
comes with the model layer.
:::

## Before and after, on a typical question

*"How do I set up single sign-on for a new client?"* needs a procedure, a screen and who does what.

| | A typical agent | OpenBrain target |
|---|---|---|
| Fixed prefix | ~16-18k (rules, catalog, dozens of tools) | ~2.5k (core, catalog, 3 tools) |
| Map of the knowledge | ~20-30k (the whole routing guide) | 0 (compiled into the index, warnings served with passages) |
| Content | 3 whole pages, ~20-30k | 2 searches (~6-8k) + 1 targeted read (~2-3k) |
| **Context of the last call** | **~55-75k** | **~10-13k** |

These are targets. The measured ratio will be published once the benchmark runs: `[N]x fewer tokens than our previous
agent [MEASURED IN BENCHMARK]`.

## The three tools

```ts
search_knowledge({ query: string, section?: string, k?: number })   // k: default 6, max 10
// -> passages with a stable citation id [n], page id, title, heading path, text, Notion URL,
//    status, updated_at, page warnings (once per page), section rules (once per section)

read_document({ doc_id: string, heading?: string, page?: number })
// -> one section of one page, paginated, with its citation id and warnings

report_gap({ question: string, searched: string[], reason: "not_found" | "partial" | "contradiction" | "out_of_scope" })
// -> flags the question for the next weekly update
```

Details that matter:

- **Stable citation ids.** The model writes `[3]`, the UI turns it into a link to the Notion page. The model never
  copies a URL: fewer output tokens and no invented links.
- **No duplicates in a conversation.** A passage already served is not sent again (only its citation id), and the
  warnings of a page or the rules of a section are served once.
- **Passages, not pages.** Pages are split at H2 and H3 headings into passages of 300 to 500 tokens, each prefixed
  with its page title and heading path so it reads on its own. Tables are never cut.
- **Search.** BM25F with weighted fields (title and aliases x3, `when_to_open` and headings x2, body x1), plus
  optional [hybrid search](#hybrid-search).
- **No live tools.** The chatbot does not query a CRM or a finance tool at question time. It reads Notion only.

## Hybrid search

Keyword search (BM25F) plus the registry's aliases is enough to start: on the Acme example it finds the expected pages
for all 40 eval questions, with no LLM and no embeddings. To add semantic search (useful for paraphrases and questions
in another language than the base), set an embeddings model and its key:

```yaml
models:
  embeddings: { provider: voyage, model: voyage-4-lite, dimensions: 512 }   # VOYAGE_API_KEY
```

Voyage, OpenAI, Google, Mistral and OpenAI-compatible endpoints work. How it runs:

- **At build**, `bundle` embeds every passage once. The vectors are normalized and stored as int8, four times smaller
  than floats, inside the chatbot bundle.
- **At each search**, the question is embedded with the same model, and the vector ranking is fused with the BM25F
  ranking by Reciprocal Rank Fusion. RRF only uses ranks, so the two scores never need calibrating.
- **Without the key**, nothing breaks: the build log says the embeddings were skipped, and search stays BM25 only.

The fixed prompt and the budgets do not change: hybrid search changes which passages come back, not how many.

## Prompt caching

The prefix is rendered in a fixed order (tools sorted, then `core.md` and `catalog.md`, then messages) with nothing
variable in it: no date, no user name. The date of the day goes in the user message. On providers with explicit
caching, a cache breakpoint sits at the end of the system prompt.

## Guardrails enforced in code

| Guardrail | How |
|---|---|
| At most 4 tool rounds per question | After the 4th, the model answers with what it found. |
| At most 10,000 tokens of tool results per question | Results beyond are truncated and marked. |
| Links | The UI only renders links that come from citations, and no remote images (anti-exfiltration). |
| Time | Server-sent heartbeat every 5 seconds; a clean stop at 50 seconds on Netlify. |
| Read-only | The chatbot has no action tool. The worst case of a prompt injection is a wrong answer, not an action. |

## The golden rules in `brain/core.md`

Zero invention (every company fact comes from a retrieved passage, otherwise *"This is not documented yet"* and a
flag), a negative result covers only what was actually searched, facts are separated from inferences, every fact is
cited right after it, `to_confirm` and `stale` pages are announced, the answer is entirely in the language of the
question, and its length follows the question.
