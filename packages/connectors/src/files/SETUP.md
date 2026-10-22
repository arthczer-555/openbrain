# Input: local files (`files`)

Reads documents from folders on your machine: an export of Confluence, SharePoint or Google Drive, a docs
folder, meeting notes. Nothing leaves your machine during the collection, and nothing is ever written to
those folders.

No token is needed.

## 1. Put the files in a folder

Any folder works, inside or outside the instance repository. Keep exports out of git: if the folder is
inside the repository, add it to `.gitignore`.

| Format | What OpenBrain keeps |
|---|---|
| `.md`, `.markdown`, `.txt` | The text as is |
| `.csv`, `.tsv` | A Markdown table (first 200 rows by default, `max_csv_rows`) |
| `.html`, `.htm` | The main content as Markdown (headings, lists, tables, links), without menus and footers |
| `.json` | A fenced JSON block |
| `.docx` | Paragraphs, headings, lists and tables |
| `.pptx` | One section per slide: title and bullet points |
| `.pdf`, `.doc`, `.xlsx`, `.pages`... | Not read in v0.1: listed as skipped, with how to convert them |

Images and other binary files are ignored.

## 2. Declare the folder in `openbrain.config.yaml`

```yaml
inputs:
  files:
    enabled: true
    paths: ["./docs-export"]          # relative to the instance root, or absolute
    include: ["**/*.md", "**/*.docx"] # optional, default: every supported format
    exclude: ["drafts/**"]            # optional
    max_file_mb: 20                   # larger files are skipped
```

Globs are matched on the path relative to each folder: `README.md` only matches the top-level file,
`**/*.md` matches at any depth. `node_modules`, `.git` and `.openbrain` folders are always skipped.

## 3. Test

```bash
npm run openbrain -- connectors test files
```

You should see `status ok`, the number of files per folder and three sample files. A missing folder is
reported as `not found: <path>`.

## 4. Collect

```bash
npm run openbrain -- collect --only files --dry-run   # count only
npm run openbrain -- collect --only files             # write .openbrain/weekly/<date>/inputs/files/
```

Only files modified since the last weekly update are collected (file modification time). Use `--full`
to collect everything, for example during the initialization (`--out .openbrain/init`).
