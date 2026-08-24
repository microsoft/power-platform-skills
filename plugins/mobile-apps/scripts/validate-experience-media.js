#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { inspectExperienceImage } = require('./lib/experience-media');

const MEDIA_FIELDS = ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function approvedUrl(record, approvedHosts) {
  if (!record.imageUrl) return false;
  try {
    const url = new URL(record.imageUrl);
    return url.protocol === 'https:' && approvedHosts.includes(url.hostname);
  } catch {
    return false;
  }
}

function validateBundledAsset(root, assetKey, asset, issues) {
  if (!asset || typeof asset !== 'object') {
    issues.push({ rule: 'missing-materialized-media-asset', message: `Media fallback ${assetKey} has no asset recipe.` });
    return false;
  }
  if (asset.kind === 'local-illustration' || asset.kind === 'icon-fallback' || asset.materialized !== true) {
    issues.push({ rule: 'icon-only-critical-media', message: `Media fallback ${assetKey} is symbolic/icon-only instead of a materialized image.` });
    return false;
  }
  const relativePath = normalizePath(asset.localPath);
  const filePath = path.resolve(root, relativePath);
  if (!relativePath || !filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) {
    issues.push({ rule: 'missing-materialized-media-file', message: `Media fallback ${assetKey} does not resolve to a project-local file.` });
    return false;
  }
  let inspected;
  try {
    inspected = inspectExperienceImage(filePath);
  } catch (error) {
    issues.push({ rule: 'undecodable-media-file', message: `Media fallback ${assetKey} is not decodable: ${error.message}.` });
    return false;
  }
  if (inspected.width < 480 || inspected.height < 320) {
    issues.push({ rule: 'undersized-critical-media', message: `Media fallback ${assetKey} must be at least 480x320; received ${inspected.width}x${inspected.height}.` });
  }
  if (inspected.byteLength < 1024) {
    issues.push({ rule: 'insubstantial-critical-media', message: `Media fallback ${assetKey} is too small to be a substantive visual.` });
  }
  if (asset.width !== inspected.width || asset.height !== inspected.height || asset.byteLength !== inspected.byteLength) {
    issues.push({ rule: 'media-metadata-drift', message: `Media fallback ${assetKey} metadata does not match its file.` });
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (!asset.sha256 || asset.sha256 !== sha256) {
    issues.push({ rule: 'media-checksum-drift', message: `Media fallback ${assetKey} checksum does not match its file.` });
  }
  return inspected.width >= 480 && inspected.height >= 320 && inspected.byteLength >= 1024;
}

function mediaRouteSources(projectRoot, pack) {
  const sources = [];
  for (const screen of pack.screens || []) {
    if (!['primary', 'key-flow'].includes(screen.role)) continue;
    const filePath = path.join(projectRoot, normalizePath(screen.file));
    if (fs.existsSync(filePath)) sources.push({ file: normalizePath(screen.file), content: fs.readFileSync(filePath, 'utf8') });
  }
  const foundationRoot = path.join(projectRoot, 'src', 'components', 'experience');
  if (fs.existsSync(foundationRoot)) {
    for (const entry of fs.readdirSync(foundationRoot)) {
      if (!entry.endsWith('.tsx')) continue;
      const filePath = path.join(foundationRoot, entry);
      sources.push({ file: path.relative(projectRoot, filePath).replace(/\\/g, '/'), content: fs.readFileSync(filePath, 'utf8') });
    }
  }
  return sources;
}

function entityImageDefinitions(projectRoot) {
  const root = path.join(projectRoot, 'src', 'components');
  const definitions = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (/\.tsx?$/.test(entry.name)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (/(?:export\s+)?(?:function|const)\s+EntityImage\b/.test(content)) {
          definitions.push({
            file: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
            content,
          });
        }
      }
    }
  }
  visit(root);
  return definitions;
}

function validateRemoteAdapter(source, requireBundledFallback, issues) {
  const connectsUrlToPrimary = /httpsImageSource\s*\(\s*record\.imageUrl\s*\)/.test(source)
    && /imageSource\s*:\s*remoteSource\s*\|\|\s*fallbackSource/.test(source);
  if (!connectsUrlToPrimary) {
    issues.push({
      rule: 'remote-media-source-disconnected',
      message: 'Canonical media resolver must derive its rendered primary imageSource from record.imageUrl for remote media policies.',
    });
  }
  if (requireBundledFallback && (
    !/fallbackSource\s*=\s*EXPERIENCE_ASSET_SOURCES/.test(source)
    || !/fallbackSource\s*,/.test(source)
  )) {
    issues.push({
      rule: 'remote-media-fallback-disconnected',
      message: 'Canonical media resolver must expose the Metro-bundled asset as fallbackSource.',
    });
  }
}

function validateRemoteEntityImage(definition, requireBundledFallback, issues) {
  const { content, file } = definition;
  const usesExpoImage = /from\s+['"]expo-image['"]/.test(content);
  const usesDiskCache = /cachePolicy\s*=\s*['"](?:memory-disk|disk)['"]/.test(content);
  const rendersRemotePrimary = /source\s*=\s*\{\{\s*uri\s*:\s*imageUrl\s*\}\}/.test(content)
    || /source\s*=\s*\{\s*media\??\.imageSource\s*\}/.test(content);
  const rendersBundledFallback = /fallbackSource/.test(content)
    && /source\s*=\s*\{\s*(?:media\??\.fallbackSource|fallbackSource|bundledSource)\s*\}/.test(content);
  const switchesAfterFailure = /onError\s*=/.test(content)
    && /(?:remote|primary|image|load)Failed/i.test(content);

  if (!usesExpoImage || !usesDiskCache || !rendersRemotePrimary) {
    issues.push({
      rule: 'remote-media-runtime-unused',
      message: `${file} must render the canonical remote image source through expo-image with disk caching.`,
    });
  }
  if (requireBundledFallback && (!rendersBundledFallback || !switchesAfterFailure)) {
    issues.push({
      rule: 'remote-media-fallback-unused',
      message: `${file} must switch to fallbackSource after a remote error or offline cache miss.`,
    });
  }
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
  const mediaIntent = pack.experience?.mediaIntent;
  const expectsMedia = policy !== 'not-applicable' && (
    mediaIntent?.criticality === 'required'
    || (pack.experience?.contentModel || []).some((kind) => ['media', 'products'].includes(kind))
  );
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
    for (const required of ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey', 'imageSource', 'fallbackSource', 'resolveExperienceMedia']) {
      if (!source.includes(required)) issues.push({ rule: 'incomplete-experience-media-adapter', message: `Canonical view model is missing ${required}.` });
    }
    if (['remote-cdn-cached', 'remote-allowed'].includes(policy)) {
      validateRemoteAdapter(source, policy === 'remote-cdn-cached', issues);
    }
  }

  if (manifest) {
    if (manifest.assetPolicy !== policy || manifest.media?.policy !== policy) {
      issues.push({ rule: 'media-policy-manifest-drift', message: 'Media manifest policy does not match the screen build pack.' });
    }
    const records = manifest.media?.records || {};
    const assets = manifest.assets || {};
    const recordEntries = Object.entries(records);
    const approvedHosts = Array.isArray(manifest.media?.approvedHosts) ? manifest.media.approvedHosts : [];
    const requiresRemote = ['remote-cdn-cached', 'remote-allowed'].includes(policy);
    const requiresBundled = pack.fixtures?.adapter === 'local' || ['local-first', 'remote-cdn-cached'].includes(policy);
    if (pack.fixtures?.adapter === 'local' && recordEntries.length === 0) {
      issues.push({ rule: 'missing-fixture-media', message: 'A media-critical local prototype needs at least one resolved media record.' });
    }
    if (requiresRemote && !approvedHosts.length) {
      issues.push({ rule: 'missing-approved-cdn-hosts', message: 'Remote fixture media requires approved hosts in the media manifest.' });
    }
    const validatedAssets = new Map();
    let resolvedRecords = 0;
    for (const [recordKey, record] of recordEntries) {
      const hasIdentity = ['imageAltText', 'imageCacheKey', 'imageAssetKey']
        .every((field) => typeof record?.[field] === 'string' && record[field].trim());
      if (!hasIdentity || (requiresRemote && !(typeof record?.imageUrl === 'string' && record.imageUrl.trim()))) {
        issues.push({ rule: 'incomplete-media-record', message: `Media record ${recordKey} is missing alt text, cache identity, fallback identity, or its required URL.` });
        continue;
      }
      if (!record.imageAssetKey.startsWith('asset://experience/')) {
        issues.push({ rule: 'invalid-media-fallback-key', message: `Media record ${recordKey} needs an asset://experience fallback identity.` });
      }
      if (record.imageUrl && !approvedUrl(record, approvedHosts)) {
        issues.push({ rule: 'unapproved-cdn-media-url', message: `Media record ${recordKey} uses an invalid or unapproved CDN URL.` });
      }
      let bundledValid = false;
      if (requiresBundled) {
        if (validatedAssets.has(record.imageAssetKey)) bundledValid = validatedAssets.get(record.imageAssetKey);
        else {
          bundledValid = validateBundledAsset(root, record.imageAssetKey, assets[record.imageAssetKey], issues);
          validatedAssets.set(record.imageAssetKey, bundledValid);
        }
        const asset = assets[record.imageAssetKey];
        if (bundledValid && record.imageLocalPath !== asset.localPath) {
          issues.push({ rule: 'media-local-path-drift', message: `Media record ${recordKey} does not point to its materialized fallback.` });
          bundledValid = false;
        }
      }
      if ((!requiresRemote || approvedUrl(record, approvedHosts)) && (!requiresBundled || bundledValid)) resolvedRecords += 1;
    }
    const coverage = manifest.media?.coverage;
    if (!coverage || coverage.expectedRecords !== recordEntries.length || coverage.resolvedRecords !== resolvedRecords) {
      issues.push({ rule: 'media-coverage-drift', message: `Media coverage must resolve every expected record; resolved ${resolvedRecords} of ${recordEntries.length}.` });
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
  if (['remote-cdn-cached', 'remote-allowed'].includes(policy)) {
    const definitions = entityImageDefinitions(root);
    if (!definitions.length) {
      issues.push({
        rule: 'missing-entity-image-runtime',
        message: 'Remote media requires a canonical EntityImage implementation under src/components.',
      });
    } else {
      for (const definition of definitions) {
        validateRemoteEntityImage(definition, policy === 'remote-cdn-cached', issues);
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
