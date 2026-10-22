import { describe, expect, it } from "vitest";
import {
  csvToMarkdown,
  detectSensitive,
  docxToMarkdown,
  firstJsonPath,
  globFilter,
  htmlToMarkdown,
  ibanValid,
  luhnValid,
  matchGlob,
  nirValid,
  parseCsv,
  pptxToMarkdown,
  queryJsonPath,
  ReadOnlyHttp,
  ReadOnlyViolationError,
  readZip,
  renderTemplate,
  resolveMappingValue,
  withRetry,
} from "../../src/index.ts";
import { buildDocx, buildPptx, buildZip, fixture, json, RecordingFetch, slideXml, wPara } from "./helpers.ts";

describe("glob", () => {
  it("anchors patterns on the whole relative path", () => {
    expect(matchGlob("README.md", "README.md")).toBe(true);
    expect(matchGlob("docs/README.md", "README.md")).toBe(false);
    expect(matchGlob("docs/setup.md", "docs/**/*.md")).toBe(true);
    expect(matchGlob("docs/guides/deep/setup.md", "docs/**/*.md")).toBe(true);
    expect(matchGlob("src/docs/setup.md", "docs/**/*.md")).toBe(false);
  });

  it("supports **, *, ?, classes and alternatives", () => {
    expect(matchGlob("a.md", "**/*.md")).toBe(true);
    expect(matchGlob("x/y/a.md", "**/*.md")).toBe(true);
    expect(matchGlob("x/a.txt", "**/*.{md,txt}")).toBe(true);
    expect(matchGlob("x/a.csv", "**/*.{md,txt}")).toBe(false);
    expect(matchGlob("v1.md", "v?.md")).toBe(true);
    expect(matchGlob("v12.md", "v?.md")).toBe(false);
    expect(matchGlob("a/b.md", "*.md")).toBe(false);
    expect(matchGlob("notes-b.md", "notes-[ab].md")).toBe(true);
    expect(matchGlob("notes-c.md", "notes-[!ab].md")).toBe(true);
    expect(matchGlob("drafts/x.md", "drafts/**")).toBe(true);
    expect(matchGlob("./docs/a.md", "docs/*.md")).toBe(true);
  });

  it("filters with include and exclude", () => {
    expect(globFilter("docs/a.md", [], [])).toBe(true);
    expect(globFilter("docs/a.md", ["**/*.md"], ["docs/**"])).toBe(false);
    expect(globFilter("guide/a.md", ["**/*.md"], ["docs/**"])).toBe(true);
  });
});

describe("JSONPath subset", () => {
  const data = {
    issues: [
      { id: "ACME-1", title: "Login fails", state: { name: "Done" }, labels: ["bug", "auth"] },
      { id: "ACME-2", title: "Export CSV", state: { name: "Todo" }, labels: [] },
    ],
    pageInfo: { endCursor: "c2", "has-next": true },
  };

  it("queries keys, wildcards, indexes and quoted keys", () => {
    expect(queryJsonPath(data, "$.issues[*].id")).toEqual(["ACME-1", "ACME-2"]);
    expect(firstJsonPath(data, "$.issues[0].state.name")).toBe("Done");
    expect(firstJsonPath(data, "$.issues[-1].id")).toBe("ACME-2");
    expect(firstJsonPath(data, "$.pageInfo['has-next']")).toBe(true);
    expect(queryJsonPath(data, "$.missing.key")).toEqual([]);
    expect(firstJsonPath(data, "$")).toBe(data);
    expect(() => queryJsonPath(data, "$..id")).toThrow(/recursive descent/);
  });

  it("renders templates and bare paths", () => {
    const item = data.issues[0];
    expect(renderTemplate("{{$.title}}\n\nStatus: {{$.state.name}} ({{since}})", item, { since: "2026-10-01" })).toBe(
      "Login fails\n\nStatus: Done (2026-10-01)",
    );
    expect(renderTemplate("Labels: {{$.labels}}", item)).toBe("Labels: bug, auth");
    expect(resolveMappingValue("$.id", item)).toBe("ACME-1");
    expect(resolveMappingValue("$.labels[*]", item)).toEqual(["bug", "auth"]);
  });
});

describe("HTML to Markdown", () => {
  it("keeps the main content and drops the chrome", async () => {
    const { title, markdown } = htmlToMarkdown(await fixture("web/acme-docs-sso.html"), { baseUrl: "https://acme.example/docs/sso" });
    expect(title).toBe("Single sign-on | Acme Docs");
    expect(markdown).toContain("# Single sign-on");
    expect(markdown).toContain("## Requirements");
    expect(markdown).toContain("Acme supports **SAML 2.0** and *OpenID Connect*.");
    expect(markdown).toContain("- An admin account\n- Your identity provider metadata URL");
    expect(markdown).toContain("1. Open **Settings**\n2. Click [Security](https://acme.example/docs/security)\n   - Choose SAML");
    expect(markdown).toContain("| Plan | SSO | Price |\n|---|---|---|\n| Starter | No | 10 \\| 12 EUR |\n| Business | Yes | 25 EUR |");
    expect(markdown).toContain("```bash\nacme sso enable --provider okta\n```");
    expect(markdown).toContain("> Allow up to 24 hours for the change to apply.");
    expect(markdown).toContain("If the login loops, run `acme login` again.");
    expect(markdown).not.toContain("Pricing");
    expect(markdown).not.toContain("tracking");
    expect(markdown).not.toContain("Cookie");
    expect(markdown).not.toContain("All rights reserved");
    expect(markdown).not.toContain("javascript");
  });

  it("falls back to the body and drops page headers there", () => {
    const html = "<html><body><header><a href='/'>Home</a></header><h2>Hello</h2><p>World &amp; more&nbsp;text</p><footer>legal</footer></body></html>";
    expect(htmlToMarkdown(html).markdown).toBe("## Hello\n\nWorld & more text");
  });

  it("closes implied paragraphs and list items", () => {
    const html = "<main><p>One<p>Two<ul><li>a<li>b</ul><dl><dt>Term<dd>Definition</dl></main>";
    expect(htmlToMarkdown(html).markdown).toBe("One\n\nTwo\n\n- a\n- b\n\n**Term**\n\nDefinition");
  });
});

describe("CSV", () => {
  it("parses quotes, embedded delimiters and newlines, and guesses the delimiter", () => {
    expect(parseCsv('name,notes\n"Acme, Inc.","line 1\nline 2"\n"say ""hi""",x\n')).toEqual([
      ["name", "notes"],
      ["Acme, Inc.", "line 1\nline 2"],
      ['say "hi"', "x"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("caps the rows of the Markdown table", () => {
    const csv = ["plan,price", ...Array.from({ length: 5 }, (_, i) => `p${i},${i}`)].join("\n");
    const table = csvToMarkdown(csv, 2);
    expect(table.markdown).toBe("| plan | price |\n|---|---|\n| p0 | 0 |\n| p1 | 1 |\n\n(3 more rows not shown, 5 in total)");
    expect(table).toMatchObject({ rows: 5, truncated: true });
  });
});

describe("ZIP and Office", () => {
  it("reads stored and deflated entries", () => {
    for (const store of [true, false]) {
      const zip = readZip(buildZip({ "a.txt": "hello", "dir/b.txt": "world".repeat(100) }, { store }));
      expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
      expect(zip.read("a.txt")?.toString()).toBe("hello");
      expect(zip.read("dir/b.txt")?.toString()).toBe("world".repeat(100));
      expect(zip.read("missing")).toBeUndefined();
    }
  });

  it("refuses non-ZIP data and oversized entries", () => {
    expect(() => readZip(Buffer.from("not a zip at all, definitely not"))).toThrow(/not a ZIP/);
    const zip = readZip(buildZip({ "big.txt": "x".repeat(10_000) }), { maxEntryBytes: 100 });
    expect(() => zip.read("big.txt")).toThrow(/too large/);
  });

  it("extracts .docx headings, paragraphs, lists and tables", () => {
    const table = `<w:tbl><w:tr><w:tc>${wPara("Plan")}</w:tc><w:tc>${wPara("Seats")}</w:tc></w:tr><w:tr><w:tc>${wPara("Business")}</w:tc><w:tc>${wPara("50")}</w:tc></w:tr></w:tbl>`;
    const docx = buildDocx(
      [
        wPara("Acme onboarding", "Title"),
        wPara("Before you start", "Heading1"),
        wPara("Create the workspace &amp; invite the team."),
        wPara("Admin account", undefined, 0),
        wPara("Billing contact", undefined, 1),
        table,
        `<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>`,
      ].join(""),
    );
    expect(docxToMarkdown(docx)).toBe(
      "# Acme onboarding\n\n# Before you start\n\nCreate the workspace & invite the team.\n\n- Admin account\n  - Billing contact\n\n| Plan | Seats |\n|---|---|\n| Business | 50 |\n\nKept",
    );
  });

  it("extracts .pptx slides in presentation order", () => {
    const pptx = buildPptx([slideXml("Roadmap", ["Q1: SSO", "Q2: Exports"]), slideXml("Welcome", ["Acme in 2026"])], [1, 0]);
    expect(pptxToMarkdown(pptx)).toBe("## Slide 1: Welcome\n\n- Acme in 2026\n\n## Slide 2: Roadmap\n\n- Q1: SSO\n- Q2: Exports");
  });
});

describe("sensitive data detection", () => {
  it("validates cards, IBANs and French social security numbers", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanValid("FR76 3000 6000 0112 3456 7890 189")).toBe(true);
    expect(ibanValid("FR76 3000 6000 0112 3456 7890 188")).toBe(false);
    expect(nirValid("1 85 05 78 006 084 91")).toBe(true);
    expect(nirValid("1 85 05 78 006 084 90")).toBe(false);
  });

  it("reports kinds, counts and lines, never the values", () => {
    const content = [
      "Contact: jane.doe@acme.example or +33 6 12 34 56 78",
      "IBAN FR76 3000 6000 0112 3456 7890 189",
      "Card 4111 1111 1111 1111, order 1234567890123456",
      "NIR 1 85 05 78 006 084 91",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 and ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "slack xoxb-123456789012-abcdefghijkl, aws AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "Released on 2026-10-01, version 1.2.3, invoice 2026-0042, call 06 12 34 56 78",
    ].join("\n");
    const findings = detectSensitive(content);
    const byKind = Object.fromEntries(findings.map((f) => [f.kind, { count: f.count, lines: f.lines, category: f.category }]));
    expect(byKind).toEqual({
      private_key: { count: 1, lines: [7], category: "secret" },
      aws_access_key: { count: 1, lines: [6], category: "secret" },
      github_token: { count: 1, lines: [5], category: "secret" },
      slack_token: { count: 1, lines: [6], category: "secret" },
      api_key: { count: 1, lines: [5], category: "secret" },
      email: { count: 1, lines: [1], category: "pii" },
      iban: { count: 1, lines: [2], category: "pii" },
      fr_social_security: { count: 1, lines: [4], category: "pii" },
      card_number: { count: 1, lines: [3], category: "pii" },
      phone: { count: 2, lines: [1, 8], category: "pii" },
    });
    expect(JSON.stringify(findings)).not.toMatch(/jane|4111|FR76|sk-ant|ghp_|xoxb|AKIA/);
  });

  it("finds nothing in ordinary text", () => {
    expect(detectSensitive("Acme Business plan: 25 EUR per seat, 3 seats, since 2026-10-01 (ticket 4521).")).toEqual([]);
  });
});

describe("read-only HTTP", () => {
  it("retries 429 with Retry-After and 5xx with backoff", async () => {
    const delays: number[] = [];
    let n = 0;
    const response = await withRetry(
      async () => {
        n++;
        if (n === 1) return json({}, 429, { "retry-after": "2" });
        if (n === 2) return json({}, 503);
        return json({ ok: true });
      },
      { sleep: async (ms) => void delays.push(ms), baseDelayMs: 100 },
    );
    expect(response.status).toBe(200);
    expect(delays).toEqual([2000, 200]);
  });

  it("does not retry a 404 and gives up after maxAttempts", async () => {
    let n = 0;
    const notFound = await withRetry(async () => {
      n++;
      return json({}, 404);
    });
    expect([notFound.status, n]).toEqual([404, 1]);
    const failing = await withRetry(async () => json({}, 500), { maxAttempts: 3, sleep: async () => undefined });
    expect(failing.status).toBe(500);
  });

  it("refuses any POST outside the declared token endpoints", async () => {
    const recorder = new RecordingFetch().on("https://oauth.acme.example/token", json({ access_token: "t" }));
    const http = new ReadOnlyHttp({ fetch: recorder.fetch, tokenEndpoints: ["https://oauth.acme.example/token"] });
    await expect(http.postTokenForm("https://api.acme.example/items", { a: "1" })).rejects.toBeInstanceOf(ReadOnlyViolationError);
    await expect(http.postTokenForm("https://oauth.acme.example/token", { grant_type: "x" })).resolves.toEqual({ access_token: "t" });
    expect(recorder.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://oauth.acme.example/token"]);
  });
});
