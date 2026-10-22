---
title: openbrain.config.yaml
description: Every key of the instance configuration file.
---

`openbrain.config.yaml` sits at the root of your instance and is committed. `/setup` writes it (through `openbrain init`)
and keeps it updated as you answer its questions.
**Secrets never go in it**: keys and tokens come from the environment ([environment variables](/docs/reference/environment/)).
Unknown keys are kept, so the file can grow with new features.

```yaml
instance:
  name: "Acme"
  kb_language: en                # language your Notion is written in
notion:
  root_page: "<root-page-id>"    # the 32-character id at the end of the root page URL
chatbot:
  assistant_name: "Acme Brain"
  accent: "#F00050"
auth:
  mode: passcode                 # passcode | google | netlify
budgets:
  monthly_usd: 50
  questions_per_user_per_day: 100
models:
  chat: { provider: anthropic, model: claude-opus-5-5, effort: low }
  fallback:
    - { provider: anthropic, model: claude-sonnet-5-5, effort: low }
  # embeddings: { provider: voyage, model: voyage-4-lite, dimensions: 512 }
user_choice:
  enabled: false
  allowed: []
inputs:
  files: { enabled: true, paths: ["./docs-export"] }
```

The Acme example ships a complete, commented file: `examples/acme/openbrain.config.yaml`.

## Knowledge

| Key | Meaning |
|---|---|
| `instance.name` | Company name, used in the prompt and the UI. |
| `instance.kb_language` | Language your Notion is written in (`en`, `fr`...). Searches are written in it. |
| `notion.root_page` | Id of the root page. Only this tree is read. |

## Chatbot

| Key | Default | Meaning |
|---|---|---|
| `chatbot.assistant_name` | | Name shown in the UI. |
| `chatbot.accent` | `#F00050` | Accent color, `#RRGGBB`. |
| `chatbot.logo` | OpenBrain logo | Path or URL of the logo. |
| `chatbot.mode` | `auto` | `auto`, `agent`, or `retrieval_first` for models without tool calling. |
| `auth.mode` | `passcode` | `passcode`, `google` or `netlify`. `none` is refused outside local runs. |
| `auth.allowed_domains` | | `google` mode: email domains allowed to sign in (also `ALLOWED_EMAIL_DOMAINS`). |
| `auth.identified` | `false` | `true`: flagged questions keep the user's email instead of a hash. |
| `budgets.monthly_usd` | `50` | Monthly spending cap of the chat (estimate); `0` disables it. |
| `budgets.questions_per_user_per_day` | `100` | Per-user daily quota. |

## Models

| Key | Meaning |
|---|---|
| `models.chat` | `provider`, `model`, optional `effort` (`low`, `medium`, `high`), `base_url`, `api_key_env` (when the key is not in the provider's default variable), `max_output_tokens`. |
| `models.fallback` | Models with the same shape, tried in order when the chat model fails. |
| `models.embeddings` | Optional hybrid search: `{ provider, model, dimensions }`, plus `api_key_env` or `base_url` if needed. Voyage, OpenAI, Google, Mistral or an OpenAI-compatible endpoint. |
| `user_choice.enabled`, `user_choice.allowed` | Let users pick a model in the chat, among `"provider:model"` entries. Also editable from `/admin/models`. |
| `providers.openai_compatible` | Extra endpoints: `[{ name, base_url, api_key_env }]`, then usable as `provider: <name>`. |
| `pricing` | `"provider/model": { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok }` to override the built-in price table. |

See [Models](/docs/models/). The model of the eval judge is a flag of `openbrain eval` (`--judge provider:model`), not a
config key.

## Inputs

| Key | Meaning |
|---|---|
| `inputs.files` | `enabled`, `paths`, `include`, `exclude`, `max_file_mb`. |
| `inputs.web` | `enabled`, `sitemap`, `urls`, `include`, `exclude`, `max_pages`, `delay_ms`. |
| `inputs.github` | `enabled`, `repos`, `docs_globs`, `commits`, `pull_requests`, `branch`, `api_url`, `token_env`. |
| `inputs.gdrive` | `enabled`, `folders`, `mime`, `max_file_mb`, `max_sheet_rows`, `credentials_env`. |
| `inputs.mcp.<name>` | `enabled`, `transport` (`stdio` or `http`), `url` or `command` and `args`, `env`, `auth_env`, `headers`, `mapping`. |
| `inputs.api.<name>` | `enabled`, `base_url` (https), `auth` (`type`: `bearer`, `header`, `basic` or `query`; `env`; `name` for header and query), `headers`, `delay_ms`, `mapping`. |
| `inputs.claude.<name>` | `enabled`, `scope` (required, the allow-list in plain words), `connector` (name of the connector in Claude Code, default: the input name). Read by Claude during `/init` and `/weekly`, never by the CLI. |

Every input is read-only and allow-listed. See [Inputs overview](/docs/connectors/inputs/) and the `SETUP.md` of each
connector in `packages/connectors/src/`.
