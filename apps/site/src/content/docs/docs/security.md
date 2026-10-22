---
title: Security & privacy
description: What is stored where, for how long, and the threats OpenBrain is designed against. For your DPO or CISO.
---

A company brain concentrates internal knowledge in one place: that is its value and its risk. This page lists what
OpenBrain stores, where, and how each threat is handled.

## Where your data lives

| Data | Where | Retention |
|---|---|---|
| The knowledge | **Notion**, under your root page | Managed by you, in Notion |
| The mirror of the knowledge | Your **private** git repo (`knowledge/`) | Replaced at each sync, history in git |
| Content collected from other tools | `.openbrain/` on the operator's machine, ignored by git | Purged at the next update |
| The index | Netlify build artifact | Replaced at each deploy |
| Flags (no answer; thumbs down with question, answer, cited pages, comment) | Netlify Blobs on your site | Until processed by the weekly update, 90 days at most |
| Conversations (for multi-turn answers) | Netlify Blobs | 24 hours |
| Usage counters (questions, thumbs up, estimated cost) | Netlify Blobs | Aggregated, no content |

There is no OpenBrain server, no telemetry and no analytics. Each company runs its own instance in its own GitHub,
Notion and Netlify accounts; the OpenBrain maintainers never see them.

## What goes to the LLM provider

Questions, the recent turns of the conversation and the passages retrieved to answer them are sent to the LLM provider
you choose, under its API terms. Choose the provider (and region) that fits your constraints: Azure OpenAI, Amazon
Bedrock, Google Vertex AI and Mistral are common answers to data-residency requirements. OpenRouter adds an
intermediary: that is your choice to make.

## Threats and answers

| Threat | Answer |
|---|---|
| **The mirror ends up in a public repo** | Instances are private copies. The provided CI fails when the repo is public and `knowledge/` is not empty; `doctor` and `deploy` check it too; the pre-push hook (`git config core.hooksPath .githooks`) runs `doctor` before every push. |
| **Chatbot reachable without sign-in** | `auth.mode: none` is refused outside local runs; a chat without access code is an explicit, confirmed choice at `deploy` (`OPENBRAIN_OPEN_ACCESS=1`), a missing `ACCESS_CODE_HASH` alone keeps it closed; an edge function checks the session on every route; sessions are signed cookies; sign-in attempts are limited to 5 per 15 minutes per IP. |
| **Access codes leak** | Only their hashes (PBKDF2) are stored on Netlify; `deploy` shows the codes once. |
| **A token leaks** | Notion and tool tokens live only in the operator's `.env` (or are their MCP connectors), never in Netlify, GitHub or a chat: `deploy` refuses to send them. Netlify builds from the committed mirror, without any token. |
| **Writing too widely in Notion** | The integration token is read-only and shared on the root page only; `connectors test notion` warns about any page visible outside the tree. Writes go through your Notion connector in Claude Code, only after your go-ahead. Inputs stay read-only: write scopes are reported, write-like MCP tools are refused. |
| **Personal or sensitive data copied into Notion** | Allow-listed scopes; personal data and secrets detected during collection are reported and never proposed for writing; no author names written into the base; `doctor` looks for secret patterns in `knowledge/` and `brain/`. Planned: `sensitivity: restricted` to keep a page out of the index. |
| **Prompt injection through content** | The chatbot has no action tool: the worst case is a wrong answer, not an action. Passages are framed as data. During updates, content is data and a human approves every write. Answers render no remote images and no links outside the cited sources; the site sends a strict Content-Security-Policy. |
| **Secrets committed** | `.env` is ignored and `doctor` checks it is not tracked; tokens are pasted by the user in `.env`, never in the conversation; never a token in a git remote URL. |
| **Runaway LLM bill** | Rate limit, per-user daily quota, monthly spending cap, at most 4 tool rounds and about 10,000 tokens of results per question. Maintenance runs on a Claude subscription, with no API bill. |
| **A wrong answer presented as certain** | One source without known contradictions, citations to the Notion page on every fact, `to_confirm` and `stale` shown, the exact passage behind each citation, a visible thumbs down, evals with thresholds. |

## Before going to production

Run `npm run openbrain -- doctor`: it checks most of this list for you.

- The instance repo is private.
- An auth mode is set: `google` for companies on Google Workspace, `passcode` otherwise. Leave the access code empty
  only if anyone holding the link may read the knowledge base.
- `SESSION_SECRET` and `ADMIN_TOKEN` are long random values.
- The Notion integration is shared on the root page only, with no extra capability you do not need.
- The input tokens are read-only.
- The monthly spending cap fits your budget.

## Reporting a vulnerability

Please report security issues privately, never in a public issue: `SECURITY.md` at the root of the repository gives the
contact, the response times and the supported versions. Until 1.0, only the latest release receives security fixes;
instances update with `openbrain upgrade`.
