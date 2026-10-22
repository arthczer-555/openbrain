import DOMPurify from "dompurify";
import { Marked } from "marked";

// Answers are Markdown with [n] citations. Rendering rules:
// - [n] becomes a citation chip, only for citations the server actually sent;
// - no images, no iframes, no forms: nothing remote is loaded from an answer (exfiltration by URL);
// - links are kept only towards the pages of the sources (Notion) or the app itself.

const marked = new Marked({ gfm: true, breaks: false, async: false });
const CITE_RE = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;
const MARK = "⁣";

let allowedOrigins = new Set<string>();

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") ?? "";
  let keep = href.startsWith("/") && !href.startsWith("//");
  if (!keep) {
    try {
      keep = allowedOrigins.has(new URL(href).origin);
    } catch {
      keep = false;
    }
  }
  if (!keep) {
    node.removeAttribute("href");
    return;
  }
  if (!href.startsWith("/")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export interface RenderOptions {
  /** Citation ids known for this answer: other [n] stay plain text. */
  cites: ReadonlySet<number>;
  /** Origins of the source pages (links towards them are kept). */
  origins: ReadonlySet<string>;
  /** Citation currently shown in the source panel. */
  selected?: number | null;
}

export function renderAnswer(text: string, options: RenderOptions): string {
  const withMarks = text.replace(CITE_RE, (match, group: string) => {
    const ids = group.split(/[,;]/).map((p) => Number(p.trim()));
    if (!ids.every((id) => options.cites.has(id))) return match;
    return ids.map((id) => `${MARK}${id}${MARK}`).join("");
  });
  const html = marked.parse(withMarks, { async: false });
  allowedOrigins = new Set(options.origins);
  const safe = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "picture", "video", "audio", "iframe", "object", "embed", "form", "input", "button", "style", "svg", "math"],
    FORBID_ATTR: ["style", "srcset"],
  });
  return safe.replace(new RegExp(`${MARK}(\\d{1,3})${MARK}`, "g"), (_m, id: string) => {
    const pressed = options.selected === Number(id) ? "true" : "false";
    return `<button type="button" class="cite" data-cite="${id}" aria-pressed="${pressed}" aria-label="Show source ${id}">${id}</button>`;
  });
}

/** Plain Markdown (knowledge browser pages): same sanitizing, no citations. */
export function renderMarkdown(text: string, origins: ReadonlySet<string> = new Set()): string {
  return renderAnswer(text, { cites: new Set(), origins });
}
