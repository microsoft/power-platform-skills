#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');

function install(projectDir) {
  const target = path.join(path.resolve(projectDir), '.mobile-build');
  fs.mkdirSync(target, { recursive: true });
  for (const [source, destination] of [['core.cjs', 'panel-core.cjs'], ['middleware.cjs', 'panel-middleware.cjs'], ['panel.html', 'panel.html']]) {
    core.atomicWrite(path.join(target, destination), fs.readFileSync(path.join(__dirname, source)));
  }
  return core.loadState(path.resolve(projectDir));
}

if (require.main === module) {
  const projectDir = process.argv[2];
  if (!projectDir) { console.error('usage: install.js <project-dir>'); process.exit(1); }
  try { const state = install(projectDir); console.log(JSON.stringify({ url: 'http://localhost:8081/panel', sections: Object.keys(state) })); }
  catch (error) { console.error(`prototype-panel: ${error.message}`); process.exit(1); }
}

module.exports = { install };