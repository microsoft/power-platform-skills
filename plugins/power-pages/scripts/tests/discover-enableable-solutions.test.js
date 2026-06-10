'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverEnableableSolutions, isSystemSolution, DEFAULT_SYSTEM_PREFIXES, MICROSOFT_DEFAULT_PUBLISHER } = require('../lib/discover-enableable-solutions');

// All tests use DI hooks so they run entirely offline.

// ===== constants =====

test('default system prefixes and MicrosoftDefault publisher are exported', () => {
  assert.deepEqual(DEFAULT_SYSTEM_PREFIXES, ['cr', 'msdyn', 'msft', 'sample']);
  assert.equal(MICROSOFT_DEFAULT_PUBLISHER, 'MicrosoftDefault');
});

// ===== argument validation =====

test('required-arg validation: --envUrl missing', async () => {
  const r=await discoverEnableableSolutions({ token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/envUrl/);
});

// ===== happy path =====

test('happy path with 3 user solutions returned', async () => {
  const value=[1,2,3].map((n)=>({ solutionid:`s${n}`, uniquename:`User${n}`, friendlyname:`User ${n}`, version:'1.0.0.0', modifiedon:`2026-06-0${n}`, publisherid:{ customizationprefix:`u${n}`, uniquename:`Pub${n}` } }));
  const r=await discoverEnableableSolutions({ envUrl:'https://env/', token:'t', _makeRequestImpl: async()=>({ statusCode:200, body:JSON.stringify({ value }) }) });
  assert.equal(r.ok,true); assert.equal(r.envUrl,'https://env'); assert.equal(r.count,3); assert.equal(r.solutions[0].publisherPrefix,'u1');
});

test('empty value array → solutions:[]', async () => {
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:200, body:JSON.stringify({ value:[] }) }) });
  assert.equal(r.ok,true); assert.deepEqual(r.solutions,[]);
});

test('token from _getTokenImpl', async () => {
  let header;
  const r=await discoverEnableableSolutions({ envUrl:'https://env', _getTokenImpl:()=>'minted', _makeRequestImpl: async(opts)=>{ header=opts.headers.Authorization; return { statusCode:200, body:JSON.stringify({ value:[] }) }; } });
  assert.equal(r.ok,true); assert.equal(header,'Bearer minted');
});

test('DI URL contains correct $filter $select $expand $orderby', async () => {
  let url;
  await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async(opts)=>{ url=opts.url; return { statusCode:200, body:JSON.stringify({ value:[] }) }; } });
  assert.match(url, /\$filter=ismanaged eq false and isvisible eq true and enabledforsourcecontrolintegration eq false/);
  assert.match(url, /\$select=solutionid,uniquename,friendlyname,version,modifiedon,_publisherid_value/);
  assert.match(url, /\$expand=publisherid\(\$select=customizationprefix,uniquename\)/);
  assert.match(url, /\$orderby=modifiedon desc/);
});

// ===== filtering =====

test('system-solution exclusion: Default, Active, MicrosoftDefault publisher', async () => {
  const value=[ { solutionid:'d', uniquename:'Default', publisherid:{ customizationprefix:'abc', uniquename:'UserPub' } }, { solutionid:'a', uniquename:'Active', publisherid:{ customizationprefix:'abc', uniquename:'UserPub' } }, { solutionid:'m', uniquename:'UserButMs', publisherid:{ customizationprefix:'abc', uniquename:'MicrosoftDefault' } }, { solutionid:'u', uniquename:'User', publisherid:{ customizationprefix:'abc', uniquename:'UserPub' } } ];
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:200, body:JSON.stringify({ value }) }) });
  assert.equal(r.ok,true); assert.deepEqual(r.solutions.map(s=>s.solutionId), ['u']);
});

test('publisher-prefix exclusion (cr, msdyn)', async () => {
  const value=[ { solutionid:'cr', uniquename:'CrSol', publisherid:{ customizationprefix:'cr', uniquename:'UserPub' } }, { solutionid:'ms', uniquename:'MsSol', publisherid:{ customizationprefix:'msdyn', uniquename:'UserPub' } }, { solutionid:'u', uniquename:'User', publisherid:{ customizationprefix:'abc', uniquename:'UserPub' } } ];
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:200, body:JSON.stringify({ value }) }) });
  assert.equal(r.ok,true); assert.deepEqual(r.solutions.map(s=>s.solutionId), ['u']);
});

test('--includeAllPrefixes bypasses prefix filter', async () => {
  const value=[ { solutionid:'cr', uniquename:'CrSol', publisherid:{ customizationprefix:'cr', uniquename:'UserPub' } } ];
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', includeAllPrefixes:true, _makeRequestImpl: async()=>({ statusCode:200, body:JSON.stringify({ value }) }) });
  assert.equal(r.ok,true); assert.equal(r.count,1);
});

test('isSystemSolution unit cases', () => {
  assert.equal(isSystemSolution({ uniquename:'System', publisherid:{ customizationprefix:'abc' } }), true);
  assert.equal(isSystemSolution({ uniquename:'Custom', publisherid:{ customizationprefix:'sample' } }), true);
  assert.equal(isSystemSolution({ uniquename:'Custom', publisherid:{ customizationprefix:'sample' } }, true), false);
});

// ===== error paths =====

test('401 → ok:false', async () => {
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:401, body:'{}' }) });
  assert.equal(r.ok,false); assert.match(r.hint,/az login/);
});

test('404 → ok:false', async () => {
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:404, body:'{}' }) });
  assert.equal(r.ok,false); assert.match(r.hint,/not found/);
});

test('missing value array → ok:false', async () => {
  const r=await discoverEnableableSolutions({ envUrl:'https://env', token:'t', _makeRequestImpl: async()=>({ statusCode:200, body:'{}' }) });
  assert.equal(r.ok,false); assert.match(r.error,/value array/);
});
