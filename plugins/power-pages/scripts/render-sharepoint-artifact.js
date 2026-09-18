#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderTemplate, parseArgs } = require('./lib/render-template');
const { renderReportHtml } = require('./lib/sharepoint-report-html');

// Reading order of the records. `sharing` sits after `plan` because it reports
// what the approved plan actually provisioned and who can reach it.
const ARTIFACTS = ['requirements', 'discovery', 'plan', 'sharing', 'progress'];
const TONES = ['neutral', 'info', 'success', 'warning', 'danger'];
const TEMPLATE = path.join(__dirname, '..', 'skills', 'sharepoint-to-power-pages', 'assets', 'report.html');
const ICON = path.join(__dirname, '..', 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png');
const DATA_PATTERN = /<script id="sharepoint-report-data" type="application\/json">([\s\S]*?)<\/script>/;
// The checksum covers the rendered file before this final comment, including its
// embedded JSON. Manual HTML edits are detected so regeneration cannot silently
// discard changes that were made outside the structured report data.
const INTEGRITY_PATTERN = /<!-- power-pages-sharepoint-report-sha256:([a-f0-9]{64}) -->\r?\n?$/;

function fail(message) {
  throw new Error(message);
}

function text(value, location, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    fail(`${location} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
}

function object(value, location, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${location} must be an object.`);
  if (keys) {
    const unknown = Object.keys(value).filter((key) => !keys.includes(key));
    if (unknown.length) fail(`${location} contains unsupported fields: ${unknown.join(', ')}.`);
  }
}

function array(value, location) {
  if (!Array.isArray(value)) fail(`${location} must be an array.`);
}

function link(value, location, navigation = false) {
  text(value, location, false);
  if (navigation) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.html$/.test(value) || value.includes('..')) {
      fail(`${location} must be a local HTML filename without traversal.`);
    }
    return;
  }
  if (/^#[a-zA-Z][\w-]*$/.test(value)) return;
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.html(?:#[a-zA-Z][\w-]*)?$/.test(value) && !value.includes('..')) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${location} must be an HTTPS URL, local HTML filename, or section fragment.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /[\u0000-\u0020\\]/.test(value)) {
    fail(`${location} must be an HTTPS URL without credentials or control characters.`);
  }
}

function richText(value, location) {
  if (typeof value === 'string') return;
  array(value, location);
  for (const [index, run] of value.entries()) {
    const at = `${location}[${index}]`;
    object(run, at);
    if (!['text', 'strong', 'emphasis', 'code', 'badge', 'link'].includes(run.kind)) {
      fail(`${at}.kind is not a supported inline type.`);
    }
    object(run, at, ['kind', 'text', ...(run.kind === 'badge' ? ['tone'] : []), ...(run.kind === 'link' ? ['href'] : [])]);
    text(run.text, `${at}.text`);
    if (run.kind === 'badge' && !TONES.includes(run.tone)) fail(`${at}.tone is invalid.`);
    if (run.kind === 'link') link(run.href, `${at}.href`);
  }
}

function blocks(value, location, depth = 0) {
  array(value, location);
  if (depth > 8) fail(`${location} exceeds the supported callout nesting depth.`);
  for (const [index, block] of value.entries()) {
    const at = `${location}[${index}]`;
    object(block, at);
    const fields = {
      paragraph: ['content'], heading: ['text', 'level'], code: ['text'],
      list: ['items', 'ordered'], facts: ['items'], table: ['columns', 'rows', 'emptyMessage'], callout: ['tone', 'blocks'],
    };
    if (Object.hasOwn(fields, block.type)) object(block, at, ['type', ...fields[block.type]]);
    switch (block.type) {
      case 'paragraph':
        richText(block.content, `${at}.content`);
        break;
      case 'heading':
        text(block.text, `${at}.text`, false);
        if (block.level !== undefined && ![3, 4].includes(block.level)) fail(`${at}.level must be 3 or 4.`);
        break;
      case 'code':
        text(block.text, `${at}.text`);
        break;
      case 'list':
        array(block.items, `${at}.items`);
        if (block.ordered !== undefined && typeof block.ordered !== 'boolean') fail(`${at}.ordered must be boolean.`);
        block.items.forEach((item, i) => richText(item, `${at}.items[${i}]`));
        break;
      case 'facts':
        array(block.items, `${at}.items`);
        for (const [i, item] of block.items.entries()) {
          object(item, `${at}.items[${i}]`, ['label', 'value']);
          text(item.label, `${at}.items[${i}].label`, false);
          richText(item.value, `${at}.items[${i}].value`);
        }
        break;
      case 'table':
        array(block.columns, `${at}.columns`);
        if (!block.columns.length) fail(`${at}.columns must not be empty.`);
        block.columns.forEach((column, i) => text(column, `${at}.columns[${i}]`));
        array(block.rows, `${at}.rows`);
        for (const [rowIndex, row] of block.rows.entries()) {
          array(row, `${at}.rows[${rowIndex}]`);
          if (row.length !== block.columns.length) fail(`${at}.rows[${rowIndex}] has the wrong number of cells.`);
          row.forEach((cell, i) => richText(cell, `${at}.rows[${rowIndex}][${i}]`));
        }
        if (block.emptyMessage !== undefined) text(block.emptyMessage, `${at}.emptyMessage`);
        break;
      case 'callout':
        if (!TONES.includes(block.tone)) fail(`${at}.tone is invalid.`);
        blocks(block.blocks, `${at}.blocks`, depth + 1);
        break;
      default:
        fail(`${at}.type is not a supported block type.`);
    }
  }
}

function validateArtifact(data, { allowLegacySummary = false, allowLegacyLinks = false } = {}) {
  object(data, 'Report', ['version', 'artifact', 'title', 'updatedAt', 'phase', 'summary', 'metadata', 'footer', 'links', 'sections']);
  if (data.version !== 1) fail('Report.version must be 1.');
  if (!ARTIFACTS.includes(data.artifact)) fail(`Report.artifact must be one of ${ARTIFACTS.join(', ')}.`);
  for (const key of ['title', 'updatedAt', 'phase']) text(data[key], `Report.${key}`, false);
  for (const key of ['summary', 'metadata', 'footer']) {
    if (data[key] !== undefined) richText(data[key], `Report.${key}`);
  }
  const summaryText = typeof data.summary === 'string' ? data.summary : data.summary?.map((run) => run.text).join('');
  if (!allowLegacySummary && !summaryText?.trim()) fail('Report.summary must contain a reader-facing summary before rendering.');
  array(data.links, 'Report.links');
  const linked = new Set();
  for (const [index, entry] of data.links.entries()) {
    const at = `Report.links[${index}]`;
    object(entry, at, ['artifact', 'label', 'href']);
    if (!ARTIFACTS.includes(entry.artifact) || linked.has(entry.artifact)) fail(`${at}.artifact is invalid or duplicated.`);
    linked.add(entry.artifact);
    text(entry.label, `${at}.label`, false);
    link(entry.href, `${at}.href`, true);
  }
  // Records written before the sharing map existed carry four links. They stay
  // readable so an in-flight migration can be loaded and reconciled; a write must
  // still name every record, because the template renders the link set as the
  // reader's only navigation between them.
  if (!allowLegacyLinks && linked.size !== ARTIFACTS.length) {
    fail(`Report.links must contain all ${ARTIFACTS.length} artifacts.`);
  }
  if (!linked.has(data.artifact)) fail('Report.links must include an entry for this report.');
  array(data.sections, 'Report.sections');
  const ids = new Set(['overview']);
  for (const [index, section] of data.sections.entries()) {
    const at = `Report.sections[${index}]`;
    object(section, at, ['id', 'title', 'blocks', 'detail']);
    if (typeof section.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(section.id) || ids.has(section.id)) {
      fail(`${at}.id must be a unique lowercase section slug other than overview.`);
    }
    ids.add(section.id);
    text(section.title, `${at}.title`, false);
    if (section.detail !== undefined && typeof section.detail !== 'boolean') fail(`${at}.detail must be boolean.`);
    blocks(section.blocks, `${at}.blocks`);
  }
  return data;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function existingFile(outputPath) {
  let stat;
  try {
    stat = fs.lstatSync(outputPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Output must be a regular file, not a directory or symbolic link.');
  const html = fs.readFileSync(outputPath, 'utf8');
  const marker = html.match(INTEGRITY_PATTERN);
  const integrity = marker && sha256(html.slice(0, marker.index)) === marker[1] ? 'valid' : 'modified-or-unmanaged';
  return { html, sha256: sha256(html), integrity };
}

function readArtifact(outputPath) {
  const file = existingFile(outputPath);
  if (!file) fail('Report does not exist.');
  const embedded = file.html.match(DATA_PATTERN);
  if (!embedded) fail('Report has no managed data. Review and convert the existing content before adopting it.');
  let data;
  try {
    data = JSON.parse(embedded[1]);
  } catch {
    fail('Report contains invalid embedded JSON.');
  }
  // Version-1 records created before reader summaries were required remain
  // readable for migration. A subsequent write requires the missing summary.
  return { data: validateArtifact(data, { allowLegacySummary: true, allowLegacyLinks: true }), sha256: file.sha256, integrity: file.integrity };
}

function assertReplacement(file, expectedSha256, allowUnmanaged) {
  if (!file) {
    if (expectedSha256) fail('Expected an existing report, but the output is missing.');
    return;
  }
  if (!expectedSha256) fail('Output already exists. Read it first and pass --expected-sha256 to update it.');
  if (file.sha256 !== expectedSha256) fail('Report changed since it was read. Reload and reconcile the latest content.');
  if (file.integrity !== 'valid' && !allowUnmanaged) {
    fail('Report has manual edits or is unmanaged. Reconcile its content before using --allow-unmanaged true.');
  }
}

function renderArtifact({ outputPath, data, expectedSha256, allowUnmanaged = false }) {
  validateArtifact(data);
  const document = renderReportHtml(data);
  text(outputPath, 'Output path', false);
  if (path.extname(outputPath).toLowerCase() !== '.html') fail('Output path must end in .html.');
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) fail('Expected SHA-256 is invalid.');
  if (typeof allowUnmanaged !== 'boolean') fail('allowUnmanaged must be boolean.');
  const output = path.resolve(outputPath);
  assertReplacement(existingFile(output), expectedSha256, allowUnmanaged);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.sharepoint-report-'));
  try {
    const stagedOutput = path.join(staging, 'report.html');
    renderTemplate({
      templatePath: TEMPLATE,
      outputPath: stagedOutput,
      dataObject: {
        TITLE: data.title,
        REPORT_DATA: data,
        ICON: `data:image/png;base64,${fs.readFileSync(ICON).toString('base64')}`,
        NAVIGATION: document.navigation,
        CONTENTS: document.toc,
        REPORT_CONTENT: document.content,
        LABEL: document.label,
        UPDATED: document.updated,
      },
      requiredKeys: ['TITLE', 'REPORT_DATA', 'ICON', 'NAVIGATION', 'CONTENTS', 'REPORT_CONTENT', 'LABEL', 'UPDATED'],
      emitStatus: false,
    });
    const html = fs.readFileSync(stagedOutput, 'utf8');
    const result = `${html}<!-- power-pages-sharepoint-report-sha256:${sha256(html)} -->\n`;
    fs.writeFileSync(stagedOutput, result, { mode: 0o600 });
    fs.chmodSync(stagedOutput, 0o600);
    // Recheck after rendering to catch another session's edits during generation.
    // New files use exclusive creation; replacements rename a complete same-volume
    // staging file so readers never see a partly rewritten report.
    assertReplacement(existingFile(output), expectedSha256, allowUnmanaged);
    if (expectedSha256) fs.renameSync(stagedOutput, output);
    else fs.writeFileSync(output, result, { flag: 'wx', mode: 0o600 });
    return { status: 'ok', output, sha256: sha256(result) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main(argv = process.argv) {
  const allowed = new Set(['mode', 'output', 'data', 'expected-sha256', 'allow-unmanaged']);
  const seen = new Set();
  const input = argv.slice(2);
  if (input.length % 2 !== 0) fail('Every option requires a value.');
  for (let i = 0; i < input.length; i += 2) {
    const key = input[i].slice(2);
    if (!input[i].startsWith('--') || !allowed.has(key) || seen.has(key)) fail(`Unknown or duplicate option: ${input[i]}`);
    seen.add(key);
  }
  const args = parseArgs(argv);
  if (!args.output) fail('Usage: render-sharepoint-artifact.js --output <report.html> --data <data.json|-> [--expected-sha256 <hash>]');
  const mode = args.mode || 'write';
  if (mode === 'read') {
    if (args.data || args['expected-sha256'] || args['allow-unmanaged']) fail('Read mode accepts only --output.');
    return readArtifact(path.resolve(args.output));
  }
  if (mode !== 'write') fail('--mode must be read or write.');
  if (!args.data) fail('Write mode requires --data <data.json|->.');
  if (args['allow-unmanaged'] !== undefined && !['true', 'false'].includes(args['allow-unmanaged'])) {
    fail('--allow-unmanaged must be true or false.');
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.data === '-' ? 0 : args.data, 'utf8'));
  } catch (error) {
    // JSON.parse errors can quote private report values; return the failure class
    // rather than copying source content into CLI diagnostics.
    fail(error instanceof SyntaxError ? 'Report input is not valid JSON.' : `Could not read report input (${error.code || 'read error'}).`);
  }
  return renderArtifact({
    outputPath: args.output,
    data,
    expectedSha256: args['expected-sha256'],
    allowUnmanaged: args['allow-unmanaged'] === 'true',
  });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(main()));
  } catch (error) {
    console.error(`SharePoint report: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateArtifact, renderArtifact, readArtifact, main };
