import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// Local secrets live in the instance .env. Values already set in the environment win,
// and no value is ever printed: callers only learn whether a variable is set.

export type EnvMap = Record<string, string | undefined>;

/** Loads <root>/.env into `env` without overriding existing values. Returns the names it set. */
export function loadDotEnv(root: string, env: EnvMap = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] === undefined && value !== undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}

export function isEnvSet(env: EnvMap, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

/** Replaces "${NAME}" with the variable value ("" when unset). Used for MCP stdio env and headers. */
export function interpolateEnv(value: string, env: EnvMap): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

/** Names referenced as "${NAME}" in a value. */
export function referencedEnv(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] ?? "").filter(Boolean);
}
