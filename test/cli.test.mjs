import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'gwmcp-'));
const inbox = join(home, 'inbox');
mkdirSync(inbox);
const env = { ...process.env, GOODWILL_MCP_HOME: join(home, 'data'), GOODWILL_MCP_INBOX: inbox };

function run(args, { ok = true } = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' });
  if (ok) assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
  return r;
}
const json = (args) => JSON.parse(run([...args, '--json']).stdout);

async function photo(name, color) {
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: color } }).jpeg().toFile(join(inbox, name));
}

test('empty inbox is a user error with exit 1', () => {
  const r = run(['intake', 'open'], { ok: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INBOX_EMPTY/);
});

test('HEIC is rejected with the fix', () => {
  writeFileSync(join(inbox, 'IMG_0001.HEIC'), 'x');
  const r = run(['intake', 'open'], { ok: false });
  assert.match(r.stderr, /HEIC_UNSUPPORTED.*Most Compatible/);
  spawnSync('rm', [join(inbox, 'IMG_0001.HEIC')]);
});

let intakeId;
test('intake open reads photos and marks the receipt', async () => {
  await photo('a-items.jpg', '#884422');
  await photo('b-receipt.jpg', '#ffffff');
  const r = json(['intake', 'open']);
  intakeId = r.intake_id;
  assert.equal(r.files.length, 2);
  assert.equal(r.files.find((f) => f.file === 'b-receipt.jpg').kind, 'receipt');
});

test('donation create prices from the guide, skips poor items, archives photos', () => {
  const draft = join(home, 'draft.json');
  writeFileSync(draft, JSON.stringify({
    intake_id: intakeId, donated_at: '2026-03-14', store: 'Store #0412', receipt_number: 'T-0001', basis: 'mid',
    items: [
      { description: "women's blouses", category: 'womens.shirt_blouse', qty: 10, condition: 'good' },
      { description: "women's jeans", category: 'womens.jeans', qty: 4, condition: 'like_new' },
      { description: 'stained rug', qty: 1, condition: 'poor', group: 'household', unit_value: 20 },
    ],
  }));
  const r = json(['donation', 'create', '--from-json', draft]);
  // mid of $2-12 = $7 x 10 = $70; mid of $4-21 = $12.50 x 4 = $50; rug left out
  assert.equal(r.donation.total_cents, 12000);
  assert.equal(r.donation.items.length, 2);
  assert.ok(r.warnings.some((w) => w.code === 'BELOW_GOOD_CONDITION'));
  assert.equal(readdirSync(inbox).length, 0, 'photos moved out of the inbox');
  assert.equal(readdirSync(join(home, 'data', 'archive')).length, 2);
});

test('same receipt again is a no-op duplicate', () => {
  const r = json(['donation', 'create', '--donated-at', '2026-03-14', '--receipt-number', 'T-0001',
    '--items', JSON.stringify([{ description: 'x', qty: 1, condition: 'good', unit_value: 1 }])]);
  assert.equal(r.duplicate, true);
});

test('unit value above the guide high needs an override reason', () => {
  const r = run(['donation', 'create', '--donated-at', '2026-04-01', '--items',
    JSON.stringify([{ description: 'blouse', category: 'womens.shirt_blouse', qty: 1, condition: 'good', unit_value: 40 }])], { ok: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VALUE_OVER_GUIDE/);
});

let bigId;
test('a 450-piece clothing donation trips Form 8283 and the year adds up', () => {
  const r = json(['donation', 'create', '--donated-at', '2026-11-07', '--store', 'Store #0412', '--receipt-number', 'T-0002',
    '--items', JSON.stringify([{ description: "women's clothing", category: 'womens.shirt_blouse', qty: 450, condition: 'good', unit_value: 5 }])]);
  bigId = r.donation.id;
  assert.equal(r.donation.total_cents, 225000);
  assert.equal(r.year.total_cents, 237000);
  assert.ok(r.year.flags.some((f) => f.code === 'FORM_8283_REQUIRED'));
  assert.ok(r.warnings.some((w) => w.code === 'RECEIPT_NOT_ARCHIVED'));
});

test('form8283 groups all clothing on one line and flags missing cost basis', () => {
  const r = json(['donation', 'report', '--year', '2026', '--format', 'form8283']);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].h_fmv, '$2,370.00');
  assert.equal(r.rows[0].d_date_contributed, 'Various');
  assert.equal(r.rows[0].i_method, 'Thrift shop value');
  assert.equal(r.rows[0].g_cost_basis, null);
});

test('crossing $4,000 in one group warns before the appraisal line', () => {
  const r = json(['donation', 'create', '--donated-at', '2026-12-01', '--items',
    JSON.stringify([{ description: "men's coats", category: 'mens.coat', qty: 50, condition: 'good', unit_value: 40 }])]);
  assert.ok(r.year.flags.some((f) => f.code === 'APPRAISAL_WARNING'));
});

test('portal format produces paste-ready text under 1,000 characters', () => {
  const r = json(['donation', 'report', '--format', 'portal', '--donation-id', bigId]);
  assert.equal(r.value, '2250.00');
  assert.equal(r.receipt_number, 'T-0002');
  assert.ok(r.description.length <= 1000);
  assert.match(r.description, /thrift shop value/);
});

test('update replaces items with a revision; void removes it from totals', () => {
  const up = json(['donation', 'update', bigId, '--reason', 'recount', '--items',
    JSON.stringify([{ description: "women's clothing", category: 'womens.shirt_blouse', qty: 400, condition: 'good', unit_value: 5 }])]);
  assert.equal(up.after.total_cents, 200000);
  const dry = json(['donation', 'update', bigId, '--reason', 'test', '--void', '--dry-run']);
  assert.equal(dry.dry_run, true);
  const v = json(['donation', 'update', bigId, '--reason', 'duplicate entry', '--void']);
  assert.equal(v.after.status, 'void');
  const rep = json(['donation', 'report', '--year', '2026']);
  assert.equal(rep.donations, 2);
});

test('unknown flag and missing required field exit 1', () => {
  assert.equal(run(['donation', 'report', '--nope', 'x'], { ok: false }).status, 1);
  assert.equal(run(['donation', 'create', '--items', '[]'], { ok: false }).status, 1);
});

test('MCP server lists the four tools over stdio', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', CLI, 'server', 'start'], env }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['donation_create', 'donation_report', 'donation_update', 'intake_open']);
  const res = await client.callTool({ name: 'donation_report', arguments: { year: 2026 } });
  assert.match(res.content[0].text, /2026/);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, 'log_donation');
  await client.close();
});
