import { z } from 'zod';
import { defineCommand, UserError } from '../registry.js';
import { usd } from '../rules.js';

export function guideRows(db: import('../db.js').Db, orgSlug: string) {
  const g = db.prepare(`SELECT g.id, g.version, g.tax_year, g.source_url FROM valuation_guide g JOIN org o ON o.id = g.org_id
    WHERE o.slug = ? ORDER BY g.tax_year DESC, g.version DESC LIMIT 1`).get(orgSlug) as
    { id: string; version: string; tax_year: number; source_url: string } | undefined;
  if (!g) throw new UserError('UNKNOWN_ORG', `No price guide for "${orgSlug}".`);
  const rates = db.prepare('SELECT category, item, grp AS "group", low_cents, high_cents FROM valuation_rate WHERE guide_id = ? ORDER BY category').all(g.id) as
    unknown as { category: string; item: string; group: string; low_cents: number; high_cents: number }[];
  return { ...g, rates };
}

export const valuationShow = defineCommand({
  tool: null,
  noun: 'valuation',
  verb: 'show',
  description: 'Print the price guide: category keys, items and low / high values.',
  input: { org: z.string().default('goodwill') },
  async run(ctx, input) {
    const g = guideRows(ctx.db, input.org);
    const text = [
      `${input.org} guide ${g.version} (tax year ${g.tax_year}) · source: ${g.source_url}`,
      'CATEGORY                     ITEM                                LOW      HIGH',
      ...g.rates.map((r) => `${r.category.padEnd(28)} ${r.item.slice(0, 34).padEnd(34)} ${usd(r.low_cents).padStart(7)}  ${usd(r.high_cents).padStart(7)}`),
    ].join('\n');
    return { data: g, text };
  },
});
