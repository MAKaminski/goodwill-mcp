// Stage a production copy (dist, guides, manifest, prod node_modules) and pack it with the official mcpb CLI.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const out = '.mcpb-stage';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['dist', 'guides', 'manifest.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) cpSync(f, `${out}/${f}`, { recursive: true });
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' });
execSync(`npx -y @anthropic-ai/mcpb@2 pack ${out} goodwill-mcp.mcpb`, { stdio: 'inherit' });
