---
title: Models
description: Any provider, any model, a fallback chain, switched live from the admin page and compared on your own questions.
---

OpenBrain is provider-agnostic. Claude is the template's default, not a dependency: the chat model, its fallbacks and the
optional embeddings model come from any provider, are set in `openbrain.config.yaml`, and the chat model can be switched
live from the [admin page](/docs/operate/admin/).

:::note[Status]
Implemented on the Vercel AI SDK and covered by tests, including a wire-level test of the conversation history. Runs
against each provider's real API are being validated.
:::

## Model references

A model is written `provider:model`, for example `anthropic:claude-opus-5-5`, `mistral:<model>` or `ollama:<model>`.
The same form is used by the CLI flags (`--model`, `--matrix`, `--judge`), the admin page and `user_choice.allowed`.

## Chat model and fallbacks

```yaml
# openbrain.config.yaml
models:
  chat: { provider: anthropic, model: claude-opus-5-5, effort: low }
  fallback:
    - { provider: anthropic, model: claude-sonnet-5-5, effort: low }
    - { provider: openrouter, model: "<any>" }
```

Model fields: `provider`, `model`, `effort` (`low`, `medium`, `high`; translated for each provider, ignored when the
model has no such setting), `base_url` (Ollama, vLLM, proxies), `api_key_env` (when the key is not in the provider's
default variable), `max_output_tokens`. The fallbacks are tried in order when the chat model fails (server errors,
persistent rate limits, refusals); a fallback without its key is skipped.

The setup and the weekly update do not use these models: they run in Claude Code, see
[why Claude Code is required](/docs/getting-started/claude-code/).

## Providers

| Provider | `provider` id | Key (environment) | Adapter |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | native, explicit prompt caching |
| OpenAI | `openai` | `OPENAI_API_KEY` | native |
| Google | `google` | `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`, `GEMINI_API_KEY`) | native |
| Mistral | `mistral` | `MISTRAL_API_KEY` | native |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | OpenAI-compatible; one key, hundreds of models, through a third party |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | OpenAI-compatible |
| Groq | `groq` | `GROQ_API_KEY` | OpenAI-compatible |
| xAI | `xai` | `XAI_API_KEY` | OpenAI-compatible |
| Ollama | `ollama` | none | OpenAI-compatible, `http://localhost:11434/v1`, local only (see below) |
| Any OpenAI-compatible endpoint | your name | `api_key_env` | vLLM, an internal proxy, the OpenAI-compatible endpoints of Azure, Bedrock or Vertex |
| Demo | `demo` | none | `demo:extractive`, no LLM (see below) |
| Claude Code | `claude-code` | none: your Claude subscription | `claude-code:sonnet`, local tests only (see below) |

```yaml
providers:
  openai_compatible:
    - { name: internal-llm, base_url: "https://llm.acme.example/v1", api_key_env: ACME_LLM_KEY }
models:
  chat: { provider: internal-llm, model: "<model>" }
```

## Every model of each provider

```bash
npm run openbrain -- models list          # models reachable with your keys, with context, capabilities and prices
npm run openbrain -- models list --all    # every model of the catalog
npm run openbrain -- models refresh       # refresh the capability and price catalog
```

The list merges what each provider says your key can use (so only working models are offered), a catalog of
capabilities and prices, and your overrides. A model released yesterday is usable as soon as its provider lists it.
When a price is missing or negotiated, override it:

```yaml
pricing:
  "internal-llm/<model>": { input_per_mtok: 0, output_per_mtok: 0 }
```

## Switching live from the admin page

The *Models* tab of `/admin` lists the models available with the keys set on Netlify. You can:

- **change the chat model and its fallbacks** without redeploying (stored in Netlify Blobs, it overrides the config,
  which stays the default and the trace in git);
- **Test on 5 questions**: the candidate answers five of your own eval questions before you switch;
- **let people pick a model** in the chat, among the models you allow:

```yaml
user_choice:
  enabled: true
  allowed: ["anthropic:claude-sonnet-5-5", "mistral:<model>"]
```

## Agent mode and retrieval-first mode

| | Agent mode (default with tool-capable models) | Retrieval-first mode |
|---|---|---|
| Who searches | The model, through `search_knowledge` and `read_document` | The server, before the call |
| LLM calls per question | 2 to 4 | 1 |
| No answer | `report_gap` tool | Detected in the answer |
| Best for | Multi-step questions | Small local models, very high volumes |

The default, `chatbot.mode: auto`, picks the mode from the model's capabilities; `agent` or `retrieval_first` forces it.
`ask --mode` does the same for one question.

## The demo model

`demo:extractive` needs no key and costs nothing. It is deterministic: it searches with the question, answers by quoting
the best passages with their citations, and reports a gap when nothing matches. It exists so the whole chain (agent
loop, citations, flags, streaming, UI) runs for real in `npm run demo` and in the tests. It does not reason or
rephrase: add `--llm` to the demo to use the model of the config.

## Testing on your Claude subscription

`claude-code:sonnet` (or `opus`, `haiku`) answers through your own Claude Code (`claude -p`), on your Claude
subscription, with no API key. `ask` and `eval` use it on their own when no key of the configured models is set, and
`serve --model claude-code:sonnet` opens the chat page locally with it. Each call is isolated: no tool, no MCP server,
no session saved. It has no tools, so the assistant runs in retrieval-first mode. It never runs on Netlify: the
online chat page needs an API key.

## Embeddings (hybrid search)

`models.embeddings` adds semantic search on top of keyword search. Voyage, OpenAI, Google, Mistral and OpenAI-compatible
endpoints work. See [hybrid search](/docs/concepts/lean-brain/#hybrid-search).

## Local models

Ollama, LM Studio or vLLM on a laptop are reachable from the CLI (`ask`, `eval`, `serve`), **not from Netlify**: the
function runs in the cloud, and `doctor` warns about it. For the online chatbot, expose a protected endpoint
(`openai_compatible` with a key) or use a hosted provider.

## Choosing on numbers

Guardrails (zero invention, citations, abstention) are partly enforced in code, but a weaker model follows them less.
Compare models on your own questions before switching in production:

```bash
npm run openbrain -- eval --matrix anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,mistral:<model>
npm run openbrain -- eval --model anthropic:claude-haiku-5-5 --effort low --judge google:<model>
```

The table gives, per model, the scores against the thresholds, tokens, cost and latency per question. `doctor` warns
when the chat model never passed your evals. A public ranking on the Acme set is planned.
