#!/usr/bin/env node

// Creates an annotated git tag in Azure DevOps. Used by commit-to-git Phase 9
// to offer a "tag this release" choice after a successful commit lands on the
// repo's default branch (typically a release-cut commit).
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/annotated-tags/create
//
//   POST {org}/{project}/_apis/git/repositories/{repo}/annotatedtags?api-version=7.0
//   Body: {
//     "name":         "v1.2.3",
//     "taggedObject": { "objectId": "<commit sha>" },
//     "message":      "Release v1.2.3"
//   }
//
// Response (201 Created): { name, objectId: "<tag sha>", taggedObject: {...}, message, ... }
//
// Output (JSON to stdout):
//   Success: {
//     name:    "v1.2.3",
//     tagSha:  "<tag object sha>",
//     commitSha: "<sha that was tagged>",
//     message: "...",
//     url:     "https://dev.azure.com/.../_git/.../tag/v1.2.3",
//     organization, project, repository,
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-create-tag.js
//       --organization <org>
//       --project      <project>
//       --repository   <repo>
//       --name         <tag>          # see TAG_NAME_REGEX below
//       --commitSha    <sha>
//       [--message     <annotated message>]   # default: "Tagged via commit-to-git"
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion  <ver>]         # default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');

// Reasonable git tag name regex: starts with letter/digit/v, allows
// letters/digits/. / _ / - / / , length 1-100. Rejects whitespace, control
// chars, and the git-reserved patterns ('.' alone, ending with '.lock',
// starting with '-', containing '..', containing '@{').
const TAG_NAME_REGEX = /^(?!-)[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/;
function isValidTagName(name) {
  if (typeof name !== 'string') return false;
  if (!TAG_NAME_REGEX.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('..')) return false;
  if (name.includes('@{')) return false;
  return true;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    name: null, commitSha: null, message: 'Tagged via commit-to-git',
    pat: null, token: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--commitSha' && args[i + 1]) out.commitSha = args[++i];
    else if (args[i] === '--message' && args[i + 1]) out.message = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

async function createTag({
  organization, project, repository, name, commitSha,
  message = 'Tagged via commit-to-git',
  pat = null, token = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!name) throw new Error('--name is required');
  if (!commitSha) throw new Error('--commitSha is required');
  if (!pat && !token) throw new Error('Either --pat or --token is required for ADO auth');
  if (!isValidTagName(name)) {
    throw new Error(`--name "${name}" is not a valid git tag name (must start with alnum, allow [A-Za-z0-9._/-], no '..' or '@{', no '.lock' suffix)`);
  }
  if (!/^[0-9a-fA-F]{40}$/.test(commitSha)) {
    throw new Error(`--commitSha must be a full 40-char hex SHA; got: ${commitSha}`);
  }

  const client = createAdoClient({ organization, project, repository, pat, token, baseUrl, apiVersion });
  const body = {
    name,
    taggedObject: { objectId: commitSha },
    message,
  };

  const res = await client.post('/annotatedtags', { body });

  if (res.error) return { error: res.error };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.message || msg;
      code = parsed.typeKey || parsed.errorCode || null;
    } catch {}
    // Common: 409 Conflict when the tag already exists. Surface clearly.
    if (res.statusCode === 409) {
      return { error: `Tag "${name}" already exists in ${repository}`, statusCode: 409, errorCode: code };
    }
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'create-tag returned 2xx but body was not JSON: ' + e.message };
  }

  return {
    name: parsed.name,
    tagSha: parsed.objectId,
    commitSha: parsed.taggedObject ? parsed.taggedObject.objectId : commitSha,
    message: parsed.message || message,
    url: parsed.url || null,
    organization, project, repository,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createTag(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-create-tag: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { createTag, isValidTagName, TAG_NAME_REGEX };
