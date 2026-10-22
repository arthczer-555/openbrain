// robots.txt (RFC 9309): the group of the most specific matching user agent applies ("openbrain" before "*"),
// the longest matching rule wins, Allow wins a tie. Patterns support "*" and a final "$".

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  /** Crawl-delay of the selected group, in seconds. */
  crawlDelaySec?: number;
  /** "disallow-all" when robots.txt could not be read because of a server error. */
  mode?: "rules" | "allow-all" | "disallow-all";
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec?: number;
}

export const ALLOW_ALL: RobotsPolicy = { rules: [], mode: "allow-all" };
export const DISALLOW_ALL: RobotsPolicy = { rules: [{ allow: false, pattern: "/" }], mode: "disallow-all" };

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything: it adds no rule.
      if (current && value) current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else if (key === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (current && Number.isFinite(seconds)) current.crawlDelaySec = seconds;
      lastWasAgent = false;
    }
  }
  return groups;
}

/** `agentToken` is the product token of our user agent, for example "openbrain". */
export function parseRobots(text: string, agentToken: string): RobotsPolicy {
  const token = agentToken.toLowerCase();
  const groups = parseGroups(text);
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && token.includes(a)));
  const selected = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  const delays = selected.map((g) => g.crawlDelaySec).filter((d): d is number => d !== undefined);
  return {
    rules: selected.flatMap((g) => g.rules),
    ...(delays.length > 0 ? { crawlDelaySec: Math.max(...delays) } : {}),
    mode: "rules",
  };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** `pathAndQuery` is the URL path with its query string, for example "/docs/setup?x=1". */
export function isAllowedByRobots(policy: RobotsPolicy, pathAndQuery: string): boolean {
  let best: RobotsRule | undefined;
  for (const rule of policy.rules) {
    if (!patternToRegExp(rule.pattern).test(pathAndQuery)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieAllow = best !== undefined && rule.pattern.length === best.pattern.length && rule.allow;
    if (longer || tieAllow) best = rule;
  }
  return best ? best.allow : true;
}
