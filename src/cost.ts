import { PRICING_USD_PER_MTOK, env } from './config.js';
import { table } from './report.js';

export type Usage = {
  stage: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type CostEntry = Usage & { usd: number };

export function priceOf(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_USD_PER_MTOK[model];
  if (pricing === undefined) return Number.NaN;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export class CostLedger {
  private entries: CostEntry[] = [];

  record(usage: Usage): CostEntry {
    const entry: CostEntry = {
      ...usage,
      usd: priceOf(usage.model, usage.inputTokens, usage.outputTokens),
    };
    this.entries.push(entry);
    return entry;
  }

  merge(other: CostLedger): void {
    this.entries.push(...other.all());
  }

  all(): readonly CostEntry[] {
    return this.entries;
  }

  totalUsd(): number {
    return this.entries.reduce((sum, entry) => sum + (Number.isNaN(entry.usd) ? 0 : entry.usd), 0);
  }

  hasUnpricedModel(): boolean {
    return this.entries.some((entry) => Number.isNaN(entry.usd));
  }

  overCeiling(): boolean {
    return this.totalUsd() > env.COST_CEILING_USD;
  }

  report(): string {
    if (this.entries.length === 0) return 'cost        $0.000000 (no metered calls)';

    const rows = this.entries.map((entry) => [
      entry.stage,
      entry.model,
      String(entry.inputTokens),
      String(entry.outputTokens),
      Number.isNaN(entry.usd) ? 'unpriced' : `$${entry.usd.toFixed(6)}`,
    ]);

    const total = this.totalUsd();
    const lines = [
      table(['stage', 'model', 'in tok', 'out tok', 'usd'], rows),
      '',
      `total       $${total.toFixed(6)} of $${env.COST_CEILING_USD.toFixed(2)} ceiling (${((total / env.COST_CEILING_USD) * 100).toFixed(1)}%)`,
    ];
    if (this.hasUnpricedModel()) {
      lines.push('warning     a model has no PRICING_USD_PER_MTOK entry; total is understated');
    }
    return lines.join('\n');
  }
}
