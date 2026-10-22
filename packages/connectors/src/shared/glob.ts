// Tiny glob matcher for relative POSIX paths (no dependency). Supported: `**` (any number of folders,
// zero included), `*` and `?` (never cross a "/"), `[abc]` / `[!abc]` classes and `{a,b}` alternatives.
// Patterns are anchored on the whole path: "README.md" only matches the root README, "**/*.md" any depth.

const cache = new Map<string, RegExp>();

function escapeRegExp(char: string): string {
  return /[.+^$()|\\/]/.test(char) ? `\\${char}` : char;
}

/** Index of the "}" closing the "{" at `start`, or -1. */
function closingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Splits "a,{b,c},d" on top-level commas. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function translate(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        if (atSegmentStart && pattern[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
          continue;
        }
        if (atSegmentStart && i + 2 === pattern.length) {
          out += ".*";
          i += 1;
          continue;
        }
      }
      out += "[^/]*";
      while (pattern[i + 1] === "*") i++;
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) {
        out += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (char === "{") {
      const end = closingBrace(pattern, i);
      if (end < 0) {
        out += "\\{";
        continue;
      }
      out += `(?:${splitAlternatives(pattern.slice(i + 1, end)).map(translate).join("|")})`;
      i = end;
    } else {
      out += escapeRegExp(char);
    }
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  let regex = cache.get(normalized);
  if (!regex) {
    regex = new RegExp(`^${translate(normalized)}$`);
    cache.set(normalized, regex);
  }
  return regex;
}

/** `relativePath` uses "/" separators and no leading "./". */
export function matchGlob(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath.replace(/^\.\//, ""));
}

export function matchAnyGlob(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchGlob(relativePath, pattern));
}

/** Include / exclude filter: an empty include list means "everything". */
export function globFilter(relativePath: string, include: readonly string[], exclude: readonly string[]): boolean {
  if (include.length > 0 && !matchAnyGlob(relativePath, include)) return false;
  return !matchAnyGlob(relativePath, exclude);
}
