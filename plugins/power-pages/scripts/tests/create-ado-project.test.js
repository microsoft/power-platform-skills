'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdoProject, AGILE_PROCESS_TEMPLATE_ID, DEFAULT_MAX_POLL_ATTEMPTS } = require('../lib/create-ado-project');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('Agile process template constant matches documented GUID', () => {
  assert.equal(AGILE_PROCESS_TEMPLATE_ID, '6b724908-ef14-45cf-84f8-768b5384da45');
  assert.equal(DEFAULT_MAX_POLL_ATTEMPTS, 60);
});

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await createAdoProject({ name:'p', token:'t' });
  assert.equal(r.ok, false); assert.match(r.error, /organization/);
});
test('required-arg validation: --name missing', async () => {
  const r = await createAdoProject({ organization:'o', token:'t' });
  assert.equal(r.ok, false); assert.match(r.error, /name/);
});
test('required-arg validation: --token missing', async () => {
  const r = await createAdoProject({ organization:'o', name:'p' });
  assert.equal(r.ok, false); assert.match(r.error, /token/);
});

// ===== happy path =====

test('happy path with poll succeeding on 2nd attempt', async () => {
  let polls = 0;
  const r = await createAdoProject({ organization:'org', name:'Proj', token:'t', pollIntervalMs:0, _makeRequestImpl: async (opts) => {
    if (opts.method === 'POST') return { statusCode:202, body: JSON.stringify({ id:'op1', url:'https://poll', status:'queued' }) };
    polls += 1;
    return { statusCode:200, body: JSON.stringify({ status: polls === 1 ? 'inProgress' : 'succeeded' }) };
  }});
  assert.equal(r.ok, true); assert.equal(r.operationId, 'op1'); assert.equal(r.status, 'succeeded'); assert.equal(polls, 2);
});

test('DI captures POST body has correct visibility/templateId', async () => {
  let sent;
  await createAdoProject({ organization:'o', name:'P', description:'D', token:'a.b.c', pollIntervalMs:0, _makeRequestImpl: async (opts) => {
    if (opts.method === 'POST') { sent = JSON.parse(opts.body); assert.equal(opts.headers.Authorization, 'Bearer a.b.c'); return { statusCode:202, body: JSON.stringify({ id:'op', url:'u', status:'queued' }) }; }
    return { statusCode:200, body: JSON.stringify({ status:'succeeded' }) };
  }});
  assert.equal(sent.name, 'P'); assert.equal(sent.description, 'D'); assert.equal(sent.visibility, 'private'); assert.equal(sent.capabilities.processTemplate.templateTypeId, AGILE_PROCESS_TEMPLATE_ID);
});

test('processTemplateId override propagates', async () => {
  let sent;
  await createAdoProject({ organization:'o', name:'P', token:'t', processTemplateId:'custom-template', pollIntervalMs:0, _makeRequestImpl: async (opts) => {
    if (opts.method === 'POST') { sent = JSON.parse(opts.body); return { statusCode:202, body: JSON.stringify({ id:'op', url:'u' }) }; }
    return { statusCode:200, body: JSON.stringify({ status:'succeeded' }) };
  }});
  assert.equal(sent.capabilities.processTemplate.templateTypeId, 'custom-template');
});

// ===== error paths =====

test('poll exhausted after maxPollAttempts → ok:false', async () => {
  const r = await createAdoProject({ organization:'o', name:'P', token:'t', pollIntervalMs:0, maxPollAttempts:2, _makeRequestImpl: async (opts) => opts.method === 'POST' ? { statusCode:202, body: JSON.stringify({ id:'op', url:'u' }) } : { statusCode:200, body: JSON.stringify({ status:'inProgress' }) } });
  assert.equal(r.ok, false); assert.equal(r.operationId, 'op'); assert.match(r.error, /Timed out/);
});

test('202 returned but no operation id → ok:false', async () => {
  const r = await createAdoProject({ organization:'o', name:'P', token:'t', _makeRequestImpl: async () => ({ statusCode:202, body: JSON.stringify({ status:'queued' }) }) });
  assert.equal(r.ok, false); assert.match(r.error, /operation id/);
});

test('400 name conflict → statusCode 409 with Project already exists hint', async () => {
  const r = await createAdoProject({ organization:'o', name:'P', token:'t', _makeRequestImpl: async () => ({ statusCode:400, body: JSON.stringify({ message:'name already exists' }) }) });
  assert.equal(r.ok, false); assert.equal(r.statusCode, 409); assert.equal(r.hint, 'Project already exists');
});

test('401 → ok:false', async () => {
  const r = await createAdoProject({ organization:'o', name:'P', token:'t', _makeRequestImpl: async () => ({ statusCode:401, body:'{}' }) });
  assert.equal(r.ok, false); assert.match(r.hint, /Token rejected/);
});

test('403 → ok:false', async () => {
  const r = await createAdoProject({ organization:'o', name:'P', token:'t', _makeRequestImpl: async () => ({ statusCode:403, body:'{}' }) });
  assert.equal(r.ok, false); assert.match(r.hint, /lacks permission/);
});

test('create-ado-project: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-create-ado-project.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    let header;
    const r = await createAdoProject({ organization: 'org', name: 'proj', tokenFile, _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) }; } });
    assert.equal(r.ok, false);
    assert.equal(header, 'Bearer header.payload.sig');
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
