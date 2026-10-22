import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildBundle,
  createApp,
  hashCode,
  memoryKVFactory,
  signSession,
  verifyCode,
  verifySession,
  type App,
  type KVFactory,
  type RuntimeBundle,
  type ServerDeps,
} from "../src/index.ts";
import type { ChatStreamEvent, ModelsResponse, PublicConfig, ReportsResponse } from "../src/protocol.ts";

const ACME_ROOT = fileURLToPath(new URL("../../../examples/acme", import.meta.url));
const ORIGIN = "https://acme-brain.example";
let bundle: RuntimeBundle;
let accessHash: string;
let adminHash: string;

beforeAll(async () => {
  bundle = await buildBundle(ACME_ROOT, { commit: "4e1a9c0" });
  accessHash = await hashCode("acme-team", 10_000);
  adminHash = await hashCode("acme-admin", 10_000);
});

function makeApp(overrides: Partial<ServerDeps> = {}, kv: KVFactory = memoryKVFactory()): App {
  return createApp({
    bundle,
    kv,
    env: { SESSION_SECRET: "test-secret", ACCESS_CODE_HASH: accessHash, ADMIN_CODE_HASH: adminHash, ADMIN_TOKEN: "weekly-token" },
    chatOverride: { provider: "demo", model: "extractive" },
    ...overrides,
  });
}

function post(path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
}

async function login(app: App, code = "acme-team"): Promise<string> {
  const response = await app(post("/api/auth/login", { code }), { ip: "10.0.0.1" });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  return cookie.split(";")[0] ?? "";
}

async function readSse(response: Response): Promise<ChatStreamEvent[]> {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)) as ChatStreamEvent);
}

async function ask(app: App, cookie: string, message: string, conversationId?: string): Promise<ChatStreamEvent[]> {
  return readSse(await app(post("/api/chat", { message, ...(conversationId ? { conversationId } : {}) }, cookie), { ip: "10.0.0.1" }));
}

describe("crypto and sessions", () => {
  it("verifies access codes and rejects tampered sessions", async () => {
    expect(await verifyCode("acme-team", accessHash)).toBe(true);
    expect(await verifyCode("acme-tea", accessHash)).toBe(false);
    const token = await signSession({ sub: "hash:x", email: null, name: null, admin: false, exp: 4_000_000_000 }, "s");
    expect(await verifySession(token, "s")).toMatchObject({ sub: "hash:x", admin: false });
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "hash:x", admin: true, exp: 4_000_000_000 })).toString("base64url");
    expect(await verifySession(`${forged}.${signature}`, "s")).toBeNull();
    expect(await verifySession(`${payload}.${signature}`, "other")).toBeNull();
  });
});

describe("auth", () => {
  it("serves a public config without suggestions, then refuses the chat when signed out", async () => {
    const app = makeApp();
    const config = (await (await app(get("/api/config"))).json()) as PublicConfig;
    expect(config).toMatchObject({ assistantName: "Acme Brain", authMode: "passcode", user: null, demo: true });
    // D19: no suggested questions, every base is different.
    expect("suggestions" in config).toBe(false);
    expect((await app(post("/api/chat", { message: "hi" }))).status).toBe(401);
  });

  it("limits wrong codes to 5 per 15 minutes per IP", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      expect((await app(post("/api/auth/login", { code: "nope" }), { ip: "10.0.0.9" })).status).toBe(401);
    }
    const blocked = await app(post("/api/auth/login", { code: "acme-team" }), { ip: "10.0.0.9" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("refuses an open chatbot outside a local run", () => {
    const config = { ...bundle.config, auth: { mode: "none" } };
    expect(() => makeApp({ bundle: { ...bundle, config } })).toThrow(/refused outside local runs/);
    expect(() => makeApp({ bundle: { ...bundle, config }, local: true })).not.toThrow();
  });
});

describe("chat", () => {
  it("streams steps, citations, text and a final event, then keeps the conversation", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const events = await ask(app, cookie, "How do I add a user in the internal tool?");
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("meta");
    expect(types).toContain("step");
    expect(types).toContain("citation");
    expect(types).toContain("text");
    expect(types.at(-2)).toBe("usage");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    const citation = events.find((e) => e.type === "citation");
    expect(citation?.type === "citation" && citation.citation.url).toMatch(/notion\.so/);

    const meta = events[0];
    if (meta?.type !== "meta") throw new Error("no meta");
    const followUp = await ask(app, cookie, "And how do I deactivate one?", meta.conversationId);
    const meta2 = followUp[0];
    expect(meta2?.type === "meta" && meta2.conversationId).toBe(meta.conversationId);
  });

  it("files a no-answer report, and a thumbs down with its comment", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const gapEvents = await ask(app, cookie, "zorblax quantum flux capacitor?");
    expect(gapEvents.some((e) => e.type === "report")).toBe(true);

    const events = await ask(app, cookie, "What is the price of the Enterprise plan?");
    const meta = events[0];
    if (meta?.type !== "meta") throw new Error("no meta");
    const down = await app(
      post("/api/feedback", { conversationId: meta.conversationId, turnId: meta.turnId, rating: "down", comment: "Old price" }, cookie),
    );
    expect(down.status).toBe(200);

    // A plain member cannot read the reports; the weekly update can, with ADMIN_TOKEN.
    expect((await app(get("/api/admin/reports", cookie))).status).toBe(403);
    const response = await app(get("/api/admin/reports?status=open", undefined, { authorization: "Bearer weekly-token" }));
    const { reports } = (await response.json()) as ReportsResponse;
    const thumbs = reports.find((r) => r.type === "thumbs_down");
    const gap = reports.find((r) => r.type === "no_answer");
    expect(thumbs).toMatchObject({ question: "What is the price of the Enterprise plan?", comment: "Old price", deploy: { commit: "4e1a9c0" } });
    expect(thumbs?.citations?.length).toBeGreaterThan(0);
    expect(thumbs?.searches?.[0]?.results.length).toBeGreaterThan(0);
    expect(thumbs?.user).toMatch(/^hash:/);
    expect(gap).toMatchObject({ reason: "not_found", searched: ["zorblax quantum flux capacitor?"] });

    const mark = await app(post("/api/admin/reports/mark", { ids: [gap?.id], status: "done" }, undefined, { authorization: "Bearer weekly-token" }));
    expect(await mark.json()).toMatchObject({ changed: 1 });
    const open = (await (await app(get("/api/admin/reports?status=open", undefined, { authorization: "Bearer weekly-token" }))).json()) as ReportsResponse;
    expect(open.reports.map((r) => r.type)).toEqual(["thumbs_down"]);
  });

  it("stops answering when the monthly budget is spent", async () => {
    const kv = memoryKVFactory();
    await kv("usage").set(`month/${new Date().toISOString().slice(0, 7)}`, { questions: 900, costUsd: 51 });
    const app = makeApp({}, kv);
    const cookie = await login(app);
    const response = await app(post("/api/chat", { message: "hello" }, cookie));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "budget" } });
  });

  it("refuses cross-origin chat requests", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const response = await app(post("/api/chat", { message: "hello" }, cookie, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
  });
});

describe("admin and knowledge browser", () => {
  it("switches the chat model hot, without a redeploy", async () => {
    const app = makeApp({ chatOverride: undefined });
    const adminCookie = await (async () => {
      const cookie = await login(app);
      const upgraded = await app(post("/api/auth/admin", { code: "acme-admin" }, cookie), { ip: "10.0.0.2" });
      expect(upgraded.status).toBe(200);
      return (upgraded.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    })();
    const before = (await (await app(get("/api/admin/models", adminCookie))).json()) as ModelsResponse;
    expect(before.roles.chat).toMatchObject({ model: "anthropic:claude-opus-5-5", effort: "low", source: "config" });
    expect(before.providers.find((p) => p.id === "anthropic")).toMatchObject({ configured: false, envKeys: ["ANTHROPIC_API_KEY"] });

    const update = await app(post("/api/admin/models", { chat: { model: "demo:extractive", effort: null } }, adminCookie));
    expect(update.status).toBe(200);
    const after = (await (await app(get("/api/admin/models", adminCookie))).json()) as ModelsResponse;
    expect(after.roles.chat).toMatchObject({ model: "demo:extractive", source: "settings" });
    const config = (await (await app(get("/api/config", adminCookie))).json()) as PublicConfig;
    expect(config.demo).toBe(true);

    const bad = await app(post("/api/admin/models", { chat: { model: "nope" } }, adminCookie));
    expect(bad.status).toBe(400);
  });

  it("lists the sections and renders a page with its Notion link", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const index = (await (await app(get("/api/kb", cookie))).json()) as { sections: Array<{ id: string; pages: Array<{ id: string }> }> };
    expect(index.sections.map((s) => s.id)).toContain("internal-tools");
    const page = (await (await app(get("/api/kb/page?id=internal-tools/accounts", cookie))).json()) as { markdown: string; url: string };
    expect(page.markdown).toContain("Add teammate");
    expect(page.url).toMatch(/notion\.so/);
    expect((await app(get("/api/kb/page?id=nope", cookie))).status).toBe(404);
  });
});

describe("local file store", () => {
  it("stores keys with any character and lists them back", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { fileKVFactory } = await import("../src/index.ts");
    const kv = fileKVFactory(await mkdtemp(path.join(tmpdir(), "ob-kv-")))("usage");
    await kv.set("day/2026-10-22/hash:local", { questions: 1 });
    await kv.set("month/2026-10", { questions: 2 });
    expect(await kv.get("day/2026-10-22/hash:local")).toEqual({ questions: 1 });
    expect(await kv.list("day/")).toEqual(["day/2026-10-22/hash:local"]);
    await expect(kv.set("../escape", {})).rejects.toThrow(/invalid store key/);
  });
});
