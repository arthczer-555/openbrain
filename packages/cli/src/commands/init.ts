import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, dim, green, pink, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain init: creates the instance files, called by the /setup skill (Claude Code is required, D20).
// Writes openbrain.config.yaml, brain/core.md from the generic template, an empty
// registry and evals, and never overwrites an existing file. Asks the questions itself in a terminal.

interface Answers {
  company: string;
  assistant: string;
  language: string;
  rootPage: string;
  auth: "passcode" | "google";
  domains: string;
  model: string;
}

/** The generic core prompt (budget 1,200 tokens, checked by `guide build`). */
export function coreTemplate(a: Pick<Answers, "company" | "assistant" | "language">): string {
  const languageName = a.language === "fr" ? "French" : a.language === "en" ? "English" : a.language;
  return `You are ${a.assistant}, the internal knowledge assistant of ${a.company}.
You answer employees' questions from the company knowledge base, which you reach only through your tools.

How to work
- For any question about ${a.company} (processes, products, policies, clients, tools), search first.
  Never answer company-specific questions from memory. General know-how (writing, methods) needs no search.
- Search broadly once rather than narrowly twice: issue several search_knowledge calls in parallel when the
  question spans procedure + tool screens + who does what. Write queries in ${languageName}.
- If the question names a scope (a tool, an audience, a team), that scope decides where to look; keywords
  only pick the document inside it. If a setting is chosen at one level, also check the parent level.
- Read a document with read_document only when the passages are not enough.
- Warnings returned with a passage are binding: apply them.

Golden rules
- Zero invention: every company fact comes from a retrieved passage. If it is not there, say
  "This is not documented yet", call report_gap, and say what you searched.
- A negative result covers only what you actually searched. Never claim a coverage you did not do.
- Separate facts from inferences: label your own conclusions ("my reading, to confirm").
- Cite every fact right after it as [n] using the citation ids returned by the tools.
- Documents marked to_confirm or stale: say so when you use them.
- You are read-only. You never send, create or change anything outside this chat.

Style
- Answer entirely in the language of the user's last message, whatever the language of the sources.
- Direct answer first, details after. Length proportional to the question.
- Business language by default; technical identifiers only if asked.
`;
}

function configTemplate(a: Answers): string {
  const [provider, ...rest] = a.model.split(":");
  const model = rest.join(":");
  const domains = a.domains
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return `# OpenBrain instance configuration. Secrets never go here: they live in .env (local) and in Netlify.

instance:
  name: ${JSON.stringify(a.company)}
  kb_language: ${a.language}

notion:
  root_page: ${JSON.stringify(a.rootPage || "<notion-root-page-id>")}   # the only tree the chatbot knows

chatbot:
  assistant_name: ${JSON.stringify(a.assistant)}
  accent: "#F00050"

auth:
  mode: ${a.auth}${domains.length > 0 ? `\n  allowed_domains: [${domains.map((d) => JSON.stringify(d)).join(", ")}]` : ""}

budgets:
  monthly_usd: 50
  questions_per_user_per_day: 100

models:
  chat: { provider: ${provider}, model: ${model}, effort: low }

# Read-only inputs consolidated into Notion at each weekly update (see packages/connectors/src/<id>/SETUP.md)
# inputs:
#   files:  { enabled: true, paths: ["./exports"], include: ["**/*.md"] }
#   github: { enabled: true, repos: ["acme/app"], docs_globs: ["README.md", "docs/**/*.md"], commits: true }
`;
}

async function writeIfMissing(file: string, content: string, created: string[], skipped: string[], root: string): Promise<void> {
  const rel = path.relative(root, file);
  if (existsSync(file)) {
    skipped.push(rel);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  created.push(rel);
}

export const initCommand: CommandDefinition = {
  name: "init",
  help: "init                       Create the instance files (config, core prompt, registry, evals), used by /setup",
  booleanFlags: ["yes"],
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const defaults: Answers = {
      company: stringFlag(args, "company") ?? "Acme",
      assistant: stringFlag(args, "assistant") ?? "",
      language: stringFlag(args, "language") ?? "en",
      rootPage: stringFlag(args, "root-page") ?? "",
      auth: stringFlag(args, "auth") === "google" ? "google" : "passcode",
      domains: stringFlag(args, "domains") ?? "",
      model: stringFlag(args, "model") ?? "anthropic:claude-opus-5-5",
    };
    let answers = { ...defaults };
    if (!boolFlag(args, "yes") && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = async (label: string, value: string): Promise<string> => (await rl.question(`${label} ${dim(`(${value || "empty"})`)} `)).trim() || value;
      console.log(`${pink(">")} ${bold("OpenBrain instance files")} ${dim("(Enter keeps the default; /setup in Claude Code runs this for you)")}\n`);
      answers.company = await ask("Company name", defaults.company);
      answers.assistant = await ask("Assistant name", defaults.assistant || `${answers.company} Brain`);
      answers.language = await ask("Language of the knowledge base (en, fr...)", defaults.language);
      answers.rootPage = await ask("Notion root page id or URL", defaults.rootPage);
      answers.auth = (await ask("Sign-in: passcode or google", defaults.auth)) === "google" ? "google" : "passcode";
      if (answers.auth === "google") answers.domains = await ask("Allowed email domains (comma separated)", defaults.domains);
      answers.model = await ask("Chat model (provider:model)", defaults.model);
      rl.close();
    }
    answers = { ...answers, assistant: answers.assistant || `${answers.company} Brain` };
    if (!answers.model.includes(":")) {
      console.log("the chat model must be written provider:model, for example anthropic:claude-opus-5-5");
      return 1;
    }
    // A Notion URL ends with the page id (32 hex characters).
    const fromUrl = /([0-9a-f]{32})(?:\?.*)?$/i.exec(answers.rootPage)?.[1];
    if (fromUrl) answers.rootPage = fromUrl;

    const created: string[] = [];
    const skipped: string[] = [];
    await writeIfMissing(path.join(root, "openbrain.config.yaml"), configTemplate(answers), created, skipped, root);
    await writeIfMissing(path.join(root, "brain", "core.md"), coreTemplate(answers), created, skipped, root);
    await writeIfMissing(
      path.join(root, "brain", "registry.yaml"),
      "# Routing registry: one entry per mirrored Notion page (when to open it, aliases, warnings, status)\n# and per section (description, routing rules). Written by /init and the weekly update.\nversion: 1\nsections: {}\ndocs: {}\n",
      created,
      skipped,
      root,
    );
    await writeIfMissing(
      path.join(root, "evals", "golden.yaml"),
      '# Questions of reference. Every question fixed by a weekly update lands here.\n# - id: example-01\n#   question: "How do I ...?"\n#   lang: en\n#   expect: { behavior: answer, must_cite: ["section/page"] }\n[]\n',
      created,
      skipped,
      root,
    );
    await mkdir(path.join(root, "knowledge"), { recursive: true });
    await mkdir(path.join(root, "state"), { recursive: true });

    for (const f of created) console.log(`  ${green("created")} ${f}`);
    for (const f of skipped) console.log(`  ${dim("kept   ")} ${f} ${dim("(already there)")}`);
    console.log(`\nNext, in Claude Code (required):
  1. Put NOTION_TOKEN (read-only integration) and the chat model key in .env, never in a conversation or in git.
  2. /setup continues from here: Notion test and sync, inputs, model, registry, evals.
  3. /init if the knowledge is spread over Drive, Slack or other tools, then deploy, then /weekly every week.
  Optional: up to 10 rules of your own at the end of brain/core.md (for example what you do not offer).`);
    return 0;
  },
};
