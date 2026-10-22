import type { ConnectorManifest } from "../shared/types.ts";

export const GDRIVE_MANIFEST: ConnectorManifest = {
  id: "gdrive",
  name: "Google Drive (service account)",
  kinds: ["documents"],
  transport: "rest",
  env: [{ name: "GDRIVE_SA_JSON", required: true, description: "service account key: path to the JSON file, or the JSON itself" }],
  scopes: ["https://www.googleapis.com/auth/drive.readonly", "folders shared with the service account as Viewer"],
  defaultScope: "only the folders in inputs.gdrive.folders (recursively), Google Docs, Sheets (first tab), Slides and text files",
  rateLimit: "Drive API quota (12,000 queries per minute per project); 429 / 5xx retried with backoff",
  setup: "gdrive/SETUP.md",
};
