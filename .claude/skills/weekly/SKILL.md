---
name: weekly
description: Run the weekly update of this OpenBrain instance (alias /hebdo). Prepares the week with the CLI, reads what changed in the company tools, consolidates the durable facts into Notion after the operator's approval, diagnoses the questions the chatbot could not answer, updates the routing registry, regenerates the guide and publishes. Use when the operator types /weekly or /hebdo, or asks for "the weekly update", "la MAJ hebdo", "update the brain".
---

# Weekly update

You run the weekly maintenance of this OpenBrain instance, in the operator's terminal, on their Claude
subscription. The CLI does the mechanical work (no LLM); you do the judgment; the operator approves before
anything is written. Notion is the single source of truth: you write there, never in `knowledge/` (it is a
generated mirror).

Arguments: an optional window ("since October 1st"), or `--resume` to continue an interrupted run.

## 0. Ground rules (never break them)

- Nothing is written to Notion, to `brain/registry.yaml` or pushed before the operator's explicit go.
- Zero invention: every fact you propose comes from a source you read, with its link and date. Unconfirmed
  means "to confirm".
- A contradiction (Notion vs a source, or two sources) is never written: it goes to the top of the briefing
  with both values, their sources and dates, and waits for a decision (`state/pending.json` keeps it).
- Only durable, verifiable facts. Never a meeting summary copied, never personal or HR data, never a
  negotiation in progress, never an author's name ("what changed", not "who changed it").
- Write in the language of the base (`instance.kb_language` in `openbrain.config.yaml`), even if the source
  is in another language.

## 1. Prepare (CLI, a few minutes)

```bash
npm run openbrain -- weekly prepare            # add --since 2026-10-01 for a forced window
```

It syncs the Notion mirror (NOTION_TOKEN in `.env`), collects the inputs that have a token into
`.openbrain/weekly/<date>/inputs/`, pulls the chatbot's flagged questions (OPENBRAIN_URL + ADMIN_TOKEN) and
re-tests them on the fresh mirror, lists pending decisions and pages missing from the registry, and writes
the work packet `.openbrain/weekly/<date>/packet.md`. If it reports a missing token, continue with what is
available and say so in the briefing. With `--resume`, read `.openbrain/weekly/<date>/progress.json` and
continue from the recorded step.

## 2. Read and sort (you)

1. Read `packet.md` first: it lists the files to open and their estimated size. Read inputs one tool at a
   time; open long transcripts or threads only when their metadata shows the topic matters.
2. For each tool under "Read through your MCP connectors" in the packet (`inputs.claude` in the config),
   query its MCP connector directly on the window, within its scope only. Read no other tool unless the
   operator asks.
3. Sort (rules of the update):
   - group by topic, not by tool (one event seen in Slack + a meeting + the CRM is one topic);
   - prioritize decisions, status changes, new processes, figures, product releases over discussions;
   - read the end of the story (the conclusion of a thread is in its replies);
   - for each topic, read the Notion page concerned and classify: `new`, `update`, `already up to date`,
     `contradiction`;
   - holes: "something important happened but I do not have the document" becomes a precise question.
4. Flagged questions (packet section "Reports"): for each, compare what was searched and cited with the
   mirror today, and classify:
   - the page exists but was not found: propose aliases or a better `when_to_open` in `brain/registry.yaml`;
   - a neighboring page was taken for the right one: propose a warning on the misleading page, or a section rule;
   - the information is missing from Notion: look for it in the inputs; if a reliable source exists, propose
     a Notion page; otherwise a precise question for a human;
   - the Notion page is wrong or outdated: propose the correction in Notion;
   - out of scope: note it, maybe one line in `brain/core.md`;
   - the answer was right: close it without action.
   Each question fixed becomes a test in `evals/golden.yaml` (expected page, trap page, wrong claim to never
   repeat).

## 3. Briefing (in the terminal), then wait

Use exactly this order and save it to `.openbrain/weekly/<date>/briefing.md`:

```markdown
## Needs you (10 lines max)
- contradictions to settle (Notion value, source value, which one?)
- holes (precise questions)
- decisions pending since earlier weeks

## What happened (by topic)

## Proposed Notion writes (numbered, approvable one by one)
| # | Notion page | What the page will say | Why | Source |

## Registry
| Page | Change (aliases, when to open, warning, status) | Why |

## Flagged questions this week
| Type (no answer / thumbs down) | Question | Diagnosis | Proposed fix |

## Quality
Search re-test: x/y.

<details><summary>Run log</summary>Window, tools read (including those with 0), volumes, what was skipped and why.</details>
```

One line must make sense alone. Business language in sentences, identifiers only in the Source column.
Then stop and wait. The approval can be fine-grained: "ok except 3 and 5", "fix 2: ...", "for contradiction
1, it is 30 days". Never treat silence as approval.

## 4. Write (after the go only)

1. Pre-write barrier, for each approved write: no duplicate (edit the page that covers the topic, do not
   create a second one); up to date (if the write makes another page wrong, fix it in the same batch);
   faithful to the source; no contradiction; language of the base; provenance block "Sources" at the bottom
   of the page (tool, link, date).
2. Write in Notion through the Notion MCP connector, only under the root page of the config. If the base has
   an "Update log" page, add a line to it; if it has a "Recent changes" page, add the week's entries (60 days
   rolling). Propose to create them on the first update, never without the go.
3. `npm run openbrain -- sync notion` so the mirror gets the new pages.
4. Update `brain/registry.yaml`: an entry for every new page (when to open, aliases EN + the base's
   other language, warnings only for false friends), the approved routing fixes, statuses.
5. Add the new tests to `evals/golden.yaml`.
6. `npm run openbrain -- weekly finish --reports <ids of the reports handled>`: regenerates the guide,
   lints, re-tests the search on the flagged questions and the evals, marks the reports done on the chatbot,
   records the window in `state/sync.json`. Fix anything it reports before publishing.
7. Publish: commit with the briefing as message, then push (or open a PR when `weekly.publish: pr`).
   Netlify redeploys in one to two minutes. Tell the operator what was published and what is still pending.
