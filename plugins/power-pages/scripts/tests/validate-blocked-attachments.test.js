'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBlockedAttachments } = require('../lib/validate-blocked-attachments');

const SAMPLE_BLOCKED_HAS_JS = 'ade;adp;app;asa;bat;dll;exe;js;jse;vbs;wsh';
const SAMPLE_BLOCKED_NO_JS  = 'ade;adp;app;asa;bat;dll;exe;jse;vbs;wsh';
const pacOut = (blocked) => `Connected as x\nSetting            Value\nblockedattachments ${blocked}\n`;

function fakeExec(listOut) {
  return (cmd) => {
    if (cmd.includes('list-settings')) return listOut;
    if (cmd.includes('update-settings')) throw new Error('--check-only must not mutate');
    return '';
  };
}

test('validateBlockedAttachments: ok=true when js NOT in blockedattachments', async () => {
  const r = await validateBlockedAttachments({
    envUrl: 'https://x', extensions: ['js'],
    execImpl: fakeExec(pacOut(SAMPLE_BLOCKED_NO_JS)),
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
});

test('validateBlockedAttachments: ok=false when js IS blocked, exits a single BLOCKER', async () => {
  const r = await validateBlockedAttachments({
    envUrl: 'https://x', extensions: ['js'],
    execImpl: fakeExec(pacOut(SAMPLE_BLOCKED_HAS_JS)),
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].severity, 'blocker');
  assert.equal(r.blocking[0].key, 'blocked-attachment-extension');
  assert.equal(r.blocking[0].ref, 'IL-ATTACH-001');
  assert.equal(r.blocking[0].details.extension, 'js');
  assert.match(r.blocking[0].remediation, /without --check-only/);
});

test('validateBlockedAttachments: does NOT call pac update-settings (read-only)', async () => {
  let mutated = false;
  const r = await validateBlockedAttachments({
    envUrl: 'https://x', extensions: ['js'],
    execImpl: (cmd) => {
      if (cmd.includes('list-settings')) return pacOut(SAMPLE_BLOCKED_HAS_JS);
      if (cmd.includes('update-settings')) { mutated = true; return ''; }
      return '';
    },
  });
  assert.equal(mutated, false);
  assert.equal(r.ok, false);
});

test('validateBlockedAttachments: surfaces underlying errors via {error}', async () => {
  const r = await validateBlockedAttachments({
    envUrl: 'https://x', extensions: ['js'],
    execImpl: () => { throw new Error('pac not authenticated'); },
  });
  assert.ok(r.error);
  assert.match(r.error, /pac env list-settings failed/);
});
