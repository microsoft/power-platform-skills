'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initAdoRepo,
  normalizeBranchRef,
  EMPTY_REPO_OLD_OBJECT_ID,
} = require('../lib/init-ado-repo');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.
// initAdoRepo's contract is documented in init-ado-repo.js's header comment.

// ===== constants =====

test('EMPTY_REPO_OLD_OBJECT_ID is 40 zeros (ADO empty-repo marker)', () => {
  assert.equal(EMPTY_REPO_OLD_OBJECT_ID.length, 40);
  assert.match(EMPTY_REPO_OLD_OBJECT_ID, /^0+$/);
});

// ===== normalizeBranchRef =====

test('normalizeBranchRef: bare name gets refs/heads/ prefix', () => {
  assert.equal(normalizeBranchRef('main'), 'refs/heads/main');
  assert.equal(normalizeBranchRef('develop'), 'refs/heads/develop');
  assert.equal(normalizeBranchRef('feature/foo'), 'refs/heads/feature/foo');
});

test('normalizeBranchRef: already-prefixed values pass through unchanged', () => {
  assert.equal(normalizeBranchRef('refs/heads/main'), 'refs/heads/main');
  assert.equal(normalizeBranchRef('refs/heads/feature/x'), 'refs/heads/feature/x');
});

// ===== arg validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await initAdoRepo({ project: 'p', repository: 'r', branch: 'main', token: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /organization/i);
});
test('required-arg validation: --project missing', async () => {
  const r = await initAdoRepo({ organization: 'o', repository: 'r', branch: 'main', token: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /project/i);
});
test('required-arg validation: --repository missing', async () => {
  const r = await initAdoRepo({ organization: 'o', project: 'p', branch: 'main', token: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /repository/i);
});
test('required-arg validation: --branch missing', async () => {
  const r = await initAdoRepo({ organization: 'o', project: 'p', repository: 'r', token: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /branch/i);
});
test('required-arg validation: --token missing', async () => {
  const r = await initAdoRepo({ organization: 'o', project: 'p', repository: 'r', branch: 'main' });
  assert.equal(r.ok, false);
  assert.match(r.error, /token/i);
});

// ===== idempotency =====

test('idempotency: defaultBranch already set → alreadyInitialized:true, no POST', async () => {
  const calls = [];
  const fakeMake = async (opts) => {
    calls.push(opts);
    assert.equal(opts.method, 'GET', 'idempotent path must not POST');
    return {
      statusCode: 200,
      body: JSON.stringify({
        id: 'repo-guid-123',
        defaultBranch: 'refs/heads/main',
      }),
    };
  };
  const r = await initAdoRepo({
    organization: 'contoso',
    project: 'pp',
    repository: 'pp-repo',
    branch: 'main',
    token: 'fake-pat',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(calls.length, 1, 'should have made exactly one (GET) call');
  assert.equal(r.ok, true);
  assert.equal(r.initialized, false);
  assert.equal(r.alreadyInitialized, true);
  assert.equal(r.commitId, null);
  assert.equal(r.branch, 'main');
  assert.equal(r.repoId, 'repo-guid-123');
});

// ===== happy push path =====

test('empty repo + valid token → POST is made and commitId returned', async () => {
  const capturedPosts = [];
  const fakeMake = async (opts) => {
    if (opts.method === 'GET') {
      return {
        statusCode: 200,
        body: JSON.stringify({ id: 'repo-guid-abc', defaultBranch: null }),
      };
    }
    capturedPosts.push(opts);
    return {
      statusCode: 201,
      body: JSON.stringify({
        commits: [{ commitId: 'abc1234567890def', comment: 'Initialize…' }],
      }),
    };
  };
  const r = await initAdoRepo({
    organization: 'contoso',
    project: 'pp',
    repository: 'pp-repo',
    branch: 'main',
    token: 'eyJhbGc.eyJzdWIi.signature', // JWT shape → Bearer
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.initialized, true);
  assert.equal(r.alreadyInitialized, false);
  assert.equal(r.commitId, 'abc1234567890def');
  assert.equal(r.branch, 'main');
  assert.equal(r.repoId, 'repo-guid-abc');
  assert.ok(r.pushedAt, 'pushedAt must be set on a real push');

  assert.equal(capturedPosts.length, 1);
  const push = capturedPosts[0];
  assert.match(push.url, /\/_apis\/git\/repositories\/repo-guid-abc\/pushes/);
  assert.equal(push.headers['Content-Type'], 'application/json');
  assert.match(push.headers.Authorization, /^Bearer eyJhbGc/);
  const sent = JSON.parse(push.body);
  assert.equal(sent.refUpdates[0].name, 'refs/heads/main');
  assert.equal(sent.refUpdates[0].oldObjectId, EMPTY_REPO_OLD_OBJECT_ID);
  assert.equal(sent.commits[0].changes[0].item.path, '/README.md');
  assert.equal(sent.commits[0].changes[0].newContent.contentType, 'rawtext');
});

test('PAT (no dots) routes through Basic auth header', async () => {
  const capturedHeaders = [];
  const fakeMake = async (opts) => {
    capturedHeaders.push(opts.headers.Authorization);
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    return { statusCode: 201, body: JSON.stringify({ commits: [{ commitId: 'sha' }] }) };
  };
  await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main',
    token: 'plainPatNoDotsHere',
    _makeRequestImpl: fakeMake,
  });
  for (const h of capturedHeaders) assert.ok(h.startsWith('Basic '), `expected Basic, got ${h}`);
});

// ===== branch normalization at push time =====

test('branch normalization: --branch develop → refs/heads/develop in payload', async () => {
  let pushBody;
  const fakeMake = async (opts) => {
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    pushBody = JSON.parse(opts.body);
    return { statusCode: 201, body: JSON.stringify({ commits: [{ commitId: 'sha' }] }) };
  };
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'develop', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.branch, 'develop');
  assert.equal(pushBody.refUpdates[0].name, 'refs/heads/develop');
});

test('branch normalization: --branch refs/heads/main → unchanged, no double-prefix', async () => {
  let pushBody;
  const fakeMake = async (opts) => {
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    pushBody = JSON.parse(opts.body);
    return { statusCode: 201, body: JSON.stringify({ commits: [{ commitId: 'sha' }] }) };
  };
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'refs/heads/main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.branch, 'main');
  assert.equal(pushBody.refUpdates[0].name, 'refs/heads/main');
});

// ===== custom README content override =====

test('--readmeContent override replaces the default README body', async () => {
  let pushBody;
  const fakeMake = async (opts) => {
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    pushBody = JSON.parse(opts.body);
    return { statusCode: 201, body: JSON.stringify({ commits: [{ commitId: 'sha' }] }) };
  };
  await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    readmeContent: '# Custom readme line\n',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(pushBody.commits[0].changes[0].newContent.content, '# Custom readme line\n');
});

// ===== error propagation =====

test('GET returns 403 → ok:false statusCode:403 with Contribute hint', async () => {
  const fakeMake = async () => ({
    statusCode: 403,
    body: JSON.stringify({ message: 'TF401019: not authorized.' }),
  });
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 403);
  assert.match(r.error, /TF401019/);
  assert.match(r.hint, /Contribute/);
  assert.match(r.hint, /o\/p\/r/);
});

test('GET returns 404 → ok:false statusCode:404 with repo-not-found hint', async () => {
  const fakeMake = async () => ({
    statusCode: 404,
    body: JSON.stringify({ message: 'TF401019: not found.' }),
  });
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 404);
  assert.match(r.hint, /not found/i);
});

test('GET returns 401 → ok:false statusCode:401 with scope hint', async () => {
  const fakeMake = async () => ({
    statusCode: 401,
    body: JSON.stringify({ message: 'Unauthorized.' }),
  });
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 401);
  assert.match(r.hint, /scope/i);
});

test('GET network error → ok:false with error field', async () => {
  const fakeMake = async () => ({ error: 'ECONNREFUSED' });
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('POST returns 403 → ok:false statusCode:403', async () => {
  const fakeMake = async (opts) => {
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    return {
      statusCode: 403,
      body: JSON.stringify({ message: 'TF401019: cannot push.' }),
    };
  };
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 403);
  assert.match(r.hint, /Contribute/);
});

test('GET returns 200 but JSON has no id → ok:false', async () => {
  const fakeMake = async () => ({
    statusCode: 200,
    body: JSON.stringify({ defaultBranch: null }), // no id field
  });
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /id field/i);
});

// ===== api-version regression guard =====
//
// Regression test for the bug fixed on 2026-06-11: api-version=7.1-preview.1
// works for the GET /_apis/git/repositories/{repo} call but is rejected with
// HTTP 405 on POST /_apis/git/repositories/{repoId}/pushes. Both URLs must use
// stable 7.1 (or newer stable). Anything ending in `-preview.N` is a defect.

test('api-version: both GET repo and POST pushes use the stable 7.1 (no preview)', async () => {
  const capturedUrls = [];
  const fakeMake = async (opts) => {
    capturedUrls.push({ method: opts.method, url: opts.url });
    if (opts.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ id: 'r1', defaultBranch: null }) };
    }
    return { statusCode: 201, body: JSON.stringify({ commits: [{ commitId: 'sha' }] }) };
  };
  const r = await initAdoRepo({
    organization: 'o', project: 'p', repository: 'r', branch: 'main', token: 't',
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);

  assert.equal(capturedUrls.length, 2, 'expected exactly one GET and one POST');
  const getCall  = capturedUrls.find((c) => c.method === 'GET');
  const postCall = capturedUrls.find((c) => c.method === 'POST');
  assert.ok(getCall,  'GET repo-metadata call must be made');
  assert.ok(postCall, 'POST /pushes call must be made');

  // Both URLs must carry `api-version=7.1` exactly — not any `-preview.N` value.
  // The Pushes endpoint returns 405 on preview api-versions.
  assert.match(getCall.url,  /[?&]api-version=7\.1(?:&|$)/,
    `GET URL must use api-version=7.1 (stable). Got: ${getCall.url}`);
  assert.match(postCall.url, /[?&]api-version=7\.1(?:&|$)/,
    `POST /pushes URL must use api-version=7.1 (stable). Got: ${postCall.url}`);

  assert.doesNotMatch(getCall.url,  /api-version=[\d.]+-preview/,
    'GET URL must not use a -preview api-version');
  assert.doesNotMatch(postCall.url, /api-version=[\d.]+-preview/,
    'POST /pushes URL must not use a -preview api-version (returns HTTP 405)');
});

test('init-ado-repo: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-init-ado-repo.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    let header;
    const r = await initAdoRepo({ organization: 'org', project: 'proj', repository: 'repo', branch: 'main', tokenFile, _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ id: 'rid', defaultBranch: 'refs/heads/main' }) }; } });
    assert.equal(r.ok, true);
    assert.equal(header, 'Bearer header.payload.sig');
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
