import { describe, expect, it } from "vitest";
import { parseMirrorFrontmatter, parseRoutingRegistry, splitFrontmatter } from "../src/index.ts";
import { mirrorDoc } from "./helpers.ts";

describe("splitFrontmatter", () => {
  it("separates YAML from the body", () => {
    const { data, body } = splitFrontmatter("---\ntitle: Hello\n---\n\n# Body\n");
    expect(data).toEqual({ title: "Hello" });
    expect(body.trim()).toBe("# Body");
  });

  it("throws without frontmatter", () => {
    expect(() => splitFrontmatter("# No frontmatter")).toThrow(/frontmatter/);
  });
});

describe("parseMirrorFrontmatter", () => {
  it("accepts a page of the Notion mirror", () => {
    const result = parseMirrorFrontmatter(mirrorDoc("product/booking", "# Booking\n\nText."));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("product/booking");
    expect(result.value.source.connector).toBe("notion");
    expect(result.body).toContain("# Booking");
  });

  it("reports missing required fields", () => {
    const result = parseMirrorFrontmatter("---\nid: product/x\ntitle: X\n---\nbody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.errors.join("\n");
    expect(joined).toContain("section");
    expect(joined).toContain("source");
    expect(joined).toContain("updated_at");
  });

  it("rejects a badly formatted date", () => {
    const raw = mirrorDoc("product/x", "body", { updated_at: "16/10/2026" });
    const result = parseMirrorFrontmatter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/updated_at/);
  });

  it("rejects routing fields in the mirror: they belong in brain/registry.yaml", () => {
    expect(parseMirrorFrontmatter(mirrorDoc("product/x", "body", { extra: "when_to_open: x" })).ok).toBe(false);
    expect(parseMirrorFrontmatter(mirrorDoc("product/x", "body", { extra: "managed_by: openbrain" })).ok).toBe(false);
  });
});

describe("parseRoutingRegistry", () => {
  it("applies defaults to doc entries", () => {
    const { registry, errors } = parseRoutingRegistry("docs:\n  product/x:\n    when_to_open: Open it.\n");
    expect(errors).toEqual([]);
    expect(registry?.docs["product/x"]).toEqual({ when_to_open: "Open it.", aliases: [], warnings: [], status: "validated" });
    expect(registry?.sections).toEqual({});
  });

  it("rejects an invalid status and unknown keys", () => {
    expect(parseRoutingRegistry("docs:\n  product/x:\n    when_to_open: a\n    status: draft\n").errors.join("\n")).toMatch(
      /status/,
    );
    expect(parseRoutingRegistry("docs:\n  product/x:\n    when_to_open: a\n    owner: me\n").registry).toBeNull();
  });

  it("reports invalid YAML instead of throwing", () => {
    expect(parseRoutingRegistry("docs: [unclosed").errors[0]).toMatch(/invalid YAML/);
  });
});
