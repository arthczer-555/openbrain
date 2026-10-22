import { askCommand } from "./ask.ts";
import { authCommand } from "./auth.ts";
import { bundleCommand } from "./bundle.ts";
import { collectCommand } from "./collect.ts";
import { connectorsCommand } from "./connectors.ts";
import { deployCommand } from "./deploy.ts";
import { doctorCommand } from "./doctor.ts";
import { evalCommand } from "./eval.ts";
import { initCommand } from "./init.ts";
import { modelsCommand } from "./models.ts";
import { reportsCommand } from "./reports.ts";
import { demoCommand, serveCommand } from "./serve.ts";
import { syncCommand } from "./sync.ts";
import { upgradeCommand } from "./upgrade.ts";
import { weeklyCommand } from "./weekly.ts";
import type { CommandDefinition } from "./types.ts";

export type { CommandDefinition } from "./types.ts";

// Registered commands, in help order. To add one: create ./<name>.ts exporting a CommandDefinition,
// then add it to this array (one import, one entry).
export const commands: CommandDefinition[] = [
  initCommand,
  syncCommand,
  demoCommand,
  serveCommand,
  askCommand,
  evalCommand,
  modelsCommand,
  bundleCommand,
  deployCommand,
  doctorCommand,
  reportsCommand,
  authCommand,
  connectorsCommand,
  collectCommand,
  weeklyCommand,
  upgradeCommand,
];
