---
name: write
description: Add knowledge to the brain on request, between two weekly updates - a fact, a document, a correction, or a whole topic to gather from the connected tools (how the codebase works, the product, the sales playbook, the marketing guidelines, HR policies...). Claude reads the sources, checks them against Notion, proposes the pages to create or update, writes them in Notion after approval, then syncs the mirror, updates the registry and publishes. Use when the operator types /write or says "add this to the brain", "document X in the brain", "ajoute ça dans la base", "mets dans la base tout ce qu'on sait sur X".
---

# Add knowledge on request

Two kinds of request, same rules:

- **A fact, a document or a correction** given by the operator ("our support hours change to 8am-7pm").
- **A topic to gather** from the connected tools ("document how our codebase is organized", "write a sales
  playbook from HubSpot and our Claap calls", "gather our marketing guidelines from Drive and Slack").

## 1. Understand the request

What should the brain know at the end, for whom, and from which sources. Ask only what is missing (one short
question). For a topic, list the sources you will read and their scope before reading:

- the tools under `inputs:` in `openbrain.config.yaml` (`inputs.claude` through their MCP connectors, within their
  scope; the others through `npm run openbrain -- collect --only <id> --full --out .openbrain/write`);
- a tool the operator names that is not configured yet: read it only if its connector is available in this
  session, within the scope the operator gives, and propose to add it under `inputs.claude` afterwards;
- the codebase: read the code itself when the repository is on this machine (ask for its path), otherwise
  through the GitHub connector or the `github` input. Describe what people need to know (architecture, services,
  how to run, deploy and debug, conventions, where things live), never secrets or credentials.

## 2. Read and draft

Read the sources, keep only durable, verifiable facts (no transcript, no personal data, no author names), and
find where each fact belongs: `npm run openbrain -- search "<topic>"` on the mirror and the registry. Prefer
editing the page that covers the topic over creating a new one. A large topic becomes a few pages under the right
section (one topic per page, with headings), or a new section when none fits: say so.

## 3. Pre-write barrier (as in `/weekly`)

No duplicate, up to date, faithful to the source, no contradiction with any page (if it contradicts Notion, show
both versions and ask which one is right), language of the base, "Sources" block at the bottom of each page
(tool, link, date).

## 4. Show, then wait for the go

Show the plan: the pages to create or update, where, from which sources, contradictions first. Then the exact text
of each page. Large topics go in batches. Nothing is written without the go.

## 5. Write and publish

Write through the Notion MCP connector, only under the root page, then `npm run openbrain -- sync notion`, update
`brain/registry.yaml` for every new page or changed scope (when to open, aliases, warnings), `npm run openbrain --
guide build`, `npm run openbrain -- lint`, and add tests to `evals/golden.yaml` for the questions people will ask
about it. Check with `npm run openbrain -- ask "<one of those questions>"`. Commit and push. Say what was published
and what the chat page can now answer.
