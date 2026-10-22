import { createInterface } from "node:readline/promises";
import { loadInstanceConfig } from "@openbrain/core";
import { newConversation, runTurn, type AgentMode, type ConversationState, type TurnRecord } from "@openbrain/agent";
import { createLLMChain, createProviderRegistry, type LLM } from "@openbrain/llm";
import { buildBundle, knowledgeFromBundle, resolveSettings } from "@openbrain/server";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, chatSpecs, describeSpecs, dim, formatUsage, pink, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain ask: the chatbot in the terminal, on the local mirror, with the model of the config or --model.
// Without a question it keeps one conversation open (follow-up questions work like in the web chat).

interface Session {
  llm: LLM;
  state: ConversationState;
  ask(question: string): Promise<TurnRecord>;
}

async function openSession(args: ParsedArgs, json: boolean): Promise<Session> {
  const root = rootOf(args);
  const bundle = await buildBundle(root, { env: process.env });
  const settings = resolveSettings(await loadInstanceConfig(root), process.env);
  const specs = await chatSpecs(root, stringFlag(args, "model"), { subscriptionFallback: true });
  const llm = createLLMChain(specs, { env: process.env, registry: createProviderRegistry(settings.openaiCompatible), pricing: settings.pricing });
  const knowledge = knowledgeFromBundle(bundle, process.env);
  const modeFlag = stringFlag(args, "mode");
  const mode: AgentMode | undefined =
    modeFlag === "agent" || modeFlag === "retrieval_first" ? modeFlag : settings.mode === "auto" ? undefined : settings.mode;
  if (!json) console.log(dim(`model: ${describeSpecs(specs)}, ${Object.keys(bundle.index.docs).length} pages\n`));
  const state = newConversation();

  return {
    llm,
    state,
    async ask(question) {
      let wroteText = false;
      const record = await runTurn({
        llm,
        knowledge,
        brain: bundle.brain,
        state,
        question,
        ...(mode ? { mode } : {}),
        deadline: Date.now() + 120_000,
        onEvent: (event) => {
          if (json) return;
          if (event.type === "step") {
            const s = event.step;
            const line =
              s.kind === "search"
                ? `searched${s.section ? ` ${s.section}` : ""} "${s.query}" (${s.hits})`
                : s.kind === "read"
                  ? `read ${s.title}`
                  : `flagged: ${s.reason}`;
            process.stdout.write(dim(`  ${line}\n`));
          } else if (event.type === "text") {
            if (!wroteText) process.stdout.write("\n");
            wroteText = true;
            process.stdout.write(event.delta);
          }
        },
      });
      if (json) {
        console.log(JSON.stringify(record, null, 2));
        return record;
      }
      process.stdout.write("\n\n");
      for (const c of record.citations) {
        const citation = state.citations.find((x) => x.cite === c.cite);
        const where = [citation?.title ?? c.page, ...(citation?.headingPath ?? [])].join(" > ");
        const status = citation && citation.status !== "validated" ? ` [${citation.status}]` : "";
        console.log(`  ${pink(`[${c.cite}]`)} ${where}${status} ${dim(c.url)}`);
      }
      if (record.gaps.length > 0) console.log(dim(`  flagged for the next weekly update (${record.gaps.map((g) => g.reason).join(", ")})`));
      console.log(dim(`  ${record.rounds} tool round(s), ${formatUsage(record.usage)}, ${(record.latencyMs / 1000).toFixed(1)} s\n`));
      return record;
    },
  };
}

export const askCommand: CommandDefinition = {
  name: "ask",
  help: 'ask ["<question>"]         Chat with the brain in the terminal (--model provider:model)',
  async run(args: ParsedArgs): Promise<number> {
    const json = boolFlag(args, "json");
    const question = args.positionals.slice(1).join(" ").trim();
    const session = await openSession(args, json);
    if (question) {
      await session.ask(question);
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(dim("Ask a question (empty line or Ctrl+D to quit)."));
    try {
      for (;;) {
        let line: string;
        try {
          line = (await rl.question(`${pink(">")} `)).trim();
        } catch {
          break;
        }
        if (!line) break;
        try {
          await session.ask(line);
        } catch (error) {
          console.log(`${bold("error")} ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
    return 0;
  },
};
