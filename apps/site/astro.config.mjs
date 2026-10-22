// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { FONTS_HREF, REPO_HREF, SITE_DESCRIPTION, SITE_TITLE } from "./src/consts.ts";

// GitHub Pages serves the site under https://<owner>.github.io/<repo>/, so the base path is configurable.
// SITE_BASE: "/" (default, custom domain or local dev) or "/<repo>". SITE_URL: the public origin, used for
// canonical links, the sitemap and Open Graph tags (optional in dev).
const base = normalizeBase(process.env.SITE_BASE ?? "/");
const site = process.env.SITE_URL || undefined;

/** @param {string} value */
function normalizeBase(value) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}

/**
 * Markdown links in the docs are written root-relative ("/docs/concepts/registry/"). Starlight prefixes its own
 * navigation with the base path, but not links inside page content: this hast plugin does it, so the same
 * Markdown works at "/" and under "/<repo>/". It hooks into the Markdown processor configured by Astro
 * (Satteri by default, unified as a fallback) without adding any dependency.
 * @param {string} basePath
 * @returns {import("astro").AstroIntegration}
 */
function baseLinks(basePath) {
  /** @param {string} href */
  const rewrite = (href) => (href.startsWith("/") && !href.startsWith("//") ? `${basePath}${href}` : href);
  return {
    name: "openbrain-base-links",
    hooks: {
      "astro:config:setup": ({ config, logger }) => {
        if (basePath === "/") return;
        const processor = /** @type {{ name: string; options: Record<string, unknown[]> } | undefined} */ (
          /** @type {unknown} */ (config.markdown?.processor)
        );
        if (processor?.name === "satteri" && Array.isArray(processor.options.hastPlugins)) {
          processor.options.hastPlugins.push({
            name: "openbrain-base-links",
            element: {
              filter: ["a"],
              /**
               * @param {{ properties?: Record<string, unknown> }} node
               * @param {{ setProperty: (node: unknown, key: string, value: unknown) => void }} ctx
               */
              visit(node, ctx) {
                const href = node.properties?.href;
                if (typeof href === "string") ctx.setProperty(node, "href", rewrite(href));
              },
            },
          });
          return;
        }
        if (processor && Array.isArray(processor.options.rehypePlugins)) {
          processor.options.rehypePlugins.push(() => {
            /** @param {{ type: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }} node */
            const walk = (node) => {
              if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string") {
                node.properties.href = rewrite(node.properties.href);
              }
              for (const child of node.children ?? []) walk(/** @type {typeof node} */ (child));
            };
            return walk;
          });
          return;
        }
        logger.warn("unknown Markdown processor: root-relative links in the docs will not get the base path");
      },
    },
  };
}

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO_HREF }],
      customCss: ["./src/styles/tokens.css", "./src/styles/starlight.css"],
      components: {
        SiteTitle: "./src/components/docs/SiteTitle.astro",
        Footer: "./src/components/docs/Footer.astro",
      },
      routeMiddleware: "./src/route-data.ts",
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        { tag: "link", attrs: { rel: "stylesheet", href: FONTS_HREF } },
      ],
      sidebar: [
        { label: "Overview", slug: "docs" },
        {
          label: "Getting started",
          items: [
            { label: "Quickstart (Acme demo)", slug: "docs/getting-started/quickstart" },
            { label: "Your own instance", slug: "docs/getting-started/your-own-instance" },
            { label: "Why Claude Code", slug: "docs/getting-started/claude-code" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Notion and the mirror", slug: "docs/concepts/notion-and-the-mirror" },
            { label: "The routing registry", slug: "docs/concepts/registry" },
            { label: "The lean brain", slug: "docs/concepts/lean-brain" },
            { label: "Weekly update", slug: "docs/concepts/weekly-update" },
            { label: "Flagged questions", slug: "docs/concepts/flagged-questions" },
          ],
        },
        {
          label: "Connectors",
          items: [
            { label: "Notion", slug: "docs/connectors/notion" },
            { label: "Inputs overview", slug: "docs/connectors/inputs" },
            { label: "Write your own input", slug: "docs/connectors/write-your-own" },
          ],
        },
        { label: "Models", slug: "docs/models" },
        { label: "Deploy on Netlify", slug: "docs/deploy/netlify" },
        {
          label: "Operate",
          items: [
            { label: "Admin page", slug: "docs/operate/admin" },
            { label: "Evals", slug: "docs/operate/evals" },
            { label: "Troubleshooting", slug: "docs/operate/troubleshooting" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "docs/reference/cli" },
            { label: "openbrain.config.yaml", slug: "docs/reference/config" },
            { label: "Environment variables", slug: "docs/reference/environment" },
          ],
        },
        { label: "Security & privacy", slug: "docs/security" },
        { label: "Contributing", slug: "docs/contributing" },
      ],
    }),
    baseLinks(base),
  ],
});
