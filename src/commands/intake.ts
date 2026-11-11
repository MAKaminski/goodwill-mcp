import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { defineCommand, UserError, type ImageOut } from '../registry.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const MAX_EDGE = 1568;

function mimeFor(ext: string): string {
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** Resize for the model. sharp is a dependency; if it fails to load on a platform, send the original. */
async function forModel(buf: Buffer, ext: string): Promise<{ data: Buffer; mime: string }> {
  try {
    const sharp = (await import('sharp')).default;
    const data = await sharp(buf).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 }).toBuffer();
    return { data, mime: 'image/jpeg' };
  } catch {
    return { data: buf, mime: mimeFor(ext) };
  }
}

export const intakeOpen = defineCommand({
  tool: 'intake_open',
  noun: 'intake',
  verb: 'open',
  description:
    'Open the donation inbox: read the receipt and item photos (JPEG, PNG or WebP), resize them, and return them as images ' +
    'so you can read the store, date, receipt number and items. Name the receipt photo with "receipt" in the filename, or ' +
    'it is assumed to be the first file. Next step: call donation_create with the returned intake_id.',
  input: {
    dir: z.string().optional().describe('Folder to read. Default: ~/Donations/inbox (or GOODWILL_MCP_INBOX).'),
    paths: z.array(z.string()).optional().describe('Specific image files to read instead of a folder.'),
  },
  async run(ctx, input) {
    let files: string[];
    if (input.paths?.length) {
      files = input.paths.map((p) => resolve(p));
    } else {
      const dir = resolve(input.dir ?? ctx.paths.inbox);
      try {
        files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort().map((f) => join(dir, f));
      } catch {
        throw new UserError('INBOX_MISSING', `No folder at ${dir}. Create it and drop the receipt and item photos in it.`);
      }
    }
    const heic = files.filter((f) => HEIC_EXT.has(extname(f).toLowerCase()));
    if (heic.length) {
      throw new UserError('HEIC_UNSUPPORTED',
        `${heic.map((f) => basename(f)).join(', ')}. Fix: iPhone Settings > Camera > Formats > Most Compatible, or export the photos as JPEG.`);
    }
    files = files.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()) && statSync(f).isFile());
    if (!files.length) throw new UserError('INBOX_EMPTY', 'No JPEG, PNG or WebP photos found. Drop the receipt and item photos in the inbox.');

    const receiptIdx = Math.max(0, files.findIndex((f) => /receipt/i.test(basename(f))));
    const id = randomUUID();
    const now = new Date().toISOString();
    const images: ImageOut[] = [];
    const rows: { file: string; kind: string; sha256: string; bytes: number }[] = [];
    ctx.db.exec('BEGIN');
    try {
      ctx.db.prepare('INSERT INTO intake (id, opened_at, status) VALUES (?, ?, ?)').run(id, now, 'open');
      const ins = ctx.db.prepare('INSERT OR REPLACE INTO attachment (sha256, intake_id, kind, path, bytes) VALUES (?, ?, ?, ?, ?)');
      for (const [i, f] of files.entries()) {
        const buf = readFileSync(f);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const kind = i === receiptIdx ? 'receipt' : 'item';
        ins.run(sha256, id, kind, f, buf.length);
        rows.push({ file: basename(f), kind, sha256, bytes: buf.length });
        const small = await forModel(buf, extname(f).toLowerCase());
        images.push({ name: basename(f), mimeType: small.mime, base64: small.data.toString('base64') });
      }
      ctx.db.exec('COMMIT');
    } catch (e) {
      ctx.db.exec('ROLLBACK');
      throw e;
    }
    const text = [
      `intake ${id}`,
      ...rows.map((r) => `  ${r.kind.padEnd(7)} ${r.file}  ${(r.bytes / 1024).toFixed(0)} KB`),
      'Next: read the receipt and items, then call donation_create with this intake_id.',
    ].join('\n');
    return { data: { intake_id: id, files: rows }, text, images };
  },
});
