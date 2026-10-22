// Read-only guard of the MCP adapter: a tool that looks like it writes is never called.
// Checked on the tool name (word by word, so "list_updates" passes and "update_issue" does not), on the
// description (an action verb leading the sentence or followed by an object: "Creates a new issue",
// "Use this tool to delete..."), and on the MCP annotations (destructiveHint, readOnlyHint: false).
// Matching raw substrings in descriptions would refuse most read tools ("sorted by updated date").

/** Verbs whose presence as a word of a tool name means the tool writes. */
export const WRITE_VERBS: readonly string[] = [
  "create",
  "update",
  "delete",
  "remove",
  "send",
  "post",
  "write",
  "insert",
  "upsert",
  "archive",
  "unarchive",
  "move",
  "edit",
  "set",
  "add",
  "patch",
  "put",
  "upload",
  "trash",
  "modify",
  "rename",
  "reply",
  "publish",
  "append",
  "replace",
  "destroy",
  "purge",
  "assign",
  "invite",
  "submit",
  "duplicate",
  "restore",
];

const WRITE_VERB_SET = new Set(WRITE_VERBS);

/** Description verbs: base and third person forms ("create", "creates"); past participles are fine. */
const DESCRIPTION_VERBS = WRITE_VERBS.filter((v) => !["set", "add", "put"].includes(v));

function thirdPerson(verb: string): string {
  if (verb.endsWith("y")) return `${verb.slice(0, -1)}ies`;
  if (verb.endsWith("h")) return `${verb}es`;
  return `${verb}s`;
}

const VERB_ALTERNATION = DESCRIPTION_VERBS.map((v) => `${v}|${thirdPerson(v)}`).join("|");
/** "Creates a ...", "delete the ...", "send one ...": a write verb applied to an object. */
const VERB_WITH_OBJECT = new RegExp(`\\b(?:${VERB_ALTERNATION})\\s+(?:a|an|the|new|one|multiple|existing|your|this|that|these|those|its|their)\\b`, "i");
/** The first word of the description, after an optional "Use this tool to" / "Tool to" / "Allows you to". */
const LEADING_VERB = new RegExp(`^\\s*(?:(?:use\\s+this(?:\\s+tool)?\\s+to|tool\\s+to|this\\s+tool|allows?\\s+(?:you\\s+)?to|lets?\\s+you)\\s+)?(?:${VERB_ALTERNATION})\\b`, "i");

export interface ToolLike {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
}

/** "createIssue", "issues.create", "set-status" -> ["create", "issue"], ["issues", "create"], ["set", "status"]. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

export function writeLikeName(name: string): string | undefined {
  const verb = nameWords(name).find((word) => WRITE_VERB_SET.has(word));
  return verb ? `its name contains "${verb}"` : undefined;
}

/** Why the tool looks like a write tool, or undefined when it looks read-only. */
export function writeLikeReason(tool: ToolLike): string | undefined {
  const byName = writeLikeName(tool.name);
  if (byName) return byName;
  if (tool.annotations?.destructiveHint === true) return "annotated destructiveHint: true";
  if (tool.annotations?.readOnlyHint === false) return "annotated readOnlyHint: false";
  const description = tool.description ?? "";
  if (LEADING_VERB.test(description) || VERB_WITH_OBJECT.test(description)) return "its description describes a write action";
  return undefined;
}

export class McpWriteToolError extends Error {
  readonly tool: string;

  constructor(tool: string, reason: string) {
    super(`refused MCP tool "${tool}": ${reason}. Inputs are read-only: map a list / search / get tool instead.`);
    this.name = "McpWriteToolError";
    this.tool = tool;
  }
}
