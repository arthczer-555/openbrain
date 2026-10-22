#!/usr/bin/env node
// Runs the TypeScript CLI through tsx (no build step in v0.1).
import { register } from "tsx/esm/api";

register();
process.env.OPENBRAIN_CLI = "1";
await import("../src/main.ts");
