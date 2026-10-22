import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import type { App } from "./app.ts";

// Node adapter for `openbrain serve`: the same Web handlers as on Netlify, plus the static UI (apps/web/dist)
// with a single-page fallback. Local only: binds 127.0.0.1 by default.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  });
}

async function send(res: ServerResponse, response: Response, onClose: () => void): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    onClose();
    reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string): Promise<boolean> {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(staticDir, safe);
  if (!file.startsWith(staticDir)) return false;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, "index.html");
    await stat(file);
  } catch {
    // Single-page app: unknown paths get index.html (client-side routes like /admin, /login).
    file = path.join(staticDir, "index.html");
    try {
      await stat(file);
    } catch {
      return false;
    }
  }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}

export interface NodeServerOptions {
  app: App;
  port: number;
  host?: string;
  /** Built UI (apps/web/dist). Without it, only /api answers (use the Vite dev server for the UI). */
  staticDir?: string | null;
  /** Handles every non-API request instead of the static folder (the Vite dev server in middleware mode). */
  middleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}

export function startNodeServer(options: NodeServerOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `${host}:${options.port}`}`;
    const pathname = new URL(req.url ?? "/", origin).pathname;
    const handle = async (): Promise<void> => {
      if (pathname.startsWith("/api/")) {
        const response = await options.app(toRequest(req, origin), { ip: req.socket.remoteAddress ?? undefined });
        await send(res, response, () => undefined);
        return;
      }
      if (options.middleware) {
        options.middleware(req, res, () => {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
        });
        return;
      }
      if (options.staticDir && (await serveStatic(res, options.staticDir, pathname))) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(options.staticDir ? "not found" : "UI not built: run the web app with `npm run dev -w @openbrain/web`");
    };
    handle().catch((error: unknown) => {
      console.error("[openbrain serve]", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve(server));
  });
}
