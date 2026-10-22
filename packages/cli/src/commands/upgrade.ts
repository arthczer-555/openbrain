import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, dim, green, pink, red, rootOf } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain upgrade: an instance gets the engine fixes of a release without losing its
// own files. Only the engine zone is replaced (allow-list below); the instance zone (knowledge/, brain/,
// evals/, state/, openbrain.config.yaml, .env, CLAUDE.md) is never touched. Dry run unless --yes.

/** Engine zone: paths replaced by an upgrade. Everything else belongs to the instance. */
export const ENGINE_PATHS = [
  "packages",
  "apps/web",
  "netlify",
  "netlify.toml",
  ".claude/skills",
  ".githooks",
  ".github/workflows/ci.yml",
  ".github/workflows/reminder.yml",
  "examples/acme",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".env.example",
  "CONTRIBUTING.md",
  "REFERENCE.md",
  "SECURITY.md",
  "LICENSE",
];

/** Never written by an upgrade, even if a release contained them. */
const INSTANCE_PATHS = ["knowledge", "brain", "evals", "state", "openbrain.config.yaml", ".env", "CLAUDE.md", ".openbrain"];

async function hashTree(target: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (full: string, rel: string): Promise<void> => {
    let info;
    try {
      info = await stat(full);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(full)) {
        if (name === "node_modules" || name === "dist" || name === ".astro") continue;
        await walk(path.join(full, name), rel ? `${rel}/${name}` : name);
      }
    } else {
      out.set(rel, createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  };
  await walk(target, "");
  return out;
}

async function fetchRelease(repo: string, version: string | undefined, into: string): Promise<string> {
  const api = version ? `https://api.github.com/repos/${repo}/releases/tags/${version}` : `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await fetch(api, { headers: { accept: "application/vnd.github+json" } });
  if (!release.ok) throw new Error(`${api}: HTTP ${release.status}`);
  const body = (await release.json()) as { tarball_url?: string; tag_name?: string };
  if (!body.tarball_url) throw new Error("the release has no tarball");
  const archive = await fetch(body.tarball_url);
  if (!archive.ok) throw new Error(`${body.tarball_url}: HTTP ${archive.status}`);
  const file = path.join(into, "release.tar.gz");
  await writeFile(file, Buffer.from(await archive.arrayBuffer()));
  return file;
}

/** Unpacks a .tar.gz (GitHub wraps the tree in one folder) or uses a folder as is. Returns the tree root. */
async function unpack(source: string, into: string): Promise<string> {
  if ((await stat(source)).isDirectory()) return source;
  const out = path.join(into, "tree");
  await mkdir(out, { recursive: true });
  const result = spawnSync("tar", ["-xzf", source, "-C", out], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  const entries = await readdir(out);
  return entries.length === 1 && entries[0] ? path.join(out, entries[0]) : out;
}

export const upgradeCommand: CommandDefinition = {
  name: "upgrade",
  help: "upgrade [--yes]            Update the engine files from a release, never the instance files",
  booleanFlags: ["yes"],
  async run(args: ParsedArgs): Promise<number> {
    const root = rootOf(args);
    const from = stringFlag(args, "from");
    const repo = stringFlag(args, "repo") ?? process.env.OPENBRAIN_UPSTREAM_REPO;
    if (!from && !repo) {
      console.log("usage: openbrain upgrade --repo <owner>/<repo> [--version vX.Y.Z] [--yes]   or   --from <release.tar.gz|folder>");
      return 1;
    }
    const work = await mkdtemp(path.join(tmpdir(), "openbrain-upgrade-"));
    try {
      const source = from ? path.resolve(from) : await fetchRelease(repo ?? "", stringFlag(args, "version"), work);
      const tree = await unpack(source, work);
      if (!existsSync(path.join(tree, "packages", "core"))) throw new Error(`${from ?? repo} does not look like an OpenBrain release (no packages/core)`);

      const changes: Array<{ file: string; kind: "new" | "changed" | "removed" }> = [];
      for (const entry of ENGINE_PATHS) {
        if (INSTANCE_PATHS.some((p) => entry === p || entry.startsWith(`${p}/`))) continue;
        const next = await hashTree(path.join(tree, entry));
        const current = await hashTree(path.join(root, entry));
        const single = next.size === 1 && next.has("");
        for (const [file, hash] of next) {
          const name = single ? entry : `${entry}/${file}`;
          const before = current.get(file);
          if (before === undefined) changes.push({ file: name, kind: "new" });
          else if (before !== hash) changes.push({ file: name, kind: "changed" });
        }
        for (const file of current.keys()) {
          if (!next.has(file)) changes.push({ file: next.size === 0 && file === "" ? entry : `${entry}/${file}`, kind: "removed" });
        }
      }

      console.log(bold(`Engine update from ${from ?? repo}`));
      if (changes.length === 0) {
        console.log(green("  already up to date"));
        return 0;
      }
      for (const c of changes.slice(0, 60)) console.log(`  ${c.kind === "new" ? green("new    ") : c.kind === "removed" ? red("removed") : pink("changed")} ${c.file}`);
      if (changes.length > 60) console.log(dim(`  ... ${changes.length - 60} more`));
      console.log(dim(`  instance files kept as they are: ${INSTANCE_PATHS.join(", ")}`));
      if (!boolFlag(args, "yes")) {
        console.log(pink("\nDry run: add --yes to apply. Commit your work first, so the upgrade is one reviewable commit."));
        return 0;
      }
      for (const entry of ENGINE_PATHS) {
        const src = path.join(tree, entry);
        const dest = path.join(root, entry);
        if (!existsSync(src)) {
          if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
          continue;
        }
        await rm(dest, { recursive: true, force: true });
        await mkdir(path.dirname(dest), { recursive: true });
        await cp(src, dest, { recursive: true });
      }
      console.log(green(`\n${changes.length} engine file(s) updated.`) + " Next: npm install, npm run openbrain -- doctor, then commit.");
      return 0;
    } catch (error) {
      console.log(red(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`));
      return 1;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};
