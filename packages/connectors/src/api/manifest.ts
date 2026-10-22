import type { ConnectorManifest } from "../shared/types.ts";

export const API_MANIFEST: ConnectorManifest = {
  id: "api",
  name: "Any REST API (generic GET adapter with a YAML mapping)",
  kinds: ["documents", "stream"],
  transport: "rest",
  env: [{ name: "<auth.env>", required: false, description: "API key or token, read-only when the tool offers it, named by inputs.api.<name>.auth.env" }],
  scopes: [
    "GET requests only, enforced in code: the adapter cannot create, change or delete anything",
    "prefer a read-only key whenever the tool offers one: it is the real guarantee",
  ],
  defaultScope: "only the list (and optional fetch) endpoint of the mapping, on the host of base_url",
  rateLimit: "one request at a time, delay_ms between two (default 200 ms); 429 and 5xx retried (Retry-After honored); pagination capped by paginate.max_pages (default 20)",
  setup: "api/SETUP.md",
};
