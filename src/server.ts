import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { commands } from './commands/index.js';
import { guideRows } from './commands/valuation.js';
import { openDb, paths } from './db.js';
import { UserError, type Ctx } from './registry.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export async function startServer(): Promise<void> {
  const ctx: Ctx = { db: openDb(), paths: paths() };
  const server = new McpServer({ name: 'goodwill-mcp', version: pkg.version });

  for (const c of commands) {
    if (!c.tool) continue;
    server.registerTool(c.tool, { description: c.description, inputSchema: c.input }, async (args: any): Promise<any> => {
      const t0 = Date.now();
      try {
        const parsed = z.object(c.input).parse(args);
        const r = await c.run(ctx, parsed);
        const content: any[] = [{ type: 'text', text: r.text }];
        for (const img of r.images ?? []) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
        content.push({ type: 'text', text: JSON.stringify(r.data) });
        process.stderr.write(JSON.stringify({ tool: c.tool, ms: Date.now() - t0, ok: true }) + '\n');
        return { content };
      } catch (e) {
        const msg = e instanceof UserError ? e.message : `INTERNAL: ${(e as Error).message}`;
        process.stderr.write(JSON.stringify({ tool: c.tool, ms: Date.now() - t0, ok: false, error: msg }) + '\n');
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    });
  }

  server.registerResource('valuation-goodwill', 'valuation://goodwill/latest',
    { title: 'Goodwill price guide', description: 'Category keys and low / high values used to price items.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(guideRows(ctx.db, 'goodwill')) }] }));

  server.registerPrompt('log_donation', {
    title: 'Log a donation',
    description: 'Read the receipt and item photos in the inbox and log the donation.',
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Log my donation with goodwill-mcp:',
          '1. Call intake_open.',
          '2. From the receipt photo read: donation date (YYYY-MM-DD), store name or number, receipt number.',
          '3. From the item photos list each kind of item with a count, a specific description and a condition',
          '   (new_with_tags, like_new, good, fair, poor). Map each to a category key from the valuation://goodwill/latest resource.',
          '   Count only what you can see; if a count is an estimate, say so and ask me before logging.',
          '4. Call donation_create with the intake_id, receipt details and items. Use basis "mid" unless I say otherwise.',
          '5. Tell me the total fair market value, the year-to-date total and any flags. Never describe the result as tax saved.',
        ].join('\n'),
      },
    }],
  }));

  await server.connect(new StdioServerTransport());
}
