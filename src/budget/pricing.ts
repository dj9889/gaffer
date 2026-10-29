import type { Usage } from "../types.ts";

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Anthropic first-party list prices as of 2026-10. OpenAI entries are
// placeholders: check your contract and override via config `pricing:`.
const TABLE: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
};

/** Unknown models are priced pessimistically so a typo can't make work free. */
const UNKNOWN: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

const overrides: Record<string, Price> = {};

export function setPricing(table: Record<string, Price>): void {
  Object.assign(overrides, table);
}

export function isKnownModel(model: string): boolean {
  return Boolean(overrides[model] || TABLE[model]);
}

export function priceFor(model: string): Price {
  if (overrides[model]) return overrides[model];
  if (TABLE[model]) return TABLE[model];
  // Aliases like "opus" / "sonnet" / "haiku" resolve to the current generation.
  for (const [id, price] of Object.entries(TABLE)) if (id.includes(model)) return price;
  return UNKNOWN;
}

export function costOf(model: string, usage: Usage): number {
  const p = priceFor(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite +
      (usage.cacheWrite1hTokens ?? 0) * p.input * 2) /
    1e6
  );
}
