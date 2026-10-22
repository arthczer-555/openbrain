---
title: Weekly update
description: Once a week, /weekly in Claude Code reads what changed, reviews the flags, and updates Notion after your go-ahead.
---

:::note[Status]
The `/weekly` skill and the `weekly prepare` and `weekly finish` commands are implemented and tested. Full runs on real
company tools are being validated.
:::

Once a week, the operator opens the instance repo in Claude Code and types `/weekly` (or `/hebdo`). Or, from the
terminal:

```bash
npm run openbrain -- weekly        # opens Claude Code on /weekly
```

It runs on the operator's **Claude subscription**: no API bill for maintenance. It takes 15 to 30 minutes, about ten of
which are reading the briefing and approving. Nothing runs on its own: the chatbot only records flags, and Netlify only
rebuilds on push.

## The CLI does the mechanics, Claude does the judgment

### A. Prepare (CLI, no LLM)

```bash
npm run openbrain -- weekly prepare [--since <iso>] [--no-sync] [--no-collect] [--no-reports]
```

The skill runs it first:

1. **Window**: since the last update (`state/sync.json`), 7 days if unknown. `--since` forces it (*"/weekly since
   October 1st"*). After 5 weeks without an update, the backlog is processed one week at a time.
2. **Mirror sync** from Notion, including pages your team edited by hand during the week.
3. **Inputs** that have a token are collected (`collect`) into `.openbrain/weekly/<date>/inputs/`, ignored by git.
4. **Flags** from the deployed chatbot (needs `OPENBRAIN_URL` and `ADMIN_TOKEN`), each one re-tested on the fresh
   mirror: does the right page come up now?
5. **Pending decisions** from previous weeks (`state/pending.json`) and pages still missing from the registry.
6. **A work packet**: `.openbrain/weekly/<date>/packet.md`, with what moved, figures, and the files to read.

### B. Analyze (Claude Code)

7. Claude reads the packet, and queries your **MCP connectors** directly for tools without a token (Slack, for
   example).
8. **Sorts** by topic, not by tool. Decisions, status changes, new processes, figures and releases first. Reads the end
   of each thread. Only what is durable and verifiable goes into Notion: never a meeting transcript, never personal
   data, never an author's name.
9. **Checks against Notion**: each topic is *new*, *update*, *already up to date* or *conflict*. Conflicts are isolated
   for the briefing and never proposed for writing.
10. **Diagnoses each flag** (see [flagged questions](/docs/concepts/flagged-questions/)).
11. **Writes the briefing** and waits for your go-ahead.

### C. Write and publish (after the go-ahead)

12. Writes the approved pages into **Notion** through your Notion MCP connector (pre-write check, *Sources* block),
    re-syncs the mirror, updates `brain/registry.yaml`, and adds each fixed question to `evals/golden.yaml`.
13. Runs the closing command:

    ```bash
    npm run openbrain -- weekly finish [--reports all|<id,id>]
    ```

    It rebuilds the guide, lints, re-tests the flagged questions, marks the fixed reports done on the chatbot, and
    records the update in `state/sync.json` (`last_weekly`).
14. Commits with the briefing as message and pushes. Netlify redeploys in a minute or two.

## The briefing

Order matters: an unreadable briefing ends up approved without being read.

```text
Needs you (10 lines max)
  1. The Drive pricing deck says $49, Notion says $45. Which goes into Notion?
  2. A deal moved to won, but nothing describes the scope. Who has it?

What happened (by topic)

Notion updates proposed (numbered, approvable one by one)
  | # | Notion page | What the page will say | Why | Source |

Registry changes
Flags of the week
Quality: search re-test 7/8
Run log (window, tools read, volumes, what was skipped and why)
```

The go-ahead can be precise: *"ok except 2"*, *"fix 3: ..."*, *"for conflict 1, it is 30 days"*. An unsettled conflict
is not written; it stays in `state/pending.json` and comes back at the top of the next briefing.

## Between two updates

- `/write` adds knowledge on request, with the same checks, then syncs and publishes: a single fact, a document, or a
  whole topic gathered from your connected tools ("document how our codebase is organized", "build a sales playbook
  from HubSpot and our call recordings", "gather our marketing guidelines from Drive and Slack").
- `npm run openbrain -- reports` lists what the chatbot flagged since the last update.

## Not forgetting it

The update is manual, so:

- the admin page shows *"last update 9 days ago"*, and `doctor` warns when no update was recorded;
- the provided `.github/workflows/reminder.yml` (no LLM, no key) opens an issue when no update ran for 8 days;
- after several missed weeks, the window widens and is processed in slices.

## Usage limits of the subscription

The CLI pre-filters and sizes the volume before Claude reads anything, long threads and transcripts are only opened when
their metadata shows the topic matters, and an interrupted run continues with `/weekly --resume`.

## Claude Code is required

The sorting, the conflicts and the briefing are judgment work: the weekly update runs in Claude Code, on a subscription
or with an API key. The CLI commands it calls (`weekly prepare`, `weekly finish`) only do the mechanical part. See
[why Claude Code is required](/docs/getting-started/claude-code/).
