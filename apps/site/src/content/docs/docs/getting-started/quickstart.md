---
title: Quickstart with the Acme demo
description: Run OpenBrain locally on the fictional Acme company in a few minutes, with no API key.
---

The repository ships with **Acme**, a fictional company with three products: **Acme Desk** (the client-facing helpdesk
app), **Acme Hub** and **Acme Billing** (internal tools) and **Acme Console** (the admin back-office). Its knowledge base
is a Notion mirror of **62 pages in 7 sections** (admin, internal tools, legal and security, people, product, sales,
support operations), with **40 eval questions, 11 of them in French**.

It is full of the traps real teams hit: the same word with two meanings depending on the tool (*user*, *account*,
*plan*, *SLA*), settings capped by a parent level, procedures spread over three pages, a price *to confirm*, a *stale*
page, warnings to apply, questions with no answer, and out-of-scope requests.

You need **Node 24 or newer** and git. No Notion account, no API key.

## 1. Clone and install

```bash
git clone https://github.com/arthczer-555/openbrain.git my-brain
cd my-brain && npm install
```

## 2. Start the demo chatbot

```bash
npm run demo                       # same as: npm run openbrain -- demo
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The demo serves the Acme brain with the **demo model**
(`demo:extractive`): not an LLM, but a deterministic stand-in that speaks the same tool protocol as a real model. It
searches, quotes the best passages with their citations, and flags the question when nothing matches. The whole chain
runs for real (agent loop, citations, flags, streaming, knowledge browser, admin page) without any key or cost.

Try these questions from the Acme eval set:

| Question | What to look for |
|---|---|
| How do I add a user in the internal tool? | Cites the *Acme Hub accounts* page, not the page about client users. The scope beats the keyword. |
| Why can't I enable live chat on a client group? | Opens the group page **and** the company page: the company caps what a group can use. |
| Walk me through setting up a newly signed client. | Several citations: the runbook, the screens, who does what. |
| What is the price of the Enterprise plan? | The price is marked *to confirm*, and the answer says so. |
| What is our parental leave top-up policy? | "Not documented yet", what was searched, and a flag in `/admin`. |
| Comment ajouter un utilisateur dans l'outil interne ? | Answer in French, citations to the English pages. |

## 3. Use a real model (optional)

Put a key for any provider in `.env` (the CLI loads it), then:

```bash
npm run openbrain -- demo --llm      # the demo with the model of the Acme config
npm run openbrain -- ask "Walk me through setting up a newly signed client." --root examples/acme --model anthropic:claude-opus-5-5
```

See [Models](/docs/models/) for every provider and how model references are written.

## 4. Search and evaluate without any LLM

The retrieval layer works on its own. It is what the chatbot calls through its `search_knowledge` tool:

```bash
npm run openbrain -- search "How do I add a user in the internal tool?" --root examples/acme --k 2
npm run openbrain -- eval --no-llm --root examples/acme
```

```text
[1] 5.896  internal-tools/accounts  (Acme Hub accounts: give a colleague access > Add a colleague)
    Acme Hub accounts: give a colleague access > Add a colleague Only a Hub admin can add an account. Go to
    **Settings** then **Team**, click **Add teammate** and enter the colleague's work email...
    warning: These are Acme Hub accounts only: access to Acme Billing is internal-tools/billing-overview.
    source: https://www.notion.so/acme/Acme-Hub-accounts-give-a-colleague-access-0be3250b872e5be3c22165f4e4d34c4b

[2] 5.702  internal-tools/accounts  (Acme Hub accounts: give a colleague access)
    ...

section rules (internal-tools):
  - A "user" or an "account" in Acme Hub is an Acme employee using the tool, never a client.
  - In Acme Billing, a "billing account" is the billing record of a client company; a colleague with access is a "member".
```

The question says *user*, and Acme also has a page about creating *client* users. The registry, the page warning and the
section rules route it to the right page anyway: on Acme, retrieval alone finds the expected pages for all 40 questions. That routing
is what you configure for your own company.

## Next

- [Your own instance](/docs/getting-started/your-own-instance/): `/setup` and `/init` in Claude Code, then deploy.
- [The lean brain](/docs/concepts/lean-brain/): what the agent actually reads per question.
