---
name: write
description: Add or correct one piece of knowledge between two weekly updates - the operator gives a fact or a document, Claude checks it against Notion, writes it in the right Notion page after approval, then syncs the mirror, updates the registry and publishes. Use when the operator types /write or says "add this to the brain", "ajoute ça dans la base".
---

# One-off write

1. Understand what to add (a fact, a document, a correction) and its source. Ask for the source if missing.
2. Find where it belongs: `npm run openbrain -- search "<topic>"` on the mirror and the registry. Prefer
   editing the page that covers the topic over creating a new one.
3. Pre-write barrier (as in `/weekly`): no duplicate, up to date, faithful, no contradiction with any page
   (if it contradicts Notion, show both versions and ask which one is right), language of the base,
   "Sources" block.
4. Show the exact text you will write and where. Wait for the go.
5. Write through the Notion MCP connector, then `npm run openbrain -- sync notion`, update
   `brain/registry.yaml` if a page was created or its scope changed, `npm run openbrain -- guide build`,
   `npm run openbrain -- lint`, and a test in `evals/golden.yaml` when the fact answers a question people ask.
6. Commit and push. Say what was published.
