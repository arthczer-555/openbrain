# Input: Google Drive (`gdrive`)

Reads the folders you share with a **service account**, recursively (shared drives included):

| Drive file | What OpenBrain keeps |
|---|---|
| Google Docs | Markdown export (plain text when Markdown is not available) |
| Google Sheets | The first tab, as a Markdown table (200 rows by default) |
| Google Slides | Plain text export |
| Uploaded `.docx`, `.pptx`, `.md`, `.txt`, `.csv`, `.html` | Converted like local files |
| PDF | Not read in v0.1 (listed as skipped when `pdf` is in `mime`): open it with Google Docs to convert it |

The access token is requested with the `drive.readonly` scope only. The JWT is signed locally and the
key never leaves your machine.

## 1. Create the service account

1. Open the Google Cloud console and select (or create) a project for OpenBrain.
2. **APIs & Services** > **Library** > **Google Drive API** > **Enable**.
3. **IAM & Admin** > **Service accounts** > **Create service account**. Name it for example
   `openbrain-reader`. Grant it **no role**: Drive access comes from the folder shares only.
4. Open the service account > **Keys** > **Add key** > **Create new key** > **JSON**. A key file is
   downloaded.

If key creation is blocked, your Google Workspace has the organization policy
`iam.disableServiceAccountKeyCreation`: ask your administrator for an exception on this project.

## 2. Share the folders with it, as Viewer

Copy the service account email (`openbrain-reader@<project>.iam.gserviceaccount.com`) and share each
folder with it as **Viewer**. For a shared drive, add it as a member with the **Viewer** role. If your
Workspace forbids sharing outside the domain, your administrator has to allow this address.

The folder id is the end of its URL: `https://drive.google.com/drive/folders/<folder-id>`.

## 3. Put the key in `.env`

Store the key file outside of the repository (for example `~/.config/openbrain/acme-drive.json`), then
point to it from the `.env` file at the root of the instance:

```bash
GDRIVE_SA_JSON=/Users/you/.config/openbrain/acme-drive.json
```

The JSON itself, on one line, also works. Never commit the key, never paste it in a chat.

## 4. Declare the folders in `openbrain.config.yaml`

```yaml
inputs:
  gdrive:
    enabled: true
    folders: ["<folder-id>"]
    mime: [doc, sheet, slides, text]   # add pdf to list PDFs as skipped
    max_file_mb: 20
    # max_sheet_rows: 200
    # credentials_env: GDRIVE_SA_JSON
```

## 5. Test

```bash
npm run openbrain -- connectors test gdrive
```

You should see `identity service account <email>`, the `drive.readonly` scope, one line per folder with
`viewer`, and three sample files. `editor (Viewer is enough)` raises the write warning: the token
stays read-only, but the share is wider than needed, so set it back to Viewer.

## 6. Collect

```bash
npm run openbrain -- collect --only gdrive
```

Incremental on `modifiedTime`. The only request that is not a `GET` is the token exchange at
`https://oauth2.googleapis.com/token`.
