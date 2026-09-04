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
const FRAMEWORKS = new Set(['react', 'vue', 'angular', 'astro', 'none', 'other']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function buildGitRemoteUrl({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO }) {
  return `https://github.com/${owner}/${repo}.git`;
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

function isNestedFamilyTemplate(template) {
  return template && typeof template.variants === 'object' && template.variants && !Array.isArray(template.variants);
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
  //       "requiredDataverseLanguages": [1033],
  //       "previewImages": ["spa/311-portal/previews/home.png"],
  //       "solutionPath": "spa/311-portal/solution",
  //       "spaCodePath": "spa/311-portal/spa-code",
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
    const requiredStringFields = isNestedFamilyTemplate(template)
      ? ['id', 'displayName', 'description', 'kind', 'author']
      : ['id', 'displayName', 'description', 'kind', 'framework', 'solutionPath', 'spaCodePath', 'templateVersion', 'author'];
    const missing = requiredStringFields.filter((field) => !isNonEmptyString(template[field]));
    if (missing.length > 0) return `template ${template.id || index} missing string field(s): ${missing.join(', ')}`;
    if (!isNestedFamilyTemplate(template)) {
      try {
        templateVariantRoot(template.solutionPath, template.spaCodePath);
      } catch (err) {
        return `template ${template.id || index} has invalid variant paths: ${err.message}`;
      }
    }
    if (!ID_PATTERN.test(template.id)) return `template ${template.id} id must be kebab-case`;
    if (!Array.isArray(template.audience) || template.audience.length === 0 || !template.audience.every(isNonEmptyString)) {
      return `template ${template.id} audience must be a non-empty array of strings`;
    }
    if (
      !Array.isArray(template.requiredDataverseLanguages) ||
      template.requiredDataverseLanguages.length === 0 ||
      !template.requiredDataverseLanguages.every((id) => Number.isInteger(id) && id > 0)
    ) {
      return `template ${template.id} requiredDataverseLanguages must be a non-empty array of positive integers`;
    }
    if (!Array.isArray(template.keywords)) return `template ${template.id} keywords must be an array`;
    if (!Array.isArray(template.previewImages)) {
      return `template ${template.id} previewImages must be an array`;
    }
    if (isNestedFamilyTemplate(template)) {
      const seenFrameworks = new Set();
      const variantEntries = Object.entries(template.variants);
      if (variantEntries.length === 0) return `template ${template.id} variants must contain at least one framework`;
      for (const [framework, variant] of variantEntries) {
        const normalizedFramework = framework.toLowerCase();
        if (seenFrameworks.has(normalizedFramework)) return `template ${template.id} has duplicate framework variant: ${framework}`;
        seenFrameworks.add(normalizedFramework);
        if (!FRAMEWORKS.has(normalizedFramework)) return `template ${template.id} variant ${framework} has unsupported framework`;
        if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return `template ${template.id} variant ${framework} is not an object`;
        const variantMissing = ['templateVersion', 'solutionPath', 'spaCodePath'].filter((field) => !isNonEmptyString(variant[field]));
        if (variantMissing.length > 0) return `template ${template.id} variant ${framework} missing string field(s): ${variantMissing.join(', ')}`;
        try {
          templateVariantRoot(variant.solutionPath, variant.spaCodePath);
        } catch (err) {
          return `template ${template.id} variant ${framework} has invalid paths: ${err.message}`;
        }
        if (variant.previewImages !== undefined && !Array.isArray(variant.previewImages)) {
          return `template ${template.id} variant ${framework} previewImages must be an array`;
        }
        if (
          variant.requiredDataverseLanguages !== undefined &&
          (
            !Array.isArray(variant.requiredDataverseLanguages) ||
            variant.requiredDataverseLanguages.length === 0 ||
            !variant.requiredDataverseLanguages.every((id) => Number.isInteger(id) && id > 0)
          )
        ) {
          return `template ${template.id} variant ${framework} requiredDataverseLanguages must be a non-empty array of positive integers`;
        }
      }
    }
  }
  return null;
}

function catalogBasePath(catalogPath) {
  const dir = path.posix.dirname(catalogPath || '');
  return dir === '.' ? '' : dir.replace(/\/+$/, '');
}

function resolveCatalogArtifactPath(catalogPath, artifactPath) {
  if (!isNonEmptyString(artifactPath)) return artifactPath;
  const base = catalogBasePath(catalogPath);
  if (!base || artifactPath === base || artifactPath.startsWith(`${base}/`)) {
    return artifactPath;
  }
  return `${base}/${artifactPath.replace(/^\/+/, '')}`;
}

function materializeCatalogArtifactPaths(catalog, catalogPath) {
  return {
    ...catalog,
    templates: catalog.templates.map((template) => {
      // Manifest artifact paths are authored relative to the manifest folder.
      // For the default `templates/manifest.json`, a raw entry like:
      //   "previewImages": ["spa/311-portal/previews/home.png"]
      // must download from:
      //   templates/spa/311-portal/previews/home.png
      // Do this once after validation so the rest of create-site can treat every
      // artifact path as repository-root-relative.
      const materialized = {
        ...template,
        previewImages: template.previewImages.map((imagePath) => resolveCatalogArtifactPath(catalogPath, imagePath)),
      };
      if (template.solutionPath) {
        materialized.solutionPath = resolveCatalogArtifactPath(catalogPath, template.solutionPath);
      }
      if (template.spaCodePath) {
        materialized.spaCodePath = resolveCatalogArtifactPath(catalogPath, template.spaCodePath);
      }
      if (template.seedDataPath) {
        materialized.seedDataPath = resolveCatalogArtifactPath(catalogPath, template.seedDataPath);
      }
      if (isNestedFamilyTemplate(template)) {
        materialized.variants = Object.fromEntries(Object.entries(template.variants).map(([framework, variant]) => {
          const materializedVariant = {
            ...variant,
            solutionPath: resolveCatalogArtifactPath(catalogPath, variant.solutionPath),
            spaCodePath: resolveCatalogArtifactPath(catalogPath, variant.spaCodePath),
          };
          if (Array.isArray(variant.previewImages)) {
            materializedVariant.previewImages = variant.previewImages.map((imagePath) => resolveCatalogArtifactPath(catalogPath, imagePath));
          }
          if (variant.seedDataPath) {
            materializedVariant.seedDataPath = resolveCatalogArtifactPath(catalogPath, variant.seedDataPath);
          }
          return [framework.toLowerCase(), materializedVariant];
        }));
      }
      return materialized;
    }),
  };
}

function normalizeCatalogFamilies(catalog = {}) {
  const templates = Array.isArray(catalog.templates) ? catalog.templates : [];
  return templates.map((template) => {
    if (!isNestedFamilyTemplate(template)) {
      return {
        id: template.id,
        displayName: template.displayName,
        description: template.description,
        kind: template.kind,
        keywords: template.keywords || [],
        audience: template.audience || [],
        requiredDataverseLanguages: template.requiredDataverseLanguages || [],
        previewImages: template.previewImages || [],
        ...(template.seedDataPath ? { seedDataPath: template.seedDataPath } : {}),
        author: template.author,
        variants: [{
          familyId: template.id,
          variantKey: template.framework,
          variantId: `${template.id}/${template.framework}`,
          displayName: template.displayName,
          description: template.description,
          kind: template.kind,
          framework: template.framework,
          keywords: template.keywords || [],
          audience: template.audience || [],
          requiredDataverseLanguages: template.requiredDataverseLanguages || [],
          previewImages: template.previewImages || [],
          ...(template.seedDataPath ? { seedDataPath: template.seedDataPath } : {}),
          templateVersion: template.templateVersion,
          solutionPath: template.solutionPath,
          spaCodePath: template.spaCodePath,
          author: template.author,
        }],
      };
    }
    return {
      id: template.id,
      displayName: template.displayName,
      description: template.description,
      kind: template.kind,
      keywords: template.keywords || [],
      audience: template.audience || [],
      requiredDataverseLanguages: template.requiredDataverseLanguages || [],
      previewImages: template.previewImages || [],
      ...(template.seedDataPath ? { seedDataPath: template.seedDataPath } : {}),
      author: template.author,
      variants: Object.entries(template.variants).map(([framework, variant]) => {
        const variantKey = framework.toLowerCase();
        return {
          familyId: template.id,
          variantKey,
          variantId: `${template.id}/${variantKey}`,
          displayName: template.displayName,
          description: template.description,
          kind: template.kind,
          framework: variantKey,
          keywords: template.keywords || [],
          audience: template.audience || [],
          requiredDataverseLanguages: variant.requiredDataverseLanguages || template.requiredDataverseLanguages || [],
          previewImages: Array.isArray(variant.previewImages) ? variant.previewImages : (template.previewImages || []),
          ...(variant.seedDataPath || template.seedDataPath ? { seedDataPath: variant.seedDataPath || template.seedDataPath } : {}),
          templateVersion: variant.templateVersion,
          solutionPath: variant.solutionPath,
          spaCodePath: variant.spaCodePath,
          author: template.author,
        };
      }),
    };
  });
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

function runGitLsRemote(args, deps = {}) {
  const execFile = deps.execFileSync || execFileSync;
  return execFile('git', ['ls-remote', ...args], { encoding: 'utf8', timeout: 15000 });
}

function resolveRefToSha({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO, ref = DEFAULT_REF }, deps = {}) {
  const remoteUrl = buildGitRemoteUrl({ owner, repo });
  const output = runGitLsRemote([remoteUrl, ref], deps);
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

function versionKey(tagName) {
  const match = String(tagName || '').match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part || 0));
}

function compareVersionKeys(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseRemoteTags(output) {
  const byTag = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/i);
    if (!match) continue;
    const [, sha, tagName, peeled] = match;
    const existing = byTag.get(tagName) || {};
    byTag.set(tagName, peeled ? { ...existing, peeledSha: sha } : { ...existing, sha });
  }
  return [...byTag.entries()]
    .map(([tagName, value]) => ({ tagName, sha: value.peeledSha || value.sha, version: versionKey(tagName) }))
    .filter((entry) => entry.sha && entry.version);
}

function resolveLatestRelease(options = {}, deps = {}) {
  const remoteUrl = buildGitRemoteUrl(options);
  const tags = parseRemoteTags(runGitLsRemote(['--tags', remoteUrl], deps));
  if (tags.length === 0) {
    return { ref: 'main', sha: resolveRefToSha({ ...options, ref: 'main' }, deps) };
  }
  tags.sort((a, b) => compareVersionKeys(b.version, a.version) || a.tagName.localeCompare(b.tagName));
  const latest = tags[0];
  return { ref: latest.tagName, sha: latest.sha, releaseName: latest.tagName, releaseUrl: `https://github.com/${options.owner || DEFAULT_OWNER}/${options.repo || DEFAULT_REPO}/releases/tag/${encodeURIComponent(latest.tagName)}` };
}

function resolveCatalogRef(options = {}, deps = {}) {
  const ref = options.ref || DEFAULT_REF;
  if (ref === 'latest-release') {
    return resolveLatestRelease(options, deps);
  }
  return { ref, sha: resolveRefToSha({ ...options, ref }, deps) };
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
    const resolved = resolveCatalogRef({ owner, repo, ref }, deps);
    const { sha } = resolved;
    const cacheDir = cacheDirForSha(cacheRoot, sha);
    const rawCatalog = await request(buildRawUrl({ owner, repo, sha, filePath: catalogPath }));
    const catalogError = validateCatalogShape(rawCatalog);
    if (catalogError) throw new Error(`Template catalog is malformed: ${catalogError}`);
    const catalog = materializeCatalogArtifactPaths(rawCatalog, catalogPath);
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
  try {
    const fsImpl = deps.fs || fs;
    return zipFileNames(fsImpl.readFileSync(zipPath)).some((name) => name.toLowerCase() === 'solution.xml');
  } catch {
    return false;
  }
}

function zipFileNames(buffer) {
  // ZIP stores each filename in local file headers:
  //   50 4b 03 04 ... [fileNameLength at +26] [extraLength at +28] [name at +30]
  // and again in central directory headers:
  //   50 4b 01 02 ... [fileNameLength at +28] [extraLength at +30] [commentLength at +32] [name at +46]
  // Read both forms so this remains independent of the host OS having `unzip`
  // installed. That matters in plugin hosts and CI images where external tools
  // are not guaranteed.
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const names = [];
  for (let i = 0; i <= data.length - 4; i++) {
    const signature = data.readUInt32LE(i);
    if (signature === 0x04034b50 && i + 30 <= data.length) {
      const fileNameLength = data.readUInt16LE(i + 26);
      const extraLength = data.readUInt16LE(i + 28);
      const nameStart = i + 30;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd <= data.length) names.push(data.subarray(nameStart, nameEnd).toString('utf8'));
      i = Math.max(i, nameEnd + extraLength - 1);
    } else if (signature === 0x02014b50 && i + 46 <= data.length) {
      const fileNameLength = data.readUInt16LE(i + 28);
      const extraLength = data.readUInt16LE(i + 30);
      const commentLength = data.readUInt16LE(i + 32);
      const nameStart = i + 46;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd <= data.length) names.push(data.subarray(nameStart, nameEnd).toString('utf8'));
      i = Math.max(i, nameEnd + extraLength + commentLength - 1);
    }
  }
  return names;
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

function validateSpaCodePath(spaCodePath) {
  if (!isNonEmptyString(spaCodePath)) return 'spaCodePath is required';
  if (path.isAbsolute(spaCodePath) || spaCodePath.includes('\\')) {
    return 'SPA code path must be a repository-relative POSIX directory';
  }
  const segments = spaCodePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')) {
    return 'SPA code path must stay inside the template repository';
  }
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    return 'SPA code path contains unsupported characters';
  }
  return null;
}

function validateSpaCodeDirectory(localPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const requiredFiles = ['powerpages.config.json', 'package.json'];
  for (const requiredFile of requiredFiles) {
    const requiredPath = path.join(localPath, requiredFile);
    if (!fsImpl.existsSync(requiredPath) || !fsImpl.statSync(requiredPath).isFile()) {
      return `SPA code directory is missing ${requiredFile}`;
    }
  }
  const metadataPath = path.join(localPath, '.powerpages-site');
  if (!fsImpl.existsSync(metadataPath) || !fsImpl.statSync(metadataPath).isDirectory()) {
    return 'SPA code directory is missing .powerpages-site';
  }

  const queue = [localPath];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        return `SPA code directory contains a symbolic link: ${path.relative(localPath, path.join(current, entry.name))}`;
      }
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store' || entry.name.endsWith('.tsbuildinfo')) {
        return `SPA code directory contains generated or local-only content: ${path.relative(localPath, path.join(current, entry.name))}`;
      }
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

function validateUnpackedSolutionDirectory(localPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  if (!fsImpl.existsSync(localPath)) {
    return 'Template solution source is not a directory';
  }
  const rootStat = fsImpl.lstatSync(localPath);
  if (rootStat.isSymbolicLink()) {
    return 'Template solution source must not be a symbolic link';
  }
  if (!rootStat.isDirectory()) return 'Template solution source is not a directory';

  // `pac solution unpack` uses the SolutionPackager source layout and places
  // solution metadata under `Other/`.
  // See: https://learn.microsoft.com/power-platform/developer/cli/reference/solution#pac-solution-unpack
  const solutionXmlPath = path.join(localPath, 'Other', 'Solution.xml');
  const customizationsXmlPath = path.join(localPath, 'Other', 'Customizations.xml');
  const queue = [localPath];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relativePath = path.relative(localPath, entryPath);
      if (entry.isSymbolicLink()) {
        return `Template solution source contains a symbolic link: ${relativePath}`;
      }
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.DS_Store' ||
        entry.name.endsWith('.tsbuildinfo')
      ) {
        return `Template solution source contains generated or local-only content: ${relativePath}`;
      }
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.zip') {
        return `Template solution source must not contain committed zip files: ${relativePath}`;
      }
      if (entry.isDirectory()) queue.push(entryPath);
    }
  }

  for (const requiredPath of [solutionXmlPath, customizationsXmlPath]) {
    if (!fsImpl.existsSync(requiredPath) || !fsImpl.lstatSync(requiredPath).isFile()) {
      return `Template solution source is missing ${path.relative(localPath, requiredPath)}`;
    }
  }

  const solutionXml = fsImpl.readFileSync(solutionXmlPath, 'utf8');
  if (!/<Managed>\s*0\s*<\/Managed>/i.test(solutionXml)) {
    return 'Template solution source must describe an unmanaged solution';
  }
  const customizationsXml = fsImpl.readFileSync(customizationsXmlPath, 'utf8');
  if (/<powerpagecomponents(?:\s|>)/i.test(customizationsXml)) {
    return 'Template supporting solution must not contain Power Pages website components';
  }
  return null;
}

function repositoryDirectoryCheckoutRoot({ cacheRoot = getDefaultCacheRoot(), sha, directoryPath }) {
  assertValidSha(sha);
  const pathError = validateSpaCodePath(directoryPath);
  if (pathError) throw new Error(pathError);
  // Keep cached content under a reserved leaf so a cached parent path and one of
  // its descendants cannot overwrite each other.
  return path.join(
    cacheDirForSha(cacheRoot, sha),
    '.directory-checkouts',
    ...directoryPath.split('/'),
    '.checkout'
  );
}

function runGitCheckoutCommand(args, deps = {}) {
  const execFile = deps.execFileSync || execFileSync;
  return execFile('git', args, {
    encoding: 'utf8',
    timeout: deps.gitTimeoutMs || 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function downloadRepositoryDirectory(options = {}, validateDirectory, deps = {}) {
  const {
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    sha,
    directoryPath,
    cacheRoot = getDefaultCacheRoot(),
  } = options;
  const fsImpl = deps.fs || fs;
  assertValidSha(sha);
  const pathError = validateSpaCodePath(directoryPath);
  if (pathError) throw new Error(pathError);
  const checkoutRoot = repositoryDirectoryCheckoutRoot({ cacheRoot, sha, directoryPath });
  const localPath = checkoutRoot;
  if (fsImpl.existsSync(checkoutRoot)) {
    const cachedError = validateDirectory(localPath);
    if (!cachedError) return { localPath, cached: true };
    fsImpl.rmSync(checkoutRoot, { recursive: true, force: true });
  }

  fsImpl.mkdirSync(path.dirname(checkoutRoot), { recursive: true });
  const partialRoot = `${checkoutRoot}.partial-${process.pid}-${Date.now()}`;
  fsImpl.rmSync(partialRoot, { recursive: true, force: true });
  try {
    runGitCheckoutCommand(['init', '--quiet', partialRoot], deps);
    runGitCheckoutCommand(['-C', partialRoot, 'remote', 'add', 'origin', buildGitRemoteUrl({ owner, repo })], deps);
    runGitCheckoutCommand(['-C', partialRoot, 'sparse-checkout', 'set', '--cone', '--', directoryPath], deps);
    runGitCheckoutCommand(['-C', partialRoot, 'fetch', '--quiet', '--depth', '1', 'origin', sha], deps);
    runGitCheckoutCommand(['-C', partialRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], deps);
    const partialPath = path.join(partialRoot, ...directoryPath.split('/'));
    const validationError = validateDirectory(partialPath);
    if (validationError) throw new Error(validationError);
    fsImpl.renameSync(partialPath, checkoutRoot);
    fsImpl.rmSync(partialRoot, { recursive: true, force: true });
  } catch (err) {
    fsImpl.rmSync(partialRoot, { recursive: true, force: true });
    throw err;
  }
  return { localPath, cached: false };
}

function templateVariantRoot(solutionPath, spaCodePath) {
  const solutionPathError = validateSpaCodePath(solutionPath);
  if (solutionPathError) throw new Error(`Invalid solutionPath: ${solutionPathError}`);
  const spaCodePathError = validateSpaCodePath(spaCodePath);
  if (spaCodePathError) throw new Error(`Invalid spaCodePath: ${spaCodePathError}`);
  const solutionRoot = path.posix.dirname(solutionPath);
  const variantRoot = path.posix.dirname(spaCodePath);
  if (
    path.posix.basename(solutionPath) !== 'solution' ||
    path.posix.basename(spaCodePath) !== 'spa-code' ||
    solutionRoot !== variantRoot
  ) {
    throw new Error('solutionPath and spaCodePath must use sibling solution/ and spa-code/ folders');
  }
  return variantRoot;
}

function validateTemplateVariantDirectory(localVariantPath, solutionPath, spaCodePath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const variantRoot = templateVariantRoot(solutionPath, spaCodePath);
  const relativeSolutionPath = path.posix.relative(variantRoot, solutionPath);
  const relativeSpaCodePath = path.posix.relative(variantRoot, spaCodePath);
  const localSolutionPath = path.join(localVariantPath, ...relativeSolutionPath.split('/'));
  const localSpaCodePath = path.join(localVariantPath, ...relativeSpaCodePath.split('/'));
  const solutionError = validateUnpackedSolutionDirectory(localSolutionPath, { ...deps, fs: fsImpl });
  if (solutionError) return solutionError;
  return validateSpaCodeDirectory(localSpaCodePath, deps);
}

function downloadTemplateVariant(options = {}, deps = {}) {
  const { solutionPath, spaCodePath } = options;
  try {
    const variantRoot = templateVariantRoot(solutionPath, spaCodePath);
    const result = downloadRepositoryDirectory(
      { ...options, directoryPath: variantRoot },
      (localPath) => validateTemplateVariantDirectory(localPath, solutionPath, spaCodePath, deps),
      deps
    );
    const relativeSolutionPath = path.posix.relative(variantRoot, solutionPath);
    const relativeSpaCodePath = path.posix.relative(variantRoot, spaCodePath);
    return {
      ok: true,
      variantPath: result.localPath,
      solutionPath: path.join(result.localPath, ...relativeSolutionPath.split('/')),
      spaCodePath: path.join(result.localPath, ...relativeSpaCodePath.split('/')),
      cached: result.cached,
    };
  } catch (err) {
    return { ok: false, solutionPath, spaCodePath, error: err.message };
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
  const fsImpl = deps.fs || fs;
  try {
    if (path.posix.extname(seedDataPath).toLowerCase() === '.json') {
      const seedFile = (await downloadArtifact({ owner, repo, sha, artifactPath: seedDataPath, cacheRoot }, deps)).localPath;
      const seedRoot = path.posix.dirname(seedDataPath);
      const parsed = JSON.parse(fsImpl.readFileSync(seedFile, 'utf8'));
      const attachmentPaths = collectSeedAttachmentPaths(parsed)
        .map((relativePath) => {
          if (path.posix.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
            throw new Error(`Seed attachment path must stay under seed-data root: ${relativePath}`);
          }
          return `${seedRoot}/${relativePath.replace(/^\/+/, '')}`;
        })
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const downloaded = [seedFile];
      for (const artifactPath of attachmentPaths) {
        downloaded.push((await downloadArtifact({ owner, repo, sha, artifactPath, cacheRoot }, deps)).localPath);
      }
      return { ok: true, localDir: path.dirname(seedFile), files: downloaded };
    }
    return { ok: false, seedDataPath, error: `Seed data path must point to a JSON file: ${seedDataPath}` };
  } catch (err) {
    return { ok: false, seedDataPath, error: err.message };
  }
}

function collectSeedAttachmentPaths(seedData) {
  const paths = new Set();
  for (const fileExport of Array.isArray(seedData.fileExports) ? seedData.fileExports : []) {
    if (fileExport && typeof fileExport.path === 'string' && fileExport.path.trim()) paths.add(fileExport.path);
  }
  for (const record of Array.isArray(seedData.records) ? seedData.records : []) {
    if (!record || typeof record !== 'object' || !record.__files || typeof record.__files !== 'object' || Array.isArray(record.__files)) {
      continue;
    }
    for (const value of Object.values(record.__files)) {
      if (typeof value === 'string' && value.trim()) paths.add(value);
    }
  }
  return [...paths];
}

module.exports = {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  DEFAULT_REF,
  DEFAULT_CATALOG_PATH,
  getDefaultCacheRoot,
  buildRawUrl,
  buildGitRemoteUrl,
  cacheDirForSha,
  artifactCachePath,
  requestJson,
  downloadFile,
  resolveRefToSha,
  resolveLatestRelease,
  parseRemoteTags,
  resolveCatalogRef,
  fetchCatalog,
  validateZipContainsSolution,
  downloadArtifact,
  downloadTemplateVariant,
  downloadSeedDataDirectory,
  validateSpaCodePath,
  validateSpaCodeDirectory,
  validateUnpackedSolutionDirectory,
  repositoryDirectoryCheckoutRoot,
  templateVariantRoot,
  validateTemplateVariantDirectory,
  validateCatalogShape,
  normalizeCatalogFamilies,
  zipFileNames,
  assertValidSha,
};
