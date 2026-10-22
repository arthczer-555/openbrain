---
title: The routing registry
description: brain/registry.yaml says when the agent should open each Notion page, never what the page contains.
---

`brain/registry.yaml` is the heart of the configuration. The mirror says *what* your company knows; the registry says
*when* each page is the right one. It is checked against the mirror at every build.

```yaml
version: 1
sections:
  admin:
    description: The back-office Acme staff use to set up client companies, groups and client users.
    rules:
      - 'A "user" here is a client end user, never a colleague: giving a colleague access is internal-tools/accounts.'
      - When the question is about what can be chosen on a group, also open the company settings (parent level).
docs:
  admin/users:
    when_to_open: Create, invite or import client end users in Acme Console. Not for giving a colleague access to Acme Hub.
    aliases: ["add a user", "create user", "import users", "ajouter un utilisateur"]
    warnings:
      - A user here is a client's agent or supervisor, never an Acme employee.
    status: validated
```

## Fields

| Key | Required | Default | Meaning |
|---|---|---|---|
| `version` | no | `1` | Format version. |
| `sections.<id>.description` | yes | | One line, shown in the section map of every prompt. |
| `sections.<id>.rules` | no | `[]` | Up to 10 short routing rules, sent only when a search result falls in that section. |
| `docs.<page id>.when_to_open` | yes | | When to open the page, 220 characters at most, no dates. |
| `docs.<page id>.aliases` | no | `[]` | Extra search terms. |
| `docs.<page id>.warnings` | no | `[]` | Binding notes returned with the page's passages. |
| `docs.<page id>.status` | no | `validated` | `validated`, `to_confirm` or `stale`. |

The page id is the path of the page in the mirror, without `.md` (`admin/users`). Pages that only hold headings and
links (most section pages) need no entry.

## How to write each field

| Field | Write | Avoid |
|---|---|---|
| `when_to_open` | The situation or question that should open the page. Add *"Not for X"* to separate look-alikes. | Content, dates (error), figures (warning). A copy of a fact goes stale silently. |
| `aliases` | The words your colleagues actually type: synonyms, jargon, other languages. A French question then finds an English page. | Repeating the title. |
| `warnings` | False friends and scope precisions (*"a user here is a client, not a colleague"*). The assistant must apply them. | General advice that belongs in `brain/core.md`. |
| `status` | `to_confirm` makes the assistant say the information is not confirmed yet; `stale` marks a page a human must review. | |
| section `description` | One line on what the section covers. It is in every prompt. | Long lists. |
| section `rules` | Short routing rules: scope, parent level, which page is the reference. | Facts. |

## Why "when", never "what"

A registry that copies content ("retention is 12 months") goes stale the day the Notion page changes, and nothing
tells you. A registry that says *when* to open the page ("how long client data is kept") stays true. The lint enforces
it: a date in `when_to_open` is an error, a figure is a warning (names such as ISO 27001 contain figures).

## Warnings travel with the data

Warnings and section rules are **not** in the fixed prompt. They are returned by `search_knowledge` together with the
passages of the page or section they belong to, once per conversation. You only pay for a warning when the page it
protects is actually used. See [the lean brain](/docs/concepts/lean-brain/).

## Checked at every build

`openbrain guide build` merges the mirror and the registry, generates `brain/catalog.md` (the section map) and
`brain/registry.json`, and checks the prompt budgets. `openbrain guide check` fails when:

- a page of the mirror has no registry entry (`missing-registry-entry`);
- an entry no longer matches a page, because it was renamed, moved or deleted in Notion (`orphan-registry-entry`);
- a section has no description, or an entry points to a missing section;
- the generated files are out of date, or a budget is exceeded.

Run it in CI and in the Netlify build: the registry cannot drift from Notion without the build saying so.

## Who writes it

Claude writes it: `/setup` and `/init` draft the registry from your Notion pages, and `/weekly` keeps it up to date
(new pages, aliases from the questions people really ask, warnings from the thumbs down). You review every change at the
go-ahead. After each sync, `sync notion` lists the pages that still need an entry, and `guide check` makes sure none is
forgotten.

Planned: `sensitivity: restricted` on a page, to keep it out of the chatbot's index.
