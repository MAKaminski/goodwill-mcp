// Deterministic tax rules. No model calls live here.

export const FORM_8283_LINE_CENTS = 50_000; // year's noncash total over $500 -> Form 8283
export const APPRAISAL_LINE_CENTS = 500_000; // one group of similar items over $5,000 -> appraisal
export const APPRAISAL_WARN_CENTS = 400_000; // early warning
export const ACKNOWLEDGMENT_LINE_CENTS = 25_000; // single donation of $250+ needs the receipt

export const DEDUCTIBLE_CONDITIONS = ['new_with_tags', 'like_new', 'good'] as const;
export const ALL_CONDITIONS = [...DEDUCTIBLE_CONDITIONS, 'fair', 'poor'] as const;
export type Condition = (typeof ALL_CONDITIONS)[number];

export type Basis = 'low' | 'mid' | 'high';

export function isDeductible(c: Condition): boolean {
  return (DEDUCTIBLE_CONDITIONS as readonly string[]).includes(c);
}

export function unitFromRange(low: number, high: number, basis: Basis): number {
  if (basis === 'low') return low;
  if (basis === 'high') return high;
  return Math.round((low + high) / 2);
}

export interface Flag {
  code: string;
  message: string;
}

export interface GroupTotal {
  group: string;
  cents: number;
}

export function yearFlags(totalCents: number, groups: GroupTotal[]): Flag[] {
  const flags: Flag[] = [];
  if (totalCents > FORM_8283_LINE_CENTS) {
    flags.push({ code: 'FORM_8283_REQUIRED', message: `Noncash total ${usd(totalCents)} is over $500: file Form 8283 Section A.` });
  } else {
    flags.push({ code: 'FORM_8283_HEADROOM', message: `${usd(FORM_8283_LINE_CENTS - totalCents)} until Form 8283 is required.` });
  }
  for (const g of groups) {
    if (g.cents > APPRAISAL_LINE_CENTS) {
      flags.push({ code: 'APPRAISAL_REQUIRED', message: `${g.group} totals ${usd(g.cents)} this year, over $5,000: a qualified appraisal and Section B are required.` });
    } else if (g.cents > APPRAISAL_WARN_CENTS) {
      flags.push({ code: 'APPRAISAL_WARNING', message: `${g.group} totals ${usd(g.cents)} this year; ${usd(APPRAISAL_LINE_CENTS - g.cents)} left before the $5,000 appraisal line.` });
    }
  }
  return flags;
}

export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents) / 100;
  return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}
