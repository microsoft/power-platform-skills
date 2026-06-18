'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

// Offline DI-driven tests for check-ado-folder-exists.js. The helper is the
// pre-bind safety check that git-configure Phase 4 (folder-occupied gate,
// git-configure:4.folder-occupied) runs in the solution-binding flow — its
// accuracy directly determines whether the user gets the folder-occupied
// consent gate or silently co-locates Dataverse files with unrelated content.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkAdoFolderExists,
  API_VERSION,
  isEmptyRepo404,
  normalizeBranch,
  normalizeGitFolder,
  validateGitFolderPath,
} = require('../lib/check-ado-folder-exists');

// ===== constants + small helpers =====

test('API_VERSION is the stable 7.1 (matches list-ado-folders, init-ado-repo)', () => {
  assert.equal(API_VERSION, '7.1');
});

test('isEmptyRepo404 recognizes TF401174 in the body', () => {
  assert.equal(isEmptyRepo404({ statusCode: 404, body: 'TF401174 ...' }), true);
  assert.equal(isEmptyRepo404({ statusCode: 404, body: "the item doesn't exist" }), true);
  assert.equal(isEmptyRepo404({ statusCode: 404, body: 'random other 404' }), false);
  assert.equal(isEmptyRepo404({ statusCode: 200, body: 'TF401174' }), false);
  assert.equal(isEmptyRepo404(null), false);
});

test('normalizeBranch strips refs/heads/ and leading slash; trims whitespace', () => {
  assert.equal(normalizeBranch('main'), 'main');
  assert.equal(normalizeBranch('refs/heads/main'), 'main');
  assert.equal(normalizeBranch('/main'), 'main');
  assert.equal(normalizeBranch('  main  '), 'main');
  assert.equal(normalizeBranch(''), null);
  assert.equal(normalizeBranch(null), null);
});

test('normalizeGitFolder strips leading + trailing slashes (defensive); trims whitespace', () => {
  assert.equal(normalizeGitFolder('solutions'), 'solutions');
  assert.equal(normalizeGitFolder('/solutions'), 'solutions');
  assert.equal(normalizeGitFolder('solutions/'), 'solutions');
  assert.equal(normalizeGitFolder('/solutions/'), 'solutions');
  assert.equal(normalizeGitFolder('  solutions  '), 'solutions');
  assert.equal(normalizeGitFolder(''), null);
  assert.equal(normalizeGitFolder(null), null);
});

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await checkAdoFolderExists({ project: 'p', repository: 'r', gitFolder: 'f', branch: 'b', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /organization/);
});

test('required-arg validation: --project missing', async () => {
  const r = await checkAdoFolderExists({ organization: 'o', repository: 'r', gitFolder: 'f', branch: 'b', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /project/);
});

test('required-arg validation: --repository missing', async () => {
  const r = await checkAdoFolderExists({ organization: 'o', project: 'p', gitFolder: 'f', branch: 'b', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /repository/);
});

test('required-arg validation: --gitFolder missing', async () => {
  const r = await checkAdoFolderExists({ organization: 'o', project: 'p', repository: 'r', branch: 'b', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /gitFolder/);
});

test('required-arg validation: --branch missing', async () => {
  const r = await checkAdoFolderExists({ organization: 'o', project: 'p', repository: 'r', gitFolder: 'f', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /branch/);
});

test('required-arg validation: --token missing', async () => {
  const r = await withNoAdoAcquire(() => checkAdoFolderExists({ organization: 'o', project: 'p', repository: 'r', gitFolder: 'f', branch: 'b' }));
  assert.equal(r.ok, false); assert.match(r.error, /token/);
});

test('validateGitFolderPath: single + nested forward-slash paths are accepted', () => {
  assert.equal(validateGitFolderPath('solutions').ok, true);
  assert.equal(validateGitFolderPath('solutions/RetailOS').ok, true);
  assert.equal(validateGitFolderPath('a/b/c').ok, true);
});

test('validateGitFolderPath: backslashes, empty, "." and ".." segments are rejected', () => {
  assert.equal(validateGitFolderPath('solutions\\sub').ok, false);
  assert.match(validateGitFolderPath('solutions\\sub').error, /backslashes/);
  assert.equal(validateGitFolderPath('solutions//RetailOS').ok, false);
  assert.equal(validateGitFolderPath('solutions/./RetailOS').ok, false);
  assert.equal(validateGitFolderPath('solutions/../secret').ok, false);
  assert.match(validateGitFolderPath('solutions/../secret').error, /invalid path segment/);
});

test('nested forward-slash --gitFolder (solution binding) is accepted and probes the full path', async () => {
  let itemsUrl;
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions/RetailOS', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      itemsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.gitFolder, 'solutions/RetailOS');
  assert.match(itemsUrl, /scopePath=%2Fsolutions%2FRetailOS%2F/);
});

test('embedded backslash in --gitFolder is rejected before any network call (defensive)', async () => {
  let called = false;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions\\sub', branch: 'main', token: 't',
    _makeRequestImpl: async () => { called = true; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /backslashes/);
  assert.equal(called, false, 'helper must not make any HTTP call when --gitFolder uses backslashes');
});

test('empty/".." path segment in --gitFolder is rejected before any network call', async () => {
  let called = false;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions/../secret', branch: 'main', token: 't',
    _makeRequestImpl: async () => { called = true; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid path segment/);
  assert.equal(called, false, 'helper must not make any HTTP call when a path segment is invalid');
});

// ===== happy paths =====

test('folder is occupied (5 children + the folder itself) → exists:true, itemCount:5', async () => {
  const calls = [];
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      calls.push(opts.url);
      if (calls.length === 1) {
        // refs response
        return {
          statusCode: 200,
          body: JSON.stringify({
            value: [{ name: 'refs/heads/main', objectId: 'abc123def456' }],
          }),
        };
      }
      // items response — folder + 5 children
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            { path: '/solutions', isFolder: true, gitObjectType: 'tree' },
            { path: '/solutions/sub1', isFolder: true, gitObjectType: 'tree' },
            { path: '/solutions/sub2', isFolder: true, gitObjectType: 'tree' },
            { path: '/solutions/a.xml', isFolder: false, gitObjectType: 'blob' },
            { path: '/solutions/b.xml', isFolder: false, gitObjectType: 'blob' },
            { path: '/solutions/c.xml', isFolder: false, gitObjectType: 'blob' },
          ],
        }),
      };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, true);
  assert.equal(r.itemCount, 5, 'itemCount must exclude the folder-self entry');
  assert.equal(r.headCommitId, 'abc123def456');
  assert.equal(r.branch, 'main');
  assert.equal(r.gitFolder, 'solutions');
});

test('folder is empty (refs ok, items returns []) → exists:false, itemCount:0, headCommitId preserved', async () => {
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha-head' }] }) };
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.itemCount, 0);
  assert.equal(r.headCommitId, 'sha-head');
});

test('folder not found on populated repo (items 404 TF401174) → exists:false, headCommitId preserved', async () => {
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'newfolder', branch: 'main', token: 't',
    _makeRequestImpl: async () => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha-head' }] }) };
      return { statusCode: 404, body: 'TF401174: The item /newfolder does not exist' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.itemCount, 0);
  assert.equal(r.headCommitId, 'sha-head');
});

test('empty repo (refs 404 TF401174) → exists:false, emptyRepo:true, headCommitId:null; no items call made', async () => {
  let itemsCallCount = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (/\/items\?/.test(opts.url)) itemsCallCount++;
      return { statusCode: 404, body: 'TF401174 The repository is empty' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.itemCount, 0);
  assert.equal(r.headCommitId, null);
  assert.equal(r.emptyRepo, true);
  assert.equal(itemsCallCount, 0, 'helper must short-circuit before the items call when repo is empty');
});

test('non-empty repo but requested branch does not exist (refs value=[]) → exists:false, headCommitId:null', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'feature/xyz', token: 't',
    _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.itemCount, 0);
  assert.equal(r.headCommitId, null);
});

// ===== URL contract — these pin the wire-level format =====

test('refs request URL uses filter=heads/<branch> + $top=1 + api-version=7.1', async () => {
  let refsUrl;
  await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (!refsUrl) refsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
    },
  });
  assert.match(refsUrl, /\/refs\?filter=heads%2Fmain/);
  assert.match(refsUrl, /\$top=1/);
  assert.match(refsUrl, /api-version=7\.1/);
});

test('items request URL uses scopePath=/<folder>/ + OneLevel + versionDescriptor.version + .versionType=branch', async () => {
  let idx = 0;
  let itemsUrl;
  await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      itemsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    },
  });
  assert.match(itemsUrl, /scopePath=%2Fsolutions%2F/);
  assert.match(itemsUrl, /recursionLevel=OneLevel/);
  assert.match(itemsUrl, /versionDescriptor\.version=main/);
  assert.match(itemsUrl, /versionDescriptor\.versionType=branch/);
  assert.match(itemsUrl, /api-version=7\.1/);
});

test('refs+items URLs URL-encode the organization, project, repository, and gitFolder segments', async () => {
  let refsUrl, itemsUrl;
  await checkAdoFolderExists({
    organization: 'my org', project: 'my proj', repository: 'my repo',
    gitFolder: 'my folder', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (!refsUrl) { refsUrl = opts.url; return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) }; }
      itemsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    },
  });
  assert.match(refsUrl, /my%20org/);
  assert.match(refsUrl, /my%20proj/);
  assert.match(refsUrl, /my%20repo/);
  assert.match(itemsUrl, /scopePath=%2Fmy%20folder%2F/);
});

// ===== input normalization on call boundary =====

test('refs/heads/main is normalized to main before being put in the URL', async () => {
  let refsUrl;
  await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'refs/heads/main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (!refsUrl) refsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
    },
  });
  assert.match(refsUrl, /filter=heads%2Fmain/);
  assert.doesNotMatch(refsUrl, /heads%2Frefs%2Fheads/);
});

test('trailing slash on gitFolder is silently normalized (defensive — Phase 3 step 3e should already block this)', async () => {
  let itemsUrl;
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions/', branch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      itemsUrl = opts.url;
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.match(itemsUrl, /scopePath=%2Fsolutions%2F/);
  assert.doesNotMatch(itemsUrl, /scopePath=%2Fsolutions%2F%2F/);
});

// ===== error paths =====

test('401 on refs → ok:false, statusCode:401, hint about token scope', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => ({ statusCode: 401, body: '{}' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 401);
  assert.match(r.hint, /Token rejected/);
});

test('403 on refs → ok:false, statusCode:403, hint about Contribute/Reader', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => ({ statusCode: 403, body: '{}' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 403);
  assert.match(r.hint, /Reader/);
});

test('404 non-empty-repo (e.g. unknown repo) → ok:false, statusCode:404', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'nonexistent', token: 't',
    gitFolder: 'solutions', branch: 'main',
    _makeRequestImpl: async () => ({ statusCode: 404, body: 'plain not found, no TF code' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 404);
});

test('network error (res.error) on refs → ok:false, error surfaced verbatim', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => ({ error: 'ECONNREFUSED', body: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('non-JSON refs response → ok:false, parse error', async () => {
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => ({ statusCode: 200, body: 'not json' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse refs/);
});

test('non-JSON items response → ok:false, parse error', async () => {
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      return { statusCode: 200, body: 'not json' };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse items/);
});

test('non-200/404 on items (e.g. 500) → ok:false, statusCode:500', async () => {
  let idx = 0;
  const r = await checkAdoFolderExists({
    organization: 'o', project: 'p', repository: 'r',
    gitFolder: 'solutions', branch: 'main', token: 't',
    _makeRequestImpl: async () => {
      idx++;
      if (idx === 1) return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      return { statusCode: 500, body: '{}' };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 500);
});

test('check-ado-folder-exists: --tokenFile JSON envelope resolves and --folder alias works', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-check-ado-folder-exists.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    const headers = [];
    const r = await checkAdoFolderExists({ organization: 'org', project: 'proj', repository: 'repo', folder: 'solutions', branch: 'main', tokenFile, _makeRequestImpl: async (opts) => { headers.push(opts.headers.Authorization); return headers.length === 1 ? { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) } : { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
    assert.equal(r.ok, true);
    assert.equal(r.gitFolder, 'solutions');
    assert.deepEqual(headers, ['Bearer header.payload.sig', 'Bearer header.payload.sig']);
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
