---
title: Deploy on Netlify
description: Check, deploy, sign in. Access code or Google sign-in, quotas and a spending cap, no database.
---

:::note[Status]
Implemented and covered by tests, including an end-to-end run of the chatbot in a headless browser. Deployments on real
Netlify sites are being validated. A *Deploy to Netlify* button is planned.
:::

The chatbot is a static UI (chat, knowledge browser, admin) plus Netlify Functions. Netlify builds it from the mirror
committed in your private repo: **no Notion token on Netlify**, no database, no server to run. Flags, counters and
settings live in Netlify Blobs on your own site.

## 1. Check

```bash
npm run openbrain -- doctor
```

The before-production checklist: Node, `.env` not tracked by git, private repo, no secret pattern in `knowledge/` or
`brain/`, sign-in mode, spending cap, lint and guide, the chat model (capabilities, price, local key), whether that model
passed your evals, the last weekly update. It exits with an error on a blocking problem. Enable it as a pre-push guard
once per clone:

```bash
git config core.hooksPath .githooks
```

## 2. Deploy

You need the [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm i -g netlify-cli`, then `netlify login`).

```bash
npm run openbrain -- deploy                    # plan only: nothing leaves your machine
npm run openbrain -- deploy --yes              # asks for the access code, creates the site, sets the secrets, deploys
npm run openbrain -- deploy --yes --site acme-brain
npm run openbrain -- deploy --yes --password "<code>"   # or --no-password, when nobody can answer the prompt
```

Without `--yes`, `deploy` runs the checks (lint, guide, sign-in mode, private repo, the key of the chat model, Netlify
CLI) and prints the plan. With `--yes` it:

1. asks for the chat's access code (8 characters or more), or none after a confirmation (`passcode` mode);
2. creates the Netlify site (or reuses the linked one) and links it;
3. generates `SESSION_SECRET`, `ADMIN_TOKEN` and the admin code, and sets the environment variables (the keys of your chat
   models, the Google client in `google` mode). Source tokens such as `NOTION_TOKEN` are never sent;
4. deploys to production;
5. writes `OPENBRAIN_URL` and `ADMIN_TOKEN` to your local `.env`, for `reports` and the weekly update;
6. prints the URL, the access code and the admin code **once**. They are stored only as hashes.

Share the URL and the access code with your team, keep the admin code.

## The build

```toml
# netlify.toml (extract)
[build]
  command = "npm run openbrain -- guide check --root ${OPENBRAIN_ROOT:-.} && npm run openbrain -- bundle --root ${OPENBRAIN_ROOT:-.} && npm run build -w @openbrain/web"
  publish = "apps/web/dist"

[functions]
  node_bundler = "esbuild"
  included_files = [".openbrain/runtime/bundle.json"]
```

The build never calls Notion. If the registry no longer matches the mirror or a budget is exceeded, `guide check` fails,
**the deploy fails and the previous version stays online**. Every push to your repo redeploys in a minute or two. The
site also sends strict security headers (Content-Security-Policy, no framing, no referrer).

## Sign-in modes

The chatbot exposes internal knowledge: it is closed by default. `auth.mode: none` is refused outside local runs, and an
edge function checks the session on every route.

| Mode | Netlify plan | For | Setup |
|---|---|---|---|
| `passcode` (default) | Every plan, free included | Small teams, getting started | One shared access code chosen at `deploy` (`auth hash-code` makes a new hash). Admins enter the admin code. |
| `google` | Every plan | Companies on Google Workspace (recommended) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS` (or `auth.allowed_domains`), `ADMIN_EMAILS`. |
| `netlify` | Pro (password or private visibility) | Sites already protected by Netlify | Set `OPENBRAIN_EDGE_GUARD=off`. Admins enter the admin code. |

Sessions are signed cookies valid 30 days. Sign-in attempts are limited to 5 per 15 minutes per IP.

**No access code.** In `passcode` mode, leaving the code empty at `deploy` (or `--no-password`) sets
`OPENBRAIN_OPEN_ACCESS=1`: the chat opens directly, with no sign-in page, and anyone with the link can read the
knowledge base through it. Each browser gets its own pseudonymous session for the quotas; `/admin` still asks for the
admin code. A missing `ACCESS_CODE_HASH` alone keeps the chatbot closed, and a code, when set, always wins.

## Limits and costs

| Guardrail | Default | Setting |
|---|---|---|
| Rate limit on `/api/chat` | 20 requests per minute | Netlify rate limiting, per IP and domain |
| Questions per user per day | 100 | `budgets.questions_per_user_per_day` |
| Monthly spending cap | $50 | `budgets.monthly_usd` (`0` disables it) |
| Tool rounds per question | 4 | |
| Tool results per question | about 10,000 tokens | |
| Answer deadline | 50 seconds | under Netlify's 60-second limit |

When the monthly cap is reached, the chat answers that the budget is reached until next month. The cost is estimated
from the token usage of each answer and the model's price.

## Theming

The chat uses the OpenBrain look by default and is themable per instance:

```yaml
chatbot:
  assistant_name: "Acme Brain"
  accent: "#F00050"
  logo: "/logo.svg"
```

The empty chat shows the assistant name, a short introduction (*"Ask anything about Acme. Answers come only from its
Notion, and every fact links to its page..."*) and a *Browse knowledge* link.

## Other hosts

v0.1 targets Netlify Functions, Netlify Blobs and an edge function. Other hosts are planned. Locally,
`npm run openbrain -- serve` runs the same chatbot on your machine.
