import { describe, expect, it } from "vitest";
import { describeInputs, parseInputsConfig } from "../../src/index.ts";

// inputs.claude: tools Claude reads through its own MCP connectors during /init and /weekly. Listed with
// their whitelist scope, never collected by the CLI.

describe("claude inputs (MCP connectors of Claude Code)", () => {
  it("are listed with their scope and never built by the CLI", async () => {
    const inputs = parseInputsConfig({
      claude: {
        slack: { scope: "channels #product, #sales" },
        crm: { scope: "deals that changed stage", connector: "hubspot", enabled: false },
      },
      confluence: { enabled: true },
    });
    const entries = describeInputs(inputs, { root: ".", env: {} });
    expect(entries.map((e) => [e.id, e.via, e.supported, e.enabled])).toEqual([
      ["claude:slack", "claude", false, true],
      ["claude:crm", "claude", false, false],
      ["confluence", "cli", false, true],
    ]);
    expect(entries[1]?.scope).toBe('deals that changed stage (MCP connector "hubspot" in Claude Code)');
    await expect(entries[0]?.create()).rejects.toThrow(/read by Claude through its MCP connector "slack"/);
  });

  it("require a scope", () => {
    expect(() => parseInputsConfig({ claude: { slack: {} } })).toThrow(/inputs\.claude\.slack\.scope/);
  });
});
