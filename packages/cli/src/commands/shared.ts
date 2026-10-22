import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstanceConfig } from "@openbrain/core";
import { formatRef, parseRef, specFromConfig, type ModelSpec, type NormalizedUsage } from "@openbrain/llm";
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

/** Chat model chain of an instance: `--model provider:model` wins over openbrain.config.yaml. */
export async function chatSpecs(root: string, modelFlag: string | undefined): Promise<ModelSpec[]> {
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  if (modelFlag) {
    const ref = parseRef(modelFlag);
    return [{ ref, effort: ref.model === settings.chat.model ? settings.chat.effort : "low" }];
  }
  return [specFromConfig(settings.chat), ...settings.fallback.map(specFromConfig)];
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
