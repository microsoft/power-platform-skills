'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_OWNER = 'microsoft';
const DEFAULT_REPO = 'power-pages-samples';
const DEFAULT_REF = 'latest-release';
const DEFAULT_CATALOG_PATH = 'templates/manifest.json';

function getDefaultCacheRoot() {
  return path.join(os.tmpdir(), 'powerpages-templates');
}

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function buildRawUrl({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO, sha, filePath }) {
  if (!sha) throw new Error('sha is required');
  assertValidSha(sha);
  if (!filePath) throw new Error('filePath is required');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${encodePath(filePath)}`;
}

function buildCommitUrl({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO, ref = DEFAULT_REF }) {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
}

function buildLatestReleaseUrl({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO }) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

function cacheDirForSha(cacheRoot, sha) {
  assertValidSha(sha);
  return path.join(cacheRoot || getDefaultCacheRoot(), sha);
}

function artifactCachePath({ cacheRoot, sha, artifactPath }) {
  if (path.isAbsolute(artifactPath) || artifactPath.split(/[\\/]+/).includes('..')) {
    throw new Error(`Template artifact path must stay under the templates cache: ${artifactPath}`);
  }
  return path.join(cacheDirForSha(cacheRoot, sha), artifactPath);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha || '')) {
    throw new Error(`Expected an immutable 40-character commit sha, got: ${sha}`);
  }
}

function validateCatalogShape(catalog) {
  // Raw `templates/manifest.json` shape:
  //   { "$schema": "./schemas/templates-manifest.schema.json", "templates": [
  //     { "id": "311-portal", "displayName": "311 Portal",
  //       "description": "…", "kind": "spa", "framework": "react",
  //       "keywords": ["311", "citizen-services"],
  //       "audience": ["makers", "developers"],
  //       "previewImages": ["spa/311-portal/previews/home.png"],
  //       "solutionPath": "spa/311-portal/solution/311-portal-unmanaged.zip",
  //       "seedDataPath": "spa/311-portal/seed/data.json",
  //       "templateVersion": "1.0.0.1", "author": "Microsoft" }
  //   ] }
  // `audience` here is the *template's* target persona list (admins/developers/
  // makers/partners) and is an array per the upstream schema at
  // https://github.com/microsoft/power-pages-samples/blob/main/templates/schemas/templates-manifest.schema.json
  // Do not confuse it with create-site's internal/external site audience, which
  // comes from Phase 1 discovery and is what the telemetry event records.
  // Keep this structural, not semantic: the samples repo owns the full JSON
  // Schema, while create-site only needs enough validation to fail open before
  // previewing malformed entries or caching artifacts under a pinned SHA.
  if (!catalog || !Array.isArray(catalog.templates)) {
    return 'expected a templates array';
  }
  for (const [index, template] of catalog.templates.entries()) {
    if (!template || typeof template !== 'object') return `template at index ${index} is not an object`;
    const requiredStringFields = ['id', 'displayName', 'description', 'kind', 'framework', 'solutionPath', 'templateVersion', 'author'];
    const missing = requiredStringFields.filter((field) => !isNonEmptyString(template[field]));
    if (missing.length > 0) return `template ${template.id || index} missing string field(s): ${missing.join(', ')}`;
    if (!Array.isArray(template.audience) || template.audience.length === 0 || !template.audience.every(isNonEmptyString)) {
      return `template ${template.id} audience must be a non-empty array of strings`;
    }
    if (!Array.isArray(template.keywords)) return `template ${template.id} keywords must be an array`;
    if (!Array.isArray(template.previewImages) || template.previewImages.length === 0) {
      return `template ${template.id} previewImages must be a non-empty array`;
    }
  }
  return null;
}

function startHttpsGet({ url, headers, timeoutMs, deps, reject, onResponse }) {
  const httpsImpl = deps.https || https;
  const req = httpsImpl.get(url, {
    headers: {
      'User-Agent': 'power-pages-template-catalog',
      ...headers,
    },
    timeout: timeoutMs,
  }, onResponse);
  req.on('error', reject);
  req.on('timeout', () => {
    req.destroy(new Error(`GET ${url} timed out`));
  });
  return req;
}

function requestJson(url, deps = {}) {
  return new Promise((resolve, reject) => {
    startHttpsGet({
      url,
      headers: {
        Accept: 'application/vnd.github+json, application/json',
      },
      timeoutMs: deps.timeoutMs || 10000,
      deps,
      reject,
      onResponse: (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`GET ${url} failed with ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`GET ${url} returned invalid JSON: ${err.message}`));
          }
        });
      },
    });
  });
}

function downloadFile(url, outputPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  return new Promise((resolve, reject) => {
    fsImpl.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tmpPath = `${outputPath}.partial`;
    const file = fsImpl.createWriteStream(tmpPath);
    const cleanup = () => {
      try { fsImpl.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    };
    startHttpsGet({
      url,
      headers: {},
      timeoutMs: deps.timeoutMs || 30000,
      deps,
      reject: (err) => {
        file.destroy();
        cleanup();
        reject(err);
      },
      onResponse: (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          file.destroy();
          cleanup();
          reject(new Error(`GET ${url} failed with ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fsImpl.renameSync(tmpPath, outputPath);
            resolve(outputPath);
          });
        });
      },
    });
    file.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

function resolveRefToShaWithGit({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO, ref = DEFAULT_REF }, deps = {}) {
  const execFile = deps.execFileSync || execFileSync;
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;
  const output = execFile('git', ['ls-remote', remoteUrl, ref], { encoding: 'utf8', timeout: 15000 });
  // `git ls-remote <remote> <ref>` returns tab-delimited rows:
  //   49b0e74b386206c7682019110434f034fca2e129\trefs/heads/main
  // A release tag can return multiple rows for annotated tags; any leading
  // 40-character SHA is enough because raw.githubusercontent.com accepts the
  // object id for immutable content fetches.
  const match = String(output || '').match(/^([0-9a-f]{40})\s+/im);
  if (!match) {
    throw new Error(`git ls-remote did not resolve ${owner}/${repo}@${ref}`);
  }
  return match[1];
}

async function resolveRefToSha(options = {}, deps = {}) {
  const request = deps.requestJson || ((url) => requestJson(url, deps));
  let result;
  try {
    result = await request(buildCommitUrl(options));
  } catch (err) {
    try {
      return resolveRefToShaWithGit(options, deps);
    } catch (fallbackErr) {
      throw new Error(`${err.message}; git ls-remote fallback failed: ${fallbackErr.message}`);
    }
  }
  if (!result || typeof result.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(result.sha)) {
    throw new Error('GitHub commit response did not include a valid 40-character sha');
  }
  return result.sha;
}

async function resolveLatestRelease(options = {}, deps = {}) {
  const request = deps.requestJson || ((url) => requestJson(url, deps));
  // GitHub Releases API shape used here:
  //   { "tag_name": "templates-v1.0.0", "name": "Templates v1.0.0",
  //     "html_url": "https://github.com/.../releases/tag/templates-v1.0.0" }
  // `tag_name` is the only required field; name/url are carried through for
  // diagnostics but not required for fetching.
  let result;
  try {
    result = await request(buildLatestReleaseUrl(options));
  } catch (err) {
    // GitHub returns 404 for /releases/latest until the samples repo publishes
    // its first release, and unauthenticated callers can also get a 403 rate
    // limit on this API before the lower-cost commit/raw fetches:
    //   GET https://api.github.com/repos/<owner>/<repo>/releases/latest failed with 404
    //   GET https://api.github.com/repos/<owner>/<repo>/releases/latest failed with 403
    // Use main as a temporary catalog source so create-site can still discover
    // templates during the bootstrapping window. Other release lookup failures
    // still fail open through fetchCatalog so auth/rate-limit/outage issues are
    // not masked as a successful main fallback.
    if (/\breleases\/latest\b.*\b(?:403|404)\b/i.test(err.message || '')) {
      return { ref: 'main', sha: await resolveRefToSha({ ...options, ref: 'main' }, { ...deps, requestJson: request }) };
    }
    throw err;
  }
  if (!result || !isNonEmptyString(result.tag_name)) {
    throw new Error('GitHub latest release response did not include tag_name');
  }
  const sha = await resolveRefToSha({ ...options, ref: result.tag_name }, { ...deps, requestJson: request });
  return { ref: result.tag_name, sha, releaseName: result.name || '', releaseUrl: result.html_url || '' };
}

async function resolveCatalogRef(options = {}, deps = {}) {
  const ref = options.ref || DEFAULT_REF;
  if (ref === 'latest-release') {
    return resolveLatestRelease(options, deps);
  }
  return { ref, sha: await resolveRefToSha({ ...options, ref }, deps) };
}

async function fetchCatalog(options = {}, deps = {}) {
  const {
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    ref = DEFAULT_REF,
    catalogPath = DEFAULT_CATALOG_PATH,
    cacheRoot = getDefaultCacheRoot(),
  } = options;
  const fsImpl = deps.fs || fs;
  const request = deps.requestJson || ((url) => requestJson(url, deps));

  try {
    const resolved = await resolveCatalogRef({ owner, repo, ref }, { ...deps, requestJson: request });
    const { sha } = resolved;
    const cacheDir = cacheDirForSha(cacheRoot, sha);
    const catalog = await request(buildRawUrl({ owner, repo, sha, filePath: catalogPath }));
    const catalogError = validateCatalogShape(catalog);
    if (catalogError) throw new Error(`Template catalog is malformed: ${catalogError}`);
    fsImpl.mkdirSync(cacheDir, { recursive: true });
    const catalogLocalPath = artifactCachePath({ cacheRoot, sha, artifactPath: catalogPath });
    fsImpl.mkdirSync(path.dirname(catalogLocalPath), { recursive: true });
    fsImpl.writeFileSync(catalogLocalPath, JSON.stringify(catalog, null, 2), 'utf8');
    return {
      ok: true,
      owner,
      repo,
      ref,
      resolvedRef: resolved.ref,
      sha,
      releaseName: resolved.releaseName,
      releaseUrl: resolved.releaseUrl,
      catalogPath,
      catalogLocalPath,
      cacheDir,
      catalog,
    };
  } catch (err) {
    return { ok: false, owner, repo, ref, catalogPath, error: err.message };
  }
}

function validateZipContainsSolution(zipPath, deps = {}) {
  const execFile = deps.execFileSync || execFileSync;
  try {
    const output = execFile('unzip', ['-l', zipPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    // `unzip -l` prints one file per line, for example:
    //   Length      Date    Time    Name
    //   ---------  ---------- -----   ----
    //        123  2026-07-12 12:00   solution.xml
    // Dataverse solution zips must contain a root `solution.xml`; matching a
    // whitespace-delimited token avoids false positives like `solution.xml.bak`.
    return /(^|\s)solution\.xml(\s|$)/i.test(output);
  } catch {
    return false;
  }
}

async function downloadArtifact(options = {}, deps = {}) {
  const {
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    sha,
    artifactPath,
    cacheRoot = getDefaultCacheRoot(),
  } = options;
  if (!sha) throw new Error('sha is required');
  if (!artifactPath) throw new Error('artifactPath is required');
  const fsImpl = deps.fs || fs;
  const localPath = artifactCachePath({ cacheRoot, sha, artifactPath });
  if (fsImpl.existsSync(localPath)) return { localPath, cached: true };
  const download = deps.downloadFile || ((url, dest) => downloadFile(url, dest, deps));
  await download(buildRawUrl({ owner, repo, sha, filePath: artifactPath }), localPath);
  return { localPath, cached: false };
}

async function downloadSolutionArtifact(options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  try {
    const result = await downloadArtifact(options, deps);
    const validate = deps.validateZipContainsSolution || ((zipPath) => validateZipContainsSolution(zipPath, deps));
    if (!validate(result.localPath)) {
      try { fsImpl.rmSync(result.localPath, { force: true }); } catch { /* best-effort */ }
      return {
        ok: false,
        artifactPath: options.artifactPath,
        error: `Downloaded template solution is not a valid Dataverse solution zip: ${options.artifactPath}`,
      };
    }

    return { ok: true, ...result };
  } catch (err) {
    if (options.artifactPath && options.sha) {
      try { fsImpl.rmSync(artifactCachePath(options), { force: true }); } catch { /* best-effort */ }
    }
    return { ok: false, artifactPath: options.artifactPath, error: err.message };
  }
}

async function downloadSeedDataDirectory(options = {}, deps = {}) {
  const {
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    sha,
    seedDataPath,
    cacheRoot = getDefaultCacheRoot(),
  } = options;
  if (!sha) throw new Error('sha is required');
  assertValidSha(sha);
  if (!seedDataPath) return { ok: true, localDir: null, files: [] };
  if (path.isAbsolute(seedDataPath) || seedDataPath.split(/[\\/]+/).includes('..')) {
    return { ok: false, seedDataPath, error: `Seed data path must stay under templates: ${seedDataPath}` };
  }
  const request = deps.requestJson || ((url) => requestJson(url, deps));
  try {
    const tree = await request(`https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const prefix = seedDataPath.replace(/\/+$/, '') + '/';
    // Seed data can include JSON record files plus binary attachment files
    // referenced by `__files`. Download every blob under seed-data so
    // apply-seed-data can resolve seed-data-root-relative attachment paths.
    const files = (tree.tree || [])
      .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
      .map((entry) => entry.path)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const downloaded = [];
    for (const artifactPath of files) {
      downloaded.push((await downloadArtifact({ owner, repo, sha, artifactPath, cacheRoot }, deps)).localPath);
    }
    return { ok: true, localDir: artifactCachePath({ cacheRoot, sha, artifactPath: seedDataPath }), files: downloaded };
  } catch (err) {
    return { ok: false, seedDataPath, error: err.message };
  }
}

module.exports = {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  DEFAULT_REF,
  DEFAULT_CATALOG_PATH,
  getDefaultCacheRoot,
  buildRawUrl,
  buildCommitUrl,
  buildLatestReleaseUrl,
  cacheDirForSha,
  artifactCachePath,
  requestJson,
  downloadFile,
  resolveRefToSha,
  resolveLatestRelease,
  resolveCatalogRef,
  fetchCatalog,
  validateZipContainsSolution,
  downloadArtifact,
  downloadSolutionArtifact,
  downloadSeedDataDirectory,
  validateCatalogShape,
  assertValidSha,
};
