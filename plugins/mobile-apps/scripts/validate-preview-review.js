#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkProvenance } = require('./preview-provenance');

const limitations = [
  'Checks declared evidence completeness and file freshness only, not aesthetic quality, semantic accuracy, approval or native execution.',
  'Tool image-output references are declared evidence and cannot be independently authenticated.',
  'Image files are checked for location, regular-file status, magic bytes and inspected-byte hashes; images are not decoded or visually judged.',
  'Per-observation hashes and measured geometry are declarations, not authenticated browser telemetry; file hashes detect changed evidence bytes.',
];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const caseKey = (screenId, viewport, theme) => JSON.stringify([screenId, viewport.width, viewport.height, theme]);

function resolveFile(root, file, label) {
  if (!nonempty(file)) throw new Error(`${label} must be a non-empty file path`);
  // Match the provenance guard: check the real target, not just the symlink's spelling.
  const resolved = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the real project root`);
  }
  if (!fs.statSync(resolved).isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return resolved;
}

function assertNotPreview(file, previewPath, label) {
  const target = fs.statSync(file);
  const preview = fs.statSync(previewPath);
  if (file === previewPath || (target.dev === preview.dev && target.ino === preview.ino)) {
    throw new Error(`${label} cannot be the preview itself`);
  }
}

function readPreview({ projectRoot, preview, expectedMode, requiredSources = [] }) {
  if (!nonempty(projectRoot)) throw new Error('projectRoot must be a non-empty directory path');
  if (!['intent', 'implementation'].includes(expectedMode)) throw new Error('Mode must be intent or implementation');
  const root = fs.realpathSync(projectRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('projectRoot must be a directory');
  const previewPath = resolveFile(root, preview, 'Preview');
  if (!/\.html?$/i.test(previewPath)) throw new Error('Preview must be an .html or .htm file');
  const provenance = checkProvenance({
    projectRoot: root, preview: previewPath, expectedMode, expectedScope: 'full-screens', requiredSources,
  });
  const previewSha256 = hash(fs.readFileSync(previewPath));
  return { root, previewPath, previewSha256, provenance };
}

function validateViewport(viewport) {
  if (!object(viewport) || !Number.isInteger(viewport.width) || viewport.width <= 0 ||
      !Number.isInteger(viewport.height) || viewport.height <= 0) {
    throw new Error('Viewport must have positive finite integer width and height');
  }
}

function requiredCases(screenIds, viewports, themes) {
  for (const [name, values] of Object.entries({ screenIds, viewports, themes })) {
    if (!Array.isArray(values) || !values.length) throw new Error(`${name} must be an explicit non-empty array`);
    const seen = new Set();
    for (const value of values) {
      if (name === 'viewports') validateViewport(value);
      else if (!nonempty(value)) throw new Error(`${name} must contain non-empty strings`);
      const key = name === 'viewports' ? JSON.stringify([value.width, value.height]) : value;
      if (seen.has(key)) throw new Error(`Duplicate ${name} entry: ${key}`);
      seen.add(key);
    }
  }
  const cases = new Set();
  for (const screenId of screenIds) {
    for (const viewport of viewports) {
      for (const theme of themes) cases.add(caseKey(screenId, viewport, theme));
    }
  }
  return cases;
}

function validateScreenshot(screenshot, root, previewPath) {
  if (!object(screenshot)) throw new Error('Screenshot must be a file or tool evidence object');
  if (screenshot.kind === 'tool') {
    if (!nonempty(screenshot.reference)) {
      throw new Error('Tool screenshot reference must identify a specific browser image output');
    }
    return;
  }
  if (screenshot.kind !== 'file') throw new Error('Screenshot kind must be file or tool');
  if (screenshot.sha256 !== undefined && !validHash(screenshot.sha256)) {
    throw new Error('Screenshot sha256 must be a lowercase SHA256 hash of the inspected image bytes');
  }
  if (!nonempty(screenshot.path) || path.isAbsolute(screenshot.path) || path.win32.isAbsolute(screenshot.path)) {
    throw new Error('Screenshot path must be project-relative');
  }
  const file = resolveFile(root, screenshot.path, 'Screenshot');
  assertNotPreview(file, previewPath, 'Screenshot');
  const extension = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('Screenshot must be a PNG, JPEG or WebP image file');
  }
  const header = Buffer.alloc(12);
  const descriptor = fs.openSync(file, 'r');
  let length;
  try {
    length = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const valid = extension === '.png'
    ? length >= 8 && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : extension === '.webp'
      ? length >= 12 && header.subarray(0, 4).equals(Buffer.from('RIFF')) &&
        header.subarray(8, 12).equals(Buffer.from('WEBP'))
      : length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (!valid) throw new Error('Screenshot must be non-empty with matching PNG, JPEG or WebP magic bytes');
  return hash(fs.readFileSync(file));
}

function validatePreviewReview({
  projectRoot, preview, reviewPath, expectedMode, screenIds, viewports, themes, requiredSources = [],
} = {}) {
  const cases = requiredCases(screenIds, viewports, themes);
  const { root, previewPath, previewSha256, provenance } = readPreview({
    projectRoot, preview, expectedMode, requiredSources,
  });
  const reviewFile = resolveFile(root, reviewPath, 'Review');
  assertNotPreview(reviewFile, previewPath, 'Review');
  if (path.extname(reviewFile).toLowerCase() !== '.json') throw new Error('Review must be a .json file');
  let review;
  try {
    review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid review JSON: ${error.message}`);
  }
  if (!object(review) || review.version !== 1) throw new Error('Review version must be 1');
  if (!validHash(review.previewSha256)) {
    throw new Error('Review previewSha256 must be a lowercase SHA256 hash of the exact HTML bytes');
  }
  if (!Array.isArray(review.observations)) throw new Error('Review observations must be an array');

  const reasons = [...provenance.reasons];
  const coverage = { required: cases.size, observed: 0, passed: 0, failed: 0, unverified: 0, incomplete: 0, missing: 0 };
  const seen = new Set();
  let evidenceChanged = false;
  for (const entry of review.observations) {
    if (!object(entry) || !nonempty(entry.screenId) || !nonempty(entry.theme) || !nonempty(entry.state)) {
      throw new Error('Each observation must have non-empty screenId, theme and state strings');
    }
    validateViewport(entry.viewport);
    const key = caseKey(entry.screenId, entry.viewport, entry.theme);
    if (!cases.has(key)) throw new Error(`Unexpected observation case: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate observation case: ${key}`);
    seen.add(key);
    if (!['pass', 'fail', 'unverified'].includes(entry.status)) throw new Error(`Invalid observation status: ${key}`);
    for (const field of ['observation', 'interaction']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        throw new Error(`${field} must be a string: ${key}`);
      }
    }
    if (entry.screenshots !== undefined && !Array.isArray(entry.screenshots)) {
      throw new Error(`screenshots must be an array: ${key}`);
    }
    if (entry.previewSha256 !== undefined && !validHash(entry.previewSha256)) {
      throw new Error(`Observation previewSha256 must be a lowercase SHA256 hash: ${key}`);
    }
    if (entry.renderedViewport !== undefined &&
        (!object(entry.renderedViewport) ||
         !['width', 'height'].every(dimension =>
           Number.isFinite(entry.renderedViewport[dimension]) && entry.renderedViewport[dimension] > 0))) {
      throw new Error(`Rendered viewport must have positive finite numeric width and height: ${key}`);
    }
    const missing = [];
    let invalidCapture = false;
    if (entry.previewSha256 !== undefined && entry.previewSha256 !== previewSha256) {
      evidenceChanged = true;
      invalidCapture = true;
      reasons.push(`${key}: Observation preview byte hash differs; capture a new observation`);
    }
    if (entry.renderedViewport !== undefined &&
        ['width', 'height'].some(dimension =>
          Math.abs(entry.renderedViewport[dimension] - entry.viewport[dimension]) > 1)) {
      invalidCapture = true;
      reasons.push(`${key}: Rendered viewport differs from the required app dimensions`);
    }
    const screenshots = entry.screenshots || [];
    for (const screenshot of screenshots) {
      const imageSha256 = validateScreenshot(screenshot, root, previewPath);
      if (screenshot.kind !== 'file') continue;
      if (screenshot.sha256 === undefined) {
        if (entry.status === 'pass') missing.push(`screenshot sha256: ${screenshot.path}`);
      } else if (screenshot.sha256 !== imageSha256) {
        evidenceChanged = true;
        invalidCapture = true;
        reasons.push(`${key}: Screenshot byte hash differs: ${screenshot.path}; inspect the current image`);
      }
    }
    coverage.observed++;
    if (!nonempty(entry.observation)) missing.push('observation (visible findings or unavailable reason)');
    if (entry.status === 'pass') {
      if (entry.previewSha256 === undefined) missing.push('observation previewSha256');
      if (entry.renderedViewport === undefined) missing.push('measured renderedViewport');
      if (!nonempty(entry.interaction)) missing.push('interaction steps and result');
      if (!screenshots.length) missing.push('screenshot evidence');
      if (!missing.length && !invalidCapture) coverage.passed++;
    } else {
      coverage[entry.status === 'fail' ? 'failed' : 'unverified']++;
      reasons.push(`${key}: ${entry.status}${nonempty(entry.observation) ? ` — ${entry.observation}` : ''}`);
    }
    if (missing.length) reasons.push(`${key}: missing ${missing.join(', ')}`);
    if (missing.length || invalidCapture || entry.status === 'unverified') coverage.incomplete++;
  }
  for (const key of cases) {
    if (!seen.has(key)) {
      coverage.missing++;
      reasons.push(`Missing observation case: ${key}`);
    }
  }
  const hashChanged = review.previewSha256 !== previewSha256;
  if (hashChanged) reasons.push('Preview byte hash differs from the reviewed HTML; capture a new review');
  // Never let absent evidence hide a declared failure; stale reviews still need recapture.
  const status = hashChanged || evidenceChanged || provenance.status === 'stale' ? 'stale'
    : coverage.failed ? 'failed'
      : provenance.status !== 'current' || coverage.passed !== coverage.required ? 'incomplete' : 'complete';
  return { status, reasons, coverage, limitations: [...limitations] };
}

function parseArgs(args) {
  const options = { screenIds: [], viewports: [], themes: [], requiredSources: [] };
  const scalars = new Map([
    ['--project-root', 'projectRoot'], ['--preview', 'preview'], ['--review', 'reviewPath'], ['--mode', 'expectedMode'],
  ]);
  const repeated = new Map([
    ['--screen-id', 'screenIds'], ['--viewport', 'viewports'], ['--theme', 'themes'], ['--require-source', 'requiredSources'],
  ]);
  const seen = new Set();
  let fingerprint = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--fingerprint' || scalars.has(arg)) {
      if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      seen.add(arg);
    }
    if (arg === '--fingerprint') {
      fingerprint = true;
      continue;
    }
    if (!scalars.has(arg) && !repeated.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (!nonempty(value) || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (scalars.has(arg)) options[scalars.get(arg)] = value;
    else if (arg === '--viewport') {
      // CLI shape is WIDTHxHEIGHT (for example 390x844), not floats or CSS dimensions.
      const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
      if (!match) throw new Error('Viewport must use positive integer WIDTHxHEIGHT');
      const viewport = { width: Number(match[1]), height: Number(match[2]) };
      validateViewport(viewport);
      options.viewports.push(viewport);
    } else options[repeated.get(arg)].push(value);
  }
  for (const arg of ['--project-root', '--preview', '--mode']) {
    if (!seen.has(arg)) throw new Error(`Missing required argument: ${arg}`);
  }
  if (fingerprint && seen.has('--review')) throw new Error('--review and --fingerprint are mutually exclusive');
  if (fingerprint && (options.screenIds.length || options.viewports.length || options.themes.length)) {
    throw new Error('--fingerprint accepts no screen, viewport or theme coverage arguments');
  }
  if (!fingerprint && !seen.has('--review')) throw new Error('Missing required argument: --review (or use --fingerprint)');
  return { options, fingerprint };
}

if (require.main === module) {
  try {
    const { options, fingerprint } = parseArgs(process.argv.slice(2));
    let result;
    if (fingerprint) {
      const { previewSha256, provenance } = readPreview(options);
      if (provenance.status !== 'current') {
        throw new Error(`Cannot fingerprint without current full-screen provenance: ${provenance.reasons.join('; ')}`);
      }
      result = { previewSha256 };
    } else {
      result = validatePreviewReview(options);
      if (result.status !== 'complete') process.exitCode = 2;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`validate-preview-review: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { validatePreviewReview };
