import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstanceConfig } from "@openbrain/core";
import { apiKeyFor, createProviderRegistry, formatRef, parseRef, specFromConfig, type ModelSpec, type NormalizedUsage } from "@openbrain/llm";
import { resolveSettings } from "@openbrain/server";
import { stringFlag, type ParsedArgs } from "../args.ts";

// Helpers shared by the commands of the chatbot (serve, demo, ask, eval, models, deploy, reports).

/** Repository root of the engine (where apps/ and examples/ live). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const ACME_ROOT = path.join(REPO_ROOT, "examples", "acme");
export const WEB_DIR = path.join(REPO_ROOT, "apps", "web");

export function rootOf(args: ParsedArgs): string {
  return path.resolve(stringFlag(args, "root") ?? process.cwd());
}

/** Built UI, when `npm run build -w @openbrain/web` has run. */
export function builtUiDir(): string | null {
  const dist = path.join(WEB_DIR, "dist");
  return existsSync(path.join(dist, "index.html")) ? dist : null;
}

/** The model used to test in the terminal without any API key: Claude Code, on the operator's subscription. */
export const SUBSCRIPTION_MODEL: ModelSpec = { ref: { provider: "claude-code", model: "sonnet" } };

/** True when `claude` (Claude Code) answers on this machine. */
export function claudeCodeAvailable(): boolean {
  const result = spawnSync(process.env.OPENBRAIN_CLAUDE_BIN ?? "claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
  return result.status === 0;
}

export interface ChatSpecsOptions {
  /** ask and eval: when no model of the chain has a key, answer through Claude Code (subscription) instead. */
  subscriptionFallback?: boolean;
}

/** Chat model chain of an instance: `--model provider:model` wins over openbrain.config.yaml. */
export async function chatSpecs(root: string, modelFlag: string | undefined, options: ChatSpecsOptions = {}): Promise<ModelSpec[]> {
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  if (modelFlag) {
    const ref = parseRef(modelFlag);
    return [{ ref, effort: ref.model === settings.chat.model ? settings.chat.effort : "low" }];
  }
  const specs = [specFromConfig(settings.chat), ...settings.fallback.map(specFromConfig)];
  if (!options.subscriptionFallback) return specs;
  const registry = createProviderRegistry(settings.openaiCompatible);
  const usable = specs.some((spec) => {
    const def = registry.get(spec.ref.provider);
    if (!def) return Boolean(spec.baseUrl);
    return def.keyless === true || apiKeyFor(def, process.env, spec.apiKeyEnv) !== undefined;
  });
  if (usable || !claudeCodeAvailable()) return specs;
  console.error(
    dim(
      `no API key for ${formatRef(specs[0]?.ref ?? SUBSCRIPTION_MODEL.ref)}: answering through Claude Code on your subscription (claude-code:sonnet).\n` +
        "Add the key to .env to test the chat model itself.\n",
    ),
  );
  return [SUBSCRIPTION_MODEL];
}

export function formatUsage(usage: NormalizedUsage): string {
  const cost = usage.costUsd === null ? "not priced" : `$${usage.costUsd.toFixed(4)}`;
  const cached = usage.cachedInputTokens > 0 ? ` (${usage.cachedInputTokens} cached)` : "";
  return `${usage.inputTokens} in${cached}, ${usage.outputTokens} out, ${cost}`;
}

export function describeSpecs(specs: readonly ModelSpec[]): string {
  return specs.map((s) => `${formatRef(s.ref)}${s.effort ? ` (${s.effort})` : ""}`).join(" -> ");
}

/** Tiny ANSI helpers, disabled when the output is not a terminal. */
const color = process.stdout.isTTY && !process.env.NO_COLOR;
export const dim = (text: string): string => (color ? `\x1b[2m${text}\x1b[0m` : text);
export const bold = (text: string): string => (color ? `\x1b[1m${text}\x1b[0m` : text);
export const pink = (text: string): string => (color ? `\x1b[38;2;240;0;80m${text}\x1b[0m` : text);
export const green = (text: string): string => (color ? `\x1b[32m${text}\x1b[0m` : text);
export const red = (text: string): string => (color ? `\x1b[31m${text}\x1b[0m` : text);
