---
title: Evals
description: Golden questions, what openbrain eval measures, its thresholds, and how flags become tests.
---

Without evals, "lean" means "cheaper and maybe worse". Every change to the registry, the prompt or the model is checked
on the same questions.

:::note[Status]
Implemented and tested. Retrieval evals run in CI without any LLM. Full runs need a provider key and are being validated
against real APIs.
:::

## Golden questions

`evals/golden.yaml` holds your reference questions: `/init` drafts a first set from your base plus your own, and `/weekly`
adds every question it fixes. Each trap becomes one:

```yaml
- id: scope-beats-keyword-01
  question: "How do I add a user in the internal tool?"
  lang: en
  expect:
    behavior: answer               # answer | not_documented | clarify | refuse
    must_cite: ["internal-tools/accounts"]
    must_not_cite: ["admin/users"]
    must_include: ["Add teammate"]
    must_not_include: ["CSV"]
  tags: [routing, trap]

- id: not-documented-01
  question: "What is our parental leave top-up policy?"
  lang: en
  expect:
    behavior: not_documented
  tags: [abstention, trap]
```

The Acme example ships **40 questions, 11 of them in French**, that cover the traps worth testing: the same word with two
meanings depending on the tool (*user*, *account*, *plan*, *SLA*), a setting capped by its parent level, procedures
spread over three pages, a price *to confirm*, a page marked *stale*, warnings to apply, questions with no answer in the
base, and out-of-scope requests. Retrieval alone finds the expected pages for all of them (recall@k 100% without any LLM).

## Running them

```bash
npm run openbrain -- eval --no-llm                                    # retrieval only, free
npm run openbrain -- eval                                             # full answers with the chat model of the config
npm run openbrain -- eval --model anthropic:claude-sonnet-5-5         # same questions, another model
npm run openbrain -- eval --matrix anthropic:claude-opus-5-5,mistral:<model>   # several models in one table
npm run openbrain -- eval --judge google:<model>                      # adds the LLM judge
npm run openbrain -- eval --effort medium --only scope-beats-keyword-01,not-documented-01
```

`--no-llm` is free and fast: run it after every registry change (the provided CI does). Each run is saved in
`.openbrain/evals/`, and `doctor` uses the latest runs to tell whether your chat model ever passed your evals.

## Metrics and thresholds

`eval` exits with an error when a measured metric is under its threshold.

| Metric | Definition | Threshold |
|---|---|---|
| Recall@k (pages) | The `must_cite` pages are among the retrieved pages | 90% |
| Correct abstention | `not_documented` expected: the answer says it is not documented, or the gap is reported | 100% |
| Language | The answer is entirely in the language of the question | 100% |
| Citation precision | Share of citations that support their sentence (judge) | 90% |
| Groundedness | Share of company statements supported by a cited passage (judge) | 95% |
| Tokens, cost, latency | Per question, from real usage | reported, no threshold |

Pick a judge from **another provider** than the chat model, to avoid self-grading. Evals with an LLM run only when you
ask: never in the background.

## Flags become tests

During the weekly update, each fixed flag is added to `evals/golden.yaml`, with the page that should have been cited,
the trap page, and the wrong statement in `must_not_include` so it never comes back. `weekly finish` re-runs the
retrieval check on the flagged questions.

## Planned

- `--bootstrap`: a first set of questions generated from your Notion at setup.
- A public ranking of models on the Acme set, updated at each release.
