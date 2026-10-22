# Input: any REST API (`api:<name>`)

The generic REST adapter reads any HTTP API that answers JSON (a CRM, a help desk, a ticketing tool, an
internal service...) through a small YAML **mapping**: which endpoint to call, where the items are in the
response, and how an item becomes a document or a stream event. No code to write. It is the same mapping
format as the [MCP adapter](../mcp/SETUP.md), with an endpoint instead of a tool.

Use it when the tool has no MCP server, or when you prefer a plain API key to running a server.

**Read-only by construction**: the adapter only sends `GET` requests (any other method is refused in code),
and only to the host of `base_url`, so the key never travels anywhere else.

## 1. Get a read-only key

Create an API key or token in the tool, with **read-only** permissions when the tool offers them (the
adapter never writes, but a read-only key is the real guarantee). Paste it yourself in the `.env` file at
the root of the instance, never in a chat, an issue or a commit:

```bash
ACME_CRM_TOKEN=...
```

## 2. Declare the API in `openbrain.config.yaml`

```yaml
inputs:
  api:
    crm:                                    # becomes the connector id "api:crm"
      enabled: true
      base_url: "https://api.crm.acme.example/v2"   # https only (plain http for localhost)
      auth: { type: bearer, env: ACME_CRM_TOKEN }
      headers: { Accept: application/json }         # optional, values may use ${NAME} from .env
      delay_ms: 200                                 # pause between two requests
      mapping: ./connectors/crm.mapping.yaml
```

| `auth.type` | Sends | Typical tools |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <token>` | Most modern APIs (HubSpot private apps, Intercom, Linear, Notion...) |
| `header` | `<name>: <token>`, with `auth.name: X-Api-Key` | APIs with a custom key header |
| `basic` | `Authorization: Basic ...`, the variable holds `user:password` (or `email:token`) | Jira / Confluence Cloud, Zendesk, Freshdesk |
| `query` | `?<name>=<token>`, with `auth.name: api_key` | Older APIs. Avoid when the tool offers a header: URLs end up in proxy logs. |

Omit `auth` for a public API.

## 3. Write the mapping

`examples/acme/connectors/crm.mapping.yaml` is a complete example. The format:

```yaml
kind: stream                 # stream (events, distilled) or documents (mirrored content)
list:
  path: /deals               # relative to base_url, or an absolute URL on the same host
  query: { updated_since: "{{since_date}}", limit: 100 }
  items: "$.results[*]"      # where the items are in the response
  paginate: { cursor_param: after, next: "$.paging.next.after", max_pages: 20 }
# documents only, when list items do not carry the content:
# fetch: { path: "/articles/{{id}}", text: "$.article.body" }
map:
  id: "$.id"
  title: "{{$.properties.name}}"
  url: "https://crm.acme.example/deals/{{$.id}}"
  modifiedAt: "$.updatedAt"
  author: "$.owner.name"     # stream only, never written to the knowledge base
  text: "Deal {{$.properties.name}} moved to {{$.properties.stage}}"
event_kind: deal_change      # message, thread, deal_change, note, meeting, commit or ticket
```

**Pagination**, pick the mode the API uses:

| Mode | Mapping | The adapter... |
|---|---|---|
| Cursor | `cursor_param: after`, `next: "$.paging.next.after"` | sets `?after=<value at next>` until it is empty |
| Next page URL | `next_url: "$.links.next"` | follows that URL (same host only) until it is empty |
| Page number | `page_param: page` (`start: 1` by default) | increments `?page=` until a page has no item |
| Offset | `offset_param: offset` (`start: 0` by default) | adds the number of items received until a page has no item |

`max_pages` (default 20) caps every mode.

**Variables**: `{{since}}` and `{{until}}` are the collection window as ISO dates, `{{since_date}}` /
`{{until_date}}` as `YYYY-MM-DD`, `{{since_unix}}` / `{{until_unix}}` in seconds. A query parameter made
only of a variable without a value (no `since` on a full collection) is omitted. In `fetch.path` and
`fetch.query`, `{{id}}`, `{{url}}` and `{{title}}` are the listed item's (URL-encoded in the path).

The values of `map` work as in the MCP adapter: a value starting with `$` is a JSONPath, anything else is a
template where `{{$.path}}` is replaced. Supported JSONPath: `$`, `.key`, `['key']`, `[*]`, `[n]`.

To find the endpoints and the shape of their responses, open the tool's API reference, or ask Claude in
`/setup`: it reads the reference, calls the list endpoint once with your key and proposes the mapping.

## 4. Test

```bash
npm run openbrain -- connectors test crm      # or api:crm
```

You should see `REST API <host>`, the endpoint, the auth type and three sample items. Errors never show
the key.

## 5. Collect

```bash
npm run openbrain -- collect --only api:crm --dry-run
npm run openbrain -- collect --only api:crm
```

Documents are collected when `modifiedAt` is after the start of the window, stream events when their date
is inside it. Use `--full` during the initialization.
