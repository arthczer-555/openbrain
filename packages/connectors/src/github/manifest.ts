import type { ConnectorManifest } from "../shared/types.ts";

export const GITHUB_MANIFEST: ConnectorManifest = {
  id: "github",
  name: "GitHub (docs, commits, merged pull requests)",
  kinds: ["documents", "stream"],
  transport: "rest",
  env: [{ name: "GITHUB_TOKEN", required: true, description: "fine-grained personal access token, read-only, limited to the listed repositories" }],
  scopes: ["Repository permissions > Contents: Read-only", "Repository permissions > Metadata: Read-only (mandatory)", "Repository permissions > Pull requests: Read-only (for merged pull requests)"],
  defaultScope: "only the repositories in inputs.github.repos; docs filtered by docs_globs (README.md, docs/**/*.md); commits and merged pull requests of the default branch",
  rateLimit: "5,000 requests per hour per token; 403 / 429 with x-ratelimit-reset or Retry-After are waited for (up to 60 s)",
  setup: "github/SETUP.md",
};
