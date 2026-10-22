---
title: Environment variables
description: Which secret goes where. Tool tokens stay on your machine; only the chatbot's secrets go to Netlify.
---

Copy `.env.example` to `.env` and fill only what you use. `.env` is never committed. The CLI loads it from the instance
folder and the current folder; variables already set in your terminal win. Nothing is needed for the local toolchain
(`lint`, `guide`, `index`, `search`) or for `npm run demo`.

## On Netlify (the chatbot)

`openbrain deploy --yes` generates the secrets and copies, from your local `.env`, the keys of your chat models and the
Google sign-in variables. Set the optional ones (`OPENBRAIN_EDGE_GUARD`, the embeddings key) yourself, with
`netlify env:set` or in the Netlify UI.

| Variable | Required | Used for |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` | At least one | The chat model and its fallbacks. Any variable named by `api_key_env` works too. |
| `SESSION_SECRET` | Yes | Signs the session cookies (HMAC). `deploy` generates it. |
| `ACCESS_CODE_HASH` | `passcode` mode | Hash of the shared access code (PBKDF2), never the code itself. `deploy` sets it from the code you choose; `auth hash-code` makes a new one. |
| `OPENBRAIN_OPEN_ACCESS` | No | `1`: `passcode` mode without access code, no sign-in page. Only applies when `ACCESS_CODE_HASH` is empty. `deploy --no-password` sets it. |
| `ADMIN_CODE_HASH` | `passcode` and `netlify` modes | Hash of the admin code. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `google` mode | Google OAuth client. Put them in your local `.env`: `deploy` copies them. |
| `ALLOWED_EMAIL_DOMAINS` | `google` mode | Comma-separated domains allowed to sign in. |
| `ADMIN_EMAILS` | `google` mode | Comma-separated admin emails. |
| `ADMIN_TOKEN` | Yes | Bearer token the weekly update uses to read and close flags. Same value as in your local `.env`. |
| `OPENBRAIN_ROOT` | No | Instance folder when it is not the repo root (for example `examples/acme`). |
| `OPENBRAIN_EDGE_GUARD` | No | `off` when Netlify itself protects the site (`auth.mode: netlify`). |
| `VOYAGE_API_KEY` (or the key of your embeddings provider) | No | Optional hybrid search: the passages are embedded at build, the question at each search. |

## On your machine only

| Variable | Used for |
|---|---|
| `NOTION_TOKEN` | `sync notion`, `connectors test notion`, the weekly update. |
| `GDRIVE_SA_JSON`, `GITHUB_TOKEN` | Built-in inputs. A connector of Claude Code needs no token. |
| Keys named in `inputs.mcp.<name>.auth_env` and `inputs.api.<name>.auth.env` | The MCP servers and REST APIs collected by the CLI. |
| `OPENBRAIN_URL`, `ADMIN_TOKEN` | `reports` and the weekly update. `deploy` writes them. |
| Provider keys | `ask`, `eval`, `serve` and `demo --llm` with a real model, and the eval judge. |

:::caution
Never put `NOTION_TOKEN` or another tool token on Netlify or in GitHub. The chatbot does not need them (`deploy`
refuses to send them), and keeping them local means a leak on the hosting side exposes neither Notion nor your tools.
:::
