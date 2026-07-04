'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listSourceControlComponents, resolveSolutionId } = require('../lib/list-source-control-components');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const next = queue.shift() || { status: 500, body: JSON.stringify({ error: { message: 'Unexpected request' } }) };
    res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
    res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

function serverUrl(s) { return `http://127.0.0.1:${s.port}`; }
function closeServer(s) { return new Promise((resolve) => s.server.close(resolve)); }

test('resolveSolutionId resolves a solution unique name', async () => {
  const s = await createQueuedServer([
    { status: 200, body: { value: [{ solutionid: 'sol-1' }] } },
  ]);
  try {
    const result = await resolveSolutionId({ envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'contoso_site' });
    assert.equal(result.solutionId, 'sol-1');
    assert.match(s.received[0].url, /\/api\/data\/v9\.0\/solutions\?/);
    assert.match(decodeURIComponent(s.received[0].url), /uniquename eq 'contoso_site'/);
    assert.match(s.received[0].url, /\$select=solutionid/);
  } finally { await closeServer(s); }
});

test('resolveSolutionId returns an error when no solution matches', async () => {
  const s = await createQueuedServer([{ status: 200, body: { value: [] } }]);
  try {
    const result = await resolveSolutionId({ envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'missing' });
    assert.match(result.error, /Solution not found/);
  } finally { await closeServer(s); }
});

test('listSourceControlComponents queries sourcecontrolcomponents without $select and maps rows', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: {
        value: [{
          sourcecontrolcomponentid: 'scc-1',
          action: 3,
          useraction: 0,
          iscommitted: false,
          componentid: 'ppc-1',
          componentdisplayname: 'Header',
          componentpath: 'web-templates/header.html',
          componenttype: 'mspp_webtemplate',
        }],
      },
    },
  ]);
  try {
    const result = await listSourceControlComponents({
      envUrl: serverUrl(s),
      token: 'tok',
      solutionId: 'sol-1',
      action: 3,
    });
    assert.equal(result.count, 1);
    assert.deepEqual(result.items[0], {
      sourceControlComponentId: 'scc-1',
      componentId: 'ppc-1',
      componentName: 'Header',
      componentPath: 'web-templates/header.html',
      componentType: 'mspp_webtemplate',
      partitionId: null,
      payloadId: null,
      gitHashId: null,
      lastSyncHashId: null,
      envHashId: null,
      action: 3,
      useraction: 0,
    });
    assert.match(s.received[0].url, /\/api\/data\/v9\.0\/sourcecontrolcomponents\?/);
    assert.match(decodeURIComponent(s.received[0].url), /(^|[?&])\$filter=action eq 3/);
    assert.doesNotMatch(decodeURIComponent(s.received[0].url), /iscommitted/);
    assert.match(s.received[0].url, /partitionId=sol-1/);
    assert.doesNotMatch(s.received[0].url, /\$select=/);
  } finally { await closeServer(s); }
});

test('listSourceControlComponents adds "useraction eq N" filter + surfaces hashes/partition when userAction given', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: {
        value: [{
          sourcecontrolcomponentid: 'scc-3',
          componentid: 'ppc-3',
          componentdisplayname: 'Footer',
          componentpath: 'web-templates/footer.html',
          componenttype: 'mspp_webtemplate',
          partitionid: 'sol-9',
          _sourcecontrolcomponentpayloadid_value: 'pay-3',
          githashid: 'gh', lastsynchashid: 'lh', envhashid: 'eh',
          action: 3, useraction: 0,
        }],
      },
    },
  ]);
  try {
    const result = await listSourceControlComponents({ envUrl: serverUrl(s), token: 'tok', solutionId: 'sol-9', action: 3, userAction: 0 });
    assert.equal(result.count, 1);
    const it = result.items[0];
    assert.equal(it.partitionId, 'sol-9');
    assert.equal(it.payloadId, 'pay-3');
    assert.equal(it.gitHashId, 'gh');
    assert.equal(it.lastSyncHashId, 'lh');
    assert.equal(it.envHashId, 'eh');
    assert.match(decodeURIComponent(s.received[0].url), /action eq 3 and useraction eq 0/);
    assert.doesNotMatch(decodeURIComponent(s.received[0].url), /iscommitted/);
  } finally { await closeServer(s); }
});

test('listSourceControlComponents returns iscommitted=true conflicts (portal parity — no iscommitted filter)', async () => {
  // Regression for the live-found under-report (2026-06-19, sri-alm-dev-1): a
  // site-setting conflict with iscommitted=true was hidden by the old
  // `iscommitted eq false` filter while the portal Conflicts tab listed it.
  const s = await createQueuedServer([
    {
      status: 200,
      body: {
        value: [{
          sourcecontrolcomponentid: 'scc-committed',
          componentid: 'ppc-ss',
          componentdisplayname: 'Authentication/LoginTrackingEnabled.sitesetting',
          componentpath: '/powerpagesites/RetailOS/site-settings/Authentication-LoginTrackingEnabled.sitesetting.yml',
          componenttype: 10429,
          partitionid: 'sol-1',
          action: 3, useraction: 0, iscommitted: true,
        }],
      },
    },
  ]);
  try {
    const result = await listSourceControlComponents({ envUrl: serverUrl(s), token: 'tok', solutionId: 'sol-1', action: 3, userAction: 0 });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].componentName, 'Authentication/LoginTrackingEnabled.sitesetting');
    assert.doesNotMatch(decodeURIComponent(s.received[0].url), /iscommitted/);
  } finally { await closeServer(s); }
});

test('listSourceControlComponents resolves solutionUniqueName when solutionId is omitted', async () => {
  const s = await createQueuedServer([
    { status: 200, body: { value: [{ solutionid: 'sol-2' }] } },
    { status: 200, body: { value: [{ sourcecontrolcomponentid: 'scc-2', componentdisplayname: 'Page', action: 2, useraction: 0 }] } },
  ]);
  try {
    const result = await listSourceControlComponents({
      envUrl: serverUrl(s),
      token: 'tok',
      solutionUniqueName: 'contoso_site',
      action: 2,
    });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].sourceControlComponentId, 'scc-2');
    assert.match(decodeURIComponent(s.received[1].url), /action eq 2/);
    assert.match(s.received[1].url, /partitionId=sol-2/);
  } finally { await closeServer(s); }
});

test('listSourceControlComponents returns error envelopes for API failures', async () => {
  const s = await createQueuedServer([
    { status: 500, body: { error: { message: 'boom' } } },
  ]);
  try {
    const result = await listSourceControlComponents({ envUrl: serverUrl(s), token: 'tok', solutionId: 'sol-1', action: 3 });
    assert.equal(result.error, 'boom');
    assert.equal(result.statusCode, 500);
  } finally { await closeServer(s); }
});

// ---- Bug 14: the active-conflicts predicate excludes the resolved baseline ----
test('Bug 14: conflicts query is action eq 3 AND useraction eq 0 — excludes the useraction=1 baseline', async () => {
  // action=3 is a BROAD bucket: on a real tenant it returns the whole baseline
  // (e.g. 90 rows). Only the useraction=0 subset are ACTIVE conflicts; the ~87
  // useraction=1 rows are the already-synced baseline and MUST be excluded. The
  // exclusion is server-side via the OData predicate, so the regression proves the
  // query carries `useraction eq 0` and never widens to useraction 1/2.
  const s = await createQueuedServer([
    { status: 200, body: { value: [{ sourcecontrolcomponentid: 'scc-active', action: 3, useraction: 0, componentdisplayname: 'Active' }] } },
  ]);
  try {
    const result = await listSourceControlComponents({ envUrl: serverUrl(s), token: 'tok', solutionId: 'sol-1', action: 3, userAction: 0 });
    assert.equal(result.count, 1);
    const filter = decodeURIComponent(s.received[0].url);
    assert.match(filter, /action eq 3 and useraction eq 0/);
    assert.doesNotMatch(filter, /useraction eq 1/);
    assert.doesNotMatch(filter, /useraction eq 2/);
  } finally { await closeServer(s); }
});
