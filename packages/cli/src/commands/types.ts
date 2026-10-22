import type { ParsedArgs } from "../args.ts";

/**
 * A pluggable CLI command. Add a file in this folder and one line in ./index.ts:
 * main.ts dispatches to it and lists it in the help.
 */
export interface CommandDefinition {
  /** First word of the command line, for example "sync". */
  name: string;
  /** One line for the help, for example 'sync notion            Mirror the Notion tree into knowledge/'. */
  help: string;
  /** Flags of this command that take no value (so "--dry-run notion" does not swallow "notion"). */
  booleanFlags?: string[];
  run(args: ParsedArgs): Promise<number>;
}
