#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = __dirname;
function findTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const tests = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tests.push(...findTests(full));
    else if (/.test.js$/.test(entry.name)) tests.push(full);
  }
  return tests;
}
const tests = findTests(path.join(root, 'tests'));
if (!tests.length) { console.error('No tests found under scripts/tests'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: path.resolve(root, '..'), stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
