import { parseXml, type MarkupElement } from "../shared/markup.ts";

// sitemap.xml: a <urlset> of pages (<loc>, optional <lastmod>) or a <sitemapindex> of nested sitemaps.

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export interface ParsedSitemap {
  urls: SitemapEntry[];
  /** Nested sitemaps of a sitemap index. */
  sitemaps: string[];
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function descendants(element: MarkupElement, name: string): MarkupElement[] {
  const found: MarkupElement[] = [];
  for (const child of element.children) {
    if (child.type !== "element") continue;
    if (localName(child.name) === name) found.push(child);
    else found.push(...descendants(child, name));
  }
  return found;
}

function childText(element: MarkupElement, name: string): string {
  for (const child of element.children) {
    if (child.type === "element" && localName(child.name) === name) {
      return child.children
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("")
        .trim();
    }
  }
  return "";
}

export function parseSitemap(xml: string): ParsedSitemap {
  const doc = parseXml(xml);
  const urls: SitemapEntry[] = [];
  for (const url of descendants(doc, "url")) {
    const loc = childText(url, "loc");
    if (!loc) continue;
    const lastmod = childText(url, "lastmod");
    urls.push(lastmod ? { url: loc, lastmod } : { url: loc });
  }
  const sitemaps = descendants(doc, "sitemap")
    .map((s) => childText(s, "loc"))
    .filter(Boolean);
  return { urls, sitemaps };
}
