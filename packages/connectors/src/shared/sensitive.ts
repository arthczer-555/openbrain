// PII and secret detection on collected content. A finding carries a kind, a count and
// line numbers, never the matched value: reports can be shown and stored without leaking what they flag.
// Validators (Luhn, IBAN mod 97, French NIR key) keep false positives on ids and amounts low.

export type SensitiveCategory = "pii" | "secret";

export type SensitiveKind =
  | "email"
  | "phone"
  | "iban"
  | "card_number"
  | "fr_social_security"
  | "private_key"
  | "aws_access_key"
  | "github_token"
  | "slack_token"
  | "api_key"
  | "google_api_key"
  | "notion_token";

export interface SensitiveFinding {
  kind: SensitiveKind;
  category: SensitiveCategory;
  count: number;
  /** 1-based line numbers of the first matches (at most 20). */
  lines: number[];
}

interface Detector {
  kind: SensitiveKind;
  category: SensitiveCategory;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

const MAX_LINES = 20;

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const char of numeric) remainder = (remainder * 10 + Number(char)) % 97;
  return remainder === 1;
}

/** French NIR: 13 characters (Corsica uses 2A / 2B) + a 2-digit key = 97 - (number mod 97). */
export function nirValid(raw: string): boolean {
  const compact = raw.replace(/[\s.]/g, "").toUpperCase();
  if (!/^[12]\d{4}(?:\d{2}|2A|2B)\d{6}\d{2}$/.test(compact)) return false;
  const body = compact.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const key = Number(compact.slice(13));
  return 97 - Number(BigInt(body) % 97n) === key;
}

const DETECTORS: Detector[] = [
  { kind: "private_key", category: "secret", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: "aws_access_key", category: "secret", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", category: "secret", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "slack_token", category: "secret", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "api_key", category: "secret", pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})/g },
  { kind: "google_api_key", category: "secret", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "notion_token", category: "secret", pattern: /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,})/g },
  { kind: "email", category: "pii", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  {
    kind: "iban",
    category: "pii",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    validate: ibanValid,
  },
  {
    kind: "fr_social_security",
    category: "pii",
    pattern: /(?<![\d.])[12][ .]?\d{2}[ .]?(?:0[1-9]|1[0-2]|[2-9]\d)[ .]?(?:\d{2}|2[AB])[ .]?\d{3}[ .]?\d{3}[ .]?\d{2}(?![\d])/g,
    validate: nirValid,
  },
  {
    kind: "card_number",
    category: "pii",
    pattern: /(?<![\d-])[2-6](?:[ -]?\d){12,18}(?![\d-])/g,
    validate: (match) => luhnValid(digitsOf(match)),
  },
  {
    kind: "phone",
    category: "pii",
    pattern:
      /(?<![\w+])\+\d{1,3}(?:[ .-]?\(0\))?(?:[ .-]?\d{1,4}){2,6}(?![\w])|(?<![\w.])0[1-9](?:[ .-]?\d{2}){4}(?!\w)|(?<!\w)\(\d{3}\)[ .-]?\d{3}[ .-]\d{4}(?!\w)|(?<![\w-])\d{3}[.-]\d{3}[.-]\d{4}(?![\w-])/g,
    validate: (match) => {
      const n = digitsOf(match).length;
      return n >= 9 && n <= 15;
    },
  },
];

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Findings by kind, secrets first. Each match is masked once found, so a value is never counted twice. */
export function detectSensitive(text: string): SensitiveFinding[] {
  const starts = lineStarts(text);
  let working = text;
  const findings: SensitiveFinding[] = [];
  for (const detector of DETECTORS) {
    let count = 0;
    const lines: number[] = [];
    const masks: Array<[number, number]> = [];
    for (const match of working.matchAll(detector.pattern)) {
      const value = match[0];
      if (detector.validate && !detector.validate(value)) continue;
      const index = match.index ?? 0;
      count++;
      const line = lineOf(starts, index);
      if (lines.length < MAX_LINES && !lines.includes(line)) lines.push(line);
      masks.push([index, index + value.length]);
    }
    if (count === 0) continue;
    findings.push({ kind: detector.kind, category: detector.category, count, lines });
    for (const [start, end] of masks) {
      working = `${working.slice(0, start)}${working.slice(start, end).replace(/[^\n]/g, " ")}${working.slice(end)}`;
    }
  }
  return findings;
}

/** "email x3, iban x1": a one-line summary for logs. */
export function summarizeFindings(findings: readonly SensitiveFinding[]): string {
  return findings.map((f) => `${f.kind} x${f.count}`).join(", ");
}

/** Adds the counts of `more` into `into` (lines are not merged: they belong to different files). */
export function mergeFindingCounts(into: Map<SensitiveKind, number>, more: readonly SensitiveFinding[]): void {
  for (const finding of more) into.set(finding.kind, (into.get(finding.kind) ?? 0) + finding.count);
}
