#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_MARKER = '<!-- MCP_APPS_SELF_CONTAINED_RUNTIME -->';
const EMBEDDED_RUNTIME_START = '<!-- MCP_APPS_EMBEDDED_RUNTIME_START -->';
const EMBEDDED_RUNTIME_END = '<!-- MCP_APPS_EMBEDDED_RUNTIME_END -->';
const runtimePath = path.resolve(__dirname, '..', 'assets', 'self-contained', 'mcp-app-runtime.min.js');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input' || value === '--output') {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a path`);
      result[value.slice(2)] = path.resolve(next);
      index += 1;
    } else if (value === '--prepare') {
      result.prepare = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!result.input) {
    throw new Error('Usage: inline-self-contained-runtime.js --input <html> [--output <html>] [--prepare]');
  }
  result.output ||= result.input;
  return result;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function assertNoExternalResources(html) {
  const resourceAttribute = /<(script|link|img|iframe|audio|video|source|object|image|use)\b[^>]*\b(src|srcset|href|xlink:href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(resourceAttribute)) {
    const value = (match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (match[2].toLowerCase() === 'srcset') {
      throw new Error('Self-contained widget contains an external media candidate list.');
    }
    if (value && !value.startsWith('data:') && !value.startsWith('#') && value !== 'about:blank') {
      throw new Error(`Self-contained widget contains an external ${match[1].toLowerCase()} resource.`);
    }
  }

  const checks = [
    [/\bimport\s*\(/, 'dynamic import'],
    [/^\s*import\s+(?:["'{*]|[A-Za-z_$])/m, 'module import'],
    [/@import\b/i, 'CSS import'],
    [/\burl\(\s*(?!["']?(?:data:|#))/i, 'CSS resource'],
    [/\bfetch\s*\(/i, 'fetch'],
    [/\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, 'network API'],
    [/\bnew\s+(?:Worker|SharedWorker)\s*\(/i, 'worker'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(html)) {
      throw new Error(`Self-contained widget contains a disallowed ${label}.`);
    }
  }
}

function inlineRuntime(draft, runtime) {
  const markerCount = countOccurrences(draft, RUNTIME_MARKER);
  if (markerCount !== 1) {
    throw new Error(`Expected exactly one ${RUNTIME_MARKER} marker; found ${markerCount}.`);
  }
  if (!/globalThis\.McpAppsRuntime/.test(draft)) {
    throw new Error('Draft must read App and theme tokens from globalThis.McpAppsRuntime.');
  }
  assertNoExternalResources(draft);

  // Use a replacer function because minified dependencies can legitimately contain
  // replacement tokens such as `$&`; passing the runtime as a replacement string would
  // expand those tokens and silently reinsert the marker into the bundle.
  if (draft.includes(EMBEDDED_RUNTIME_START) || draft.includes(EMBEDDED_RUNTIME_END)) {
    throw new Error('Draft already contains an embedded runtime. Run with --prepare before editing or inlining again.');
  }
  const embeddedRuntime = `${EMBEDDED_RUNTIME_START}\n<script>\n${runtime}\n</script>\n${EMBEDDED_RUNTIME_END}`;
  const output = draft.replace(RUNTIME_MARKER, () => embeddedRuntime);
  if (countOccurrences(output, '<script type="module">') !== 1) {
    throw new Error('Self-contained widget must contain exactly one application <script type="module"> block.');
  }
  return output;
}

function prepareDraft(html) {
  const start = html.indexOf(EMBEDDED_RUNTIME_START);
  const end = html.indexOf(EMBEDDED_RUNTIME_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('Expected one embedded MCP Apps runtime region.');
  }
  if (html.indexOf(EMBEDDED_RUNTIME_START, start + EMBEDDED_RUNTIME_START.length) >= 0
      || html.indexOf(EMBEDDED_RUNTIME_END, end + EMBEDDED_RUNTIME_END.length) >= 0) {
    throw new Error('Expected exactly one embedded MCP Apps runtime region.');
  }
  return html.slice(0, start) + RUNTIME_MARKER + html.slice(end + EMBEDDED_RUNTIME_END.length);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = fs.readFileSync(options.input, 'utf8');
  const output = options.prepare
    ? prepareDraft(source)
    : inlineRuntime(source, fs.readFileSync(runtimePath, 'utf8'));
  fs.writeFileSync(options.output, output);
  console.log(`${options.prepare ? 'Prepared widget source' : 'Wrote self-contained widget'}: ${options.output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  RUNTIME_MARKER,
  assertNoExternalResources,
  inlineRuntime,
  parseArgs,
  prepareDraft,
};
