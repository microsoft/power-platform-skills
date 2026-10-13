'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeGenpageCli } = require('../lib/genpage-cli.js');

const ENV = 'https://contoso.crm.dynamics.com';
const BEFORE = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const START = Date.parse('2026-01-01T12:00:00Z');
const NAME = 'Contoso Overview';

function listing(rows) {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  return [
    'Connected as maker@contoso.com',
    `Found ${rows.length} generated page(s):`,
    `${'Page ID'.padEnd(37)}${'Name'.padEnd(width + 1)}Published`,
    ...rows.map((r) => `${r.id} ${r.name.padEnd(width)} -`),
  ].join('\n');
}

function harness(opts = {}) {
  const state = { uploads: [], requests: [], lists: 0, now: START };
  const before = [{ id: BEFORE, name: 'Contoso Existing' }];
  const after = [...before, { id: CANDIDATE, name: opts.listedName || NAME }, ...(opts.multiple ? [{ id: SECOND, name: 'Contoso Other' }] : [])];
  const deps = {
    attempts: 2,
    now: () => state.now,
    sleep: async () => {},
    request: async (env, method, url) => {
      state.requests.push({ env, method, url });
      if (opts.readError) throw new Error('Contoso candidate read unavailable');
      if (opts.response !== undefined) return opts.response;
      return {
        status: 200,
        data: {
          name: opts.storedName === undefined ? NAME : opts.storedName,
          createdon: Object.prototype.hasOwnProperty.call(opts, 'createdon') ? opts.createdon : new Date(START).toISOString(),
        },
      };
    },
    run: async (args) => {
      if (args.includes('list')) {
        state.lists++;
        return { status: 0, stdout: listing(state.lists === 1 ? before : after), stderr: '' };
      }
      state.uploads.push(args);
      state.now += opts.elapsedMs || 0;
      if (args.includes('--page-id') || opts.certain) return { status: 0, stdout: `Page ID: ${CANDIDATE}`, stderr: '' };
      return {
        status: opts.zeroExit ? 0 : 1,
        stdout: 'No page id returned',
        stderr: opts.deterministic ? "Error: The value passed to '--code-file' is invalid." : 'Contoso temporary service delay',
      };
    },
  };
  const cli = makeGenpageCli(ENV, deps);
  const upload = (name = NAME) => cli.upload({ appId: 'contoso-app', codeFile: 'overview.tsx', name, prompt: 'Add a status filter' });
  return { cli, state, upload };
}

for (const deterministic of [false, true]) {
  test(`uncertain create refuses a new page with another stored name (deterministic response: ${deterministic})`, async () => {
    const { upload, state } = harness({ storedName: 'Contoso Unrelated Draft', deterministic });
    await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && e.message.includes('Contoso Unrelated Draft') && /--page-id/.test(e.message));
    assert.equal(state.uploads.length, 1);
    assert.ok(state.uploads.every((args) => !args.includes('--page-id')));
  });
}

test('uncertain create refuses a stored-name casing difference', async () => {
  const { upload, state } = harness({ storedName: NAME.toLowerCase() });
  await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && /name/i.test(e.message));
  assert.equal(state.uploads.length, 1);
});

test('uncertain create refuses a candidate older than the attempt window by one millisecond', async () => {
  const { upload, state } = harness({ createdon: new Date(START - 120001).toISOString() });
  await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && /createdon|window|older/i.test(e.message));
  assert.equal(state.uploads.length, 1);
});

test('uncertain create reports a matching recent candidate and explicit update guidance without adopting it', async () => {
  const { upload, state } = harness({ createdon: new Date(START - 120000).toISOString() });
  await assert.rejects(upload(), (e) => {
    assert.match(e.message, new RegExp(CANDIDATE));
    assert.match(e.message, new RegExp(NAME));
    assert.match(e.message, /createdon/);
    assert.match(e.message, new RegExp(`--page-id ${CANDIDATE}`));
    assert.match(e.message, /otherwise.*leave.*re-run.*create/i);
    return true;
  });
  assert.equal(state.uploads.length, 1);
  assert.ok(!state.uploads[0].includes('--page-id'));
  assert.deepEqual(state.requests, [{ env: ENV, method: 'GET', url: `uxagentprojects(${CANDIDATE})?$select=name,createdon` }]);
});

test('elapsed upload time does not authorize an automatic update of a candidate', async () => {
  const { upload } = harness({ createdon: new Date(START - 120000).toISOString(), elapsedMs: 200000 });
  await assert.rejects(upload(), /--page-id/);
});

for (const createdon of [undefined, null, '', 'not-a-date']) {
  test(`uncertain create refuses unreadable createdon ${JSON.stringify(createdon)}`, async () => {
    const { upload, state } = harness({ createdon });
    await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && /createdon|creation/i.test(e.message));
    assert.equal(state.uploads.length, 1);
  });
}

for (const response of [{ status: 403 }, { status: 404 }, { status: 500 }, {}, { status: 200, data: {} }]) {
  test(`uncertain create refuses incomplete candidate reads ${JSON.stringify(response)}`, async () => {
    const { upload, state } = harness({ response });
    await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && /read|HTTP|name/i.test(e.message));
    assert.equal(state.uploads.length, 1);
  });
}

test('uncertain create fails closed when the candidate request throws', async () => {
  const { upload, state } = harness({ readError: true });
  await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && /candidate read unavailable/.test(e.message));
  assert.equal(state.uploads.length, 1);
});

for (const name of [undefined, '', '   ']) {
  test(`uncertain create refuses adoption without a requested name ${JSON.stringify(name)}`, async () => {
    const { cli, state } = harness();
    await assert.rejects(cli.upload({ appId: 'contoso-app', codeFile: 'overview.tsx', name }), (e) => e.message.includes(CANDIDATE) && /--page-id/.test(e.message));
    assert.equal(state.uploads.length, 1);
    assert.equal(state.requests.length, 1);
  });
}

test('uncertain create checks the stored name rather than the listing label', async () => {
  const { upload, state } = harness({ listedName: 'Contoso Navigation Label', zeroExit: true });
  await assert.rejects(upload(), (e) => e.message.includes(NAME) && !e.message.includes('Contoso Navigation Label'));
  assert.equal(state.requests.length, 1);
});

test('uncertain create reports the decoded PAC name without granting it authority', async () => {
  const { upload } = harness({ storedName: 'Contoso \\"Overview\\"' });
  await assert.rejects(upload('Contoso "Overview"'), (e) => e.message.includes('Contoso') && /--page-id/.test(e.message));
});

test('an uncertain create cannot switch to an update after a deterministic-looking response', async () => {
  const { upload, state } = harness({ deterministic: true });
  await assert.rejects(upload(), /--page-id/);
  assert.equal(state.uploads.length, 1);
});

test('uncertain create reports every new candidate without updating any', async () => {
  const { upload, state } = harness({ multiple: true });
  await assert.rejects(upload(), (e) => e.message.includes(CANDIDATE) && e.message.includes(SECOND) && /createdon/.test(e.message));
  assert.equal(state.uploads.length, 1);
  assert.equal(state.requests.length, 2);
});

test('a certain create and an ordinary update do not run uncertain-create reads', async () => {
  const { cli, state } = harness({ certain: true });
  assert.equal((await cli.upload({ appId: 'contoso-app', codeFile: 'overview.tsx' })).pageId, CANDIDATE);
  assert.equal((await cli.upload({ appId: 'contoso-app', pageId: CANDIDATE, codeFile: 'overview.tsx' })).pageId, CANDIDATE);
  assert.deepEqual(state.requests, []);
});

test('an adoption refusal still removes its temporary prompt files', async () => {
  const { upload, state } = harness({ storedName: 'Contoso Other' });
  await assert.rejects(upload());
  const args = state.uploads[0];
  assert.equal(fs.existsSync(args[args.indexOf('--prompt-file') + 1]), false);
  assert.equal(fs.existsSync(args[args.indexOf('--agent-message-file') + 1]), false);
});
