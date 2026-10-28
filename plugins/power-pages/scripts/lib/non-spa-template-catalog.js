'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CATALOG_PATH,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  assertValidSha,
  buildRawUrl,
  downloadArtifact,
  fetchCatalog,
  isCreateWebsiteApiTemplate,
} = require('./template-catalog');

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const REPOSITORY_COORDINATE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

function validateRepositoryCoordinate(value, fieldName) {
  if (!REPOSITORY_COORDINATE_PATTERN.test(String(value || ''))) {
    throw new Error(`${fieldName} must be a valid GitHub owner or repository name`);
  }
  return value;
}

function normalizeNonSpaTemplate(template, catalogResult) {
  return {
    id: template.id,
    name: template.provisioning.templateName,
    displayName: template.displayName,
    description: template.description,
    capabilities: template.capabilities || [],
    requirements: template.requirements || [],
    warning: template.warning || '',
    previews: (template.responsivePreviews || []).map((preview) => ({
      name: preview.id,
      displayName: preview.displayName,
      desktop: buildRawUrl({
        owner: catalogResult.owner,
        repo: catalogResult.repo,
        sha: catalogResult.sha,
        filePath: preview.desktop,
      }),
      mobile: buildRawUrl({
        owner: catalogResult.owner,
        repo: catalogResult.repo,
        sha: catalogResult.sha,
        filePath: preview.mobile,
      }),
    })),
  };
}

function detectPreviewMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function readPreviewDataUrl(localPath, artifactPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const stat = fsImpl.lstatSync(localPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Template preview must be a regular file: ${artifactPath}`);
  }
  if (stat.size <= 0 || stat.size > MAX_PREVIEW_BYTES) {
    throw new Error(
      `Template preview must be between 1 and ${MAX_PREVIEW_BYTES} bytes: ${artifactPath}`,
    );
  }
  const bytes = fsImpl.readFileSync(localPath);
  const mimeType = detectPreviewMimeType(bytes);
  if (!mimeType) {
    throw new Error(`Template preview is not a supported PNG, JPEG, or WebP image: ${artifactPath}`);
  }
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function downloadPreviewDataUrl({
  owner,
  repo,
  sha,
  artifactPath,
  cacheRoot,
}, deps = {}) {
  const download = deps.downloadArtifact || downloadArtifact;
  const result = await download(
    { owner, repo, sha, artifactPath, cacheRoot },
    { ...deps, maxBytes: MAX_PREVIEW_BYTES },
  );
  return readPreviewDataUrl(result.localPath, artifactPath, deps);
}

async function loadNonSpaTemplatePresentation(options = {}, deps = {}) {
  const owner = validateRepositoryCoordinate(options.owner || DEFAULT_OWNER, '--catalogOwner');
  const repo = validateRepositoryCoordinate(options.repo || DEFAULT_REPO, '--catalogRepo');
  const sha = options.sha;
  assertValidSha(sha);
  if (!String(options.templateName || '').trim()) {
    throw new Error('--templateName is required');
  }

  const loadCatalog = deps.fetchCatalog || fetchCatalog;
  const catalogResult = await loadCatalog({
    owner,
    repo,
    ref: sha,
    catalogPath: options.catalogPath || DEFAULT_CATALOG_PATH,
    cacheRoot: options.cacheRoot,
  });
  if (!catalogResult?.ok) {
    throw new Error(`Non-SPA template catalog unavailable: ${catalogResult?.error || 'unknown error'}`);
  }
  if (catalogResult.sha !== sha) {
    throw new Error(`Non-SPA template catalog resolved ${catalogResult.sha} instead of requested ${sha}`);
  }

  const template = catalogResult.catalog.templates.find(
    (candidate) =>
      isCreateWebsiteApiTemplate(candidate) &&
      candidate.provisioning.templateName === options.templateName,
  );
  if (!template) {
    throw new Error(
      `Template ${options.templateName} was not found in ${owner}/${repo}@${sha}`,
    );
  }

  const previews = await Promise.all((template.responsivePreviews || []).map(async (preview) => ({
    name: preview.id,
    displayName: preview.displayName,
    desktop: await downloadPreviewDataUrl({
      owner,
      repo,
      sha,
      artifactPath: preview.desktop,
      cacheRoot: options.cacheRoot,
    }, deps),
    mobile: await downloadPreviewDataUrl({
      owner,
      repo,
      sha,
      artifactPath: preview.mobile,
      cacheRoot: options.cacheRoot,
    }, deps),
  })));

  return {
    name: template.provisioning.templateName,
    displayName: template.displayName,
    description: template.description,
    capabilities: template.capabilities || [],
    requirements: template.requirements || [],
    warning: template.warning || '',
    previews,
    catalog: {
      owner,
      repo,
      sha,
    },
  };
}

module.exports = {
  MAX_PREVIEW_BYTES,
  detectPreviewMimeType,
  loadNonSpaTemplatePresentation,
  normalizeNonSpaTemplate,
  readPreviewDataUrl,
  validateRepositoryCoordinate,
};
