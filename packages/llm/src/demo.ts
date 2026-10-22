import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

// The demo model: no LLM, no key, deterministic. It speaks the tool protocol like a real model so the whole
// chain runs for real (agent loop, citations, report_gap, streaming, UI) on the Acme example:
//  1. no tool result yet for the question  -> calls search_knowledge with the question,
//  2. passages found                       -> answers by quoting the best ones with their [n] citations,
//  3. nothing found                        -> calls report_gap, then says it is not documented.
// It reads the text format produced by the agent tools (see packages/agent/src/tools.ts).

export interface DemoPassage {
  cite: number;
  title: string;
  /** Page id from the result ("internal-tools/accounts"), empty when absent. */
  page: string;
  status: string;
  text: string;
}

/** Parses the passages of a search_knowledge or read_document result ("[n] Title > heading" blocks). */
export function parsePassages(output: string): DemoPassage[] {
  const passages: DemoPassage[] = [];
  const blocks = output.split(/\n(?=\[\d+\] )/);
  for (const block of blocks) {
    const head = /^\[(\d+)\] (.+)$/m.exec(block);
    if (!head || head.index !== block.search(/\[\d+\] /)) continue;
    const lines = block.slice(head.index).split("\n");
    const meta = lines[1] ?? "";
    const status = /status: ([a-z_]+)/.exec(meta)?.[1] ?? "validated";
    const page = /page: ([^\s|]+)/.exec(meta)?.[1] ?? "";
    const body: string[] = [];
    for (const line of lines.slice(2)) {
      if (/^(section rules|warning:|results? for|no passage)/i.test(line.trim())) break;
      body.push(line);
    }
    passages.push({ cite: Number(head[1]), title: head[2] ?? "", page, status, text: body.join("\n").trim() });
  }
  return passages;
}

const FRENCH_HINTS =
  /\b(comment|quel|quelle|quels|quelles|pourquoi|est-ce|est|le|la|les|de|du|des|un|une|dans|pour|avec|sur|nous|notre|nos|vous|votre|qui|combien|faut|peut|au|aux)\b/i;

export function looksFrench(text: string): boolean {
  return /[éèêàùç]/i.test(text) || (text.match(new RegExp(FRENCH_HINTS, "gi"))?.length ?? 0) >= 2;
}

function firstSentences(text: string, maxChars = 260): string {
  const flat = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("|"))
    .join(" ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return lastStop > 80 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}...`;
}

function textOf(message: LanguageModelV4Message): string {
  if (message.role === "system") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

interface ToolOutput {
  toolName: string;
  text: string;
}

function toolOutputsAfterLastUser(prompt: LanguageModelV4Message[]): { question: string; outputs: ToolOutput[] } {
  let lastUser = -1;
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  const userMessage = lastUser >= 0 ? prompt[lastUser] : undefined;
  // The agent sends the question first and a short context line ("Today is ...") after it.
  const question =
    userMessage && userMessage.role === "user"
      ? (userMessage.content.find((p) => p.type === "text")?.text ?? "").trim()
      : "";
  const outputs: ToolOutput[] = [];
  for (const message of prompt.slice(lastUser + 1)) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      const text =
        output.type === "text" || output.type === "error-text"
          ? output.value
          : output.type === "json" || output.type === "error-json"
            ? JSON.stringify(output.value)
            : "";
      outputs.push({ toolName: part.toolName, text });
    }
  }
  return { question, outputs };
}

type Decision = { kind: "tool"; toolName: string; input: Record<string, unknown> } | { kind: "text"; text: string };

export function decide(options: LanguageModelV4CallOptions): Decision {
  const toolNames = new Set((options.tools ?? []).filter((t) => t.type === "function").map((t) => t.name));
  const canCall = options.toolChoice?.type !== "none";
  const { question, outputs } = toolOutputsAfterLastUser(options.prompt);
  const fr = looksFrench(question);

  const searches = outputs.filter((o) => o.toolName === "search_knowledge" || o.toolName === "read_document");
  const reported = outputs.some((o) => o.toolName === "report_gap");
  // The search says when its best passage misses most key terms: the demo then abstains, like a careful model.
  const weak = searches.length > 0 && searches.every((o) => /weak match/i.test(o.text));
  const passages = weak ? [] : searches.flatMap((o) => parsePassages(o.text));

  if (searches.length === 0 && canCall && toolNames.has("search_knowledge")) {
    return { kind: "tool", toolName: "search_knowledge", input: { query: question } };
  }
  if (passages.length === 0) {
    if (!reported && canCall && toolNames.has("report_gap")) {
      return {
        kind: "tool",
        toolName: "report_gap",
        input: { question, searched: [question], reason: "not_found" },
      };
    }
    return {
      kind: "text",
      text: fr
        ? `Ce n'est pas encore documenté. J'ai cherché « ${question} » dans la base, sans rien qui y réponde. La question est signalée pour la prochaine mise à jour hebdomadaire.`
        : `This is not documented yet. I searched the knowledge base for "${question}" and found nothing that answers it. The question has been flagged for the next weekly update.`,
    };
  }

  // Scope beats keyword: quote only the section of the best passage, never a neighbor with the same words.
  const section = passages[0]?.page.split("/")[0] ?? "";
  const seen = new Set<string>();
  const picked: DemoPassage[] = [];
  for (const p of passages) {
    if (section && p.page && p.page.split("/")[0] !== section) continue;
    const doc = p.title.split(" > ")[0] ?? p.title;
    if (seen.has(doc)) continue;
    seen.add(doc);
    picked.push(p);
    if (picked.length === 2) break;
  }
  const intro = fr ? "Voici ce que dit la base (mode démo : extraits cités, sans LLM) :" : "Here is what the knowledge base says (demo mode: quoted passages, no LLM):";
  const lines = picked.map((p) => {
    const confirm = p.status === "to_confirm" ? (fr ? " (à confirmer)" : " (to be confirmed)") : "";
    return `- **${p.title}**: ${firstSentences(p.text)}${confirm} [${p.cite}]`;
  });
  return { kind: "text", text: [intro, "", ...lines].join("\n") };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function usageFor(options: LanguageModelV4CallOptions, outputText: string): LanguageModelV4Usage {
  const inputChars = JSON.stringify(options.prompt).length;
  const input = Math.ceil(inputChars / 3.5);
  const output = Math.ceil(outputText.length / 3.5);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

export class DemoLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "demo";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  /** Pause between streamed words, so a local demo looks like a real stream (0 in tests). */
  private readonly delayMs: number;

  constructor(modelId = "extractive", options: { delayMs?: number } = {}) {
    this.modelId = modelId;
    this.delayMs = options.delayMs ?? 0;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const decision = decide(options);
    const content: LanguageModelV4Content[] =
      decision.kind === "tool"
        ? [{ type: "tool-call", toolCallId: nextId("call"), toolName: decision.toolName, input: JSON.stringify(decision.input) }]
        : [{ type: "text", text: decision.text }];
    const out = decision.kind === "tool" ? JSON.stringify(decision.input) : decision.text;
    return {
      content,
      finishReason: { unified: decision.kind === "tool" ? "tool-calls" : "stop", raw: undefined },
      usage: usageFor(options, out),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const decision = decide(options);
    const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
    if (decision.kind === "tool") {
      parts.push({
        type: "tool-call",
        toolCallId: nextId("call"),
        toolName: decision.toolName,
        input: JSON.stringify(decision.input),
      });
    } else {
      const id = nextId("text");
      parts.push({ type: "text-start", id });
      // Word-sized deltas so the UI shows a real stream.
      for (const piece of decision.text.match(/\S+\s*|\s+/g) ?? []) parts.push({ type: "text-delta", id, delta: piece });
      parts.push({ type: "text-end", id });
    }
    const out = decision.kind === "tool" ? JSON.stringify(decision.input) : decision.text;
    parts.push({
      type: "finish",
      finishReason: { unified: decision.kind === "tool" ? "tool-calls" : "stop", raw: undefined },
      usage: usageFor(options, out),
    });
    const delayMs = this.delayMs;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        for (const part of parts) {
          if (delayMs > 0 && part.type === "text-delta") await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(part);
        }
        controller.close();
      },
    });
    return { stream };
  }
}
