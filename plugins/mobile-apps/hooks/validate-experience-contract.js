#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateExperienceContract } = require('../scripts/validate-experience-contract');

function isWriteTool(name) {
  return ['Write', 'Edit', 'MultiEdit'].includes(name);
}

function isPlan(filePath) {
  return typeof filePath === 'string' && path.basename(filePath) === 'native-app-plan.md';
}

function contentFrom(toolName, toolInput, filePath) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  return '';
}

let inputData = '';
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(inputData || '{}'); } catch { process.exit(0); }
  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWriteTool(toolName) || !isPlan(filePath)) process.exit(0);
  const markdown = contentFrom(toolName, toolInput, filePath);
  if (!markdown) process.exit(0);
  const projectRoot = path.resolve(input.cwd || path.dirname(filePath));
  const issues = validateExperienceContract(markdown, { projectRoot });
  if (!issues.length) process.exit(0);
  process.stderr.write(`[mobile-app] BLOCKED: Product Experience contract has ${issues.length} issue(s) in ${filePath}.\n`);
  for (const issue of issues.slice(0, 15)) {
    process.stderr.write(`- [${issue.rule}] ${issue.message}${issue.field ? ` (${issue.field}: ${issue.value || '<missing>'})` : ''}\n`);
  }
  if (issues.length > 15) process.stderr.write(`- ... and ${issues.length - 15} more\n`);
  process.exit(2);
});
