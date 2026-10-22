import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatIssues, type ConnectorKind } from "@openbrain/core";
import type { FetchLike } from "../notion/client.ts";
import { createApiConnector } from "../api/index.ts";
import { API_MANIFEST } from "../api/manifest.ts";
import { loadApiMapping } from "../api/mapping.ts";
import { createFilesConnector } from "../files/index.ts";
import { FILES_MANIFEST } from "../files/manifest.ts";
import { loadServiceAccount } from "../gdrive/auth.ts";
import { createGdriveConnector } from "../gdrive/index.ts";
import { GDRIVE_MANIFEST } from "../gdrive/manifest.ts";
import { createGithubConnector, DEFAULT_DOCS_GLOBS } from "../github/index.ts";
import { GITHUB_MANIFEST } from "../github/manifest.ts";
import { createMcpConnector } from "../mcp/index.ts";
import { MCP_MANIFEST } from "../mcp/manifest.ts";
import { loadMcpMapping } from "../mcp/mapping.ts";
import { createWebConnector } from "../web/index.ts";
import { WEB_MANIFEST } from "../web/manifest.ts";
import { isEnvSet, referencedEnv, type EnvMap } from "./env.ts";
import type { ConnectorManifest, InputConnector, InputTransport } from "./types.ts";

// The `inputs:` section of openbrain.config.yaml, parsed here because the core config
// keeps it as unknown data. Both shapes are accepted: options at the top level of an input, or nested
// under `scope:` as in the plan. Inputs that are not implemented yet (slack...) are listed, not built.

/** Accepts `{ enabled, scope: { ... } }` as well as `{ enabled, ... }` (top-level keys win). */
function flattenScope(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { scope, ...rest } = value as Record<string, unknown>;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return value;
  return { ...(scope as Record<string, unknown>), ...rest };
}

const StringList = z.union([z.string().min(1).transform((s) => [s]), z.array(z.string().min(1))]);

export const FilesInputSchema = z.preprocess(
  flattenScope,
  z
    .object({
      enabled: z.boolean().default(true),
      paths: StringList,
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      max_file_mb: z.number().positive().default(20),
      max_csv_rows: z.number().int().positive().optional(),
    })
    .strict(),
);

export const WebInputSchema = z.preprocess(
  flattenScope,
  z
    .object({
      enabled: z.boolean().default(true),
      sitemap: StringList.optional(),
      urls: z.array(z.string().min(1)).default([]),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      max_pages: z.number().int().positive().default(200),
      delay_ms: z.number().int().nonnegative().default(1000),
      user_agent: z.string().min(1).optional(),
    })
    .strict()
    .refine((w) => (w.sitemap?.length ?? 0) > 0 || w.urls.length > 0, { message: "set sitemap or urls", path: ["sitemap"] }),
);

export const GithubInputSchema = z.preprocess(
  flattenScope,
  z
    .object({
      enabled: z.boolean().default(true),
      repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo")).min(1),
      docs_globs: z.array(z.string().min(1)).default(DEFAULT_DOCS_GLOBS),
      commits: z.boolean().default(true),
      pull_requests: z.boolean().default(true),
      branch: z.string().min(1).optional(),
      api_url: z.url().optional(),
      max_file_mb: z.number().positive().default(5),
      token_env: z.string().min(1).default("GITHUB_TOKEN"),
    })
    .strict(),
);

export const GdriveInputSchema = z.preprocess(
  flattenScope,
  z
    .object({
      enabled: z.boolean().default(true),
      folders: z.array(z.string().min(1)).min(1),
      mime: z.array(z.enum(["doc", "sheet", "slides", "text", "pdf"])).default(["doc", "sheet", "slides", "text"]),
      max_file_mb: z.number().positive().default(20),
      max_sheet_rows: z.number().int().positive().optional(),
      credentials_env: z.string().min(1).default("GDRIVE_SA_JSON"),
    })
    .strict(),
);

export const McpInputSchema = z
  .object({
    enabled: z.boolean().default(true),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.url().optional(),
    auth_env: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    mapping: z.string().min(1),
  })
  .strict()
  .refine((m) => (m.transport === "stdio" ? Boolean(m.command) : Boolean(m.url)), {
    message: "stdio needs command, http needs url",
    path: ["transport"],
  });

export const ApiInputSchema = z
  .object({
    enabled: z.boolean().default(true),
    base_url: z.url(),
    auth: z
      .object({
        type: z.enum(["bearer", "header", "query", "basic"]).default("bearer"),
        env: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .refine((a) => a.type === "bearer" || a.type === "basic" || Boolean(a.name), {
        message: "header and query auth need a name (header or query parameter)",
        path: ["name"],
      })
      .optional(),
    headers: z.record(z.string(), z.string()).default({}),
    delay_ms: z.number().int().nonnegative().default(200),
    mapping: z.string().min(1),
  })
  .strict();

/** A tool read by Claude through one of its MCP connectors during /init and /weekly, not by the CLI. */
export const ClaudeInputSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Whitelist in plain words: channels, pipelines, projects... Claude stays within it. */
    scope: z.string().min(1),
    /** Name of the MCP connector in Claude Code, when it differs from the input name. */
    connector: z.string().min(1).optional(),
  })
  .strict();

const InputName = z.string().regex(/^[\w-]+$/, "input names use letters, digits, - and _");

export const InputsConfigSchema = z
  .object({
    files: FilesInputSchema.optional(),
    web: WebInputSchema.optional(),
    github: GithubInputSchema.optional(),
    gdrive: GdriveInputSchema.optional(),
    mcp: z.record(InputName, McpInputSchema).optional(),
    api: z.record(InputName, ApiInputSchema).optional(),
    claude: z.record(InputName, ClaudeInputSchema).optional(),
  })
  .passthrough();

export type FilesInput = z.infer<typeof FilesInputSchema>;
export type WebInput = z.infer<typeof WebInputSchema>;
export type GithubInput = z.infer<typeof GithubInputSchema>;
export type GdriveInput = z.infer<typeof GdriveInputSchema>;
export type McpInput = z.infer<typeof McpInputSchema>;
export type ApiInput = z.infer<typeof ApiInputSchema>;
export type ClaudeInput = z.infer<typeof ClaudeInputSchema>;
export type InputsConfig = z.infer<typeof InputsConfigSchema>;

/** Parses `config.inputs` (unknown, from the passthrough core config). Throws with readable issues. */
export function parseInputsConfig(value: unknown): InputsConfig {
  const result = InputsConfigSchema.safeParse(value ?? {});
  if (!result.success) {
    throw new Error(`invalid inputs in openbrain.config.yaml:\n${formatIssues(result.error).map((l) => `  inputs.${l}`).join("\n")}`);
  }
  return result.data;
}

export interface EnvStatus {
  name: string;
  set: boolean;
}

/** One configured input: what it is, whether it can run, and how to build it. */
export interface InputEntry {
  id: string;
  /** Folder name under inputs/: "mcp:linear" -> "mcp-linear". */
  dir: string;
  manifest: ConnectorManifest;
  kinds: readonly ConnectorKind[];
  transport: InputTransport;
  enabled: boolean;
  /** Collected by the CLI (`collect`, `weekly prepare`). */
  supported: boolean;
  /** "claude": read by Claude through its MCP connector during /init and /weekly, never by the CLI. */
  via: "cli" | "claude";
  env: EnvStatus[];
  /** Short human summary of the configured scope (no secret). */
  scope: string;
  create(): Promise<InputConnector>;
}

export interface BuildInputsOptions {
  /** Instance root: relative paths (files, MCP mappings, key files) resolve against it. */
  root: string;
  env?: EnvMap;
  /** Injected into the HTTP connectors (tests). */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function requireEnv(env: EnvMap, name: string, setup: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set: put it in .env (see packages/connectors/src/${setup})`);
  }
  return value;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The `kind` of an MCP or API mapping file, read without validation (for listings); undefined if unreadable. */
function peekMappingKind(file: string): ConnectorKind | undefined {
  try {
    const kind = (parseYaml(readFileSync(file, "utf8")) as Record<string, unknown> | null)?.kind;
    return kind === "documents" || kind === "stream" ? kind : undefined;
  } catch {
    return undefined;
  }
}

export function inputDir(id: string): string {
  return id.replace(/[^\w.-]+/g, "-");
}

export function describeInputs(inputs: InputsConfig, options: BuildInputsOptions): InputEntry[] {
  const env = options.env ?? process.env;
  const root = path.resolve(options.root);
  const http = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const entries: InputEntry[] = [];
  const base = (id: string, manifest: ConnectorManifest): Pick<InputEntry, "id" | "dir" | "manifest" | "kinds" | "transport" | "supported" | "via"> => ({
    id,
    dir: inputDir(id),
    manifest,
    kinds: manifest.kinds,
    transport: manifest.transport,
    supported: true,
    via: "cli",
  });

  const files = inputs.files;
  if (files) {
    entries.push({
      ...base("files", FILES_MANIFEST),
      enabled: files.enabled,
      env: [],
      scope: `${count(files.paths.length, "path")}: ${files.paths.join(", ")}`,
      create: async () =>
        createFilesConnector({
          baseDir: root,
          paths: files.paths,
          ...(files.include ? { include: files.include } : {}),
          ...(files.exclude ? { exclude: files.exclude } : {}),
          maxFileMb: files.max_file_mb,
          ...(files.max_csv_rows ? { maxCsvRows: files.max_csv_rows } : {}),
        }),
    });
  }

  const web = inputs.web;
  if (web) {
    const sitemaps = web.sitemap ?? [];
    entries.push({
      ...base("web", WEB_MANIFEST),
      enabled: web.enabled,
      env: [],
      scope: `${count(sitemaps.length, "sitemap")}, ${count(web.urls.length, "listed URL")}${web.include.length > 0 ? `, include ${web.include.join(" ")}` : ""}, max ${web.max_pages} pages`,
      create: async () =>
        createWebConnector({
          sitemaps,
          urls: web.urls,
          include: web.include,
          exclude: web.exclude,
          maxPages: web.max_pages,
          delayMs: web.delay_ms,
          ...(web.user_agent ? { userAgent: web.user_agent } : {}),
          ...http,
        }),
    });
  }

  const github = inputs.github;
  if (github) {
    entries.push({
      ...base("github", GITHUB_MANIFEST),
      enabled: github.enabled,
      env: [{ name: github.token_env, set: isEnvSet(env, github.token_env) }],
      scope: `${github.repos.join(", ")}; docs ${github.docs_globs.join(" ")}${github.commits ? "; commits" : ""}${github.pull_requests ? " + merged PRs" : ""}`,
      create: async () =>
        createGithubConnector({
          token: requireEnv(env, github.token_env, GITHUB_MANIFEST.setup),
          repos: github.repos,
          docsGlobs: github.docs_globs,
          commits: github.commits,
          pullRequests: github.pull_requests,
          maxFileMb: github.max_file_mb,
          ...(github.branch ? { branch: github.branch } : {}),
          ...(github.api_url ? { apiUrl: github.api_url } : {}),
          ...http,
        }),
    });
  }

  const gdrive = inputs.gdrive;
  if (gdrive) {
    entries.push({
      ...base("gdrive", GDRIVE_MANIFEST),
      enabled: gdrive.enabled,
      env: [{ name: gdrive.credentials_env, set: isEnvSet(env, gdrive.credentials_env) }],
      scope: `${count(gdrive.folders.length, "folder")}; ${gdrive.mime.join(", ")}`,
      create: async () =>
        createGdriveConnector({
          serviceAccount: loadServiceAccount(requireEnv(env, gdrive.credentials_env, GDRIVE_MANIFEST.setup), root),
          folders: gdrive.folders,
          mime: gdrive.mime,
          maxFileMb: gdrive.max_file_mb,
          ...(gdrive.max_sheet_rows ? { maxSheetRows: gdrive.max_sheet_rows } : {}),
          ...http,
        }),
    });
  }

  for (const [name, mcp] of Object.entries(inputs.mcp ?? {})) {
    const envNames = [
      ...(mcp.auth_env ? [mcp.auth_env] : []),
      ...Object.values(mcp.env).flatMap(referencedEnv),
      ...Object.values(mcp.headers).flatMap(referencedEnv),
    ];
    const id = `mcp:${name}`;
    const mappingKind = peekMappingKind(path.resolve(root, mcp.mapping));
    entries.push({
      ...base(id, MCP_MANIFEST),
      ...(mappingKind ? { kinds: [mappingKind] } : {}),
      enabled: mcp.enabled,
      env: [...new Set(envNames)].map((n) => ({ name: n, set: isEnvSet(env, n) })),
      scope: `${mcp.transport === "stdio" ? `stdio: ${mcp.command ?? ""}` : `http: ${mcp.url ?? ""}`}; mapping ${mcp.mapping}`,
      create: async () => {
        const mapping = await loadMcpMapping(path.resolve(root, mcp.mapping));
        return createMcpConnector({
          id,
          mapping,
          env,
          server: {
            transport: mcp.transport,
            ...(mcp.command ? { command: mcp.command } : {}),
            args: mcp.args,
            env: mcp.env,
            ...(mcp.cwd ? { cwd: path.resolve(root, mcp.cwd) } : {}),
            ...(mcp.url ? { url: mcp.url } : {}),
            ...(mcp.auth_env ? { authEnv: mcp.auth_env } : {}),
            headers: mcp.headers,
          },
          ...(options.now ? { now: options.now } : {}),
        });
      },
    });
  }

  for (const [name, api] of Object.entries(inputs.api ?? {})) {
    const envNames = [...(api.auth ? [api.auth.env] : []), ...Object.values(api.headers).flatMap(referencedEnv)];
    const id = `api:${name}`;
    const mappingKind = peekMappingKind(path.resolve(root, api.mapping));
    entries.push({
      ...base(id, API_MANIFEST),
      ...(mappingKind ? { kinds: [mappingKind] } : {}),
      enabled: api.enabled,
      env: [...new Set(envNames)].map((n) => ({ name: n, set: isEnvSet(env, n) })),
      scope: `GET ${api.base_url}; mapping ${api.mapping}`,
      create: async () =>
        createApiConnector({
          id,
          baseUrl: api.base_url,
          mapping: await loadApiMapping(path.resolve(root, api.mapping)),
          ...(api.auth ? { auth: api.auth } : {}),
          headers: api.headers,
          env,
          delayMs: api.delay_ms,
          ...http,
        }),
    });
  }

  for (const [name, input] of Object.entries(inputs.claude ?? {})) {
    const id = `claude:${name}`;
    const connector = input.connector ?? name;
    entries.push({
      ...base(id, CLAUDE_MANIFEST),
      kinds: [],
      supported: false,
      via: "claude",
      enabled: input.enabled,
      env: [],
      scope: `${input.scope} (MCP connector "${connector}" in Claude Code)`,
      create: async () => {
        throw new Error(
          `${id} is read by Claude through its MCP connector "${connector}" during /init and /weekly, not by the CLI: check that the connector is connected with /mcp in Claude Code`,
        );
      },
    });
  }

  // Other names (slack, confluence, hubspot...): no built-in connector, listed so the operator sees them.
  const known = new Set(["files", "web", "github", "gdrive", "mcp", "api", "claude"]);
  for (const [name, value] of Object.entries(inputs)) {
    if (known.has(name)) continue;
    const enabled = typeof value === "object" && value !== null && (value as Record<string, unknown>).enabled === true;
    entries.push({
      id: name,
      dir: inputDir(name),
      manifest: { id: name, name, kinds: [], transport: "rest", env: [], scopes: [], defaultScope: "", rateLimit: "", setup: "" },
      kinds: [],
      transport: "rest",
      enabled,
      supported: false,
      via: "cli",
      env: [],
      scope: "no built-in input of this name: declare it under inputs.claude, inputs.mcp or inputs.api",
      create: async () => {
        throw new Error(
          `input "${name}" has no built-in connector: declare it under inputs.claude (read by Claude through its MCP connector), inputs.mcp or inputs.api (see packages/connectors/src/mcp/SETUP.md and api/SETUP.md)`,
        );
      },
    });
  }
  return entries;
}

export const CLAUDE_MANIFEST: ConnectorManifest = {
  id: "claude",
  name: "A tool read by Claude through its MCP connector (Claude Code), during /init and /weekly",
  kinds: ["documents", "stream"],
  transport: "mcp",
  env: [],
  scopes: ["the operator's own access in the tool, through the connector's sign-in: Claude only reads, within inputs.claude.<name>.scope"],
  defaultScope: "only what inputs.claude.<name>.scope names",
  rateLimit: "uses the operator's Claude subscription",
  setup: "",
};

export const INPUT_MANIFESTS: readonly ConnectorManifest[] = [FILES_MANIFEST, WEB_MANIFEST, GITHUB_MANIFEST, GDRIVE_MANIFEST, MCP_MANIFEST, API_MANIFEST, CLAUDE_MANIFEST];
