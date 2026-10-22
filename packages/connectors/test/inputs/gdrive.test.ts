import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGdriveConnector,
  DRIVE_READONLY_SCOPE,
  GOOGLE_TOKEN_URL,
  isSkip,
  loadServiceAccount,
  type DocumentsConnector,
  type GdriveConnectorOptions,
  type ServiceAccountKey,
} from "../../src/index.ts";
import { buildDocx, collectAll, expectReadOnly, json, jsonFixture, noSleep, RecordingFetch, text, wPara } from "./helpers.ts";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const NOW = Date.parse("2026-10-22T10:00:00Z");

// The key pair is generated per run: no private key is ever stored in the repository.
let key: ServiceAccountKey;
let publicKey: string;
let recorder: RecordingFetch;
let canEdit: boolean;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  key = {
    client_email: "openbrain-reader@acme-knowledge.iam.gserviceaccount.com",
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    private_key_id: "acme-key-1",
  };
});

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

function filterSince(body: unknown, q: string): unknown {
  const since = /modifiedTime > '([^']+)'/.exec(q)?.[1];
  if (!since) return body;
  const record = body as { files: Array<{ mimeType: string; modifiedTime: string }> };
  return { ...record, files: record.files.filter((f) => f.mimeType.endsWith(".folder") || Date.parse(f.modifiedTime) > Date.parse(since)) };
}

beforeEach(async () => {
  canEdit = false;
  const page1 = await jsonFixture("gdrive/files-root-page1.json");
  const page2 = await jsonFixture("gdrive/files-root-page2.json");
  const policies = await jsonFixture("gdrive/files-policies.json");
  const folder = (await jsonFixture("gdrive/folder-root.json")) as Record<string, unknown>;
  recorder = new RecordingFetch()
    .on(GOOGLE_TOKEN_URL, (_url, call) => {
      const form = new URLSearchParams(call.body ?? "");
      const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
      const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
      const payload = decodePart(claims);
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !valid || payload.scope !== DRIVE_READONLY_SCOPE) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ access_token: "ya29.acme-test", expires_in: 3599, token_type: "Bearer" });
    })
    .on(`${DRIVE}/fold-root`, () => json({ ...folder, capabilities: { canEdit } }))
    .on(DRIVE, (url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.startsWith("'fold-policies' in parents")) return json(filterSince(policies, q));
      if (url.searchParams.get("pageToken") === "page-2") return json(filterSince(page2, q));
      return json(filterSince(page1, q));
    })
    .on(`${DRIVE}/doc-onboarding/export`, (url) =>
      url.searchParams.get("mimeType") === "text/markdown" ? text("# Onboarding\n\n1. Get your laptop\n2. Join #general", "text/markdown") : json({}, 500),
    )
    .on(`${DRIVE}/doc-leave/export`, (url) =>
      url.searchParams.get("mimeType") === "text/plain"
        ? text("Leave policy\r\n\r\nAsk your manager two weeks ahead.", "text/plain")
        : json({ error: { message: "The requested conversion is not supported." } }, 400),
    )
    .on(`${DRIVE}/sheet-pricing/export`, text("Plan,Price\nStarter,10\nBusiness,25\nEnterprise,custom", "text/csv"))
    .on(`${DRIVE}/slides-kickoff/export`, text("Kickoff 2026\nGoals: ship SSO", "text/plain"))
    .on(`${DRIVE}/docx-legacy`, async () => new Response(buildDocx(wPara("Legacy guide", "Heading2") + wPara("Use the old dashboard.")), { status: 200 }))
    .on(`${DRIVE}/md-readme`, text("# Readme\n\nShared drive notes.", "text/markdown"));
});

function drive(extra: Partial<GdriveConnectorOptions> = {}): DocumentsConnector {
  return createGdriveConnector({ serviceAccount: key, folders: ["fold-root"], fetch: recorder.fetch, sleep: noSleep, now: () => NOW, ...extra });
}

describe("gdrive connector", () => {
  it("lists the configured folders recursively, following pagination, with the folder path", async () => {
    const refs = await collectAll(drive().list({}));
    expect(refs.map((r) => [r.id, r.title, r.path?.join(" / ")])).toEqual([
      ["doc-onboarding", "Onboarding", "Acme Handbook"],
      ["sheet-pricing", "Pricing", "Acme Handbook"],
      ["slides-kickoff", "Kickoff 2026", "Acme Handbook"],
      ["docx-legacy", "Legacy guide.docx", "Acme Handbook"],
      ["md-readme", "README.md", "Acme Handbook"],
      ["doc-leave", "Leave policy", "Acme Handbook / Policies"],
    ]);
    expect(refs[0]).toMatchObject({ url: "https://docs.google.com/document/d/doc-onboarding/edit", modifiedAt: "2026-10-20T14:03:11.000Z" });
    const listing = recorder.calls.find((c) => c.url.startsWith(`${DRIVE}?`));
    const params = new URL(listing?.url ?? DRIVE).searchParams;
    expect(params.get("q")).toBe("'fold-root' in parents and trashed = false");
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("is incremental on modifiedTime and still walks the subfolders", async () => {
    const refs = await collectAll(drive().list({ since: "2026-10-19T12:00:00Z" }));
    expect(refs.map((r) => r.id)).toEqual(["doc-onboarding", "doc-leave"]);
    const q = new URL(recorder.calls.find((c) => c.url.startsWith(`${DRIVE}?`))?.url ?? DRIVE).searchParams.get("q");
    expect(q).toBe(
      "'fold-root' in parents and trashed = false and (modifiedTime > '2026-10-19T12:00:00Z' or mimeType = 'application/vnd.google-apps.folder')",
    );
  });

  it("exports Docs as Markdown (plain text fallback), Sheets as a table, Slides as text, and converts uploads", async () => {
    const connector = drive();
    const refs = await collectAll(connector.list({}));
    const markdown = async (id: string): Promise<string> => {
      const ref = refs.find((r) => r.id === id);
      if (!ref) throw new Error(`missing ${id}`);
      return (await connector.fetch(ref)).markdown;
    };
    expect(await markdown("doc-onboarding")).toBe("# Onboarding\n\n1. Get your laptop\n2. Join #general");
    expect(await markdown("doc-leave")).toBe("Leave policy\n\nAsk your manager two weeks ahead.");
    expect(await markdown("sheet-pricing")).toBe("| Plan | Price |\n|---|---|\n| Starter | 10 |\n| Business | 25 |\n| Enterprise | custom |");
    expect(await markdown("slides-kickoff")).toBe("Kickoff 2026\nGoals: ship SSO");
    expect(await markdown("docx-legacy")).toBe("## Legacy guide\n\nUse the old dashboard.");
    expect(await markdown("md-readme")).toBe("# Readme\n\nShared drive notes.");
  });

  it("reports PDFs as skipped when they are in scope", async () => {
    const connector = drive({ mime: ["pdf"] });
    const [pdf] = await collectAll(connector.list({}));
    if (!pdf) throw new Error("missing pdf");
    const error = await connector.fetch(pdf).catch((e: unknown) => e);
    expect(isSkip(error) && error.reason).toMatch(/PDF is not supported in v0\.1/);
  });

  it("signs the JWT locally, exchanges it once, and otherwise only sends GET requests", async () => {
    const connector = drive();
    for (const ref of await collectAll(connector.list({}))) await connector.fetch(ref);
    expectReadOnly(recorder.calls, [GOOGLE_TOKEN_URL]);
    expect(recorder.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const [, claims] = new URLSearchParams(recorder.calls[0]?.body ?? "").get("assertion")?.split(".") ?? [];
    expect(decodePart(claims)).toMatchObject({ iss: key.client_email, aud: GOOGLE_TOKEN_URL, scope: DRIVE_READONLY_SCOPE, exp: NOW / 1000 + 3600 });
    expect(recorder.calls.slice(1).every((c) => c.headers.authorization === "Bearer ya29.acme-test")).toBe(true);
  });

  it("test(): service account identity, read-only scope, folder access and a sample", async () => {
    const report = await drive().test();
    expect(report).toMatchObject({
      ok: true,
      identity: "service account openbrain-reader@acme-knowledge.iam.gserviceaccount.com",
      scopes: [DRIVE_READONLY_SCOPE, 'folder "Acme Handbook": viewer'],
      writeScopesDetected: false,
    });
    expect(report.sample?.map((r) => r.id)).toEqual(["doc-onboarding", "sheet-pricing", "slides-kickoff"]);
    canEdit = true;
    expect((await drive().test()).writeScopesDetected).toBe(true);
  });

  it("test() reports a key the token endpoint rejects", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const report = await drive({ serviceAccount: { ...key, private_key: other } }).test();
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/token exchange failed: HTTP 400/);
  });

  it("loads the service account from inline JSON or a file, and rejects anything else", async () => {
    const inline = JSON.stringify({ type: "service_account", project_id: "acme-knowledge", ...key });
    expect(loadServiceAccount(inline)).toMatchObject({ client_email: key.client_email, project_id: "acme-knowledge" });
    const dir = await mkdtemp(path.join(tmpdir(), "openbrain-sa-"));
    await writeFile(path.join(dir, "sa.json"), inline);
    expect(loadServiceAccount("sa.json", dir).client_email).toBe(key.client_email);
    expect(() => loadServiceAccount("missing.json", dir)).toThrow(/cannot be read/);
    expect(() => loadServiceAccount('{"client_email":"x"}')).toThrow(/not a service account key/);
  });
});
