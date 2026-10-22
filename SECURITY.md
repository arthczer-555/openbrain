# Security policy

OpenBrain concentrates a company's internal knowledge in one place: security reports are handled first.

## Reporting a vulnerability

Email **[SECURITY_EMAIL]** with a description, the affected version or commit, and steps to reproduce.
Do not open a public issue. You will get an answer within 3 working days, and a fix or a mitigation plan
within 30 days for a confirmed issue. We credit reporters who wish to be named.

## Supported versions

Until 1.0, only the latest release receives security fixes. Instances update with `openbrain upgrade`
(planned) or by pulling the engine files from the latest release.

## Design choices that matter for security

- The knowledge mirror lives in the instance's **private** repository. `openbrain doctor`, `openbrain deploy`
  and the CI refuse a public repository that holds a non-empty mirror.
- The chatbot is closed by default: a shared access code or Google sign-in, signed `HttpOnly` session cookies, an
  edge guard on every page, the session checked again on every API call, login attempts limited per IP. A chat
  without access code is an explicit choice at deploy (confirmed, `OPENBRAIN_OPEN_ACCESS=1`): a missing
  `ACCESS_CODE_HASH` alone keeps it closed, and `/admin` always needs the admin code.
- The chatbot cannot act: it reads a compiled index, has no tool that writes or calls the company's tools,
  renders no remote image and keeps links only towards the source pages.
- Source tokens (Notion, Drive, GitHub, Slack) stay on the operator's machine. Netlify only holds the LLM key
  and the chatbot's own secrets.
- Inputs are read-only: connectors refuse write methods and MCP tools that write, and flag tokens with write
  access.
- Personal data and secrets found while collecting are flagged and never written to Notion.
- Flagged questions are stored with a hashed user id by default, and purged after processing.
