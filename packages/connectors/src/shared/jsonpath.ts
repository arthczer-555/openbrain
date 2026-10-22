// JSONPath subset used by the MCP mappings: `$`, `.key`, `['key']`, `[*]` / `.*` and `[n]` (negative counts
// from the end). No filters, no recursive descent: mappings stay readable and predictable.

export type JsonPathSegment = { type: "key"; key: string } | { type: "index"; index: number } | { type: "wildcard" };

const cache = new Map<string, JsonPathSegment[]>();

function parseBracket(inner: string, path: string): JsonPathSegment {
  const body = inner.trim();
  if (body === "*") return { type: "wildcard" };
  if (/^-?\d+$/.test(body)) return { type: "index", index: Number.parseInt(body, 10) };
  const quoted = /^(['"])(.*)\1$/.exec(body);
  if (quoted) return { type: "key", key: quoted[2] ?? "" };
  throw new Error(`unsupported JSONPath segment [${inner}] in "${path}"`);
}

export function parseJsonPath(path: string): JsonPathSegment[] {
  const cached = cache.get(path);
  if (cached) return cached;
  const source = path.trim();
  if (!source.startsWith("$")) throw new Error(`a JSONPath starts with "$": "${path}"`);
  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < source.length) {
    const char = source[i];
    if (char === ".") {
      if (source[i + 1] === ".") throw new Error(`recursive descent ("..") is not supported: "${path}"`);
      let end = i + 1;
      while (end < source.length && source[end] !== "." && source[end] !== "[") end++;
      const name = source.slice(i + 1, end);
      if (!name) throw new Error(`empty key in JSONPath "${path}"`);
      segments.push(name === "*" ? { type: "wildcard" } : { type: "key", key: name });
      i = end;
    } else if (char === "[") {
      const quote = source[i + 1] === "'" || source[i + 1] === '"' ? source[i + 1] : undefined;
      const end = quote ? source.indexOf(`${quote}]`, i + 2) + 1 : source.indexOf("]", i);
      if (end <= 0) throw new Error(`unclosed "[" in JSONPath "${path}"`);
      segments.push(parseBracket(source.slice(i + 1, end), path));
      i = end + 1;
    } else {
      throw new Error(`unexpected "${char}" in JSONPath "${path}"`);
    }
  }
  cache.set(path, segments);
  return segments;
}

function step(value: unknown, segment: JsonPathSegment): unknown[] {
  if (segment.type === "wildcard") {
    if (Array.isArray(value)) return value;
    if (typeof value === "object" && value !== null) return Object.values(value);
    return [];
  }
  if (segment.type === "index") {
    if (!Array.isArray(value)) return [];
    const index = segment.index < 0 ? value.length + segment.index : segment.index;
    return index >= 0 && index < value.length ? [value[index]] : [];
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && segment.key in value) {
    return [(value as Record<string, unknown>)[segment.key]];
  }
  return [];
}

/** Every value matched by `path` (an empty list when nothing matches). */
export function queryJsonPath(data: unknown, path: string): unknown[] {
  let current: unknown[] = [data];
  for (const segment of parseJsonPath(path)) current = current.flatMap((value) => step(value, segment));
  return current;
}

export function firstJsonPath(data: unknown, path: string): unknown {
  return queryJsonPath(data, path)[0];
}

/** Text form of a matched value: arrays are joined, objects become JSON, null and undefined become "". */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return value
      .map(stringifyValue)
      .filter((v) => v !== "")
      .join(", ");
  }
  return JSON.stringify(value);
}

/**
 * Renders "{{$.title}} ({{$.state.name}})": `{{$...}}` reads the item, `{{name}}` reads `vars`
 * (since, until, id...). Unknown variables render as "".
 */
export function renderTemplate(template: string, data: unknown, vars: Record<string, string | undefined> = {}): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    if (!expression.startsWith("$")) return vars[expression] ?? "";
    const matches = queryJsonPath(data, expression);
    return stringifyValue(matches.length > 1 ? matches : matches[0]);
  });
}

/** A mapping value is either a bare JSONPath ("$.id", raw value kept) or a template ("{{$.a}} - {{$.b}}"). */
export function resolveMappingValue(spec: string, data: unknown, vars: Record<string, string | undefined> = {}): unknown {
  const trimmed = spec.trim();
  if (trimmed.startsWith("$") && !trimmed.includes("{{")) {
    const matches = queryJsonPath(data, trimmed);
    return matches.length > 1 ? matches : matches[0];
  }
  return renderTemplate(spec, data, vars);
}
