// Cost estimator of the landing page. Runs at build time (default values, so the page reads well without
// JavaScript) and in the browser (src/components/landing/CostEstimator.astro). Plain arithmetic, no network.

export interface ModelPrice {
  id: string;
  label: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens read from the prompt cache; null = counted at the full input price. */
  cacheRead: number | null;
}

// Anthropic public API prices (USD per million tokens), checked in October 2026. Haiku 5.5: prompts under 100K
// tokens; its cache-read price is not used (cached tokens counted at the input price, conservative).
export const OPUS: ModelPrice = {
  id: "anthropic:claude-opus-5-5",
  label: "Claude Opus 5.5",
  input: 4,
  output: 20,
  cacheRead: 0.2,
};
export const HAIKU: ModelPrice = {
  id: "anthropic:claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  input: 0.1,
  output: 0.5,
  cacheRead: null,
};
export const MODELS: readonly ModelPrice[] = [OPUS, HAIKU];

/** What one question costs in tokens: the fixed prompt is cached, the passages are not (see the lean brain). */
export const ASSUMPTIONS = {
  inputTokens: 10_000,
  cachedTokens: 2_500,
  outputTokens: 400,
  daysPerMonth: 30,
  /** Rough average for real Notion pages split at H2/H3 headings. */
  passagesPerPage: 4,
  /** Comfortable size for the in-memory index of the chatbot. */
  inMemoryPassages: 20_000,
} as const;

export interface Estimate {
  model: ModelPrice;
  perQuestion: number;
  perMonth: number;
}

export function costPerQuestion(model: ModelPrice): number {
  const { inputTokens, cachedTokens, outputTokens } = ASSUMPTIONS;
  const cacheRate = model.cacheRead ?? model.input;
  const fresh = (inputTokens - cachedTokens) * model.input;
  const cached = cachedTokens * cacheRate;
  const output = outputTokens * model.output;
  return (fresh + cached + output) / 1_000_000;
}

export function estimate(questionsPerDay: number): Estimate[] {
  const questions = Math.max(0, questionsPerDay);
  return MODELS.map((model) => {
    const perQuestion = costPerQuestion(model);
    return { model, perQuestion, perMonth: perQuestion * questions * ASSUMPTIONS.daysPerMonth };
  });
}

export function passagesFor(pages: number): number {
  return Math.max(0, Math.round(pages)) * ASSUMPTIONS.passagesPerPage;
}

/** "$0.0385" for small amounts, "$58" or "$1,234" for monthly totals. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
