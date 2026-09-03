#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const READ_CAPABLE_TOOLS = new Set([
  'bash',
  'glob',
  'grep',
  'grep_search',
  'read',
  'read_file',
  'rg',
  'run_in_terminal',
  'shell',
  'view',
]);
const DIRECT_READ_TOOLS = new Set(['read', 'read_file', 'view']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'grep_search', 'rg']);
const SHELL_TOOLS = new Set(['bash', 'run_in_terminal', 'shell']);
const PROHIBITED_PATH = /(?:^|[\\/])(?:scripts[\\/])?(?:tests?|fixtures?|snapshots?|__snapshots__|benchmarks?)(?:[\\/]|$)/i;
const PLUGIN_SCRIPT_PATH = /(?:^|[\\/])plugins[\\/]mobile-apps[\\/]scripts(?:[\\/]|$)/i;
const FULL_AUTHORING_INPUT = /(?:native-app-plan\.md|\.tmp[\\/](?:product-experience-contract|product-scope-contract|workflow-journey-contract|screen-build-pack|compiled-screen-build-pack|navigation-manifest|scenario-facts|persistence-contract|product-experience-final-preview-contract)\.json)\b/i;
const COMPACT_PROJECTION = /\.tmp[\\/]product-experience-preview-authoring\.json\b/i;
const AUTOMATIC_REFERENCE = /(?:skills[\\/]design-system[\\/](?:SKILL\.md|references[\\/](?:auto-experience|design-system-schema|final-experience-preview)\.md)|shared[\\/]shared-instructions-core\.md)\b/i;
const SOURCE_INSPECTION_COMMAND = /\b(?:cat|grep|head|less|rg|sed|tail|awk)\b[^\n]*(?:plugins[\\/]mobile-apps[\\/]scripts)/i;
const AD_HOC_GENERATOR = /(?:^|[\s"'`\\/])\.tmp[\\/]generate-[a-z0-9._-]+\.js\b/i;

function collectStrings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, result));
  }
  return result;
}

function prohibitedExcerpts(value) {
  const excerpts = collectStrings(value).flatMap((text) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => PROHIBITED_PATH.test(line))
    .map((line) => line.slice(0, 1000)));
  return [...new Set(excerpts)].sort();
}

function matchingExcerpts(value, pattern) {
  const excerpts = collectStrings(value).flatMap((text) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => pattern.test(line))
    .map((line) => line.slice(0, 1000)));
  return [...new Set(excerpts)].sort();
}

function addViolation(violations, data, phase, code, excerpts) {
  if (excerpts.length === 0) return;
  violations.push({
    code,
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    phase,
    excerpts,
  });
}

function auditJsonl(source, input = '<memory>') {
  const calls = new Map();
  const violations = [];
  const parseErrors = [];
  const automaticReferenceReads = new Map();
  const filesRead = new Set();
  let contractPrepared = false;
  let toolCallsScanned = 0;
  for (const [index, line] of String(source).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      parseErrors.push({ line: index + 1, message: error.message });
      continue;
    }
    if (event.type === 'tool.execution_start') {
      const data = event.data || {};
      calls.set(data.toolCallId, data.toolName);
      if (!READ_CAPABLE_TOOLS.has(data.toolName)) continue;
      toolCallsScanned += 1;
      const excerpts = prohibitedExcerpts(data.arguments);
      addViolation(violations, data, 'arguments', 'prohibited-test-or-fixture-read', excerpts);
      if (DIRECT_READ_TOOLS.has(data.toolName) || SEARCH_TOOLS.has(data.toolName)) {
        const implementationReads = matchingExcerpts(data.arguments, PLUGIN_SCRIPT_PATH);
        addViolation(
          violations,
          data,
          'arguments',
          'preview-implementation-source-read',
          implementationReads,
        );
        for (const candidate of collectStrings(data.arguments)) {
          if (/[/\\]|\.md$|\.json$|\.js$|\.ts$/i.test(candidate)) filesRead.add(candidate);
        }
        const references = matchingExcerpts(data.arguments, AUTOMATIC_REFERENCE);
        for (const reference of references) {
          const count = (automaticReferenceReads.get(reference) || 0) + 1;
          automaticReferenceReads.set(reference, count);
          if (count > 1) {
            addViolation(
              violations,
              data,
              'arguments',
              'automatic-reference-reread',
              [reference],
            );
          }
        }
        if (contractPrepared) {
          const fullReads = matchingExcerpts(data.arguments, FULL_AUTHORING_INPUT)
            .filter((excerpt) => !COMPACT_PROJECTION.test(excerpt));
          addViolation(
            violations,
            data,
            'arguments',
            'full-contract-reread-after-projection',
            fullReads,
          );
        }
      }
      if (SHELL_TOOLS.has(data.toolName)) {
        addViolation(
          violations,
          data,
          'arguments',
          'preview-implementation-source-read',
          matchingExcerpts(data.arguments, SOURCE_INSPECTION_COMMAND),
        );
        addViolation(
          violations,
          data,
          'arguments',
          'ad-hoc-preview-generator',
          matchingExcerpts(data.arguments, AD_HOC_GENERATOR),
        );
      }
    }
    if (event.type === 'tool.execution_complete') {
      const data = event.data || {};
      const toolName = data.toolName || calls.get(data.toolCallId);
      if (!READ_CAPABLE_TOOLS.has(toolName)) continue;
      const excerpts = prohibitedExcerpts(data.result);
      addViolation(violations, { ...data, toolName }, 'result', 'prohibited-test-or-fixture-read', excerpts);
      if (SEARCH_TOOLS.has(toolName)) {
        addViolation(
          violations,
          { ...data, toolName },
          'result',
          'preview-implementation-source-read',
          matchingExcerpts(data.result, PLUGIN_SCRIPT_PATH),
        );
      }
      if (collectStrings(data.result).some((value) => (
        /"mode"\s*:\s*"contract-preparation"/.test(value)
        || /authoringProjectionPath/.test(value)
      ))) contractPrepared = true;
    }
  }
  return {
    input,
    ok: violations.length === 0 && parseErrors.length === 0,
    toolCallsScanned,
    filesRead: [...filesRead].sort(),
    contractPrepared,
    prohibitedReadCount: violations.length,
    violations,
    parseErrors,
  };
}

function parseArgs(argv) {
  const inputs = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--input') inputs.push(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (inputs.length === 0) throw new Error('at least one --input JSONL log is required');
  return inputs;
}

function run(inputs) {
  const reports = inputs.map((input) => auditJsonl(
    fs.readFileSync(path.resolve(input), 'utf8'),
    path.resolve(input),
  ));
  return {
    ok: reports.every((report) => report.ok),
    prohibitedReadCount: reports.reduce(
      (total, report) => total + report.prohibitedReadCount,
      0,
    ),
    reports,
  };
}

function main(argv = process.argv) {
  try {
    const result = run(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`audit-final-preview-live-log: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  COMPACT_PROJECTION,
  auditJsonl,
  main,
  prohibitedExcerpts,
  run,
};