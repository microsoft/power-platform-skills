'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseHtmlDocument } = require('./html-document-lite');
const { canonicalJson, finding, sha256Hex } = require('./product-experience-contracts');

const AUTHORING_ROOTS = Object.freeze([
  'agents',
  'com.github.copilot',
  'shared',
  'skills',
]);
const AUTHORING_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const FIXTURE_ONLY_MARKERS = Object.freeze([
  'editorial-merchandise-runway',
  'equipment-command-surface',
  'dense-receiving-ledger',
  'repaired-editorial-merchandise-runway',
  'repaired-equipment-command-surface',
]);
// Opaque fingerprints are generated from isolated regression fixtures. Production compares
// hashes only; it never reads fixture source or learns a fixture's content/layout from them.
const FIXTURE_NORMALIZED_BYTE_SIGNATURES = new Set([
  '85dfb69fcb0c7df30db8f8de4a28f9badb48d8ee0dc4a65daa1f343818a0ea42',
  '707f9dbfd8c42737db3d1bb9d91db74869e0077e50a3c57f47d4abd59519da60',
  '4bd9f2b52219cd71dd7cda3c5b113b8a6209f654526e70a77c6486e4652e20a5',
  '7df625c6a8917bec5805f6ad9a0c1c2d3671f93afe9a76cf2c66c4501b66d3e5',
  '91da4a59c0c3abb2ab4a4c6066fbe1a9b93f8228448342e3921fe7ca4bd7e409',
]);
const FIXTURE_STRUCTURE_SIGNATURES = new Set([
  'f732ca632f3981d17b9e1b3d661c6254754c0e86806082f7a16167a3920f167c',
  'fb2ca598a5e76dfe457eddc443b21cb969a2f02ed31cc4ef60542022daf98096',
  'cbf34e7f470cf46907ac2ffd2cd913b3cd55371863aa7f3bb1488be166d6c553',
  'f0fef6659dc646d0a91b1e9c19aa532b87e07cdfb9508bbddd1f7f130dbddc91',
  'c12a713afa6f6ae668a7aff442e5cdf570942550e1685e0ddebca7df9ff9a53c',
]);
const FORBIDDEN_AUTHORING_PATH = /(?:^|[\s"'`(])(?:\.{0,2}\/)*(?:plugins\/mobile-apps\/)?(?:scripts\/tests\/|tests?\/|fixtures?\/|__snapshots__\/|(?:generated-)?benchmark-outputs?\/|[^\s"'`]+\.snap\b)/i;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/g;

function toPosix(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isTestRunnerPath(filePath) {
  const normalized = `/${toPosix(filePath).replace(/^\/+/, '')}`;
  return /\/(?:scripts\/)?tests(?:\/|$)|\/test(?:\/|$)/i.test(normalized);
}

function walkFiles(root, extensions) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkFiles(target, extensions));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(target);
    }
  }
  return files;
}

function walkProductionFiles(root, extensions) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['test', 'tests', 'fixture', 'fixtures', '__snapshots__'].includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkProductionFiles(target, extensions));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(target);
    }
  }
  return files;
}

function validateProductionAuthoringIsolation(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const files = AUTHORING_ROOTS.flatMap((relativePath) => walkFiles(
    path.join(root, relativePath),
    AUTHORING_EXTENSIONS,
  ));
  for (const rootFile of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(root, rootFile);
    if (fs.existsSync(file)) files.push(file);
  }
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!FORBIDDEN_AUTHORING_PATH.test(source)) continue;
    errors.push(finding(
      'preview-production-prompt-fixture-reference',
      `${toPosix(path.relative(root, file))} references a prohibited test, snapshot, or benchmark authoring path`,
    ));
  }
  return { ok: errors.length === 0, errors, scannedFiles: files.length };
}

function validateGeneratedSourceIsolation(source, sourcePath = '') {
  const errors = [];
  if (isTestRunnerPath(sourcePath)) return { ok: true, errors };
  IMPORT_SPECIFIER.lastIndex = 0;
  let match;
  while ((match = IMPORT_SPECIFIER.exec(String(source || ''))) !== null) {
    if (!FORBIDDEN_AUTHORING_PATH.test(` ${toPosix(match[1])}`)) continue;
    errors.push(finding(
      'preview-generated-test-import',
      `${sourcePath || 'generated source'} imports prohibited test, snapshot, or benchmark code`,
    ));
  }
  return { ok: errors.length === 0, errors };
}

function validateProductionSourceIsolation(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const files = ['hooks', 'scripts'].flatMap((relativePath) => walkProductionFiles(
    path.join(root, relativePath),
    SOURCE_EXTENSIONS,
  ));
  const errors = files.flatMap((file) => validateGeneratedSourceIsolation(
    fs.readFileSync(file, 'utf8'),
    toPosix(path.relative(root, file)),
  ).errors.map((error) => ({
    ...error,
    code: 'preview-production-test-import',
  })));
  return { ok: errors.length === 0, errors, scannedFiles: files.length };
}

function validateProjectSourceIsolation(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = ['app', 'src', 'brand'].flatMap((relativePath) => walkFiles(
    path.join(root, relativePath),
    SOURCE_EXTENSIONS,
  ));
  const errors = files.flatMap((file) => validateGeneratedSourceIsolation(
    fs.readFileSync(file, 'utf8'),
    toPosix(path.relative(root, file)),
  ).errors);
  return { ok: errors.length === 0, errors, scannedFiles: files.length };
}

function normalizedPreviewBytes(html) {
  return String(html || '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\sdata-composition-id=(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\b[a-f0-9]{64}\b/gi, '<sha256>')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function normalizedAttribute(name, value) {
  if (name === 'data-composition-id') return null;
  if (name === 'class') {
    return [name, String(value).split(/\s+/).filter(Boolean).sort()];
  }
  if (name === 'id') {
    return [name, ['preview-navigation', 'preview-storyboard', 'preview-all-screens'].includes(value)
      ? value
      : '<id>'];
  }
  if (name === 'style') {
    return [name, String(value).split(';').map((item) => item.split(':')[0].trim()).filter(Boolean).sort()];
  }
  if (name.startsWith('data-')) return [name, '<data>'];
  if (['href', 'src', 'title', 'aria-label'].includes(name)) return [name, '<value>'];
  return [name, value];
}

function cssShape(source) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(String(source || '').replace(/\/\*[^]*?\*\//g, ''))) !== null) {
    const selectors = match[1].split(',').map((item) => item.trim()).filter(Boolean).sort();
    const properties = match[2].split(';').map((item) => item.split(':')[0].trim().toLowerCase())
      .filter(Boolean).sort();
    rules.push([selectors, properties]);
  }
  return rules;
}

function structuralNode(node) {
  const attributes = Object.entries(node.attrs || {})
    .map(([name, value]) => normalizedAttribute(name, value))
    .filter(Boolean)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    tag: node.tag,
    attributes,
    rawShape: node.tag === 'style' ? cssShape(node.text) : null,
    children: (node.children || []).map(structuralNode),
  };
}

function previewByteSignature(html) {
  return sha256Hex(normalizedPreviewBytes(html));
}

function previewStructureSignature(html) {
  return sha256Hex(canonicalJson(structuralNode(parseHtmlDocument(html).document)));
}

function validatePreviewOutputIsolation(html) {
  const source = String(html || '').toLowerCase();
  const leaked = FIXTURE_ONLY_MARKERS.filter((marker) => source.includes(marker));
  const errors = [];
  if (leaked.length > 0) {
    errors.push(finding(
      'preview-fixture-marker-leaked',
      `final preview contains fixture-only marker(s): ${leaked.join(', ')}`,
    ));
  }
  if (FIXTURE_NORMALIZED_BYTE_SIGNATURES.has(previewByteSignature(html))) {
    errors.push(finding(
      'preview-fixture-byte-identical',
      'final preview is byte-equivalent to an isolated fixture after normalization',
    ));
  }
  if (FIXTURE_STRUCTURE_SIGNATURES.has(previewStructureSignature(html))) {
    errors.push(finding(
      'preview-fixture-structure-identical',
      'final preview is structurally identical to an isolated fixture after normalization',
    ));
  }
  return { ok: errors.length === 0, errors, leakedMarkers: leaked };
}

module.exports = {
  FIXTURE_ONLY_MARKERS,
  normalizedPreviewBytes,
  previewByteSignature,
  previewStructureSignature,
  validateGeneratedSourceIsolation,
  validatePreviewOutputIsolation,
  validateProductionAuthoringIsolation,
  validateProductionSourceIsolation,
  validateProjectSourceIsolation,
};