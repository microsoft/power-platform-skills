// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 2) { console.error('Usage: node scripts/test.mjs'); process.exit(2); }
const tests = readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(root, 'tests', name))],
  { cwd: root, shell: false, stdio: 'inherit' });
if (result.error) console.error('Could not start the Node.js test runner.');
process.exitCode = result.status ?? 1;
