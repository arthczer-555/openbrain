import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatIssues } from "./frontmatter.ts";

// openbrain.config.yaml (instance zone, committed; secrets stay in the environment).
// Unknown top-level keys are kept so the file can grow (connectors, budgets, auth) without breaking older code.

export const CONFIG_FILE = "openbrain.config.yaml";

export const EffortSchema = z.enum(["low", "medium", "high"]);

export const ModelConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: EffortSchema.optional(),
    /** OpenAI-compatible endpoints (Ollama, vLLM, a proxy) and OpenRouter. */
    base_url: z.url().optional(),
    /** Name of the environment variable holding the key, when it is not the provider default. */
    api_key_env: z.string().min(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .strict();

export const PriceSchema = z
  .object({
    input_per_mtok: z.number().nonnegative(),
    output_per_mtok: z.number().nonnegative(),
    cache_read_per_mtok: z.number().nonnegative().optional(),
    cache_write_per_mtok: z.number().nonnegative().optional(),
  })
  .strict();

export const InstanceConfigSchema = z
  .object({
    instance: z
      .object({
        name: z.string().min(1).optional(),
        kb_language: z.string().min(2).optional(),
      })
      .passthrough()
      .optional(),
    notion: z
      .object({
        /** The Notion page whose tree is the knowledge base. */
        root_page: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    models: z
      .object({
        chat: ModelConfigSchema.optional(),
        fallback: z.array(ModelConfigSchema).default([]),
      })
      .passthrough()
      .optional(),
    /** "provider/model" -> price per million tokens, overrides the built-in table. */
    pricing: z.record(z.string(), PriceSchema).optional(),
  })
  .passthrough();

export type Effort = z.infer<typeof EffortSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type Price = z.infer<typeof PriceSchema>;
export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

export async function loadInstanceConfig(root: string): Promise<InstanceConfig> {
  let text: string;
  try {
    text = await readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch {
    return {};
  }
  const result = InstanceConfigSchema.safeParse(parseYaml(text) ?? {});
  if (!result.success) {
    throw new Error(`invalid ${CONFIG_FILE}:\n${formatIssues(result.error).join("\n")}`);
  }
  return result.data;
}
