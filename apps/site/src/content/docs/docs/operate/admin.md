---
title: Admin page
description: "Two tabs, on purpose: the flagged questions and the models."
---

:::note[Status]
Implemented and covered by an end-to-end test in a headless browser. Being validated on real deployments.
:::

`/admin` is deliberately minimal. No statistics cards, no spending dashboard, no automatic clustering: the work on flags
happens during the [weekly update](/docs/concepts/weekly-update/), and the guardrails on cost run on the server.

## Who can open it

| Sign-in mode | Admins |
|---|---|
| `google` | The emails listed in `ADMIN_EMAILS`. |
| `passcode` (with or without access code), `netlify` | Anyone who enters the admin code (`ADMIN_CODE_HASH`), shown once by `deploy`. |
| Weekly update from the terminal | The `ADMIN_TOKEN` bearer token in your local `.env`. |

## Flagged questions

- A status line at the top gives the date of the last weekly update (*"last update 9 days ago"*): it is the reminder
  that the update is manual.
- One list, most recent first: type (*No answer* or *Thumbs down*), question, date, comment, cited pages.
- Filters by type and by status (open, handled).
- Each flag opens its details: the answer, the citations, the searches with their scores, the model and the version of
  the mirror that answered.
- *Mark handled* closes a flag, *Reopen* brings it back. The weekly update marks the flags it fixed.

From the terminal:

```bash
npm run openbrain -- reports                       # open flags, re-tested on your local mirror
npm run openbrain -- reports mark done <id> <id>
```

## Models

- **Chat model and fallbacks**, chosen among the models available with the keys set on Netlify. A change takes effect
  immediately, without redeploying: it is stored in Netlify Blobs and overrides `openbrain.config.yaml`.
- **Test on 5 questions**: before switching, the candidate model answers five of your own eval questions, so you see
  its answers, tokens and cost side by side.
- **User choice**: allow employees to pick a model in the chat, among the models you tick.

See [Models](/docs/models/).

## Knowledge browser

Every signed-in user can browse the knowledge at `/kb` (*Browse knowledge* in the chat): the sections and their pages,
with their status (validated, to confirm, may be outdated) and a link to the Notion original. It is rebuilt from the
index, so it shows exactly what the chatbot can see.

## The API behind it

| Route | Role |
|---|---|
| `GET /api/admin/reports` | List the flags (admin session or `ADMIN_TOKEN`). |
| `POST /api/admin/reports/mark` | Mark flags handled or open again. |
| `GET` / `POST /api/admin/models` | Read and set the chat model, the fallbacks and the user choice. |
| `POST /api/admin/models/test` | Test a model on five eval questions. |
