import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWebConnector,
  isAllowedByRobots,
  isSkip,
  parseRobots,
  parseSitemap,
  type DocumentsConnector,
  type WebConnectorOptions,
} from "../../src/index.ts";
import { collectAll, expectReadOnly, fixture, RecordingFetch, text } from "./helpers.ts";

const NOW = Date.parse("2026-10-22T10:00:00Z");

let recorder: RecordingFetch;
let clock: number;
let sleeps: number[];

beforeEach(async () => {
  clock = NOW;
  sleeps = [];
  const page = await fixture("web/acme-docs-sso.html");
  recorder = new RecordingFetch()
    .on("https://acme.example/robots.txt", text(await fixture("web/robots.txt")))
    .on("https://acme.example/sitemap.xml", text(await fixture("web/sitemap.xml"), "application/xml"))
    .on("https://acme.example/sitemap-docs.xml", text(await fixture("web/sitemap-docs.xml"), "application/xml"))
    .on("https://acme.example/sitemap-blog.xml.gz", text(gzipSync(await fixture("web/sitemap-blog.xml")), "application/gzip"))
    .on("https://acme.example/docs/sso", (_url, call) =>
      call.headers["if-modified-since"] && Date.parse(call.headers["if-modified-since"]) >= Date.parse("2026-10-20T08:30:00Z")
        ? new Response(null, { status: 304 })
        : text(page, "text/html; charset=utf-8", 200, { "last-modified": "Tue, 20 Oct 2026 08:30:00 GMT" }),
    )
    .on("https://acme.example/changelog", text("Acme changelog\n\n- Exports in CSV", "text/plain"))
    .on("https://acme.example/docs/private/public-page", text("<main><h1>Public</h1><p>Open page.</p></main>", "text/html"))
    .on("https://acme.example/report.pdf", text("%PDF-1.4", "application/pdf"));
});

function web(extra: Partial<WebConnectorOptions> = {}): DocumentsConnector {
  return createWebConnector({
    sitemaps: ["https://acme.example/sitemap.xml"],
    urls: ["https://acme.example/changelog"],
    include: ["/docs/", "/blog/"],
    exclude: ["/blog/drafts/"],
    fetch: recorder.fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  });
}

describe("robots.txt", () => {
  it("applies the most specific group, the longest rule, and Allow on ties", async () => {
    const policy = parseRobots(await fixture("web/robots.txt"), "openbrain");
    expect(isAllowedByRobots(policy, "/docs/private/roadmap")).toBe(false);
    expect(isAllowedByRobots(policy, "/docs/private/public-page")).toBe(true);
    // The OpenBrain group replaces the * group: its rules and crawl delay do not apply.
    expect(isAllowedByRobots(policy, "/docs/internal/x")).toBe(true);
    expect(policy.crawlDelaySec).toBeUndefined();
    const generic = parseRobots(await fixture("web/robots.txt"), "otherbot");
    expect(isAllowedByRobots(generic, "/docs/internal/x")).toBe(false);
    expect(generic.crawlDelaySec).toBe(5);
  });

  it("supports * and $ patterns", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?\nAllow: /", "openbrain");
    expect(isAllowedByRobots(policy, "/files/report.pdf")).toBe(false);
    expect(isAllowedByRobots(policy, "/files/report.pdf?v=2")).toBe(true);
    expect(isAllowedByRobots(policy, "/search?q=sso")).toBe(false);
    expect(isAllowedByRobots(policy, "/docs")).toBe(true);
  });
});

describe("sitemap", () => {
  it("parses url sets and sitemap indexes", async () => {
    expect(parseSitemap(await fixture("web/sitemap.xml"))).toEqual({
      urls: [],
      sitemaps: ["https://acme.example/sitemap-docs.xml", "https://acme.example/sitemap-blog.xml.gz"],
    });
    expect(parseSitemap(await fixture("web/sitemap-docs.xml")).urls[0]).toEqual({ url: "https://acme.example/docs/sso", lastmod: "2026-10-20T08:00:00+00:00" });
  });
});

describe("web connector", () => {
  it("lists listed URLs and nested, gzipped sitemaps, filtered by host and path prefixes", async () => {
    const refs = await collectAll(web().list({}));
    expect(refs.map((r) => r.id)).toEqual([
      "https://acme.example/changelog",
      "https://acme.example/docs/sso",
      "https://acme.example/docs/billing",
      "https://acme.example/docs/private/roadmap",
      "https://acme.example/docs/private/public-page",
      "https://acme.example/blog/launch",
    ]);
    expect(refs[1]).toMatchObject({ title: "sso", modifiedAt: "2026-10-20T08:00:00.000Z", path: ["acme.example", "docs"] });
  });

  it("is incremental on lastmod, keeps pages without a date, and caps max_pages", async () => {
    const recent = await collectAll(web().list({ since: "2026-10-10T00:00:00Z" }));
    expect(recent.map((r) => new URL(r.id).pathname)).toEqual(["/changelog", "/docs/sso", "/docs/private/roadmap", "/docs/private/public-page", "/blog/launch"]);
    expect(await collectAll(web({ maxPages: 2 }).list({}))).toHaveLength(2);
  });

  it("converts the main content and dates it from Last-Modified", async () => {
    const connector = web();
    const refs = await collectAll(connector.list({}));
    const sso = refs.find((r) => r.id.endsWith("/docs/sso"));
    if (!sso) throw new Error("missing ref");
    const doc = await connector.fetch(sso);
    expect(doc.title).toBe("Single sign-on | Acme Docs");
    expect(doc.modifiedAt).toBe("2026-10-20T08:30:00.000Z");
    expect(doc.markdown).toContain("[Security](https://acme.example/docs/security)");
    expect(doc.markdown).not.toContain("Pricing");
    expect(doc.metadata).toMatchObject({ status: 200, modified_at_known: true });
    const changelog = await connector.fetch({ id: "https://acme.example/changelog", url: "https://acme.example/changelog", title: "changelog", modifiedAt: sso.modifiedAt });
    expect(changelog.markdown).toBe("Acme changelog\n\n- Exports in CSV");
  });

  it("skips pages disallowed by robots.txt, not modified, or not HTML", async () => {
    const connector = web();
    const refs = await collectAll(connector.list({ since: "2026-10-20T12:00:00Z" }));
    const roadmap = refs.find((r) => r.id.endsWith("/roadmap"));
    if (!roadmap) throw new Error("missing ref");
    const blocked = await connector.fetch(roadmap).catch((e: unknown) => e);
    expect(isSkip(blocked) && blocked.reason).toBe("disallowed by robots.txt");
    expect(recorder.urls()).not.toContain("https://acme.example/docs/private/roadmap");
    const sso = await connector.fetch({ id: "https://acme.example/docs/sso", url: "https://acme.example/docs/sso", title: "sso", modifiedAt: roadmap.modifiedAt }).catch((e: unknown) => e);
    expect(isSkip(sso) && sso.reason).toMatch(/^not modified since/);
    const pdf = await connector.fetch({ id: "https://acme.example/report.pdf", url: "https://acme.example/report.pdf", title: "report", modifiedAt: roadmap.modifiedAt }).catch((e: unknown) => e);
    expect(isSkip(pdf) && pdf.reason).toBe("unsupported content type application/pdf");
  });

  it("treats an unreachable robots.txt (5xx) as disallow all", async () => {
    const down = new RecordingFetch()
      .on("https://acme.example/robots.txt", text("down", "text/plain", 503))
      .on("https://acme.example/changelog", text("x"));
    const connector = createWebConnector({ urls: ["https://acme.example/changelog"], fetch: down.fetch, sleep: async () => undefined, delayMs: 0 });
    const [ref] = await collectAll(connector.list({}));
    if (!ref) throw new Error("missing ref");
    const error = await connector.fetch(ref).catch((e: unknown) => e);
    expect(isSkip(error) && error.reason).toMatch(/robots\.txt unreachable/);
  });

  it("only sends GET requests, one at a time with the polite delay, with an OpenBrain user agent", async () => {
    const connector = web();
    for (const ref of await collectAll(connector.list({}))) await connector.fetch(ref).catch(() => undefined);
    expectReadOnly(recorder.calls);
    expect(recorder.calls.every((c) => /OpenBrain/.test(c.headers["user-agent"] ?? ""))).toBe(true);
    expect(sleeps.length).toBe(recorder.calls.length - 1);
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
  });

  it("test() reports hosts, counts and robots exclusions", async () => {
    const report = await web().test();
    expect(report).toMatchObject({ ok: true, writeScopesDetected: false });
    expect(report.identity).toBe("web: acme.example (6 URLs from 1 sitemap and 1 listed, 1 disallowed by robots.txt, max_pages 200)");
    expect(report.sample?.map((r) => r.id)).toEqual([
      "https://acme.example/changelog",
      "https://acme.example/docs/sso",
      "https://acme.example/docs/billing",
    ]);
  });
});
