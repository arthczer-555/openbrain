# OpenBrain

**An assistant for your team that answers from your Notion, shows where each answer comes from, and gets better
every week.**

Your colleagues ask questions in plain words: *"How do I give a new hire access to the CRM?"*. OpenBrain finds the
right Notion pages, answers with links to them, and says *"This is not documented yet"* instead of making something
up. Every question it could not answer is kept, and fixed in Notion at the next weekly update.

Once your tools are connected, you can also **ask Claude to put anything you want in it**: how your codebase works,
your product, your sales playbook, your marketing guidelines, your HR policies. Claude gathers it from your tools
and writes it into Notion after your OK. [See examples](#ask-for-any-knowledge).

> **Status: early version (v0.1).** Everything on this page works and is tested on the example company, including
> real answers from Claude. A real deployment on Netlify is still being validated. Items marked 🔜 are planned.
>
> OpenBrain is a personal open source project by Arthur Czernichow, developed and tested on his own time and
> accounts.

**Contents:** [How it works](#how-it-works) · [Try it](#try-it-in-2-minutes) · [What you need](#what-you-need) ·
[Set up in 6 steps](#set-up-your-brain-in-6-steps) · [Connect your tools](#connect-your-tools) ·
[Ask for any knowledge](#ask-for-any-knowledge) · [Costs](#what-it-costs) · [Privacy](#privacy-and-security) · [FAQ](#faq) · [Reference](REFERENCE.md)

## How it works

```
  Your tools                       Notion                           Your team
  Slack, HubSpot, Claap,   ───▶    the one place where      ───▶    a chat page that answers
  Google Drive, GitHub...          your company knowledge           from Notion only, with a
                                   lives                            link to each source page
        ▲                                                                   │
        └──────  once a week, Claude proposes updates and you approve  ◀────┘
                 (including the questions the chat could not answer)
```

1. **Notion is the source of truth.** The chat page only answers from your Notion pages. Your other tools feed
   Notion, never the chat page directly.
2. **Claude does the upkeep, you decide.** During the setup, once a week, and whenever you ask for a topic, Claude
   reads your tools, proposes what to add or fix in Notion, and writes only after your OK. It runs in Claude Code,
   on your Claude subscription.
3. **Answers stay honest.** Each answer links to the pages it comes from. When nothing answers the question, the
   assistant says so and notes the question for the next update.

## Try it in 2 minutes

No account and no key needed. The repo comes with **Acme**, a made-up company.

```bash
git clone https://github.com/arthczer-555/openbrain.git && cd openbrain
npm install                  # needs Node 24 or newer (nodejs.org)
npm run demo                 # then open http://127.0.0.1:8787
```

The demo answers by quoting the best passages, without any AI. To get real answers from Claude, through your
Claude Code subscription and with nothing to configure:

```bash
npm run openbrain -- ask "How do I add a user in the internal tool?" --root examples/acme
```

You play an Acme employee who wants to give a new colleague access to **Acme Hub**, Acme's (made-up) internal
tool. The answer comes from Acme's knowledge base, with its source:

```
To add a colleague to Acme Hub, you need to be a Hub admin, because only a Hub admin can add an account [1].
1. Go to Settings, then Team [1].
2. Click Add teammate and enter the colleague's work email [1].
...
  [1] Acme Hub accounts: give a colleague access > Add a colleague   https://www.notion.so/acme/...
```

The question says *user*, and Acme also has a page about creating *client* users. The assistant still opens the
page about colleagues, because a short routing guide tells it what "user" means in the internal tool. That guide is
what Claude writes for your company during the setup.

## What you need

| What | Why | Cost |
|---|---|---|
| A computer with [Node 24 or newer](https://nodejs.org) | Runs the OpenBrain commands | Free |
| [Claude Code](https://claude.com/claude-code), with a Claude plan that includes it | Claude does the setup, the tests and the weekly update | Included in your plan |
| A Notion workspace, with the **Notion connector** turned on in Claude | Where your knowledge lives. Claude writes the changes you approve through it | Free plan works |
| A personal GitHub account | Keeps your private copy and its history | Free |
| A Netlify account | Hosts the chat page | Free plan works |
| An API key from an AI provider (Anthropic, OpenAI, Google, Mistral...) | Only for the chat page once it is online | Billed per question, with a monthly cap you set |

You don't need to know how to code. You will paste a few commands; Claude Code explains each step and does most of
the work.

## Set up your brain in 6 steps

### Step 1. Make your own private copy (2 minutes)

```bash
gh repo create my-brain --private --template arthczer-555/openbrain --clone && cd my-brain
npm install
```

Or on github.com: **Use this template** → **Create a new repository** → **Private**, then clone it. Check with
`git remote -v` that it points to *your* repo: everything you publish later goes there.

> **Keep it private.** It will hold a copy of your internal documentation. OpenBrain refuses to deploy from a
> public repo.

### Step 2. Run `/setup` in Claude Code (about 15 minutes)

Open the folder in Claude Code (type `claude` in the terminal) and type `/setup`. Claude asks one question at a
time and does the work:

1. **Your company**: its name, the language of your Notion, the name and color of the assistant.
2. **Notion**. You do three things yourself:
   - Create an integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), with
     only the *Read content* permission.
   - On the top page of your company knowledge: `•••` → **Connections** → add the integration. Share only that
     page: everything under it is what the assistant will know.
   - Run `cp .env.example .env` and paste the integration key after `NOTION_TOKEN=`. Never paste a key in the chat.

   Claude then copies your pages into the repo and shows you how they are organized.
3. **Your tools** (Slack, HubSpot, Claap, Google Drive...): Claude helps you connect each one and notes what it may
   read, for example which Slack channels. See [Connect your tools](#connect-your-tools).
4. **The AI of the chat page**: any provider, with a backup. You can change it later from the admin page.
5. **The routing guide**: for each page, Claude writes when to use it and the words people use for it. You review
   it, Claude saves it.

### Step 3. Gather what is scattered: `/init` (30 to 90 minutes, once)

Skip this step if your Notion already holds your company knowledge. Otherwise, type `/init`:

1. Claude reads your tools, within the limits set in step 2, and tells you how much work it is.
2. It proposes a structure for Notion (5 to 12 sections) and, page by page, what to create or update and from which
   sources.
3. **Contradictions come first.** When two tools say different things, you decide. Nothing is written before.
4. You approve batch by batch. Claude writes into Notion, only under your top page, and adds a "Sources" block at
   the bottom of each page.
5. It drafts about 30 test questions from your pages. Add the questions your colleagues really ask.

It works in batches and can stop and pick up where it left off.

<details>
<summary>What a good Notion structure looks like</summary>

```
Company Brain                 ← the top page shared with the integration
├─ Product                    ← a section
│  ├─ Roles and permissions   ← a page
│  └─ Data retention
├─ Sales
│  └─ Pricing
└─ People & HR
   └─ Remote work
```

- **5 to 12 sections**, by team or by tool. A section page can be a simple list of links.
- **One topic per page**, with headings: the assistant finds and quotes each part on its own.
- **Facts written in the page.** Attached files (PDF, images) are not read.
- **No contradictions.** The assistant quotes your pages, it does not decide between them.

</details>

### Step 4. Test it in the terminal

No API key needed: the answers come from Claude, through your subscription.

```bash
npm run openbrain -- ask "How long do we keep client data?"      # one answer, with its sources
npm run openbrain -- ask                                          # a conversation, follow-up questions work
npm run openbrain -- search "How long do we keep client data?"   # which pages come up (instant, no AI)
npm run openbrain -- eval                                         # runs all your test questions and gives a score
npm run openbrain -- serve --model claude-code:sonnet             # the chat page on your computer: http://127.0.0.1:8787
```

For each test question, `eval` checks that the right pages are cited, that the assistant says "not documented" when
it should, and that it answers in the language of the question. `eval --no-llm` only checks which pages are found,
in a second. Tip: `alias openbrain="npm run -s openbrain --"` shortens every command.

When an answer is wrong, tell Claude in the conversation, or type `/write`. The fix is usually a word to add to the
routing guide, or a fact missing from Notion.

Once the API key of the chat page is in `.env` (step 5), `ask` and `eval` test that AI instead. `--model
claude-code:sonnet` goes back to your subscription.

### Step 5. Put the chat page online (about 10 minutes)

The online chat page cannot use your Claude subscription: add the API key of the AI chosen in step 2 to `.env`, for
example `ANTHROPIC_API_KEY=...`. Then:

```bash
npm run openbrain -- doctor           # final checklist: says what to fix, if anything
npm i -g netlify-cli && netlify login
npm run openbrain -- deploy           # shows what will happen
npm run openbrain -- deploy --yes     # asks for the access code, creates the site on Netlify, puts it online
```

`deploy --yes` asks you to choose the **access code** your team will type to open the chat. Leave it empty and the
chat opens directly, with no sign-in page: then anyone who has the link can read your knowledge through it, so keep
that for small teams and a link you don't share outside. At the end you get the address of the chat page and the
**admin code** for the admin page. The codes are shown once: save them.

**One last click**, so that your weekly updates go online by themselves: in Netlify, **Project configuration** →
**Build & deploy** → **Continuous deployment** → **Link repository** → GitHub → your private repo. Don't run
`deploy --yes` again later: it creates new codes and signs everyone out.

Prefer to click through Netlify instead of the terminal? Follow [Deploy by hand](REFERENCE.md#deploy-by-hand).

> Netlify's free plan deploys private repos from a **personal** GitHub account. A repo owned by a GitHub
> organization needs a paid Netlify plan.

What your team gets: a chat page with sources, a page to browse the knowledge (`/kb`), and 👍 / 👎 on each answer.
What you get: an admin page (`/admin`) with the unanswered questions, the feedback, the usage and the choice of AI.
Sign-in is the shared access code you chose (or none); Google Workspace accounts work too ([details](REFERENCE.md#sign-in-admin-and-ci)).

### Step 6. Every week: `/weekly` (15 to 30 minutes)

Open Claude Code in the folder and type `/weekly` (or `/hebdo`):

1. OpenBrain gathers the week: what changed in Notion and in your tools, the questions the chat page could not
   answer, and the 👎.
2. Claude writes a short briefing: what it proposes to add or fix in Notion, contradictions first.
3. You approve. Claude writes into Notion, updates the routing guide and the test questions, checks everything and
   publishes. The chat page is up to date one or two minutes later.

Between two updates, ask for anything you want in the brain: see [Ask for any knowledge](#ask-for-any-knowledge). A GitHub reminder opens an issue when no update ran for
more than 8 days.

## Connect your tools

OpenBrain only **reads** your tools, during `/init`, `/weekly` and when you [ask for a topic](#ask-for-any-knowledge),
and only what you allow: which channels, which pipelines, which folders. The chat page never touches them. What is
worth knowing ends up in Notion, after your OK.

### The easy way: connect the tool to Claude

Most work tools have an official connector for Claude (also called an MCP server). Connect it once, and Claude can
read the tool during the updates. No key to create, no code.

**1. Connect it.** On claude.ai: **Customize** → **Connectors**
([claude.ai/customize/connectors](https://claude.ai/customize/connectors)) → pick the tool → **Connect**, with the
same account as Claude Code. It shows up in Claude Code by itself. On a Team or Enterprise plan, an owner turns the
connector on first, then each person signs in.

Not in the list? Add it from the terminal with its address from the table below, then type `/mcp` in Claude Code
and sign in:

```bash
claude mcp add --transport http claap https://api.claap.io/mcp
```

**2. Tell OpenBrain what to read**, in `openbrain.config.yaml` (`/setup` writes it with you):

```yaml
inputs:
  claude:
    slack:   { scope: "channels #product, #sales and #announcements, threads included" }
    hubspot: { scope: "deals that changed stage, and notes on won or lost deals" }
    claap:   { scope: "customer call recordings: summaries and decisions only" }
```

**3. Check:** `npm run openbrain -- connectors list` shows them as *via Claude*.

**Popular tools** (checked on October 22, 2026). "claude.ai" means the tool is in claude.ai's connector list:
connect it there, it is the simplest. Use the address only if it is not.

| Tool | Easiest way | Address for `claude mcp add` | Good to know |
|---|---|---|---|
| **Slack** | claude.ai | (use claude.ai) | A Slack admin may have to approve it. |
| **HubSpot** | claude.ai | `https://mcp.hubspot.com/anthropic` | |
| **Claap** | Address | `https://api.claap.io/mcp` | Sign in with Claap in the browser. Depends on your Claap plan. |
| **Google Drive, Gmail, Google Calendar** | claude.ai | (use claude.ai) | The direct addresses need a Google Cloud project. |
| **Microsoft 365** (SharePoint, OneDrive, Outlook, Teams) | claude.ai | (use claude.ai) | Read-only by default. A Microsoft admin approves it once. |
| **Linear** | claude.ai | `https://mcp.linear.app/mcp/readonly` | This address can only read: the best choice for OpenBrain. |
| **Jira, Confluence** | claude.ai ("Atlassian") | `https://mcp.atlassian.com/v2/mcp` | Atlassian Cloud only. |
| **Asana** | claude.ai | (use claude.ai) | |
| **monday.com** | claude.ai | `https://mcp.monday.com/mcp` | |
| **ClickUp** | claude.ai | `https://mcp.clickup.com/mcp` | |
| **Intercom** | claude.ai | `https://mcp.intercom.com/mcp` | European workspaces: `https://mcp.eu.intercom.com/mcp`. |
| **Fireflies** | claude.ai | `https://api.fireflies.ai/mcp` | |
| **Granola** | claude.ai | `https://mcp.granola.ai/mcp` | The free plan only shows the last 30 days. |
| **Gong** | Address | `https://mcp.gong.io/mcp` | Read-only. A Gong admin creates the integration first. |
| **Pipedrive** | claude.ai | `https://mcp.pipedrive.ai/mcp` | Paid Pipedrive plans. |
| **Attio** | claude.ai | `https://mcp.attio.com/mcp` | |
| **Airtable** | claude.ai | `https://mcp.airtable.com/mcp` | |
| **Pennylane** | Address | `https://mcp.pennylane.com/mcp` | Read-only. |
| **GitHub** | OpenBrain's GitHub reader (below) | `https://api.githubcopilot.com/mcp/readonly` | claude.ai's GitHub integration does not reach Claude Code. |

Many other tools have one (Stripe, Zendesk, Salesforce, Dropbox, Box, Notion...): search claude.ai's list, or the
tool's help center for "MCP".

> **Claude only reads during the updates.** The OpenBrain commands forbid it to write anywhere except in Notion,
> after your OK. Most connectors could also write, though: when a tool offers a read-only address (Linear, GitHub
> above), prefer it. To block writing completely, see [Read-only connectors](REFERENCE.md#read-only-connectors).

> **A connector doesn't show up in Claude Code?** Type `/status`. If Claude Code uses an API key
> (`ANTHROPIC_API_KEY` set in your terminal), claude.ai connectors are not loaded: remove the variable and restart
> Claude Code. OpenBrain only reads the keys of its `.env` file, which Claude Code ignores.

### No connector? Other ways

| You have | Use | How |
|---|---|---|
| Files: exports from Confluence, SharePoint, Google Drive, meeting notes | A folder on your computer | [files](packages/connectors/src/files/SETUP.md), no key |
| A public website, help center or documentation | The website reader | [web](packages/connectors/src/web/SETUP.md), no key |
| Documentation and changes in GitHub | The GitHub reader | [github](packages/connectors/src/github/SETUP.md), a read-only key |
| Thousands of Google Drive files | The Drive reader | [gdrive](packages/connectors/src/gdrive/SETUP.md), a read-only service account |
| Any other tool with an API or an MCP server | A short description file that Claude writes with you in `/setup` | [api](packages/connectors/src/api/SETUP.md), [mcp](packages/connectors/src/mcp/SETUP.md) |

These readers run on your computer and don't use your Claude subscription, which helps with large volumes. They
can only read: the code refuses anything that would create, change or delete. All the details:
[Connectors](REFERENCE.md#connectors).

## Ask for any knowledge

Once your tools are connected, ask Claude to put whatever you want in your brain, in your own words. Open Claude
Code in the folder and type `/write` followed by your request, or simply ask (*"add this to the brain"*).

| Topic | What you can ask |
|---|---|
| **Codebase and tech** | *"Document how our codebase is organized, from the GitHub repo: architecture, main services, how to run and deploy it."* |
| **Product** | *"Write one page per feature we shipped this quarter, from Linear and the release notes."* |
| **Sales** | *"Build a sales playbook from HubSpot and our Claap call recordings: objections, pricing questions, competitors."* |
| **Marketing** | *"Gather our marketing guidelines from Google Drive and Slack #marketing: tone of voice, personas, current campaigns."* |
| **Customer support** | *"Turn the most frequent Intercom questions of the last three months into answers, one page per topic."* |
| **People and operations** | *"Put our HR policies from the Drive folder 'People' into Notion: leave, remote work, expenses."* |
| **A single fact** | *"Our support hours change to 8am to 7pm from November 1st."* |

Then Claude:

1. reads the tools you named, only what you allowed, and the code itself when the repo is on your computer;
2. proposes the pages to create or update in Notion, with their sources, contradictions first;
3. writes after your OK, updates the routing guide and the test questions, and publishes.

A minute or two later, your team can ask the chat page about it. Nothing is written in Notion without your OK, and
nothing is ever written in your tools.

## What it costs

- **Setup, tests and weekly updates**: included in your Claude plan, no API bill.
- **Notion, GitHub and Netlify**: their free plans are enough to start.
- **The chat page online**: your AI provider charges per question. OpenBrain keeps each question small (about
  3,000 tokens of context on the example company, a few pages of text), and you set a monthly cap
  (`budgets.monthly_usd`). Above it, the chat page says the budget is reached.

## Privacy and security

- **Your copy stays private.** It holds your documentation: OpenBrain checks that the repo is private before every
  deployment.
- **Keys stay on your computer.** The keys of Notion and of your tools never go to Netlify. The chat page only
  reads the copy of your Notion pages, so a problem on the hosting side exposes neither Notion nor your tools.
- **Read only.** The assistant never sends, creates or changes anything outside the chat. Notion only changes
  during `/init`, `/weekly` or `/write`, after your OK.
- **Sensitive content is flagged.** Passwords, keys and personal data found in your tools are reported and never
  copied into Notion.
- **Access codes are stored as fingerprints only**, and shown once.

## FAQ

**Do I need to know how to code?** No. You paste a few commands, and Claude Code explains and does the rest.

**My company doesn't use Notion.** Notion is required for now: it is the one place the assistant answers from.
The other tools (Drive, Confluence exports, Slack...) can fill it during `/init`.

**Which AI answers my team?** The one you choose: Anthropic, OpenAI, Google, Mistral, OpenRouter, DeepSeek, Groq,
xAI, or your own server. You can switch from the admin page, without redeploying.

**Can I add knowledge that is not in any tool yet?** Yes: tell Claude the facts, or give it a document, with
`/write`. It finds the right Notion page and shows you the text before writing.

**Can the assistant change things in my tools?** No. Your tools are only read, and Notion only changes after your
OK.

**What happens when it doesn't know?** It says *"This is not documented yet"* and notes the question. At the next
`/weekly`, Claude looks for the answer in your tools and proposes to add it to Notion.

**How do I get new versions of OpenBrain?** `npm run openbrain -- upgrade --repo arthczer-555/openbrain` shows what
would change, `--yes` applies it. It only replaces OpenBrain's own files, never your knowledge or your settings.

**Something doesn't work.** Run `npm run openbrain -- doctor`, or ask Claude in the folder: it knows the project.

## Roadmap

- 🔜 A built-in Slack reader (today: the Slack connector for Claude), the weekly update without Claude Code, the
  public website and documentation.
- 🔜 Later: a Slack bot, access rights per team.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Quick check before a pull request:

```bash
npm install && npm test && npm run typecheck && npm run e2e
```

The code layout is in the [reference](REFERENCE.md#code-layout). Never put real company data in this repo: the
examples use the made-up company Acme.

## License

MIT, see [LICENSE](LICENSE).
