# Input: any MCP server (`mcp:<name>`)

The generic adapter plugs any MCP server (Linear, Jira, a CRM, an internal tool...) into the collection
through a small YAML **mapping**: which read tool to call, where the items are in its result, and how
an item becomes a document or a stream event. No code to write.

If the server is already connected to Claude Code (a claude.ai connector or `claude mcp add`), the simplest
is to declare it under `inputs.claude` and let Claude read it during `/init` and `/weekly` (see the README,
"Connect your tools"). This adapter is for the CLI collection: reproducible, and without using your Claude
subscription. For a tool that has an HTTP API but no MCP server, use the [REST adapter](../api/SETUP.md).

## 1. Get a read-only access

- **Remote server (Streamable HTTP)**: create an API key or token with read-only permissions in the tool,
  and paste it in the `.env` file at the root of the instance, for example `ACME_TRACKER_TOKEN=...`.
  It is sent as `Authorization: Bearer <token>`.
- **Local server (stdio)**: the server runs as a command (often `npx <package>`). Its own credentials go
  in `.env` too, and are passed to it with `${NAME}` references.

Prefer read-only keys whenever the tool offers them: the adapter only calls read tools, but a read-only
key is the real guarantee.

## 2. Declare the server in `openbrain.config.yaml`

```yaml
inputs:
  mcp:
    tracker:                                   # becomes the connector id "mcp:tracker"
      enabled: true
      transport: http
      url: "https://tracker.acme.example/mcp"
      auth_env: ACME_TRACKER_TOKEN
      mapping: ./connectors/tracker.mapping.yaml
    wiki:
      enabled: true
      transport: stdio
      command: npx
      args: ["-y", "@acme/wiki-mcp"]
      env: { WIKI_API_KEY: "${ACME_WIKI_KEY}" }   # read from the environment / .env
      mapping: ./connectors/wiki.mapping.yaml
```

## 3. Write the mapping

`examples/acme/connectors/tracker.mapping.yaml` is a complete example. The format:

```yaml
kind: stream                 # stream (events, distilled) or documents (mirrored content)
list:
  tool: list_issues          # a read tool of the server
  args: { updatedAfter: "{{since}}", limit: 50 }
  items: "$.issues[*]"       # where the items are in the tool result
  paginate: { cursor_arg: after, next: "$.pageInfo.endCursor", max_pages: 20 }
# documents only, when list items do not carry the content:
# fetch: { tool: get_document, args: { id: "{{id}}" }, text: "$.document.body" }
map:
  id: "$.identifier"
  title: "{{$.identifier}}: {{$.title}}"
  url: "$.url"
  modifiedAt: "$.updatedAt"
  author: "$.assignee.name"  # stream only, never written to the knowledge base
  text: "{{$.description}}\n\nStatus: {{$.state.name}}"
event_kind: ticket           # message, thread, deal_change, note, meeting, commit or ticket
```

- `{{since}}` and `{{until}}` are the collection window (ISO dates), also available as `{{since_date}}` /
  `{{until_date}}` (`YYYY-MM-DD`) and `{{since_unix}}` / `{{until_unix}}` (seconds); `{{id}}`, `{{url}}`,
  `{{title}}` are available in `fetch.args`. An argument made only of a variable without a value is omitted.
- A value starting with `$` is a JSONPath; anything else is a template where `{{$.path}}` is replaced.
  Supported JSONPath: `$`, `.key`, `['key']`, `[*]`, `[n]` (negative from the end).
- A tool result is read from its structured content, else its text parsed as JSON, else `{ "text": ... }`.

To find the tool names and the shape of their results, run `connectors test` with a first guess (it
lists the server's tools), or ask Claude in `/setup` to propose the mapping: it lists the tools, calls a read
tool once and drafts the YAML for you to approve.

## 4. Read-only guard

The adapter refuses, before any call, a mapped tool that looks like a write:

- a word of its name is a write verb (`create`, `update`, `delete`, `remove`, `send`, `post`, `write`,
  `insert`, `upsert`, `archive`, `move`, `edit`, `set`, `add`...): `create_issue`, `setStatus`;
- its description starts with, or applies, such a verb ("Creates a new issue", "Use this tool to send");
- it is annotated `destructiveHint: true` or `readOnlyHint: false`.

## 5. Test

```bash
npm run openbrain -- connectors test tracker      # or mcp:tracker
```

You should see the server name and version, the number of tools, the write-like tools present on the
server (never called, but they raise the write warning: prefer a read-only key), and three sample items.

## 6. Collect

```bash
npm run openbrain -- collect --only mcp:tracker
```
