import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInstanceConfig } from "@openbrain/core";
import {
  builtinCatalog,
  createProviderRegistry,
  isConfigured,
  listProviderModels,
  mergeCatalogs,
  parseModelsDev,
  SNAPSHOT_DATE,
  type CatalogModel,
  type ListedModel,
} from "@openbrain/llm";
import { buildBundle, MODELS_FILE, resolveSettings } from "@openbrain/server";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { bold, chatSpecs, describeSpecs, dim, green, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain models list | refresh: what each configured provider really serves with
// your keys, merged with the capability and price catalog. `refresh` pulls the public models.dev catalog.

const MODELS_DEV_URL = "https://models.dev/api.json";

function price(m: CatalogModel): string {
  return m.price ? `$${m.price.input}/$${m.price.output}` : "not priced";
}

async function list(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  const registry = createProviderRegistry(settings.openaiCompatible);
  const bundle = await buildBundle(root);
  const catalog = mergeCatalogs(builtinCatalog(), bundle.models ?? []);
  const all = boolFlag(args, "all");
  const json = boolFlag(args, "json");

  const rows: Array<{ provider: string; configured: boolean; listed: ListedModel[]; error: string | null }> = [];
  for (const def of registry.providers) {
    const configured = isConfigured(def, process.env);
    if (!configured && !all) {
      rows.push({ provider: def.id, configured, listed: [], error: null });
      continue;
    }
    try {
      rows.push({ provider: def.id, configured, listed: configured ? await listProviderModels(def, process.env) : [], error: null });
    } catch (error) {
      rows.push({ provider: def.id, configured, listed: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (json) {
    console.log(JSON.stringify({ providers: rows, catalog }, null, 2));
    return 0;
  }

  console.log(bold("Chat model") + dim(` (openbrain.config.yaml, the admin page can override it): ${describeSpecs(await chatSpecs(root, undefined))}\n`));
  for (const row of rows) {
    const def = registry.get(row.provider);
    if (!def) continue;
    const state = row.configured ? green("configured") : dim(`set ${def.envKeys.join(" or ") || "base_url"}`);
    console.log(`${bold(def.label.padEnd(26))} ${state}${def.local ? dim("  (local: CLI only, not reachable from Netlify)") : ""}${row.error ? `  error: ${row.error}` : ""}`);
    if (!row.configured && !all) continue;
    const known = catalog.filter((m) => m.provider === def.id);
    const listedIds = new Set(row.listed.map((l) => l.id));
    const shown = new Set<string>();
    for (const m of known) {
      if (row.configured && row.listed.length > 0 && !listedIds.has(m.id) && !all) continue;
      shown.add(m.id);
      const tools = m.caps.tools ? "tools" : dim("no tools");
      console.log(`  ${`${def.id}:${m.id}`.padEnd(44)} ${tools.padEnd(8)} ${price(m).padEnd(14)} ${dim(m.name)}`);
    }
    for (const l of row.listed) {
      if (shown.has(l.id)) continue;
      console.log(`  ${`${def.id}:${l.id}`.padEnd(44)} ${dim("capabilities not verified")}`);
    }
  }
  console.log(dim(`\nPrices in USD per million tokens (input/output). Catalog snapshot ${SNAPSHOT_DATE}${bundle.models ? ", refreshed copy in " + MODELS_FILE : ""}.`));
  return 0;
}

async function refresh(args: ParsedArgs): Promise<number> {
  const root = rootOf(args);
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  const registry = createProviderRegistry(settings.openaiCompatible);
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    console.log(`could not fetch ${MODELS_DEV_URL}: HTTP ${response.status}`);
    return 1;
  }
  const models = parseModelsDev(await response.json(), registry.providers.map((p) => p.id));
  const file = path.join(root, MODELS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ source: MODELS_DEV_URL, fetched_at: new Date().toISOString(), models }, null, 1), "utf8");
  const perProvider = new Map<string, number>();
  for (const m of models) perProvider.set(m.provider, (perProvider.get(m.provider) ?? 0) + 1);
  console.log(`wrote ${path.relative(process.cwd(), file)}: ${models.length} models (${[...perProvider].map(([p, n]) => `${p} ${n}`).join(", ")})`);
  return 0;
}

export const modelsCommand: CommandDefinition = {
  name: "models",
  help: "models list|refresh        Models your keys can use, with capabilities and prices",
  booleanFlags: ["all"],
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positionals[1] ?? "list";
    if (sub === "list") return list(args);
    if (sub === "refresh") return refresh(args);
    console.log("usage: openbrain models list [--all] | openbrain models refresh");
    return 1;
  },
};
