import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type Db = DatabaseSync;

export interface Paths {
  home: string;
  db: string;
  archive: string;
  inbox: string;
}

export function paths(): Paths {
  const home = process.env.GOODWILL_MCP_HOME ?? join(homedir(), '.goodwill-mcp');
  return {
    home,
    db: join(home, 'ledger.db'),
    archive: join(home, 'archive'),
    inbox: process.env.GOODWILL_MCP_INBOX ?? join(homedir(), 'Donations', 'inbox'),
  };
}

const MIGRATIONS: string[] = [
  `CREATE TABLE org (
     id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ein TEXT, address TEXT);
   CREATE TABLE valuation_guide (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES org(id), version TEXT NOT NULL,
     tax_year INTEGER NOT NULL, source_url TEXT, UNIQUE(org_id, version));
   CREATE TABLE valuation_rate (
     id TEXT PRIMARY KEY, guide_id TEXT NOT NULL REFERENCES valuation_guide(id),
     category TEXT NOT NULL, item TEXT NOT NULL, grp TEXT NOT NULL,
     low_cents INTEGER NOT NULL, high_cents INTEGER NOT NULL, UNIQUE(guide_id, category));
   CREATE TABLE intake (
     id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, status TEXT NOT NULL);
   CREATE TABLE attachment (
     sha256 TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES intake(id),
     kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL);
   CREATE TABLE donation (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES org(id),
     intake_id TEXT REFERENCES intake(id), donated_at TEXT NOT NULL, store_name TEXT,
     receipt_number TEXT, receipt_sha256 TEXT UNIQUE, valuation_basis TEXT NOT NULL,
     total_cents INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE UNIQUE INDEX donation_receipt ON donation(org_id, receipt_number) WHERE receipt_number IS NOT NULL;
   CREATE INDEX donation_org_date ON donation(org_id, donated_at);
   CREATE TABLE donation_item (
     id TEXT PRIMARY KEY, donation_id TEXT NOT NULL REFERENCES donation(id),
     rate_id TEXT REFERENCES valuation_rate(id), description TEXT NOT NULL, category TEXT,
     grp TEXT NOT NULL, qty INTEGER NOT NULL, condition TEXT NOT NULL, unit_cents INTEGER NOT NULL,
     acquired TEXT, how_acquired TEXT, cost_basis_cents INTEGER, override_reason TEXT,
     photo_sha256 TEXT);
   CREATE INDEX donation_item_donation ON donation_item(donation_id);
   CREATE TABLE revision (
     id TEXT PRIMARY KEY, donation_id TEXT NOT NULL REFERENCES donation(id),
     at TEXT NOT NULL, patch_json TEXT NOT NULL, reason TEXT);`,
];

export function guidesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.GOODWILL_MCP_GUIDES ?? join(here, '..', 'guides');
}

export function openDb(): Db {
  const p = paths();
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.archive, { recursive: true });
  const db = new DatabaseSync(p.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  loadGuides(db);
  return db;
}

interface GuideFile {
  org: { slug: string; name: string; ein: string | null; address?: string };
  version: string;
  tax_year: number;
  source_url: string;
  rates: { category: string; item: string; group: string; low: number; high: number }[];
}

/** Guides are versioned JSON. A guide already loaded (same org + version) is left alone. */
function loadGuides(db: Db): void {
  const dir = guidesDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GuideFile;
    let org = db.prepare('SELECT id FROM org WHERE slug = ?').get(g.org.slug) as { id: string } | undefined;
    if (!org) {
      org = { id: randomUUID() };
      db.prepare('INSERT INTO org (id, slug, name, ein, address) VALUES (?, ?, ?, ?, ?)').run(
        org.id, g.org.slug, g.org.name, g.org.ein ?? null, g.org.address ?? null);
    }
    const exists = db.prepare('SELECT id FROM valuation_guide WHERE org_id = ? AND version = ?').get(org.id, g.version);
    if (exists) continue;
    const gid = randomUUID();
    db.exec('BEGIN');
    db.prepare('INSERT INTO valuation_guide (id, org_id, version, tax_year, source_url) VALUES (?, ?, ?, ?, ?)').run(
      gid, org.id, g.version, g.tax_year, g.source_url);
    const ins = db.prepare(
      'INSERT INTO valuation_rate (id, guide_id, category, item, grp, low_cents, high_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of g.rates) {
      ins.run(randomUUID(), gid, r.category, r.item, r.group, Math.round(r.low * 100), Math.round(r.high * 100));
    }
    db.exec('COMMIT');
  }
}
