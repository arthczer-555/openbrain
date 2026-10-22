// Prudent token estimate: tokenizers differ between providers,
// so budgets use characters / 3.5 with a 15 % safety margin. Provider counters can refine it later.

const CHARS_PER_TOKEN = 3.5;
const SAFETY_MARGIN = 1.15;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export interface BudgetLimits {
  core: number;
  catalog: number;
}

/** Budgets of the stable prefix. */
export const DEFAULT_BUDGETS: BudgetLimits = {
  core: 1200,
  catalog: 700,
};

export interface BudgetReport {
  name: keyof BudgetLimits;
  tokens: number;
  limit: number;
  ok: boolean;
}

export function checkBudgets(
  texts: { core: string; catalog: string },
  limits: BudgetLimits = DEFAULT_BUDGETS,
): BudgetReport[] {
  return (["core", "catalog"] as const).map((name) => {
    const tokens = estimateTokens(texts[name]);
    return { name, tokens, limit: limits[name], ok: tokens <= limits[name] };
  });
}
