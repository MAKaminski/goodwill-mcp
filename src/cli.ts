import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { commands } from './commands/index.js';
import { openDb, paths } from './db.js';
import { UserError, type Command } from './registry.js';
import { startServer } from './server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function help(): string {
  const rows = commands.map((c) => `  goodwill-mcp ${`${c.noun} ${c.verb}`.padEnd(18)} ${c.tool ? `[MCP ${c.tool}]`.padEnd(24) : ''.padEnd(24)} ${c.description.split('. ')[0].replace(/\.$/, '').split(':')[0]}.`);
  return [
    `goodwill-mcp ${pkg.version} · log donations from a receipt and photos`,
    '',
    'Usage: goodwill-mcp <noun> <verb> [flags]',
    '',
    ...rows,
    `  goodwill-mcp ${'server start'.padEnd(18)} ${''.padEnd(24)} Start the MCP stdio server (what Claude runs).`,
    '',
    'Flags: --json (machine output) · --from-json <file> (input as a JSON file) · --<field> <value>',
    'Data:  ~/.goodwill-mcp (GOODWILL_MCP_HOME) · inbox ~/Donations/inbox (GOODWILL_MCP_INBOX)',
    'Exit:  0 ok · 1 user error · 2 system error',
  ].join('\n');
}

function parseFlags(argv: string[], c: Command<any>) {
  const out: Record<string, unknown> = {};
  let json = false;
  const rest = [...argv];
  if (c.positional && rest[0] && !rest[0].startsWith('--')) out[c.positional] = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new UserError('BAD_ARG', `Unexpected argument "${a}".`);
    const key = a.slice(2).replace(/-/g, '_');
    if (key === 'json') { json = true; continue; }
    if (key === 'help') { out.__help = true; continue; }
    const next = rest[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    const val: unknown = isBool ? true : rest[++i];
    if (key === 'from_json') { Object.assign(out, JSON.parse(readFileSync(String(val), 'utf8'))); continue; }
    const field = (c.input as Record<string, z.ZodTypeAny>)[key];
    if (!field) throw new UserError('BAD_ARG', `Unknown flag --${a.slice(2)} for ${c.noun} ${c.verb}.`);
    const base = field instanceof z.ZodOptional || field instanceof z.ZodDefault ? (field as any)._def.innerType : field;
    if (base instanceof z.ZodNumber) out[key] = Number(val);
    else if (base instanceof z.ZodBoolean) out[key] = val === true || val === 'true';
    else if (base instanceof z.ZodArray || base instanceof z.ZodObject) out[key] = JSON.parse(String(val));
    else out[key] = val;
  }
  return { input: out, json };
}

async function main(): Promise<number> {
  const [noun, verb, ...rest] = process.argv.slice(2);
  if (!noun || noun === '--help' || noun === 'help' || noun === '-h') { process.stdout.write(help() + '\n'); return 0; }
  if (noun === '--version') { process.stdout.write(pkg.version + '\n'); return 0; }
  if (noun === 'server' && verb === 'start') { await startServer(); return -1; }
  const c = commands.find((x) => x.noun === noun && x.verb === verb);
  if (!c) { process.stderr.write(`Unknown command "${noun} ${verb ?? ''}".\n\n${help()}\n`); return 1; }
  const { input, json } = parseFlags(rest, c);
  if (input.__help) { process.stdout.write(`goodwill-mcp ${c.noun} ${c.verb}\n\n${c.description}\n`); return 0; }
  const parsed = z.object(c.input).safeParse(input);
  if (!parsed.success) {
    process.stderr.write(`error BAD_INPUT: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`);
    return 1;
  }
  const r = await c.run({ db: openDb(), paths: paths() }, parsed.data);
  process.stdout.write((json ? JSON.stringify(r.data, null, 2) : r.text) + '\n');
  return 0;
}

main().then((code) => { if (code >= 0) process.exitCode = code; }).catch((e) => {
  if (e instanceof UserError) { process.stderr.write(`error ${e.message}\n`); process.exitCode = 1; }
  else { process.stderr.write(`error INTERNAL: ${(e as Error).stack ?? e}\n`); process.exitCode = 2; }
});
