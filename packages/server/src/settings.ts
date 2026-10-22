import { type InstanceConfig } from "@openbrain/core";
import type { CustomEndpoint, ModelConfigLike, PriceOverride } from "@openbrain/llm";
import { z } from "zod";
import type { AuthMode } from "./protocol.ts";

// Chatbot settings read from openbrain.config.yaml (keys kept by the passthrough of InstanceConfigSchema):
//   chatbot:   { assistant_name, accent, logo, mode }
//   auth:      { mode: passcode | google | netlify, allowed_domains, identified }
//   budgets:   { monthly_usd, questions_per_user_per_day }
//   user_choice: { enabled, allowed: ["provider:model", ...] }
//   providers: { openai_compatible: [{ name, base_url, api_key_env }] }
// Secrets never live here: they come from the environment.

const HEX = /^#[0-9a-fA-F]{6}$/;

const ChatbotSchema = z
  .object({
    assistant_name: z.string().min(1).optional(),
    accent: z.string().regex(HEX, "must be a #RRGGBB color").optional(),
    logo: z.string().min(1).optional(),
    mode: z.enum(["auto", "agent", "retrieval_first"]).optional(),
  })
  .passthrough();

const AuthSchema = z
  .object({
    mode: z.enum(["passcode", "google", "netlify", "none"]).optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    /** Store the email in reports instead of a hash (to tell the person when the answer is added). */
    identified: z.boolean().optional(),
  })
  .passthrough();

const BudgetsSchema = z
  .object({
    monthly_usd: z.number().nonnegative().optional(),
    questions_per_user_per_day: z.number().int().positive().optional(),
  })
  .passthrough();

const UserChoiceSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowed: z.array(z.string().min(3)).optional(),
  })
  .passthrough();

const ProvidersSchema = z
  .object({
    openai_compatible: z
      .array(z.object({ name: z.string().min(1), base_url: z.url(), api_key_env: z.string().min(1).optional() }).strict())
      .optional(),
  })
  .passthrough();

const ModelEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high"]).optional(),
    base_url: z.string().optional(),
    api_key_env: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

export interface EmbeddingsSettings {
  provider: string;
  model: string;
  dimensions?: number | undefined;
  api_key_env?: string | undefined;
  base_url?: string | undefined;
}

const EmbeddingsSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive().optional(),
    api_key_env: z.string().min(1).optional(),
    base_url: z.string().optional(),
  })
  .passthrough();

export interface ChatbotSettings {
  companyName: string;
  assistantName: string;
  accent: string;
  logoUrl: string | null;
  kbLanguage: string;
  mode: "auto" | "agent" | "retrieval_first";
  /** The configured mode ("open" is never configured: AppContext.authMode derives it from the environment). */
  auth: { mode: Exclude<AuthMode, "open">; allowedDomains: string[]; identified: boolean };
  budgets: { monthlyUsd: number; questionsPerUserPerDay: number };
  chat: ModelConfigLike;
  fallback: ModelConfigLike[];
  /** Optional embeddings for hybrid search (models.embeddings), null when off. */
  embeddings: EmbeddingsSettings | null;
  userChoice: { enabled: boolean; allowed: string[] };
  openaiCompatible: CustomEndpoint[];
  pricing: Record<string, PriceOverride>;
}

/** Default of the template: Claude Opus 5.5 at low effort. */
export const DEFAULT_CHAT_MODEL: ModelConfigLike = { provider: "anthropic", model: "claude-opus-5-5", effort: "low" };

function section<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new Error(`invalid "${name}" in openbrain.config.yaml: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

function toModel(value: z.infer<typeof ModelEntrySchema>): ModelConfigLike {
  return {
    provider: value.provider,
    model: value.model,
    ...(value.effort ? { effort: value.effort } : {}),
    ...(value.base_url ? { base_url: value.base_url } : {}),
    ...(value.api_key_env ? { api_key_env: value.api_key_env } : {}),
    ...(value.max_output_tokens ? { max_output_tokens: value.max_output_tokens } : {}),
  };
}

export function resolveSettings(config: InstanceConfig, env: Record<string, string | undefined> = {}): ChatbotSettings {
  const raw = config as Record<string, unknown>;
  const chatbot = section(ChatbotSchema, raw.chatbot, "chatbot");
  const auth = section(AuthSchema, raw.auth, "auth");
  const budgets = section(BudgetsSchema, raw.budgets, "budgets");
  const userChoice = section(UserChoiceSchema, raw.user_choice, "user_choice");
  const providers = section(ProvidersSchema, raw.providers, "providers");
  const models = (raw.models ?? {}) as Record<string, unknown>;
  const chat = models.chat ? toModel(section(ModelEntrySchema, models.chat, "models.chat")) : DEFAULT_CHAT_MODEL;
  const fallback = Array.isArray(models.fallback)
    ? models.fallback.map((entry, i) => toModel(section(ModelEntrySchema, entry, `models.fallback[${i}]`)))
    : [];

  const embeddingsRaw = models.embeddings ? section(EmbeddingsSchema, models.embeddings, "models.embeddings") : null;
  const embeddings: EmbeddingsSettings | null = embeddingsRaw
    ? {
        provider: embeddingsRaw.provider,
        model: embeddingsRaw.model,
        ...(embeddingsRaw.dimensions ? { dimensions: embeddingsRaw.dimensions } : {}),
        ...(embeddingsRaw.api_key_env ? { api_key_env: embeddingsRaw.api_key_env } : {}),
        ...(embeddingsRaw.base_url ? { base_url: embeddingsRaw.base_url } : {}),
      }
    : null;
  const companyName = config.instance?.name ?? "Your company";
  const domainsFromEnv = (env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  return {
    companyName,
    assistantName: chatbot.assistant_name ?? `${companyName} Brain`,
    accent: chatbot.accent ?? "#F00050",
    logoUrl: chatbot.logo ?? null,
    kbLanguage: config.instance?.kb_language ?? "en",
    mode: chatbot.mode ?? "auto",
    auth: {
      mode: auth.mode ?? "passcode",
      allowedDomains: [...new Set([...(auth.allowed_domains ?? []).map((d) => d.toLowerCase()), ...domainsFromEnv])],
      identified: auth.identified ?? false,
    },
    budgets: {
      monthlyUsd: budgets.monthly_usd ?? 50,
      questionsPerUserPerDay: budgets.questions_per_user_per_day ?? 100,
    },
    chat,
    fallback,
    embeddings,
    userChoice: { enabled: userChoice.enabled ?? false, allowed: userChoice.allowed ?? [] },
    openaiCompatible: providers.openai_compatible ?? [],
    pricing: (config.pricing ?? {}) as Record<string, PriceOverride>,
  };
}
