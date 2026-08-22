#!/usr/bin/env node
'use strict';

const { runHook } = require('../skills/create-mobile-prototype/harness/static/run.js');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
	try { process.exit(runHook(JSON.parse(input || '{}'))); }
	catch (error) { process.stderr.write(`static AST gate error: ${error.message}\n`); process.exit(2); }
});