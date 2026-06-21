#!/usr/bin/env node

// Fetches the content of a single file from an Azure DevOps Git repository at a
// specific branch, tag, or commit SHA. This is the THEIRS/BASE reader for the
// selective-merge conflict flow: Dataverse Git serializes each Power Pages
// component's source field into its own file (e.g. a web template lands at
// `<root>/<solution>/powerpagesites/<site>/web-templates/<Name>/<Name>.webtemplate.source.html`),
// so the incoming (branch tip) and common-ancestor (synced commit) versions of
// that field are plain files we can read here and feed straight into a 3-way merge.
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get
//
//   GET {org}/{project}/_apis/git/repositories/{repo}/items
//       ?path=<path>
//       &includeContent=true
//       &versionDescriptor.version=<branch|tag|sha>
//       &versionDescriptor.versionType=<branch|tag|commit>
//       &$format=json
//       &api-version=7.0
//
// Response (JSON): { objectId, gitObjectType, commitId, path, content, ... }
// `content` is present only when includeContent=true and the item is a blob.
//
// Output (JSON to stdout):
//   Found:      { found: true, path, content, contentLength, objectId, version, versionType }
//   Not found:  { found: false, statusCode: 404, path, version, versionType }
//               (404 is returned, NOT thrown — an absent file is a normal merge
//                input: it means the component did not exist at that ref, i.e. an
//                add/add conflict with an empty BASE. See selective-merge-reference.md.)
//   Other:      { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-get-file.js
//       --organization <org>
//       --project      <project>
//       --repository   <repo>
//       --path         <repo-relative path, e.g. /solutions/RetailOS/.../X.webtemplate.source.html>
//       --version      <branch name | tag | commit SHA>
//       [--versionType branch|tag|commit]   // default: branch
//       [--no-content]                      // omit file content (existence/metadata probe only)
//       [--pat <PAT>] | [--token <bearer>] | [--tokenFile <path>]
//       [--apiVersion <ver>]                // default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const VALID_VERSION_TYPES = new Set(['branch', 'tag', 'commit']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    path: null, version: null, versionType: 'branch',
    includeContent: true,
    pat: null, token: null, tokenFile: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--path' && args[i + 1]) out.path = args[++i];
    else if (args[i] === '--version' && args[i + 1]) out.version = args[++i];
    else if (args[i] === '--versionType' && args[i + 1]) out.versionType = args[++i];
    else if (args[i] === '--no-content') out.includeContent = false;
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

/**
 * Fetch a file's content from ADO at a given ref.
 *
 * @param {object} opts
 * @param {string} opts.organization
 * @param {string} opts.project
 * @param {string} opts.repository
 * @param {string} opts.path           Repo-relative path (leading slash optional).
 * @param {string} opts.version        Branch name, tag, or commit SHA.
 * @param {string} [opts.versionType]  'branch' | 'tag' | 'commit'. Default 'branch'.
 * @param {boolean} [opts.includeContent] Default true.
 * @param {string} [opts.pat]
 * @param {string} [opts.token]
 * @param {string} [opts.tokenFile]
 * @param {string} [opts.apiVersion]   Default '7.0'.
 * @param {string} [opts.baseUrl]      Test seam.
 * @returns {Promise<object>}
 */
async function getFile({
  organization, project, repository, path, version,
  versionType = 'branch', includeContent = true,
  pat = null, token = null, tokenFile = null,
  apiVersion = '7.0', baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!path) throw new Error('--path is required');
  if (!version) throw new Error('--version is required');
  if (!VALID_VERSION_TYPES.has(versionType)) {
    throw new Error(`--versionType must be one of ${[...VALID_VERSION_TYPES].join(', ')}; got: ${versionType}`);
  }

  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }

  // ADO wants the path with a leading slash.
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });
  const res = await client.get('/items', {
    query: {
      path: normalizedPath,
      includeContent: includeContent ? 'true' : 'false',
      'versionDescriptor.version': version,
      'versionDescriptor.versionType': versionType,
      '$format': 'json',
    },
  });

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) {
    return { found: false, statusCode: 404, path: normalizedPath, version, versionType };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.message || msg;
      code = parsed.typeKey || parsed.errorCode || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'ado-get-file returned 2xx but body was not JSON: ' + e.message };
  }

  const content = typeof parsed.content === 'string' ? parsed.content : null;
  return {
    found: true,
    path: normalizedPath,
    content,
    contentLength: content ? content.length : 0,
    objectId: parsed.objectId || null,
    commitId: parsed.commitId || null,
    version,
    versionType,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getFile(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-get-file: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { getFile, VALID_VERSION_TYPES };
