import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineCommand, UserError, type Ctx } from '../registry.js';
import type { Db } from '../db.js';
import {
  ALL_CONDITIONS, ACKNOWLEDGMENT_LINE_CENTS, isDeductible, toCents, unitFromRange, usd, yearFlags,
  type Basis, type Condition, type Flag, type GroupTotal,
} from '../rules.js';

const itemSchema = z.object({
  description: z.string().min(1).describe('What it is, e.g. "women\'s blouses". Be specific: the IRS rejects vague entries.'),
  category: z.string().optional().describe('Price-guide key, e.g. "womens.shirt_blouse". See the valuation resource for keys.'),
  qty: z.number().int().min(1).default(1),
  condition: z.enum(ALL_CONDITIONS).describe('new_with_tags | like_new | good are deductible; fair | poor are left out.'),
  unit_value: z.number().nonnegative().optional().describe('Dollars per piece. Omit to price from the guide.'),
  group: z.string().optional().describe('Similar-items group when there is no guide category, e.g. "household".'),
  acquired: z.string().optional().describe('When acquired, e.g. "2021-05" or "Various".'),
  how_acquired: z.string().optional().describe('e.g. "Purchase", "Gift".'),
  cost_basis: z.number().nonnegative().optional().describe('What you paid in total for this line, in dollars, if known.'),
  override_reason: z.string().optional().describe('Required when unit_value is above the guide high.'),
});
type ItemIn = z.infer<typeof itemSchema>;

interface Rate { id: string; category: string; item: string; grp: string; low_cents: number; high_cents: number }
interface Priced {
  id: string; rate_id: string | null; description: string; category: string | null; grp: string; qty: number;
  condition: Condition; unit_cents: number; acquired: string | null; how_acquired: string | null;
  cost_basis_cents: number | null; override_reason: string | null;
}

function orgFor(db: Db, slug: string): { id: string; name: string; address: string | null } {
  const org = db.prepare('SELECT id, name, address FROM org WHERE slug = ?').get(slug) as
    { id: string; name: string; address: string | null } | undefined;
  if (!org) throw new UserError('UNKNOWN_ORG', `No price guide for "${slug}". Add guides/${slug}.json.`);
  return org;
}

function latestRates(db: Db, orgId: string): Map<string, Rate> {
  const g = db.prepare('SELECT id FROM valuation_guide WHERE org_id = ? ORDER BY tax_year DESC, version DESC LIMIT 1').get(orgId) as
    { id: string } | undefined;
  const m = new Map<string, Rate>();
  if (!g) return m;
  for (const r of db.prepare('SELECT id, category, item, grp, low_cents, high_cents FROM valuation_rate WHERE guide_id = ?').all(g.id) as unknown as Rate[]) {
    m.set(r.category, r);
  }
  return m;
}

function priceItems(items: ItemIn[], rates: Map<string, Rate>, basis: Basis) {
  const priced: Priced[] = [];
  const skipped: string[] = [];
  const warnings: Flag[] = [];
  for (const it of items) {
    if (!isDeductible(it.condition)) {
      skipped.push(it.description);
      warnings.push({ code: 'BELOW_GOOD_CONDITION', message: `"${it.description}" is ${it.condition}: left out (clothing and household items must be in good used condition or better).` });
      continue;
    }
    const rate = it.category ? rates.get(it.category) : undefined;
    let unit = 0;
    if (it.unit_value !== undefined) {
      unit = toCents(it.unit_value);
      if (rate && unit > rate.high_cents && !it.override_reason) {
        throw new UserError('VALUE_OVER_GUIDE',
          `"${it.description}" at ${usd(unit)} is above the guide high of ${usd(rate.high_cents)} for ${rate.item}. Lower it or pass override_reason.`);
      }
    } else if (rate) {
      unit = unitFromRange(rate.low_cents, rate.high_cents, basis);
    } else {
      warnings.push({ code: 'NO_RATE_MATCH', message: `"${it.description}" has no guide category${it.category ? ` "${it.category}"` : ''} and no unit_value: saved at $0. Fix with donation_update.` });
    }
    priced.push({
      id: randomUUID(), rate_id: rate?.id ?? null, description: it.description, category: it.category ?? null,
      grp: rate?.grp ?? it.group ?? 'other', qty: it.qty, condition: it.condition, unit_cents: unit,
      acquired: it.acquired ?? null, how_acquired: it.how_acquired ?? null,
      cost_basis_cents: it.cost_basis !== undefined ? toCents(it.cost_basis) : null, override_reason: it.override_reason ?? null,
    });
  }
  const total = priced.reduce((s, p) => s + p.unit_cents * p.qty, 0);
  return { priced, skipped, warnings, total };
}

function insertItems(db: Db, donationId: string, items: Priced[]): void {
  const ins = db.prepare(`INSERT INTO donation_item (id, donation_id, rate_id, description, category, grp, qty, condition,
    unit_cents, acquired, how_acquired, cost_basis_cents, override_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of items) {
    ins.run(p.id, donationId, p.rate_id, p.description, p.category, p.grp, p.qty, p.condition, p.unit_cents,
      p.acquired, p.how_acquired, p.cost_basis_cents, p.override_reason);
  }
}

function moveToArchive(from: string, archiveDir: string, sha: string): string {
  const to = join(archiveDir, `${sha}${extname(from).toLowerCase()}`);
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    try { unlinkSync(from); } catch { /* leave the original if it cannot be removed */ }
  }
  return to;
}

export function yearSummary(db: Db, year: number) {
  const like = `${year}-%`;
  const total = (db.prepare(`SELECT COALESCE(SUM(total_cents),0) AS t, COUNT(*) AS n FROM donation WHERE status='active' AND donated_at LIKE ?`).get(like) as { t: number; n: number });
  const groups = db.prepare(`SELECT i.grp AS "group", SUM(i.unit_cents*i.qty) AS cents FROM donation_item i JOIN donation d ON d.id=i.donation_id
    WHERE d.status='active' AND d.donated_at LIKE ? GROUP BY i.grp ORDER BY cents DESC`).all(like) as unknown as GroupTotal[];
  return { year, donations: total.n, total_cents: total.t, groups, flags: yearFlags(total.t, groups) };
}

function donationView(db: Db, id: string) {
  const d = db.prepare(`SELECT d.*, o.slug AS org FROM donation d JOIN org o ON o.id=d.org_id WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!d) throw new UserError('NOT_FOUND', `No donation ${id}.`);
  const items = db.prepare('SELECT description, category, grp, qty, condition, unit_cents, acquired, how_acquired, cost_basis_cents, override_reason FROM donation_item WHERE donation_id = ?').all(id);
  return { ...d, items };
}

const basisSchema = z.enum(['low', 'mid', 'high']).default('mid').describe('Where in the guide range to price: low, mid or high. Match the condition.');

export const donationCreate = defineCommand({
  tool: 'donation_create',
  noun: 'donation',
  verb: 'create',
  description:
    'Log a donation. Pass the intake_id from intake_open (so the receipt photo is archived), the date, store, receipt number and ' +
    'an itemized list. Items are priced from the price guide unless unit_value is given. Returns the donation, the year-to-date ' +
    'fair market value and Form 8283 / appraisal flags. Reports fair market value donated, never tax saved.',
  input: {
    intake_id: z.string().optional(),
    org: z.string().default('goodwill'),
    donated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, from the receipt.'),
    store: z.string().optional().describe('Store name or number from the receipt.'),
    receipt_number: z.string().optional(),
    basis: basisSchema,
    items: z.array(itemSchema).min(1),
  },
  async run(ctx: Ctx, input) {
    const db = ctx.db;
    const org = orgFor(db, input.org);
    let receiptSha: string | null = null;
    let atts: { sha256: string; kind: string; path: string }[] = [];
    if (input.intake_id) {
      const intake = db.prepare('SELECT status FROM intake WHERE id = ?').get(input.intake_id) as { status: string } | undefined;
      if (!intake) throw new UserError('NOT_FOUND', `No intake ${input.intake_id}. Run intake_open first.`);
      atts = db.prepare('SELECT sha256, kind, path FROM attachment WHERE intake_id = ?').all(input.intake_id) as unknown as typeof atts;
      receiptSha = atts.find((a) => a.kind === 'receipt')?.sha256 ?? null;
    }
    const dup = (receiptSha && db.prepare('SELECT id FROM donation WHERE receipt_sha256 = ?').get(receiptSha)) ||
      (input.receipt_number && db.prepare('SELECT id FROM donation WHERE org_id = ? AND receipt_number = ?').get(org.id, input.receipt_number));
    if (dup) {
      const existing = donationView(db, (dup as { id: string }).id);
      return { data: { duplicate: true, donation: existing }, text: `DUPLICATE_RECEIPT: already logged as ${(dup as { id: string }).id}. Nothing changed.` };
    }

    const { priced, warnings, total } = priceItems(input.items, latestRates(db, org.id), input.basis);
    if (!priced.length) throw new UserError('NOTHING_DEDUCTIBLE', 'Every item is below good used condition. Nothing was logged.');
    if (!receiptSha) {
      warnings.push({ code: 'RECEIPT_NOT_ARCHIVED', message: 'No receipt photo archived for this donation. Keep the paper receipt.' });
    }
    if (total >= ACKNOWLEDGMENT_LINE_CENTS && !receiptSha) {
      warnings.push({ code: 'ACKNOWLEDGMENT_NEEDED', message: `At ${usd(total)}, this donation needs the charity's written acknowledgment (the receipt) to be deductible.` });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO donation (id, org_id, intake_id, donated_at, store_name, receipt_number, receipt_sha256, valuation_basis,
        total_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(
        id, org.id, input.intake_id ?? null, input.donated_at, input.store ?? null, input.receipt_number ?? null, receiptSha,
        input.basis, total, now);
      insertItems(db, id, priced);
      db.prepare('INSERT INTO revision (id, donation_id, at, patch_json, reason) VALUES (?, ?, ?, ?, ?)').run(
        randomUUID(), id, now, JSON.stringify({ op: 'create' }), null);
      if (input.intake_id) {
        const upd = db.prepare('UPDATE attachment SET path = ? WHERE sha256 = ?');
        for (const a of atts) upd.run(moveToArchive(a.path, ctx.paths.archive, a.sha256), a.sha256);
        db.prepare("UPDATE intake SET status = 'used' WHERE id = ?").run(input.intake_id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const ytd = yearSummary(db, Number(input.donated_at.slice(0, 4)));
    const pieces = priced.reduce((s, p) => s + p.qty, 0);
    const text = [
      `Logged ${input.donated_at}${input.store ? ` · ${input.store}` : ''}${receiptSha ? ' · receipt archived' : ''}`,
      `${pieces} items · ${usd(total)} FMV · ${ytd.year} total ${usd(ytd.total_cents)}`,
      ...warnings.map((w) => `! ${w.code}: ${w.message}`),
      ...ytd.flags.map((f) => `· ${f.message}`),
    ].join('\n');
    return { data: { donation: donationView(db, id), warnings, year: ytd }, text };
  },
});

export const donationUpdate = defineCommand({
  tool: 'donation_update',
  noun: 'donation',
  verb: 'update',
  description:
    'Correct or void a donation. Replace its items, change the date, store or receipt number, or void it. Every change is written ' +
    'to an append-only revision with your reason.',
  positional: 'donation_id',
  input: {
    donation_id: z.string(),
    reason: z.string().min(1).describe('Why the change is being made. Stored in the revision history.'),
    donated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    store: z.string().optional(),
    receipt_number: z.string().optional(),
    basis: z.enum(['low', 'mid', 'high']).optional(),
    items: z.array(itemSchema).min(1).optional().describe('Replaces every item on the donation.'),
    void: z.boolean().optional().describe('Void the donation. It stays in history but leaves every total.'),
    dry_run: z.boolean().optional(),
  },
  async run(ctx, input) {
    const db = ctx.db;
    const before = donationView(db, input.donation_id) as Record<string, unknown>;
    const orgId = before.org_id as string;
    const basis = (input.basis ?? before.valuation_basis) as Basis;
    let total = before.total_cents as number;
    let priced: Priced[] | null = null;
    let warnings: Flag[] = [];
    if (input.items) {
      const r = priceItems(input.items, latestRates(db, orgId), basis);
      if (!r.priced.length) throw new UserError('NOTHING_DEDUCTIBLE', 'Every item is below good used condition.');
      priced = r.priced; total = r.total; warnings = r.warnings;
    }
    const patch = {
      donated_at: input.donated_at, store: input.store, receipt_number: input.receipt_number, basis: input.basis,
      items: input.items ? input.items.length : undefined, void: input.void, total_cents: total,
    };
    if (input.dry_run) {
      return { data: { dry_run: true, before, patch }, text: `Dry run: ${input.void ? 'would void' : `total would be ${usd(total)}`}. Nothing changed.` };
    }
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE donation SET donated_at = COALESCE(?, donated_at), store_name = COALESCE(?, store_name),
        receipt_number = COALESCE(?, receipt_number), valuation_basis = ?, total_cents = ?, status = ? WHERE id = ?`).run(
        input.donated_at ?? null, input.store ?? null, input.receipt_number ?? null, basis, total,
        input.void ? 'void' : (before.status as string), input.donation_id);
      if (priced) {
        db.prepare('DELETE FROM donation_item WHERE donation_id = ?').run(input.donation_id);
        insertItems(db, input.donation_id, priced);
      }
      db.prepare('INSERT INTO revision (id, donation_id, at, patch_json, reason) VALUES (?, ?, ?, ?, ?)').run(
        randomUUID(), input.donation_id, now, JSON.stringify({ op: 'update', patch, before_total_cents: before.total_cents }), input.reason);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const after = donationView(db, input.donation_id) as Record<string, unknown>;
    const ytd = yearSummary(db, Number(String(after.donated_at).slice(0, 4)));
    const text = [
      input.void ? `Voided ${input.donation_id}.` : `Updated ${input.donation_id}: ${usd(before.total_cents as number)} → ${usd(total)}.`,
      ...warnings.map((w) => `! ${w.code}: ${w.message}`),
      `${ytd.year} total ${usd(ytd.total_cents)}`,
    ].join('\n');
    return { data: { before, after, warnings, year: ytd }, text };
  },
});

interface Line { donated_at: string; store_name: string | null; receipt_number: string | null; total_cents: number; items: number; receipt: boolean; id: string }

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const donationReport = defineCommand({
  tool: 'donation_report',
  noun: 'donation',
  verb: 'report',
  description:
    'Year totals and exports. format=table (default) or json for the ledger; csv for a spreadsheet; form8283 for Form 8283 ' +
    'Section A rows grouped by similar items; portal for the description text and value to paste into a charity donor portal ' +
    '(latest donation, or donation_id).',
  input: {
    year: z.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    format: z.enum(['table', 'json', 'csv', 'form8283', 'portal']).default('table'),
    donation_id: z.string().optional().describe('For format=portal: which donation. Default: the latest.'),
  },
  async run(ctx, input) {
    const db = ctx.db;
    const like = `${input.year}-%`;
    const summary = yearSummary(db, input.year);
    const lines = db.prepare(`SELECT d.id, d.donated_at, d.store_name, d.receipt_number, d.total_cents,
      (SELECT SUM(qty) FROM donation_item i WHERE i.donation_id = d.id) AS items, d.receipt_sha256 IS NOT NULL AS receipt
      FROM donation d WHERE d.status='active' AND d.donated_at LIKE ? ORDER BY d.donated_at`).all(like) as unknown as Line[];

    if (input.format === 'portal') {
      const id = input.donation_id ??
        (db.prepare("SELECT id FROM donation WHERE status='active' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined)?.id;
      if (!id) throw new UserError('NOT_FOUND', 'No donations logged yet.');
      const d = donationView(db, id) as Record<string, unknown> & { items: Record<string, unknown>[] };
      const parts = d.items.map((i) => `${i.qty} ${i.description} (${String(i.condition).replace(/_/g, ' ')}) @ ${usd(i.unit_cents as number)}`);
      const pieces = d.items.reduce((s, i) => s + (i.qty as number), 0);
      let description = `${pieces} items, good used condition or better. ${parts.join('; ')}. FMV: thrift shop value, total ${usd(d.total_cents as number)}. Acquired: various (purchased).`;
      if (description.length > 1000) description = `${description.slice(0, 990)}…`;
      const value = ((d.total_cents as number) / 100).toFixed(2);
      return {
        data: { donation_id: id, receipt_number: d.receipt_number, description, value },
        text: `Receipt ID   ${d.receipt_number ?? '(add from the paper receipt)'}\nDescription  ${description}\nValue        ${value}`,
      };
    }

    if (input.format === 'form8283') {
      const rows = db.prepare(`SELECT o.name AS org_name, o.address AS org_address, i.grp, i.description, i.qty, i.condition,
        i.unit_cents, i.acquired, i.how_acquired, i.cost_basis_cents, d.donated_at
        FROM donation_item i JOIN donation d ON d.id=i.donation_id JOIN org o ON o.id=d.org_id
        WHERE d.status='active' AND d.donated_at LIKE ? ORDER BY o.name, i.grp`).all(like) as unknown as Record<string, any>[];
      const byKey = new Map<string, Record<string, any>[]>();
      for (const r of rows) {
        const k = `${r.org_name}|${r.grp}`;
        byKey.set(k, [...(byKey.get(k) ?? []), r]);
      }
      const out = [...byKey.values()].map((g) => {
        const fmv = g.reduce((s, r) => s + r.unit_cents * r.qty, 0);
        const dates = [...new Set(g.map((r) => r.donated_at))];
        const basisKnown = g.every((r) => r.cost_basis_cents !== null);
        const how = [...new Set(g.map((r) => r.how_acquired ?? 'Purchase'))];
        const acq = [...new Set(g.map((r) => r.acquired ?? 'Various'))];
        return {
          a_donee: `${g[0].org_name}${g[0].org_address ? `, ${g[0].org_address}` : ''}`,
          c_description: `${g[0].grp}: ${g.reduce((s, r) => s + r.qty, 0)} items (${[...new Set(g.map((r) => r.description))].join(', ')}), good used condition or better`,
          d_date_contributed: dates.length === 1 ? dates[0] : 'Various',
          e_date_acquired: acq.length === 1 ? acq[0] : 'Various',
          f_how_acquired: how.length === 1 ? how[0] : 'Various',
          g_cost_basis: basisKnown ? usd(g.reduce((s, r) => s + r.cost_basis_cents, 0)) : null,
          h_fmv: usd(fmv),
          i_method: 'Thrift shop value',
          needs_efg: fmv > 50_000,
        };
      });
      const missing = out.filter((r) => r.needs_efg && r.g_cost_basis === null);
      const text = [
        `Form 8283 Section A · ${input.year} · ${summary.total_cents > 50_000 ? 'required' : 'not required yet'}`,
        ...out.map((r) => `- ${r.c_description}\n    (a) ${r.a_donee} (d) ${r.d_date_contributed} (e) ${r.e_date_acquired} (f) ${r.f_how_acquired} (g) ${r.g_cost_basis ?? 'MISSING'} (h) ${r.h_fmv} (i) ${r.i_method}`),
        ...(missing.length ? [`! Column (g) cost basis is missing on ${missing.length} line(s) over $500. Add cost_basis with donation_update, or a reasonable-cause statement.`] : []),
        'Not tax advice. Confirm with your preparer.',
      ].join('\n');
      return { data: { year: input.year, rows: out, flags: summary.flags }, text };
    }

    if (input.format === 'csv') {
      const head = 'date,store,receipt_number,items,fmv_usd,receipt_archived,donation_id';
      const body = lines.map((l) => [l.donated_at, l.store_name, l.receipt_number, l.items, (l.total_cents / 100).toFixed(2), l.receipt ? 'yes' : 'no', l.id].map(csvCell).join(','));
      const csv = [head, ...body].join('\n');
      return { data: { csv }, text: csv };
    }

    const table = [
      'DATE        STORE              ITEMS  FMV          RECEIPT',
      ...lines.map((l) => `${l.donated_at}  ${(l.store_name ?? '—').slice(0, 17).padEnd(17)}  ${String(l.items).padStart(5)}  ${usd(l.total_cents).padStart(11)}  ${l.receipt ? 'archived' : 'paper'}`),
      '-'.repeat(60),
      `${input.year}        ${summary.donations} donations · ${usd(summary.total_cents)} FMV`,
      ...summary.groups.map((g) => `${g.group.padEnd(10)}  ${usd(g.cents)} of $5,000.00 appraisal line`),
      ...summary.flags.map((f) => `· ${f.message}`),
    ].join('\n');
    return { data: { ...summary, lines }, text: table };
  },
});
