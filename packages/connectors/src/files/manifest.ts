import type { ConnectorManifest } from "../shared/types.ts";

export const FILES_MANIFEST: ConnectorManifest = {
  id: "files",
  name: "Local files",
  kinds: ["documents"],
  transport: "local",
  env: [],
  scopes: ["read access to the folders listed in inputs.files.paths"],
  defaultScope: "only the configured folders, filtered by include / exclude globs; node_modules, .git and .openbrain are skipped",
  rateLimit: "none (local disk); files above max_file_mb (default 20) are skipped",
  setup: "files/SETUP.md",
};
