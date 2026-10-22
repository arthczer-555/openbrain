import type { ConnectorManifest } from "../shared/types.ts";

export const MCP_MANIFEST: ConnectorManifest = {
  id: "mcp",
  name: "Any MCP server (generic adapter with a YAML mapping)",
  kinds: ["documents", "stream"],
  transport: "mcp",
  env: [{ name: "<auth_env>", required: false, description: "bearer token of a remote (Streamable HTTP) server, named by inputs.mcp.<name>.auth_env" }],
  scopes: ["read-only tools only: the adapter refuses any mapped tool that looks like a write (name, description, annotations)"],
  defaultScope: "only the list (and optional fetch) tool named in the mapping, with the arguments of the mapping",
  rateLimit: "one tool call at a time; pagination capped by paginate.max_pages (default 20)",
  setup: "mcp/SETUP.md",
};
