---
title: Flagged questions
description: The two signals the chatbot captures, no answer and thumbs down, and how the weekly update fixes them.
---

The chatbot captures **two signals, and only two**:

| Signal | Trigger | What the user does |
|---|---|---|
| **No answer** | The bot found nothing in Notion (or only part of the answer). It says so, says what it searched, and calls `report_gap`. | Nothing |
| **Thumbs down** | The user clicks thumbs down under an answer, with an optional comment. | One click |

A **thumbs up** is a counter, nothing more. There is no confidence score, no automatic judge, no log of every
question and no AI running in the background. The consequence is assumed: a wrong answer nobody flags is not caught.
The safeguards are elsewhere: a base without contradictions, citations to Notion on every fact, evals, and a thumbs
down that is visible and fast.

## What is stored

Flags go to **Netlify Blobs** (the key-value store included with every Netlify site), written after the answer is sent,
so they add no latency. No database.

```json
{
  "id": "r_8c21...",
  "type": "thumbs_down",
  "created_at": "2026-10-16T10:03:30Z",
  "question": "And in the internal tool?",
  "context": [{ "role": "user", "text": "How do I add a user?" }],
  "answer": "Import a CSV from Admin > Users [1]...",
  "citations": [{ "cite": 1, "page": "admin/users", "url": "https://www.notion.so/...", "heading_path": "Users > CSV import" }],
  "searches": [{ "query": "add user", "results": [{ "page": "admin/users", "score": 0.82 }, { "page": "internal-tools/accounts", "score": 0.61 }] }],
  "model": { "provider": "anthropic", "model": "claude-opus-5-5", "mode": "agent" },
  "deploy": { "commit": "4e1a9c0" },
  "comment": "That is for clients, not for us",
  "user": "hash:9a7e...",
  "status": "open"
}
```

- `searches` with scores tells whether the right page was in the results (here yes, second).
- `deploy.commit` tells which version of the mirror answered, so the update can reread the page as it was.
- `context` keeps only the two previous user messages, truncated.
- A *no answer* flag stores the question, the reason (`not_found`, `partial`, `contradiction`, `out_of_scope`), the
  queries tried and the top results.
- The user is a hash by default. Conversations nobody flagged are deleted after 24 hours, flags after processing
  (90 days at most).

When someone clicks thumbs down, the UI says it: *"Flagged. Your question and this answer will be reviewed at the next
weekly update."*, and offers an optional comment.

## How the weekly update fixes them

`weekly prepare` pulls the open flags from the deployed chatbot (with `OPENBRAIN_URL` and `ADMIN_TOKEN`, written to
your `.env` by `deploy`) and re-runs each search on the fresh mirror. Then Claude classifies each one:

| Diagnosis | Fix proposed (written after your go-ahead) |
|---|---|
| The page exists but was not found | An alias or a sharper `when_to_open` in the registry. One line fixes every question of the same kind. |
| A neighbor page was taken for the right one | A warning on the misleading page, or a section rule. |
| The information is missing from Notion | Look in the other tools; if a reliable source exists, a Notion page is proposed. Otherwise, a precise question for a human in the briefing. |
| The Notion page is wrong or outdated | The page is corrected **in Notion**. |
| Out of scope | Noted, possibly one line in `brain/core.md` (*"this topic is not covered, ask X"*). |
| The answer was right | Closed. |

Each fixed question then **becomes a test** in `evals/golden.yaml` (expected page, trap page, wrong statement never to
repeat), and `weekly finish` marks the flags done. Between two updates, the same list is one command away:

```bash
npm run openbrain -- reports                       # open flags, re-tested on your local mirror
npm run openbrain -- reports mark done <id> <id>   # close flags by hand
```

The [admin page](/docs/operate/admin/) shows the same list with filters and details.

## Where each memory lives

| What improves | Where |
|---|---|
| The knowledge | Notion |
| The routing (finding the right page) | `brain/registry.yaml` (git) |
| The agent's rules | `brain/core.md` (git) |
| Non-regression | `evals/golden.yaml` (git) |
| Flags waiting for the update | Netlify Blobs, until processed |
