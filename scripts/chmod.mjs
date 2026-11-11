import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
const f = 'dist/cli.js';
const src = readFileSync(f, 'utf8');
if (!src.startsWith('#!')) writeFileSync(f, '#!/usr/bin/env -S node --no-warnings=ExperimentalWarning\n' + src);
chmodSync(f, 0o755);
