// Every internal link goes through withBase so the site works at "/" and under "/<repo>/" on GitHub Pages
// (SITE_BASE, see astro.config.mjs).

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Prefixes a root-relative path ("/docs/") with the configured base path. */
export function withBase(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE}${path}`;
}
