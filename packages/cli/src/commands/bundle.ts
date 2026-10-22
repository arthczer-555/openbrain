import path from "node:path";
import { BUNDLE_FILE, buildBundle, saveBundle } from "@openbrain/server";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain bundle: one JSON file with everything the deployed chatbot needs (index, core.md, catalog.md,
// config, eval questions, date of the last weekly update), shipped with the Netlify function. Run at deploy.

export const bundleCommand: CommandDefinition = {
  name: "bundle",
  help: "bundle [--out <file>]      Build the runtime bundle of the chatbot (run by the Netlify build)",
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const out = path.resolve(stringFlag(args, "out") ?? BUNDLE_FILE);
    const commit = stringFlag(args, "commit") ?? process.env.COMMIT_REF ?? null;
    const bundle = await buildBundle(root, { commit, env: process.env });
    await saveBundle(out, bundle);
    const kb = Object.keys(bundle.index.docs).length;
    console.log(
      `wrote ${path.relative(process.cwd(), out)}: ${kb} pages, ${bundle.index.chunks.length} passages, ` +
        `${bundle.evalQuestions.length} eval questions${commit ? `, commit ${commit.slice(0, 7)}` : ""}, embeddings ${bundle.embeddings}`,
    );
    return 0;
  },
};
