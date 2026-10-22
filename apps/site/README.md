# OpenBrain site

The public landing page and documentation of OpenBrain, built with [Astro](https://astro.build) and
[Starlight](https://starlight.astro.build), published on GitHub Pages from the upstream repository only.

- `/` is a custom landing page (`src/pages/index.astro`), the approved design "direction B: Terminal".
- `/docs/...` is the Starlight documentation (`src/content/docs/docs/**`).
- No tracker, no analytics, no cookie. Fonts come from Google Fonts (JetBrains Mono, Schibsted Grotesk).

## Run it locally

From the repository root, after `npm install`:

```bash
npm run dev -w @openbrain/site          # or: cd apps/site && npx astro dev
```

Open http://localhost:4321. In a non-interactive shell (an agent, a CI step), Astro 7 starts the dev server in the
background: stop it with `npx astro dev stop` from `apps/site`.

To try the GitHub Pages base path locally:

```bash
SITE_BASE=/openbrain SITE_URL=https://example.github.io npx astro dev    # then open http://localhost:4321/openbrain/
```

## Layout

```text
astro.config.mjs              Starlight config, sidebar, base path, Markdown base-link plugin
src/consts.ts                 placeholders and shared values (repository link, license, fonts)
src/pages/index.astro         landing page, one component per section in src/components/landing/
src/layouts/Landing.astro     <head> of the landing page
src/components/docs/          Starlight overrides: site title (wordmark) and footer (author, license)
src/content/docs/docs/        documentation pages (Markdown), served at /docs/
src/content/docs/404.md       not-found page
src/lib/cost.ts               cost estimator (shared by the build and the browser)
src/lib/paths.ts              withBase(): every internal link of the landing goes through it
src/route-data.ts             `lang:` frontmatter support (a page written in another language)
src/styles/tokens.css         design tokens: --accent, --accent-ink, --ink, --muted...
src/styles/landing.css        global landing styles
src/styles/starlight.css      Starlight theme: same fonts, accent and neutrals as the landing
public/                       favicon.svg (the logo), og.svg
```

## Writing docs

- English, short sentences, real commands. Examples use the fictional Acme company only (Acme Desk, Acme Hub, Acme
  Console). Never real company data.
- Never use the em dash or the en dash: commas, periods, parentheses or a hyphen.
- Write internal links root-relative: `[Models](/docs/models/)`. A small plugin in `astro.config.mjs` adds the base
  path at build, so the same Markdown works at `/` and under `/<repo>/`.
- Mark what is not shipped yet: a `:::note[Status]` aside at the top of the page, "in progress" or "planned" in tables.
- A new page also needs an entry in the `sidebar` of `astro.config.mjs`.

## To fill at launch

| What | Where |
|---|---|
| `[N]x fewer tokens ... [MEASURED IN BENCHMARK]` | `src/components/landing/Lean.astro`, `src/content/docs/docs/concepts/lean-brain.md` |
| Social image | `public/og.svg` is the source: export it to a 1200x630 PNG (LinkedIn and X do not render SVG) and add `og:image` in `src/layouts/Landing.astro` and the Starlight `head` |

## Deploy to GitHub Pages

The base path and the site URL come from the environment, read in `astro.config.mjs`:

| Variable | Default | Meaning |
|---|---|---|
| `SITE_BASE` | `/` | `/` for a custom domain, `/<repo>` for `https://<owner>.github.io/<repo>/` |
| `SITE_URL` | unset | Public origin, for example `https://<owner>.github.io`. Used for canonical links, the sitemap and Open Graph. |

The workflow is `.github/workflows/pages.yml` at the repository root. It builds this app with `npm run build -w
@openbrain/site`, passing the origin and base path returned by `actions/configure-pages` (so both
`https://<owner>.github.io/<repo>/` and a custom domain work), and deploys `apps/site/dist`.

It only runs in the upstream repository: its jobs are guarded by `if: vars.OPENBRAIN_UPSTREAM == 'true'`, a
repository variable set only on the public repo (the same variable turns on the engine tests and the end-to-end test
in `ci.yml`). An instance created from the template never publishes anything. To enable it on the public repo:

1. *Settings* > *Secrets and variables* > *Actions* > *Variables*: add `OPENBRAIN_UPSTREAM` = `true`.
2. *Settings* > *Pages* > *Source*: *GitHub Actions*.
3. Push a change under `apps/site/`, or run the workflow by hand (*Run workflow*).
