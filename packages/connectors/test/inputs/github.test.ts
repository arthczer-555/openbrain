import { beforeEach, describe, expect, it } from "vitest";
import { createGithubConnector, type GithubConnector, type GithubConnectorOptions } from "../../src/index.ts";
import { collectAll, expectReadOnly, json, jsonFixture, noSleep, RecordingFetch, text } from "./helpers.ts";

const API = "https://api.github.com/repos/acme/app";
const NOW = Date.parse("2026-10-22T10:00:00Z");
const WINDOW = { since: "2026-10-15T00:00:00Z", until: "2026-10-22T00:00:00Z" };

const LAST_CHANGE: Record<string, string> = {
  "README.md": "2026-09-30T12:00:00Z",
  "docs/api/auth.md": "2026-10-21T09:15:00Z",
  "docs/setup.md": "2026-10-16T10:00:00Z",
};

const RAW: Record<string, string> = {
  "README.md": "# Acme app\n\nThe Acme planning app.",
  "docs/setup.md": "# Setup\n\nRun `acme init`, then invite the team.",
  "docs/api/auth.md": "Authenticate with a workspace token.",
};

let recorder: RecordingFetch;

beforeEach(async () => {
  const page1 = await jsonFixture("github/commits-page1.json");
  const page2 = await jsonFixture("github/commits-page2.json");
  recorder = new RecordingFetch()
    .on("https://api.github.com/user", json(await jsonFixture("github/user.json")))
    .on(API, json(await jsonFixture("github/repo.json")))
    .on(`${API}/git/trees/main`, json(await jsonFixture("github/tree.json")))
    .on(`${API}/commits`, (url) => {
      const filePath = url.searchParams.get("path");
      if (filePath) return json([{ sha: "f".repeat(40), commit: { committer: { date: LAST_CHANGE[filePath] } } }]);
      if (url.searchParams.get("page") === "2") return json(page2);
      return json(page1, 200, { link: `<${url.href}&page=2>; rel="next", <${url.href}&page=2>; rel="last"` });
    })
    .on(`${API}/commits/${"c3".repeat(20)}`, json(await jsonFixture("github/commit-c3.json")))
    .on(`${API}/commits/${"b0".repeat(20)}`, json(await jsonFixture("github/commit-b0.json")))
    .on(`${API}/commits/${"c1".repeat(20)}`, json(await jsonFixture("github/commit-c1.json")))
    .on(`${API}/pulls`, json(await jsonFixture("github/pulls.json")))
    .on(/\/repos\/acme\/app\/contents\//, (url) => {
      const filePath = decodeURIComponent(url.pathname.replace("/repos/acme/app/contents/", ""));
      const body = RAW[filePath];
      return body === undefined ? json({ message: "Not Found" }, 404) : text(body, "text/plain");
    });
});

function github(extra: Partial<GithubConnectorOptions> = {}): GithubConnector {
  return createGithubConnector({ token: "github_pat_test", repos: ["acme/app"], fetch: recorder.fetch, sleep: noSleep, now: () => NOW, ...extra });
}

describe("github connector", () => {
  it("lists the docs matching docs_globs, dated by their last commit", async () => {
    const refs = await collectAll(github().list({}));
    expect(refs).toEqual([
      {
        id: "acme/app:README.md",
        url: "https://github.com/acme/app/blob/main/README.md",
        title: "README.md",
        modifiedAt: "2026-09-30T12:00:00.000Z",
        path: ["acme/app"],
      },
      {
        id: "acme/app:docs/api/auth.md",
        url: "https://github.com/acme/app/blob/main/docs/api/auth.md",
        title: "docs/api/auth.md",
        modifiedAt: "2026-10-21T09:15:00.000Z",
        path: ["acme/app", "docs", "api"],
      },
      {
        id: "acme/app:docs/setup.md",
        url: "https://github.com/acme/app/blob/main/docs/setup.md",
        title: "docs/setup.md",
        modifiedAt: "2026-10-16T10:00:00.000Z",
        path: ["acme/app", "docs"],
      },
    ]);
  });

  it("collects incrementally: only docs touched by commits since `since`", async () => {
    const refs = await collectAll(github().list({ since: WINDOW.since }));
    expect(refs.map((r) => [r.id, r.modifiedAt])).toEqual([
      ["acme/app:docs/api/auth.md", "2026-10-21T09:15:00.000Z"],
      ["acme/app:docs/setup.md", "2026-10-16T10:00:00.000Z"],
    ]);
    // Per-file history is not needed in incremental mode.
    expect(recorder.urls().some((u) => u.includes("path="))).toBe(false);
  });

  it("fetches raw content and titles the doc from its first heading", async () => {
    const connector = github();
    const [, auth, setup] = await collectAll(connector.list({}));
    if (!auth || !setup) throw new Error("missing refs");
    const doc = await connector.fetch(setup);
    expect(doc).toMatchObject({ title: "Setup (docs/setup.md)", markdown: "# Setup\n\nRun `acme init`, then invite the team.", metadata: { repo: "acme/app", branch: "main" } });
    expect((await connector.fetch(auth)).title).toBe("docs/api/auth.md");
    const raw = recorder.calls.find((c) => c.url.includes("/contents/docs/setup.md"));
    expect(raw?.headers.accept).toBe("application/vnd.github.raw+json");
    expect(raw?.url).toContain("?ref=main");
    await expect(connector.fetch({ id: "other/repo:README.md", title: "x", modifiedAt: WINDOW.since })).rejects.toThrow(/not a configured repository/);
  });

  it("streams commits (no merges, no bots) and merged pull requests of the window", async () => {
    const events = await collectAll(github().changes(WINDOW));
    expect(events.map((e) => [e.ref.id, e.kind, e.occurredAt, e.author])).toEqual([
      ["acme/app@c3c3c3c", "commit", "2026-10-21T09:15:00.000Z", "dev-a"],
      ["acme/app@c1c1c1c", "commit", "2026-10-16T10:00:00.000Z", "dev-c"],
      ["acme/app#42", "pull_request", "2026-10-20T16:00:00.000Z", "dev-b"],
    ]);
    expect(events[0]?.text).toBe("Fix SSO redirect loop\n\n2 files changed (+12 -3) on acme/app@main");
    expect(events[2]?.ref.title).toBe("PR #42: Add SSO with SAML");
    expect(events[2]?.text).toBe(
      "Merged pull request #42 into main: Add SSO with SAML\n\nAdds SAML 2.0 single sign-on for Business workspaces.\n\nCloses #40\n\nLabels: feature, auth",
    );
    // Pull requests are sorted by update: the listing stops at the first one older than the window.
    expect(recorder.urls().filter((u) => u.includes("/pulls"))).toHaveLength(1);
  });

  it("only sends GET requests with the token in a header, never in the URL", async () => {
    const connector = github();
    for (const ref of await collectAll(connector.list({}))) await connector.fetch(ref);
    await collectAll(connector.changes(WINDOW));
    await connector.test();
    expectReadOnly(recorder.calls);
    expect(recorder.calls.every((c) => c.headers.authorization === "Bearer github_pat_test")).toBe(true);
    expect(recorder.urls().some((u) => u.includes("github_pat_test"))).toBe(false);
  });

  it("test(): identity, repository access, and a read-only verdict for a fine-grained token", async () => {
    const report = await github().test();
    expect(report).toMatchObject({ ok: true, identity: "user acme-reader", writeScopesDetected: false });
    expect(report.scopes).toContain("acme/app: pull");
    expect(report.sample?.map((r) => r.id)).toEqual(["acme/app:README.md", "acme/app:docs/api/auth.md", "acme/app:docs/setup.md"]);
  });

  it("test() flags write access: classic repo scope or push permission", async () => {
    const classic = new RecordingFetch()
      .on("https://api.github.com/user", json({ login: "acme-admin" }, 200, { "x-oauth-scopes": "repo, read:org" }))
      .on(API, json({ ...((await jsonFixture("github/repo.json")) as Record<string, unknown>), permissions: { admin: true, push: true, pull: true } }))
      .on(`${API}/git/trees/main`, json({ tree: [], truncated: false }));
    const report = await createGithubConnector({ token: "ghp_x", repos: ["acme/app"], fetch: classic.fetch, sleep: noSleep }).test();
    expect(report.writeScopesDetected).toBe(true);
    expect(report.scopes).toEqual(["classic: repo", "classic: read:org", "acme/app: admin"]);
  });

  it("test() reports a rejected token", async () => {
    const rejected = new RecordingFetch().on("https://api.github.com/user", json({ message: "Bad credentials" }, 401));
    const report = await createGithubConnector({ token: "bad", repos: ["acme/app"], fetch: rejected.fetch, sleep: noSleep }).test();
    expect(report).toMatchObject({ ok: false, error: "token rejected (401): check GITHUB_TOKEN" });
  });

  it("waits for the rate limit reset on 403 x-ratelimit-remaining: 0", async () => {
    const sleeps: number[] = [];
    let first = true;
    const limited = new RecordingFetch().on(API, () => {
      if (first) {
        first = false;
        return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 2) });
      }
      return json({ default_branch: "main", html_url: "https://github.com/acme/app", permissions: { pull: true } });
    });
    limited.on(`${API}/git/trees/main`, json({ tree: [] }));
    const connector = createGithubConnector({ token: "t", repos: ["acme/app"], fetch: limited.fetch, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
    expect(await collectAll(connector.list({}))).toEqual([]);
    expect(sleeps).toEqual([3000]);
  });
});
