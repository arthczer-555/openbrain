import { existsSync } from "node:fs";
import path from "node:path";
import { blobsKVFactory, BUNDLE_FILE, createApp, loadBundleFile, type App } from "@openbrain/server";

// Shared by the Netlify functions: the app is built once per function instance (module scope), from the
// runtime bundle shipped with the function (netlify.toml included_files). Warm calls reuse it.

/** The part of the Netlify function context we use. */
export interface NetlifyContext {
  ip?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

let app: Promise<App> | null = null;

function bundlePath(): string {
  const candidates = [
    path.resolve(BUNDLE_FILE),
    path.join(process.env.LAMBDA_TASK_ROOT ?? "/var/task", BUNDLE_FILE),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0] ?? BUNDLE_FILE;
}

function getApp(): Promise<App> {
  app ??= loadBundleFile(bundlePath()).then((bundle) => createApp({ bundle, env: process.env, kv: blobsKVFactory() }));
  return app;
}

export async function handle(request: Request, context: NetlifyContext): Promise<Response> {
  const instance = await getApp();
  return instance(request, {
    ip: context.ip,
    ...(context.waitUntil ? { waitUntil: (promise: Promise<unknown>) => context.waitUntil?.(promise) } : {}),
  });
}
