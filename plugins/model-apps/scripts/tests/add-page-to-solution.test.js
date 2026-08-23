'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-page-to-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('adds appmodule (80) with required components', () => {
  assert.match(scriptSrc, /APPMODULE_COMPONENT_TYPE\s*=\s*80/);
  assert.match(scriptSrc, /addComponent\([^)]*APPMODULE_COMPONENT_TYPE,\s*true\)/);
});

test('adds connection references by confirmed component type', () => {
  assert.match(scriptSrc, /connectionreferences\?\$filter=connectionreferencelogicalname/);
  assert.match(scriptSrc, /CONNECTION_REFERENCE_COMPONENT_TYPE\s*=\s*10158/);
});

test('adds the GenPage uxagentproject explicitly (type 10372)', () => {
  assert.match(scriptSrc, /UXAGENTPROJECT_COMPONENT_TYPE\s*=\s*10372/);
  assert.match(scriptSrc, /flags\['page-ids'\]/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

const { connectionRefsToAdd } = require(scriptPath);

test('connection references are gated by the connectors flag (added only when ON)', () => {
  assert.deepEqual(connectionRefsToAdd(['new_a', 'new_b'], true), ['new_a', 'new_b']);
  assert.deepEqual(connectionRefsToAdd(['new_a', 'new_b'], false), []);
});

// Fail-closed backstop (AGENTS.md → connectors gate checklist item 4). Explicitly requesting
// --connection-refs while the flag is OFF must exit 3 BEFORE any AddSolutionComponent call, so the
// run cannot report success while silently dropping the refs (which would package a solution whose
// connectors are unbound on import).
test('--connection-refs while connectors are OFF exits 3 before any mutation', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'sol', 'app-1', '--connection-refs', 'new_a'],
    { encoding: 'utf8', env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '0' } }
  );
  assert.equal(res.status, 3, 'exit 3 = feature off (distinct from 1 = usage/runtime error)');
  assert.match(res.stderr, /Connector support is disabled/);
  // No Dataverse call was attempted: the env URL is bogus, so any mutation would have surfaced a
  // network/auth error on stderr instead of the clean gate message.
  assert.doesNotMatch(res.stderr, /AddSolutionComponent/);
  assert.doesNotMatch(res.stdout || '', /"ok":\s*true/, 'must not report success');
});

test('no --connection-refs is NOT gated (non-connector packaging proceeds when OFF)', () => {
  // Only an explicit request is refused; ordinary page packaging must still work with the flag OFF.
  // Reaching a Dataverse/auth failure (not exit 3) proves the gate did not fire.
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.invalid', 'sol', 'app-1', '--page-ids', 'p1'],
    { encoding: 'utf8', env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '0' } }
  );
  assert.notEqual(res.status, 3, 'the connectors gate must not fire without --connection-refs');
});
