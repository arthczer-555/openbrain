import type { ConnectorManifest } from "../shared/types.ts";

export const WEB_MANIFEST: ConnectorManifest = {
  id: "web",
  name: "Website (sitemap or URL list)",
  kinds: ["documents"],
  transport: "http",
  env: [],
  scopes: ["public pages only (GET), robots.txt respected for the OpenBrain user agent"],
  defaultScope: "the URLs of the configured sitemap(s) on the sitemap host, filtered by include / exclude path prefixes, plus the listed URLs",
  rateLimit: "one request per second by default (delay_ms), Crawl-delay honored up to 10 s, max_pages (default 200)",
  setup: "web/SETUP.md",
};
