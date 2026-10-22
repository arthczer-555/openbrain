---
title: Write your own input
description: The Connector interface, the files of a connector, and the quality bar to merge it upstream.
---

Before writing code, check whether the tool has an **MCP server**: the [generic MCP adapter](/docs/connectors/inputs/#the-generic-mcp-adapter)
covers it with a mapping file and no code. Write a dedicated input when you need a stable, tested connector for a tool
many teams use.

## The interface

Simplified from `packages/core/src/connector.ts`, which is the reference:

```ts
export type ConnectorKind = "documents" | "stream";

export interface SourceRef {
  id: string;              // stable on the source side (file id, channel:ts, deal id...)
  url?: string;            // link to the original, written as provenance in Notion
  title: string;
  modifiedAt: string;      // ISO date, used for incremental collection
  path?: string[];         // source tree, helps propose where it goes in Notion
}

export interface SourceDocument extends SourceRef {
  markdown: string;        // normalized content
  mimeType?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface StreamEvent {
  ref: SourceRef;
  kind: "message" | "thread" | "deal_change" | "note" | "meeting" | "commit" | "ticket";
  occurredAt: string;
  author?: string;         // never written into Notion
  text: string;
}

export interface HealthReport {
  ok: boolean;
  identity?: string;            // "bot @openbrain in workspace X"
  scopes: string[];             // scopes actually granted
  writeScopesDetected: boolean; // an input must be read-only
  sample?: SourceRef[];         // 3 visible items, to check the scope
  error?: string;
}

export interface Connector {
  id: string;                                                                   // "gdrive", "mcp:linear"...
  kind: ConnectorKind;
  test(): Promise<HealthReport>;
  list?(opts: { since?: string; cursor?: string }): AsyncIterable<SourceRef>;   // documents
  fetch?(ref: SourceRef): Promise<SourceDocument>;                              // documents
  changes?(opts: { since: string; until: string }): AsyncIterable<StreamEvent>; // streams
}
```

A **documents** input implements `list` and `fetch`; a **stream** input implements `changes`. Both implement `test`.

## Files of a connector

```text
packages/connectors/src/<id>/
  index.ts          the Connector implementation
  manifest.ts       kind, transport, environment variables, minimal scopes, default scope, rate limits
  SETUP.md          step by step: how to get a read-only token, what to share, the config block
packages/connectors/test/
  fixtures/         recorded API responses
  inputs/           tests on the fixtures, no network
```

`SETUP.md` is the single source for the setup instructions: `connectors list` points to it, and the `/setup` skill
reads it. Export it from `packages/connectors/src/index.ts`, and declare its config schema and factory in
`packages/connectors/src/shared/inputs.ts`, so `connectors`, `collect` and the weekly update see it.

## Rules

- **Read-only, proven.** No request other than GET, except authentication and search endpoints explicitly listed. A
  contract test fails otherwise.
- **Least privilege.** The manifest lists the minimal scopes; `test()` reports any write scope.
- **Allow-lists.** The default scope is narrow and explicit (folders, channels, repos), never "everything".
- **Incremental.** Use `since` and `modifiedAt` so a weekly run only reads what changed.
- **Polite.** Respect rate limits, back off on 429.
- **Clean Markdown.** Conversion to Markdown is tested on fixtures.
- **No personal data in the output** beyond what the content needs; authors are never written into Notion.

## Merging upstream

A new input is merged when it has fixtures and tests, proven read-only behavior, 429 handling, incremental
collection, tested Markdown conversion, and a `SETUP.md` checked by someone who did not write it. Use the
`connector-request` label on GitHub to vote for the next connectors (Slack is next).
