---
title: Troubleshooting
description: The usual problems, what they mean and how to fix them.
---

Start with `npm run openbrain -- doctor`: it runs the checks below in one go and says what blocks.

## Lint and guide

| Message | Meaning | Fix |
|---|---|---|
| `missing-registry-entry` | A page of the mirror has no entry in `brain/registry.yaml`. | Add `docs.<page id>` with a `when_to_open`. Section pages with only links need none. |
| `orphan-registry-entry` | An entry points to a page that no longer exists: renamed, moved or deleted in Notion. | Update or remove the entry. |
| `missing-section-entry` / `orphan-section-entry` | Same, for sections. | Add or remove `sections.<id>`. |
| `when-to-open-length` | More than 220 characters. | Say when to open the page, not what is inside. |
| `when-to-open-date` | A date in `when_to_open`. | Remove it: dates belong in the page. |
| `id-matches-path` / `section-matches-folder` | A mirror file disagrees with its location. | Do not edit `knowledge/` by hand: fix Notion and sync. |
| `missing-section-index` | The section page is missing from the mirror. | Re-run `sync notion`. |
| `budget core ... OVER` | `brain/core.md` exceeds 1,200 tokens. | Move facts to Notion, keep at most 10 instance rules. |
| `budget catalog ... OVER` | The section map exceeds 700 tokens. | Shorten section descriptions, or merge small sections. |
| `stale: ... (run: openbrain guide build)` | `guide check` found generated files out of date. | Run `guide build`, commit `brain/catalog.md` and `brain/registry.json`. |

## Notion sync

| Symptom | Fix |
|---|---|
| `NOTION_TOKEN is not set` | Put it in `.env` at the root of the instance (the CLI loads it), or export it in your terminal. |
| `no Notion root page` | Set `notion.root_page` in `openbrain.config.yaml`, or pass `--root-page <id>`. |
| 0 pages, or a 404 on the root | The integration is not connected to the root page: `•••`, *Connections*, add it. |
| `connectors test notion` lists pages outside the root tree | The integration was shared on other pages: remove it from them, so it can only see your tree. |
| A page is missing | It is not under the root page: move it under the root. |
| Slow first sync | Normal: Notion allows about 3 requests per second. Later syncs only fetch edited pages. |

## Wrong answers

| Symptom | Usual fix |
|---|---|
| The right page exists but is not found | Add the words people type to `aliases`, sharpen `when_to_open`. Check with `search`, then `eval --no-llm`. |
| A look-alike page wins | Add *"Not for X"* to its `when_to_open`, a warning on the misleading page, or a section rule. |
| A question in another language misses | Add aliases in that language, or turn on [hybrid search](/docs/concepts/lean-brain/#hybrid-search). |
| A setting answered at the wrong level | A section rule: *"for what a group can use, also open the company settings"*. |
| "Not documented" but it is | If `search` finds the page, it is routing (registry); if not, the page is missing or empty in Notion. |

Every fix you make this way deserves a golden question, see [Evals](/docs/operate/evals/).

## Deploy

| Message | Fix |
|---|---|
| `the repo is PUBLIC` | Make the repository private: the mirror holds your internal knowledge. |
| `no <provider> key` | Put the key of the chat model in your local `.env`: `deploy` copies it to Netlify. |
| `install the Netlify CLI` | `npm i -g netlify-cli`, then `netlify login`. |
| `set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET` | `google` mode needs an OAuth client in your local `.env`. |
| The Netlify build fails on `guide check` | Run `guide build` locally and commit. The previous version stays online meanwhile. |
| Embeddings `skipped: no key` in the build log | Set the key of your embeddings provider on Netlify, or remove `models.embeddings`. Search falls back to BM25. |

## Chatbot

| Symptom | Fix |
|---|---|
| `SESSION_SECRET is not set on the server` | Re-run `deploy --yes`, or set it on Netlify (a long random string). |
| `ACCESS_CODE_HASH is not set on the server` | `passcode` mode needs it: `auth hash-code`, then set the hash on Netlify. For a chat without access code, set `OPENBRAIN_OPEN_ACCESS=1` instead. |
| `too many attempts` | 5 failed sign-ins in 15 minutes from the same IP: wait, then try again. |
| `daily limit of 100 questions reached` | Per-user quota: raise `budgets.questions_per_user_per_day`. |
| `the monthly budget of the chatbot is reached` | Raise `budgets.monthly_usd`, or wait for next month. |
| Answers stop at about 50 seconds | Under Netlify's 60-second limit: try a faster model or a lower `effort`. |
| An Ollama model works locally but not online | Netlify cannot reach your laptop: use a hosted provider or a protected endpoint. |
| A sign-in loop with `auth.mode: netlify` | Set `OPENBRAIN_EDGE_GUARD=off` on Netlify. |

## Weekly update

| Symptom | Fix |
|---|---|
| The session stopped (usage limit, terminal closed) | `/weekly --resume` continues the interrupted run. |
| A conflict keeps coming back | It stays at the top of every briefing until you decide: answer it in the go-ahead. |
| Flags are not fetched | `OPENBRAIN_URL` and `ADMIN_TOKEN` in your local `.env` must match the deployed site (`deploy` writes them). |
| `doctor` says no weekly update recorded | Run `weekly finish` at the end of the update: it records it in `state/sync.json`. |
