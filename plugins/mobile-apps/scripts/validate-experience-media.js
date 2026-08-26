#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MEDIA_FIELDS = ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function mediaRouteSources(projectRoot, pack) {
  const sources = [];
  for (const screen of pack.screens || []) {
    if (!['primary', 'key-flow'].includes(screen.role)) continue;
    const filePath = path.join(projectRoot, normalizePath(screen.file));
    if (fs.existsSync(filePath)) sources.push({ file: normalizePath(screen.file), content: fs.readFileSync(filePath, 'utf8') });
  }
  const foundationRoot = path.join(projectRoot, 'src', 'components', 'experience');
  const sharedComponents = path.join(projectRoot, 'src', 'components', 'index.tsx');
  if (fs.existsSync(sharedComponents)) {
    sources.push({
      file: path.relative(projectRoot, sharedComponents).replace(/\\/g, '/'),
      content: fs.readFileSync(sharedComponents, 'utf8'),
    });
  }
  if (fs.existsSync(foundationRoot)) {
    for (const entry of fs.readdirSync(foundationRoot)) {
      if (!entry.endsWith('.tsx')) continue;
      const filePath = path.join(foundationRoot, entry);
      sources.push({ file: path.relative(projectRoot, filePath).replace(/\\/g, '/'), content: fs.readFileSync(filePath, 'utf8') });
    }
  }
  return sources;
}

function validateExperienceMedia(projectRoot, packPath = '.tmp/screen-build-pack.json') {
  const root = path.resolve(projectRoot);
  const issues = [];
  const resolvedPackPath = path.resolve(root, packPath);
  if (!fs.existsSync(resolvedPackPath)) {
    return [{ rule: 'missing-screen-build-pack', message: 'Experience media validation requires .tmp/screen-build-pack.json.' }];
  }

  let pack;
  try {
    pack = readJson(resolvedPackPath);
  } catch (error) {
    return [{ rule: 'invalid-screen-build-pack', message: `Screen build pack is invalid JSON: ${error.message}` }];
  }

  const policy = pack.fixtures?.mediaPolicy;
  if (!['local-first', 'remote-cdn-cached', 'remote-allowed', 'not-applicable'].includes(policy)) {
    issues.push({ rule: 'invalid-media-policy', message: 'Screen build pack has no supported media policy.' });
    return issues;
  }
  const expectsMedia = policy !== 'not-applicable' && (pack.experience?.contentModel || []).includes('media');
  if (!expectsMedia) return issues;

  const expectedFields = pack.fixtures?.mediaFields;
  if (!Array.isArray(expectedFields) || expectedFields.join('|') !== MEDIA_FIELDS.join('|')) {
    issues.push({ rule: 'media-field-contract-drift', message: 'Screen build pack must declare imageUrl, imageAltText, imageCacheKey, and imageAssetKey.' });
  }

  const manifestRelativePath = pack.fixtures?.mediaManifest || pack.fixtures?.assetManifest;
  const manifestPath = path.join(root, normalizePath(manifestRelativePath));
  let manifest = null;
  if (!manifestRelativePath || !fs.existsSync(manifestPath)) {
    issues.push({ rule: 'missing-media-manifest', message: 'Screen build pack declares media but its manifest is missing.' });
  } else {
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      issues.push({ rule: 'invalid-media-manifest', message: `Media manifest is invalid JSON: ${error.message}` });
    }
  }

  const viewModelRelativePath = pack.fixtures?.viewModel;
  const viewModelPath = path.join(root, normalizePath(viewModelRelativePath));
  if (!viewModelRelativePath || !fs.existsSync(viewModelPath)) {
    issues.push({ rule: 'missing-experience-media-adapter', message: 'Screen build pack declares media but the canonical view model is missing.' });
  } else {
    const source = fs.readFileSync(viewModelPath, 'utf8');
    for (const required of ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey', 'resolveExperienceMedia']) {
      if (!source.includes(required)) issues.push({ rule: 'incomplete-experience-media-adapter', message: `Canonical view model is missing ${required}.` });
    }
  }

  if (manifest) {
    if (manifest.assetPolicy !== policy || manifest.media?.policy !== policy) {
      issues.push({ rule: 'media-policy-manifest-drift', message: 'Media manifest policy does not match the screen build pack.' });
    }
    const records = manifest.media?.records || {};
    if (policy === 'remote-cdn-cached') {
      const approvedHosts = Array.isArray(manifest.media?.approvedHosts) ? manifest.media.approvedHosts : [];
      if (!approvedHosts.length) issues.push({ rule: 'missing-approved-cdn-hosts', message: 'Cached CDN media requires approved hosts in the media manifest.' });
      if (pack.fixtures?.adapter === 'local' && Object.keys(records).length === 0) {
        issues.push({ rule: 'missing-cdn-fixture-media', message: 'Local fixture media requires at least one resolved CDN media record.' });
      }
      for (const [recordKey, record] of Object.entries(records)) {
        if (!MEDIA_FIELDS.every((field) => typeof record?.[field] === 'string' && record[field].trim())) {
          issues.push({ rule: 'incomplete-cdn-media-record', message: `Media record ${recordKey} is missing URL, alt text, cache key, or fallback asset key.` });
          continue;
        }
        let url;
        try {
          url = new URL(record.imageUrl);
        } catch {
          issues.push({ rule: 'invalid-cdn-media-url', message: `Media record ${recordKey} does not contain a valid URL.` });
          continue;
        }
        if (url.protocol !== 'https:' || !approvedHosts.includes(url.hostname)) {
          issues.push({ rule: 'unapproved-cdn-media-url', message: `Media record ${recordKey} uses an unapproved CDN host.` });
        }
        if (!record.imageAssetKey.startsWith('asset://')) {
          issues.push({ rule: 'invalid-media-fallback-key', message: `Media record ${recordKey} needs an asset:// fallback identity.` });
        }
      }
    }
  }

  const sources = mediaRouteSources(root, pack);
  if (sources.length) {
    const aggregate = sources.map((source) => source.content).join('\n');
    if (!aggregate.includes('EntityImage') || !aggregate.includes('resolveExperienceMedia')) {
      issues.push({ rule: 'media-resolver-unused', message: 'Built media routes/foundations must render EntityImage from resolveExperienceMedia.' });
    }
    for (const source of sources) {
      if (/https?:\/\//i.test(source.content)) {
        issues.push({ rule: 'hard-coded-screen-media-url', message: `Built media source ${source.file} hard-codes a remote URL instead of reading the canonical media model.` });
      }
    }
  }
  return issues;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-experience-media.js --project-root <dir> [--pack <path>] [--json]\n');
    return 2;
  }
  const issues = validateExperienceMedia(args.projectRoot, args.pack);
  if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-experience-media', issues }, null, 2)}\n`);
  if (issues.length) {
    if (!args.json) issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
    return 2;
  }
  if (!args.json) process.stdout.write('Experience media contract valid.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateExperienceMedia };