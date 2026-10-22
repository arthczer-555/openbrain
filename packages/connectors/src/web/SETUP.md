# Input: website (`web`)

Reads public pages of your website, help center or docs site, from a sitemap and / or a list of URLs.
Only `GET` requests, one at a time, with a polite delay. No token is needed: pages behind a login are
out of scope (export them and use the `files` input instead).

## 1. Find your sitemap

Most sites publish one at `https://<your-site>/sitemap.xml` (it is often listed in `/robots.txt`).
Sitemap indexes (a sitemap of sitemaps) and gzipped sitemaps (`.xml.gz`) are supported. Without a
sitemap, list the pages in `urls`.

## 2. Declare the site in `openbrain.config.yaml`

```yaml
inputs:
  web:
    enabled: true
    sitemap: "https://acme.example/sitemap.xml"   # or a list of sitemaps
    urls: ["https://acme.example/changelog"]      # always collected, not filtered by include / exclude
    include: ["/docs/", "/help/"]                 # path prefixes kept from the sitemap (default: all)
    exclude: ["/docs/archive/"]                   # path prefixes dropped from the sitemap
    max_pages: 200
    delay_ms: 1000                                # pause between two requests
```

Sitemap URLs on another host than the sitemap itself are ignored.

## 3. robots.txt

OpenBrain respects `robots.txt`. Its user agent contains the token `OpenBrain`: rules written for
`User-agent: OpenBrain` apply first, otherwise the `User-agent: *` rules apply. `Crawl-delay` is
honored (up to 10 seconds). If `robots.txt` answers with a server error, no page is fetched.

To let OpenBrain read pages that are closed to other crawlers, add a group for it:

```text
User-agent: OpenBrain
Allow: /docs/
```

## 4. Test

```bash
npm run openbrain -- connectors test web
```

You should see the host, the number of URLs found, how many are disallowed by `robots.txt`, and three
sample pages.

## 5. Collect

```bash
npm run openbrain -- collect --only web
```

A page is collected when its sitemap `lastmod` is after the start of the window, or when it has no
`lastmod` (then a conditional request with `If-Modified-Since` lets the server answer "not modified").
The main content is kept as Markdown (`<main>` or `<article>` first); menus, headers, footers, scripts
and images are dropped. PDFs and other non-HTML pages are skipped.
