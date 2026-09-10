#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const marker = '<!-- mobile-preview-provenance -->';
const blockPattern = /<script\b(?=[^>]*\sid\s*=\s*["']mobile-preview-provenance["'])[^>]*>[\s\S]*?<\/script>/gi;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveFile(root, file) {
  const resolved = fs.realpathSync(path.resolve(root, file));
  if (!inside(root, resolved)) throw new Error('Preview inputs must stay inside the project root');
  if (!fs.statSync(resolved).isFile()) throw new Error(`Not a regular file: ${file}`);
  return resolved;
}

function resolvePreview(root, file) {
  const resolved = resolveFile(root, file);
  if (!/\.html?$/i.test(resolved)) throw new Error('Preview output must be an HTML file');
  return resolved;
}

function normalizeDocument(html) {
  const blocks = [...html.matchAll(blockPattern)];
  const markers = html.split(marker).length - 1;
  if (blocks.length > 1 || markers > 1 || (blocks.length && markers)) {
    throw new Error('Duplicate preview provenance blocks');
  }
  if (blocks.length) return { html: html.replace(blockPattern, marker), block: blocks[0][0] };
  if (markers) return { html, block: null };
  const end = html.toLowerCase().lastIndexOf('</body>');
  if (end < 0) throw new Error('Preview must contain a closing body element');
  return { html: `${html.slice(0, end)}${marker}\n${html.slice(end)}`, block: null };
}

function writeProvenance({ projectRoot, preview, mode, scope, sources }) {
  const root = fs.realpathSync(projectRoot);
  const previewPath = resolvePreview(root, preview);
  if (!['intent', 'implementation'].includes(mode)) throw new Error('Choose intent or implementation mode');
  if (!['full-screens', 'components'].includes(scope)) throw new Error('Choose full-screens or components scope');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('At least one reviewed source is required');
  const entries = new Map();
  for (const source of sources) {
    const file = resolveFile(root, source);
    if (file === previewPath) throw new Error('A preview cannot be its own source');
    entries.set(path.relative(root, file).split(path.sep).join('/'), hash(fs.readFileSync(file)));
  }
  const document = normalizeDocument(fs.readFileSync(previewPath, 'utf8')).html;
  const provenance = {
    version: 1, mode, scope, generatedAt: new Date().toISOString(),
    documentSha256: hash(document),
    sources: [...entries].sort(([left], [right]) => left.localeCompare(right))
      .map(([file, sha256]) => ({ file, sha256 })),
  };
  // JSON is embedded as inert data; escape '<' so even a source filename cannot close the script.
  const json = JSON.stringify(provenance, null, 2).replace(/</g, '\\u003c');
  const block = `<script type="application/json" id="mobile-preview-provenance">\n${json}\n</script>`;
  fs.writeFileSync(previewPath, document.replace(marker, () => block));
  return { status: 'recorded', ...provenance };
}

function checkProvenance({ projectRoot, preview, expectedMode, expectedScope, requiredSources = [] }) {
  if (expectedMode && !['intent', 'implementation'].includes(expectedMode)) throw new Error('Invalid expected mode');
  if (expectedScope && !['full-screens', 'components'].includes(expectedScope)) throw new Error('Invalid expected scope');
  if (!Array.isArray(requiredSources) || requiredSources.some(source => typeof source !== 'string' || !source.trim())) {
    throw new Error('Required sources must be an array of non-empty file paths');
  }
  const root = fs.realpathSync(projectRoot);
  const previewPath = resolvePreview(root, preview);
  const requiredFiles = new Set(requiredSources.map(source => {
    const file = resolveFile(root, source);
    if (file === previewPath) throw new Error('A preview cannot be its own source');
    return file;
  }));
  const document = normalizeDocument(fs.readFileSync(previewPath, 'utf8'));
  if (!document.block) return { status: 'unverified', reasons: ['No source provenance recorded'] };
  if (!/\stype\s*=\s*["']application\/json["']/i.test(document.block)) {
    throw new Error('Provenance must be inert application/json data');
  }
  const content = document.block.slice(document.block.indexOf('>') + 1, document.block.lastIndexOf('<'));
  const provenance = JSON.parse(content);
  if (!provenance || provenance.version !== 1 || !['intent', 'implementation'].includes(provenance.mode) ||
      !['full-screens', 'components'].includes(provenance.scope) ||
      typeof provenance.generatedAt !== 'string' || !Number.isFinite(Date.parse(provenance.generatedAt)) ||
      !Array.isArray(provenance.sources) || !provenance.sources.length ||
      !/^[a-f0-9]{64}$/.test(provenance.documentSha256)) {
    throw new Error('Invalid preview provenance');
  }
  const reasons = [];
  if (hash(document.html) !== provenance.documentSha256) reasons.push('Preview document changed after recording');
  const seen = new Set();
  const recordedFiles = new Set();
  for (const source of provenance.sources) {
    if (!source || typeof source.file !== 'string' || path.isAbsolute(source.file) ||
        !/^[a-f0-9]{64}$/.test(source.sha256) || seen.has(source.file)) {
      throw new Error('Invalid or duplicate provenance source');
    }
    seen.add(source.file);
    const file = resolveFile(root, source.file);
    if (file === previewPath) throw new Error('A preview cannot be its own source');
    recordedFiles.add(file);
    if (hash(fs.readFileSync(file)) !== source.sha256) reasons.push(`Source changed: ${source.file}`);
  }
  // A fresh hash set can still omit the plan, theme or shared component a caller is
  // handing off. Assert those inputs without replacing or restamping recorded evidence.
  const missingRequiredSources = [...requiredFiles].filter(file => !recordedFiles.has(file))
    .map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  for (const file of missingRequiredSources) reasons.push(`Required source not recorded: ${file}`);
  const mismatch = (expectedMode && expectedMode !== provenance.mode) ||
    (expectedScope && expectedScope !== provenance.scope) || missingRequiredSources.length > 0;
  if (expectedMode && expectedMode !== provenance.mode) reasons.push(`Expected ${expectedMode} mode, recorded ${provenance.mode}`);
  if (expectedScope && expectedScope !== provenance.scope) reasons.push(`Expected ${expectedScope} scope, recorded ${provenance.scope}`);
  return {
    status: mismatch ? 'mismatch' : reasons.length ? 'stale' : 'current',
    mode: provenance.mode, scope: provenance.scope,
    generatedAt: provenance.generatedAt, sourceCount: provenance.sources.length, reasons,
    limitations: 'Checks recorded file freshness only, not dependency completeness, visual quality, approval or native execution',
  };
}

function parseArgs(args) {
  const options = { projectRoot: process.cwd(), sources: [], requiredSources: [] };
  let action;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--write' || arg === '--check') {
      if (action) throw new Error('Choose exactly one of --write or --check');
      action = arg;
      continue;
    }
    if (!['--project-root', '--preview', '--mode', '--scope', '--source', '--expect-mode', '--expect-scope', '--require-source'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--source') options.sources.push(value);
    else if (arg === '--require-source') options.requiredSources.push(value);
    else options[{
      '--project-root': 'projectRoot', '--preview': 'preview', '--mode': 'mode', '--scope': 'scope',
      '--expect-mode': 'expectedMode', '--expect-scope': 'expectedScope',
    }[arg]] = value;
  }
  if (!action || !options.preview) throw new Error('Use --write or --check with --preview <file.html>');
  if (action === '--check' && (options.mode || options.scope || options.sources.length)) {
    throw new Error('--check uses the recorded mode, scope and sources; do not supply replacements');
  }
  if (action === '--write' && (options.expectedMode || options.expectedScope || options.requiredSources.length)) {
    throw new Error('Expected mode/scope and required sources are assertions for --check only');
  }
  return { action, options };
}

if (require.main === module) {
  try {
    const { action, options } = parseArgs(process.argv.slice(2));
    const result = action === '--write' ? writeProvenance(options) : checkProvenance(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'recorded' && result.status !== 'current') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`preview-provenance: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { writeProvenance, checkProvenance };
