import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkGuide, hasErrors, lintKnowledgeBase, loadInstanceConfig, loadKnowledgeBase, prepareGuide } from "@openbrain/core";
import { detectSensitive } from "@openbrain/connectors";
import { builtinCatalog, createProviderRegistry, findModel, formatRef } from "@openbrain/llm";
import { resolveSettings } from "@openbrain/server";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { bold, chatSpecs, dim, green, red, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain doctor: the "before production" checklist of an instance.
// Read-only, no LLM. Exit code 1 when a blocking check fails, so it can run as a pre-push hook.

type Level = "ok" | "warn" | "fail";

interface Check {
  level: Level;
  label: string;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

async function latestEvalRun(root: string): Promise<{ file: string; runs: Array<{ model: string; summary: { abstention: number | null; language: number | null; recallAtK: number | null } }> } | null> {
  const dir = path.join(root, ".openbrain", "evals");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  for (const file of files.reverse()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as { runs?: unknown };
      if (Array.isArray(parsed.runs) && parsed.runs.length > 0) return { file, runs: parsed.runs as never };
    } catch {
      continue;
    }
  }
  return null;
}

async function secretsInBase(root: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(md|ya?ml|json)$/.test(entry.name)) {
        const secrets = detectSensitive(await readFile(full, "utf8")).filter((f) => f.category === "secret");
        for (const s of secrets) hits.push(`${path.relative(root, full)} line ${s.lines[0] ?? "?"}: ${s.kind}`);
      }
    }
  };
  await walk(path.join(root, "knowledge"));
  await walk(path.join(root, "brain"));
  return hits;
}

export const doctorCommand: CommandDefinition = {
  name: "doctor",
  help: "doctor                     Before-production checklist: privacy, auth, guide, model, evals, secrets",
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const checks: Check[] = [];
    const add = (level: Level, label: string): void => {
      checks.push({ level, label });
    };

    const major = Number(process.versions.node.split(".")[0]);
    add(major >= 24 ? "ok" : "fail", `Node ${process.versions.node}${major >= 24 ? "" : " (24 or newer required)"}`);

    // Privacy: private repo, secrets out of git and out of the base.
    const inRepo = git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.ok) {
      const tracked = git(root, ["ls-files", "--", ".env", ".env.*"]).out.split("\n").filter((f) => f && !f.endsWith(".env.example"));
      add(tracked.length === 0 ? "ok" : "fail", tracked.length === 0 ? ".env is not tracked by git" : `secrets file tracked by git: ${tracked.join(", ")}`);
      const visibility = spawnSync("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], { cwd: root, encoding: "utf8" });
      if (visibility.status === 0) {
        const isPublic = (visibility.stdout ?? "").trim().toUpperCase() === "PUBLIC";
        const examples = root.includes(`${path.sep}examples${path.sep}`);
        add(isPublic && !examples ? "fail" : "ok", isPublic ? (examples ? "public repo, fictional example only" : "the repo is PUBLIC while it holds the knowledge mirror") : "repo is private");
      } else add("warn", "repo visibility not checked (gh missing or no GitHub remote)");
    } else add("warn", "not a git repository yet: the weekly update publishes with git push");

    const secrets = await secretsInBase(root);
    add(secrets.length === 0 ? "ok" : "fail", secrets.length === 0 ? "no secret pattern in knowledge/ and brain/" : `secret patterns found: ${secrets.slice(0, 3).join("; ")}`);

    // Configuration and auth.
    let settings;
    try {
      settings = resolveSettings(await loadInstanceConfig(root), process.env);
      add(settings.auth.mode === "none" ? "fail" : "ok", settings.auth.mode === "none" ? 'auth.mode "none" is refused in production' : `auth: ${settings.auth.mode}`);
      if (settings.auth.mode === "google" && settings.auth.allowedDomains.length === 0) add("warn", "google sign-in without allowed_domains: any Google account could sign in");
      add(settings.budgets.monthlyUsd > 0 ? "ok" : "warn", settings.budgets.monthlyUsd > 0 ? `monthly budget cap: $${settings.budgets.monthlyUsd}` : "no monthly budget cap");
    } catch (error) {
      add("fail", error instanceof Error ? error.message : String(error));
    }

    // Knowledge base and guide.
    const kb = await loadKnowledgeBase(root);
    const issues = lintKnowledgeBase(kb);
    add(hasErrors(issues) ? "fail" : "ok", hasErrors(issues) ? `lint: ${issues.filter((i) => i.level === "error").length} error(s), run openbrain lint` : `lint clean (${kb.docs.length} pages)`);
    const { guide, problems, budgets } = await prepareGuide(kb);
    const state = await checkGuide(root, guide);
    add(problems.length === 0 && state.upToDate ? "ok" : "fail", problems.length > 0 ? problems.join("; ") : state.upToDate ? `guide up to date (${budgets.map((b) => `${b.name} ~${b.tokens}/${b.limit}`).join(", ")})` : "guide stale: run openbrain guide build");

    // The core prompt goes into every call: no placeholder may stay in it.
    try {
      const core = await readFile(path.join(root, "brain", "core.md"), "utf8");
      const placeholder = /\((add|todo|tbd|to fill)[^)]*\)|<[a-z][^>]*>|\[(todo|tbd)\]/i.exec(core);
      add(placeholder ? "warn" : "ok", placeholder ? `brain/core.md still has a placeholder: "${placeholder[0].slice(0, 60)}"` : "brain/core.md has no placeholder");
    } catch {
      add("fail", "brain/core.md is missing (npm run openbrain -- init)");
    }

    // Model: capabilities, key, evals.
    if (settings) {
      const [primary] = await chatSpecs(root, undefined);
      if (primary) {
        const id = formatRef(primary.ref);
        const entry = findModel(builtinCatalog(), primary.ref);
        add(entry ? "ok" : "warn", entry ? `chat model ${id}: ${entry.caps.tools ? "tool calling" : "no tool calling (retrieval-first mode)"}, ${entry.price ? `$${entry.price.input}/$${entry.price.output} per M tokens` : "not priced"}` : `chat model ${id}: capabilities not verified (run openbrain models refresh)`);
        const def = createProviderRegistry(settings.openaiCompatible).get(primary.ref.provider);
        if (def?.local) add("warn", `${def.label} runs on this machine: Netlify cannot reach it`);
        const keyName = primary.apiKeyEnv ?? def?.envKeys.find((k) => process.env[k]) ?? def?.envKeys[0];
        if (def && !def.keyless) add(keyName && process.env[keyName] ? "ok" : "warn", keyName && process.env[keyName] ? `${keyName} set locally (deploy copies it to Netlify)` : `${keyName ?? "provider key"} not set locally`);
        const evals = await latestEvalRun(root);
        const run = evals?.runs.find((r) => r.model === id);
        if (!run) add("warn", `${id} has never passed this instance's evals: npm run openbrain -- eval --model ${id}`);
        else {
          const s = run.summary;
          const below = [
            s.recallAtK !== null && s.recallAtK < 0.9 ? "recall" : "",
            s.abstention !== null && s.abstention < 1 ? "abstention" : "",
            s.language !== null && s.language < 1 ? "language" : "",
          ].filter(Boolean);
          add(below.length === 0 ? "ok" : "warn", below.length === 0 ? `${id} passed the evals (${evals?.file})` : `${id} is below the thresholds on ${below.join(", ")} (${evals?.file})`);
        }
      }
    }

    // Maintenance.
    try {
      const sync = JSON.parse(await readFile(path.join(root, "state", "sync.json"), "utf8")) as { last_weekly?: string };
      const days = sync.last_weekly ? Math.floor((Date.now() - Date.parse(sync.last_weekly)) / 86_400_000) : null;
      add(days !== null && days <= 8 ? "ok" : "warn", days === null ? "no weekly update recorded" : `last weekly update ${days} day(s) ago${days > 8 ? ": run claude then /weekly" : ""}`);
    } catch {
      add("warn", "no weekly update recorded yet (state/sync.json)");
    }

    if (boolFlag(args, "json")) {
      console.log(JSON.stringify(checks, null, 2));
    } else {
      console.log(bold("OpenBrain doctor"));
      for (const c of checks) console.log(`  ${c.level === "ok" ? green("ok  ") : c.level === "warn" ? dim("warn") : red("FAIL")} ${c.label}`);
      const fails = checks.filter((c) => c.level === "fail").length;
      const warns = checks.filter((c) => c.level === "warn").length;
      console.log(`\n${fails === 0 ? green("ready") : red(`${fails} blocking problem(s)`)}${warns > 0 ? dim(`, ${warns} warning(s)`) : ""}`);
    }
    return checks.some((c) => c.level === "fail") ? 1 : 0;
  },
};
