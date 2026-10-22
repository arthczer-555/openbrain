# Input: GitHub (`github`)

Reads, in the repositories you list:

- **documents**: the files matching `docs_globs` on the default branch (by default `README.md` and
  `docs/**/*.md`);
- **stream**: the commits of the default branch (first line of the message and number of files changed)
  and the merged pull requests (title, description excerpt, labels).

Merge commits and bot activity (Dependabot...) are left out. Authors are kept for the triage only and
are never written to the knowledge base.

## 1. Create a read-only token

Use a **fine-grained personal access token**, limited to the repositories OpenBrain reads:

1. GitHub > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** >
   **Generate new token**.
2. **Resource owner**: your organization (an organization admin may have to approve the token).
3. **Expiration**: as your security policy requires (OpenBrain only needs it when you run the weekly
   update).
4. **Repository access**: **Only select repositories**, then pick the repositories of
   `inputs.github.repos`.
5. **Repository permissions**, and nothing else:
   - **Contents**: Read-only
   - **Metadata**: Read-only (selected automatically)
   - **Pull requests**: Read-only (only if you keep `pull_requests: true`)
6. No account permission. Generate, then copy the token (it starts with `github_pat_`).

Avoid classic tokens and `gh auth token`: reading a private repository with them needs the `repo`
scope, which can also write. `connectors test github` flags it.

## 2. Put it in `.env`

Paste it yourself in the `.env` file at the root of the instance (never in a chat, an issue or a commit):

```bash
GITHUB_TOKEN=github_pat_...
```

## 3. Declare the repositories in `openbrain.config.yaml`

```yaml
inputs:
  github:
    enabled: true
    repos: ["acme/app"]
    docs_globs: ["README.md", "docs/**/*.md"]
    commits: true            # commits in the stream
    pull_requests: true      # merged pull requests in the stream
    # branch: main           # default: the default branch of each repository
    # api_url: https://github.acme.example/api/v3   # GitHub Enterprise Server
    # token_env: GITHUB_TOKEN
```

## 4. Test

```bash
npm run openbrain -- connectors test github
```

You should see `identity user <login>`, one line per repository with your access level (`pull` is the
expected one) and three sample docs.

`WARNING write access detected` means either a classic token with a write scope, or a repository where
the reported access is `push`, `maintain` or `admin`. With a fine-grained token, GitHub reports the
access of your account on the repository, which can be higher than the token's: check the token's
permission page, or use a dedicated machine account that only has read access to remove the doubt.

## 5. Collect

```bash
npm run openbrain -- collect --only github
```

Incremental: only the docs touched by a commit since the start of the window are fetched. Requests are
GET only, the token travels in the `Authorization` header, and rate limits (5,000 requests per hour) are
waited for when they reset within a minute.
