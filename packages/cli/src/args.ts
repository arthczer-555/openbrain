// Minimal argument parser: positionals + "--flag value" / "--flag=value" / boolean "--flag".

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["json", "full", "help"]);

/** `extraBooleans`: flags of the command being run that take no value. */
export function parseArgs(argv: string[], extraBooleans: readonly string[] = []): ParsedArgs {
  const booleans = new Set([...BOOLEAN_FLAGS, ...extraBooleans]);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!booleans.has(body) && next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { positionals, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function intFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`--${name} expects a number, got "${value}"`);
  return parsed;
}

/** The command word: the first argument that is not a flag. */
export function firstPositional(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith("-"));
}
