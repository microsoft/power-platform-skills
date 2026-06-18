'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enableSolutionSourceControl, API_VERSION, SYNC_STATUS_SYNCED } = require('../lib/enable-solution-source-control');

// All tests use DI hooks so they run entirely offline.

// ===== constants =====

test('API_VERSION is v9.0 and synced status is 3', () => {
  assert.equal(API_VERSION, 'v9.0'); assert.equal(SYNC_STATUS_SYNCED, 3);
});

// ===== argument validation =====

test('required-arg validation: --envUrl missing', async () => {
  const r=await enableSolutionSourceControl({ solutionId:'s', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/envUrl/);
});
test('required-arg validation: --solutionId missing', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://org.crm.dynamics.com', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/solutionId/);
});

// ===== happy paths =====

test('happy path without poll captures PATCH body string "true"', async () => {
  let body;
  const r=await enableSolutionSourceControl({ envUrl:'https://env.crm.dynamics.com/', solutionId:'{11111111-2222-3333-4444-555555555555}', token:'tok', _makeRequestImpl: async (opts)=>{ body=JSON.parse(opts.body); return { statusCode:204, body:'' }; } });
  assert.equal(r.ok,true); assert.equal(r.polled,false); assert.equal(r.finalSyncStatus,null); assert.equal(body.enabledforsourcecontrolintegration, 'true'); assert.notEqual(body.enabledforsourcecontrolintegration, true);
});

test('DI captures correct URL with v9.0 (not v9.2)', async () => {
  let url;
  await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s1', token:'t', _makeRequestImpl: async (opts)=>{ url=opts.url; return { statusCode:204, body:'' }; } });
  assert.match(url, /\/api\/data\/v9\.0\/solutions\(s1\)$/); assert.doesNotMatch(url, /v9\.2/);
});

test('204 with poll=false → finalSyncStatus:null', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', _makeRequestImpl: async()=>({ statusCode:204, body:'' }) });
  assert.equal(r.ok,true); assert.equal(r.finalSyncStatus,null);
});

test('poll happy path: status 0 then 3 → ok:true', async () => {
  let gets=0;
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', poll:true, pollIntervalMs:0, _makeRequestImpl: async (opts)=>{
    if (opts.method==='PATCH') return { statusCode:204, body:'' };
    gets += 1; return { statusCode:200, body: JSON.stringify({ sourcecontrolsyncstatus: gets === 1 ? 0 : 3, enabledforsourcecontrolintegration:true }) };
  }});
  assert.equal(r.ok,true); assert.equal(r.pollAttempts,2); assert.equal(r.finalSyncStatus,3);
});

test('poll timeout: status stays 0 → ok:true timedOut:true', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', poll:true, pollIntervalMs:0, maxPollAttempts:2, _makeRequestImpl: async (opts)=> opts.method==='PATCH' ? { statusCode:204, body:'' } : { statusCode:200, body: JSON.stringify({ sourcecontrolsyncstatus:0 }) } });
  assert.equal(r.ok,true); assert.equal(r.timedOut,true); assert.equal(r.finalSyncStatus,0);
});

test('token from _getTokenImpl used when --token omitted', async () => {
  let header;
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', _getTokenImpl: ()=>'minted', _makeRequestImpl: async (opts)=>{ header=opts.headers.Authorization; return { statusCode:204, body:'' }; } });
  assert.equal(r.ok,true); assert.equal(header, 'Bearer minted');
});

test('DI captures Authorization: Bearer header', async () => {
  let header;
  await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'tok', _makeRequestImpl: async (opts)=>{ header=opts.headers.Authorization; return { statusCode:204, body:'' }; } });
  assert.equal(header, 'Bearer tok');
});

// ===== error paths =====

test('poll abort on 404 mid-poll → ok:false', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', poll:true, pollIntervalMs:0, _makeRequestImpl: async (opts)=> opts.method==='PATCH' ? { statusCode:204, body:'' } : { statusCode:404, body:'{}' } });
  assert.equal(r.ok,false); assert.equal(r.statusCode,404);
});

test('404 on PATCH → ok:false with hint', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', _makeRequestImpl: async()=>({ statusCode:404, body:'{}' }) });
  assert.equal(r.ok,false); assert.match(r.hint,/Solution s not found/);
});

test('401 on PATCH → ok:false with az login hint', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', _makeRequestImpl: async()=>({ statusCode:401, body:'{}' }) });
  assert.equal(r.ok,false); assert.match(r.hint,/az login/);
});

test('non-204 on PATCH → ok:false', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', token:'t', _makeRequestImpl: async()=>({ statusCode:400, body: JSON.stringify({ error:{ message:'bad' } }) }) });
  assert.equal(r.ok,false); assert.equal(r.error,'bad');
});

test('no token and _getTokenImpl null → ok:false', async () => {
  const r=await enableSolutionSourceControl({ envUrl:'https://env', solutionId:'s', _getTokenImpl:()=>null });
  assert.equal(r.ok,false); assert.match(r.error,/token/);
});
