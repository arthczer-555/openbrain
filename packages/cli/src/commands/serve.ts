import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buildBundle, createApp, fileKVFactory, startNodeServer, type ServerDeps } from "@openbrain/server";
import type { ModelConfigLike } from "@openbrain/llm";
import { boolFlag, intFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { ACME_ROOT, bold, builtUiDir, dim, pink, rootOf, WEB_DIR } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain serve: the chatbot of an instance on this machine (same handlers as on Netlify).
// openbrain demo: the Acme example with the demo model, no API key, no account, nothing to configure.

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** The Vite dev server in middleware mode, when the UI is not built (no build step needed for a demo). */
async function viteMiddleware(port: number): Promise<{ middleware: Middleware; close: () => Promise<void> } | null> {
  try {
    const vite = await import("vite");
    const server = await vite.createServer({
      root: WEB_DIR,
      configFile: path.join(WEB_DIR, "vite.config.ts"),
      server: { middlewareMode: true, ws: { port: port + 1 } },
      appType: "spa",
      logLevel: "warn",
    });
    return { middleware: server.middlewares as unknown as Middleware, close: () => server.close() };
  } catch (error) {
    console.log(dim(`(UI dev server unavailable: ${error instanceof Error ? error.message : String(error)})`));
    return null;
  }
}

interface ServeOptions {
  root: string;
  port: number;
  host: string;
  chatOverride?: ModelConfigLike;
  withAuth: boolean;
  label: string;
}

async function serve(options: ServeOptions): Promise<number> {
  const bundle = await buildBundle(options.root, { commit: null, env: process.env });
  if (!options.withAuth) {
    // Local run: open access by default (the server refuses this mode outside local runs).
    bundle.config = { ...bundle.config, auth: { ...((bundle.config as { auth?: object }).auth ?? {}), mode: "none" } };
  }
  const deps: ServerDeps = {
    bundle,
    env: process.env,
    kv: fileKVFactory(options.root),
    local: true,
    ...(options.chatOverride ? { chatOverride: options.chatOverride } : {}),
  };
  const app = createApp(deps);
  const staticDir = builtUiDir();
  const vite = staticDir ? null : await viteMiddleware(options.port);
  const server = await startNodeServer({
    app,
    port: options.port,
    host: options.host,
    staticDir,
    ...(vite ? { middleware: vite.middleware } : {}),
  });

  const url = `http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${options.port}`;
  const pages = Object.keys(bundle.index.docs).length;
  console.log(`\n  ${pink(">")} ${bold(options.label)} is running at ${bold(url)}`);
  console.log(dim(`    ${pages} pages, ${bundle.index.chunks.length} passages from ${path.relative(process.cwd(), options.root) || "."}, embeddings ${bundle.embeddings}`));
  console.log(dim(`    UI: ${staticDir ? "built (apps/web/dist)" : vite ? "Vite dev server" : "not available, API only"}`));
  console.log(dim(`    auth: ${options.withAuth ? "as configured" : "open (local only)"}, admin at ${url}/admin`));
  console.log(dim("    stop with Ctrl+C\n"));
  // Keep the process alive until Ctrl+C.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  // Close everything so the process exits (open sockets would keep it alive).
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vite?.close();
  return 0;
}

export const serveCommand: CommandDefinition = {
  name: "serve",
  help: "serve [--port 8787]        Run the chatbot of this instance locally (API + UI)",
  booleanFlags: ["with-auth"],
  async run(args: ParsedArgs): Promise<number> {
    const model = stringFlag(args, "model");
    const [provider, ...rest] = (model ?? "").split(":");
    return serve({
      root: rootOf(args),
      port: intFlag(args, "port") ?? 8787,
      host: stringFlag(args, "host") ?? "127.0.0.1",
      withAuth: boolFlag(args, "with-auth"),
      label: "OpenBrain",
      ...(model && provider && rest.length > 0 ? { chatOverride: { provider, model: rest.join(":"), effort: "low" } } : {}),
    });
  },
};

export const demoCommand: CommandDefinition = {
  name: "demo",
  help: "demo                       Try the fictional Acme brain locally, no API key needed",
  booleanFlags: ["llm"],
  async run(args: ParsedArgs): Promise<number> {
    // The demo model streams word by word, like a real one.
    process.env.OPENBRAIN_DEMO_DELAY_MS ??= "18";
    const useLlm = boolFlag(args, "llm");
    if (!useLlm) {
      console.log(dim("Demo model: answers by quoting the best passages, without an LLM. Add --llm to use the model of"));
      console.log(dim("examples/acme/openbrain.config.yaml with your own API key (ANTHROPIC_API_KEY in .env).\n"));
    }
    return serve({
      root: ACME_ROOT,
      port: intFlag(args, "port") ?? 8787,
      host: stringFlag(args, "host") ?? "127.0.0.1",
      withAuth: false,
      label: "Acme Brain (demo)",
      ...(useLlm ? {} : { chatOverride: { provider: "demo", model: "extractive" } }),
    });
  },
};
