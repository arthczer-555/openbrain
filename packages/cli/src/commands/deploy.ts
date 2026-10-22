import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { checkGuide, loadInstanceConfig, loadKnowledgeBase, prepareGuide } from "@openbrain/core";
import { createProviderRegistry, type Env } from "@openbrain/llm";
import { buildBundle, hashCode, randomId, resolveSettings } from "@openbrain/server";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, chatSpecs, dim, green, pink, red, REPO_ROOT, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain deploy: checks the instance, asks the operator for the chat's access code (or none), generates
// the other secrets, creates or reuses the Netlify site, sets its environment, deploys, and writes
// OPENBRAIN_URL + ADMIN_TOKEN to the local .env for the weekly update. Without --yes it only prints the plan:
// nothing leaves the machine.

interface Check {
  ok: boolean;
  label: string;
  blocking: boolean;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** The chat's access code, chosen by the operator; "open" = no code, anyone with the link can use the chat. */
type Access = { kind: "code"; code: string } | { kind: "open" };

const MIN_CODE_LENGTH = 8;

/** From --password <code> / --no-password; undefined when neither is given, a string when they are wrong. */
function accessFromFlags(args: ParsedArgs): Access | string | undefined {
  const password = args.flags.get("password");
  if (boolFlag(args, "no-password")) return password === undefined ? { kind: "open" } : "--password and --no-password cannot be used together";
  if (password === undefined) return undefined;
  if (password === true) return "--password needs a value (or use --no-password)";
  return password.length >= MIN_CODE_LENGTH ? { kind: "code", code: password } : `the access code needs at least ${MIN_CODE_LENGTH} characters`;
}

async function askAccess(): Promise<Access> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const code = (await rl.question(`Access code for the chat ${dim("(your team types it to sign in; empty = no code)")} `)).trim();
      if (code.length >= MIN_CODE_LENGTH) return { kind: "code", code };
      if (code) {
        console.log(red(`  at least ${MIN_CODE_LENGTH} characters`));
        continue;
      }
      const answer = await rl.question(`No access code: anyone with the link can read the knowledge base through the chat. Continue? ${dim("(y/N)")} `);
      if (/^y(es)?$/i.test(answer.trim())) return { kind: "open" };
    }
  } finally {
    rl.close();
  }
}

/** "4h7k-9q2m-xp3d": readable, about 60 bits. */
function accessCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

async function upsertEnv(file: string, values: Record<string, string>): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = "";
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${line}\n`;
  }
  await writeFile(file, text, "utf8");
}

async function preflight(root: string, env: Env): Promise<{ checks: Check[]; providerKeys: Record<string, string> }> {
  const checks: Check[] = [];
  const config = await loadInstanceConfig(root);
  const settings = resolveSettings(config, env);

  try {
    await buildBundle(root);
    checks.push({ ok: true, label: "knowledge base lints clean", blocking: true });
  } catch (error) {
    checks.push({ ok: false, label: `knowledge base: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, blocking: true });
  }
  const kb = await loadKnowledgeBase(root);
  const { guide, problems } = await prepareGuide(kb);
  const guideState = await checkGuide(root, guide);
  checks.push({
    ok: problems.length === 0 && guideState.upToDate,
    label: problems.length > 0 ? `guide: ${problems.join("; ")}` : guideState.upToDate ? "guide up to date (catalog, budgets)" : "guide stale: run openbrain guide build",
    blocking: true,
  });
  checks.push({
    ok: settings.auth.mode !== "none",
    label: settings.auth.mode === "none" ? 'auth.mode "none" is refused: the chatbot exposes internal knowledge' : `auth: ${settings.auth.mode}`,
    blocking: true,
  });
  if (settings.auth.mode === "google") {
    const ok = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    checks.push({ ok, label: ok ? "Google OAuth client set" : "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env", blocking: true });
  }

  // T1: an instance repo must be private as soon as the mirror holds knowledge.
  const visibility = run("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], root);
  if (visibility.ok) {
    const isPublic = visibility.out.trim().toUpperCase() === "PUBLIC";
    const isExample = path.resolve(root).startsWith(path.join(REPO_ROOT, "examples"));
    checks.push({
      ok: !isPublic || isExample,
      label: isPublic ? (isExample ? "public repo, fictional example data only" : "the repo is PUBLIC: make it private before deploying knowledge") : "repo is private",
      blocking: true,
    });
  } else {
    checks.push({ ok: true, label: "repo visibility not checked (no gh or no GitHub remote)", blocking: false });
  }

  const providerKeys: Record<string, string> = {};
  const registry = createProviderRegistry(settings.openaiCompatible);
  const specs = await chatSpecs(root, undefined);
  for (const [i, spec] of specs.entries()) {
    const def = registry.get(spec.ref.provider);
    if (!def || def.keyless) continue;
    const name = spec.apiKeyEnv ?? def.envKeys.find((k) => env[k]) ?? def.envKeys[0];
    const value = name ? env[name] : undefined;
    if (name && value) providerKeys[name] = value;
    checks.push({
      ok: Boolean(value),
      label: value ? `${def.label} key found (${name})` : `no ${def.label} key: set ${name ?? "the key"} in .env (model ${spec.ref.provider}:${spec.ref.model})`,
      // The primary model must work; a fallback without its key is only skipped.
      blocking: i === 0,
    });
  }
  const netlify = run("netlify", ["--version"], root);
  checks.push({ ok: netlify.ok, label: netlify.ok ? `netlify CLI ${netlify.out.split(" ")[0] ?? ""}` : "install the Netlify CLI: npm i -g netlify-cli", blocking: true });
  return { checks, providerKeys };
}

export const deployCommand: CommandDefinition = {
  name: "deploy",
  help: "deploy [--yes]             Check, set the secrets and deploy the chatbot on Netlify (--password <code> | --no-password)",
  booleanFlags: ["yes", "no-password"],
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const env = process.env;
    const settings = resolveSettings(await loadInstanceConfig(root), env);

    // Passcode mode: the operator chooses the access code, or none (no sign-in page).
    const passcode = settings.auth.mode === "passcode";
    const flagged = accessFromFlags(args);
    if (typeof flagged === "string") {
      console.log(red(flagged));
      return 1;
    }
    if (!passcode && flagged) console.log(dim(`--password / --no-password ignored: auth.mode is ${settings.auth.mode}`));
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (passcode && !flagged && boolFlag(args, "yes") && !interactive) {
      console.log(red("Choose the chat's access code: --password <code>, or --no-password for a chat without sign-in."));
      return 1;
    }

    const { checks, providerKeys } = await preflight(root, env);

    console.log(bold("Checks"));
    for (const c of checks) console.log(`  ${c.ok ? green("ok  ") : c.blocking ? red("FAIL") : dim("warn")} ${c.label}`);
    const blocked = checks.filter((c) => !c.ok && c.blocking);
    if (blocked.length > 0) {
      console.log(red(`\n${blocked.length} blocking problem(s): nothing was deployed.`));
      return 1;
    }


    const repoRoot = process.cwd();
    const relativeRoot = path.relative(repoRoot, root) || ".";
    const sessionSecret = randomId(32);
    const adminToken = randomId(24);
    const adminCode = accessCode();
    const vars: Record<string, string> = {
      SESSION_SECRET: sessionSecret,
      ADMIN_TOKEN: adminToken,
      ...(relativeRoot !== "." ? { OPENBRAIN_ROOT: relativeRoot } : {}),
      ...(settings.auth.mode !== "google" ? { ADMIN_CODE_HASH: await hashCode(adminCode) } : {}),
      ...(settings.auth.mode === "google"
        ? {
            GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "",
            GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "",
            ...(env.ADMIN_EMAILS ? { ADMIN_EMAILS: env.ADMIN_EMAILS } : {}),
            ...(env.ALLOWED_EMAIL_DOMAINS ? { ALLOWED_EMAIL_DOMAINS: env.ALLOWED_EMAIL_DOMAINS } : {}),
          }
        : {}),
      ...providerKeys,
    };
    // The chat never calls the sources: their tokens stay local.
    for (const local of ["NOTION_TOKEN", "GDRIVE_SA_JSON", "SLACK_BOT_TOKEN", "GITHUB_TOKEN"]) delete vars[local];

    console.log(bold("\nPlan"));
    const linked = existsSync(path.join(repoRoot, ".netlify", "state.json"));
    const site = stringFlag(args, "site");
    console.log(`  1. ${linked ? "use the linked Netlify site" : `create a Netlify site${site ? ` named ${site}` : ""} and link it`}`);
    const accessVar = !passcode ? [] : !flagged ? ["ACCESS_CODE_HASH or OPENBRAIN_OPEN_ACCESS"] : [flagged.kind === "open" ? "OPENBRAIN_OPEN_ACCESS" : "ACCESS_CODE_HASH"];
    const names = [...Object.keys(vars), ...accessVar];
    console.log(`  2. set ${names.length} environment variables: ${names.join(", ")}`);
    if (passcode) {
      const chosen = !flagged ? "asked when you run with --yes (or pass --password <code> / --no-password)" : flagged.kind === "open" ? "none, anyone with the link can use the chat" : "the one given with --password";
      console.log(`     access code: ${chosen}`);
    }
    console.log("  3. deploy to production (the build runs guide check, bundle and the UI build)");
    console.log("  4. write OPENBRAIN_URL and ADMIN_TOKEN to the local .env (for the weekly update)");
    console.log(dim(`  models: ${settings.chat.provider}:${settings.chat.model}; source tokens stay on this machine`));

    if (!boolFlag(args, "yes")) {
      console.log(pink("\nDry run: add --yes to create the site, set the variables and deploy."));
      return 0;
    }

    // A code, when set, always wins over OPENBRAIN_OPEN_ACCESS: the other variable is removed from a linked site.
    const access = passcode ? (flagged ?? (await askAccess())) : null;
    const unset: string[] = [];
    if (access?.kind === "code") {
      vars.ACCESS_CODE_HASH = await hashCode(access.code);
      unset.push("OPENBRAIN_OPEN_ACCESS");
    } else if (access?.kind === "open") {
      vars.OPENBRAIN_OPEN_ACCESS = "1";
      unset.push("ACCESS_CODE_HASH");
    }

    if (!linked) {
      const created = run("netlify", ["sites:create", ...(site ? ["--name", site] : [])], repoRoot);
      if (!created.ok) {
        console.log(red(`netlify sites:create failed:\n${created.out}`));
        return 1;
      }
    }
    for (const [key, value] of Object.entries(vars)) {
      const secret = key !== "OPENBRAIN_ROOT" && key !== "OPENBRAIN_OPEN_ACCESS";
      const set = run("netlify", ["env:set", key, value, "--force", ...(secret ? ["--secret"] : [])], repoRoot);
      if (!set.ok) {
        console.log(red(`netlify env:set ${key} failed:\n${set.out.replace(value, "***")}`));
        return 1;
      }
    }
    for (const key of linked ? unset : []) {
      // Usually fails because the variable is not set. A leftover OPENBRAIN_OPEN_ACCESS is harmless (the code wins).
      const removed = run("netlify", ["env:unset", key], repoRoot).ok;
      if (!removed && key === "ACCESS_CODE_HASH") console.log(dim("  ACCESS_CODE_HASH not removed (probably not set); if it is, the sign-in page stays"));
    }
    const deployed = run("netlify", ["deploy", "--build", "--prod", "--json"], repoRoot);
    if (!deployed.ok) {
      console.log(red(`netlify deploy failed:\n${deployed.out.slice(-2000)}`));
      return 1;
    }
    let url = "";
    try {
      const parsed = JSON.parse(deployed.out.slice(deployed.out.indexOf("{"))) as { url?: string; deploy_url?: string };
      url = parsed.url ?? parsed.deploy_url ?? "";
    } catch {
      url = "";
    }
    await upsertEnv(path.join(repoRoot, ".env"), { ADMIN_TOKEN: adminToken, ...(url ? { OPENBRAIN_URL: url } : {}) });

    console.log(bold(`\n${pink(">")} Deployed${url ? ` at ${url}` : ""}`));
    if (access?.kind === "code") console.log(`  access code for your team: ${bold(access.code)}`);
    if (access?.kind === "open") console.log(`  no access code: anyone with the link can use the chat`);
    if (settings.auth.mode !== "google") console.log(`  admin code (for /admin): ${bold(adminCode)}`);
    console.log(dim("  Codes are stored only as hashes. Share the access code, keep the admin code."));
    console.log(dim("  OPENBRAIN_URL and ADMIN_TOKEN were written to .env for `openbrain reports` and the weekly update."));
    return 0;
  },
};
