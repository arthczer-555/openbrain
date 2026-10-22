export * from "./catalog.ts";
export * from "./claude-code.ts";
export * from "./demo.ts";
export * from "./embeddings.ts";
export * from "./llm.ts";
export * from "./providers.ts";
export * from "./types.ts";

import type { ModelSpec } from "./llm.ts";
import type { Effort } from "./types.ts";

/** Shape of a model entry in openbrain.config.yaml (ModelConfigSchema in @openbrain/core). */
export interface ModelConfigLike {
  provider: string;
  model: string;
  effort?: Effort | undefined;
  base_url?: string | undefined;
  api_key_env?: string | undefined;
  max_output_tokens?: number | undefined;
}

export function specFromConfig(config: ModelConfigLike): ModelSpec {
  return {
    ref: { provider: config.provider, model: config.model },
    effort: config.effort,
    baseUrl: config.base_url,
    apiKeyEnv: config.api_key_env,
    maxOutputTokens: config.max_output_tokens,
  };
}
