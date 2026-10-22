// Date helpers for incremental collection. An unknown or unparsable date never filters an item out:
// collecting one item too many is better than silently missing a change.

export function toIso(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** True when `iso` is strictly after `since`, or when either date is unknown. */
export function isAfter(iso: string | undefined, since: string | undefined): boolean {
  if (!since || !iso) return true;
  const a = Date.parse(iso);
  const b = Date.parse(since);
  return Number.isNaN(a) || Number.isNaN(b) || a > b;
}

/** since < iso <= until, unknown dates included. */
export function inWindow(iso: string | undefined, since: string, until: string): boolean {
  if (!iso) return true;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return true;
  const from = Date.parse(since);
  const to = Date.parse(until);
  return (Number.isNaN(from) || time > from) && (Number.isNaN(to) || time <= to);
}

export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
