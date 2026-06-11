const test = require('node:test');
const assert = require('node:assert/strict');
const { fixBlockedAttachments } = require('../lib/fix-blocked-attachments');

const SAMPLE_BLOCKED = 'ade;adp;app;asa;bat;dll;exe;js;jse;vbs;wsh';
const SAMPLE_PAC_OUTPUT = `Connected as admin@example.onmicrosoft.com
Setting            Value
blockedattachments ${SAMPLE_BLOCKED}
`;

function fakeExec(listOut, updateOut) {
  return (cmd) => {
    if (cmd.includes('list-settings')) return listOut;
    if (cmd.includes('update-settings')) return updateOut || "Setting 'blockedattachments' updated successfully";
    return '';
  };
}

test('removes js from blockedattachments', async () => {
  const result = await fixBlockedAttachments({
    extensions: ['js'],
    quiet: true,
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.deepEqual(result.wasBlocked, ['js']);
  assert.deepEqual(result.removed, ['js']);
  assert.equal(result.changed, true);
  assert.ok(!result.newValue.split(';').includes('js'), 'js should be removed');
  assert.ok(result.newValue.split(';').includes('exe'), 'exe should remain');
});

test('removes multiple extensions', async () => {
  const result = await fixBlockedAttachments({
    extensions: ['js', 'jse'],
    quiet: true,
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.deepEqual(result.wasBlocked, ['js', 'jse']);
  assert.equal(result.changed, true);
  assert.ok(!result.newValue.split(';').includes('js'));
  assert.ok(!result.newValue.split(';').includes('jse'));
});

test('no-op when extension not blocked', async () => {
  const result = await fixBlockedAttachments({
    extensions: ['css'],
    quiet: true,
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.deepEqual(result.wasBlocked, []);
  assert.equal(result.changed, false);
  assert.deepEqual(result.unchanged, ['css']);
});

test('dry-run does not call update-settings', async () => {
  let updateCalled = false;
  const result = await fixBlockedAttachments({
    extensions: ['js'],
    dryRun: true,
    quiet: true,
    execImpl: (cmd) => {
      if (cmd.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      if (cmd.includes('update-settings')) { updateCalled = true; return 'ok'; }
      return '';
    },
  });
  assert.equal(updateCalled, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.wasBlocked, ['js']);
});

test('passes --environment arg when envUrl provided', async () => {
  let capturedCmd = null;
  await fixBlockedAttachments({
    envUrl: 'https://staging.crm.dynamics.com',
    extensions: ['js'],
    quiet: true,
    execImpl: (cmd) => {
      capturedCmd = cmd;
      if (cmd.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      return "Setting 'blockedattachments' updated successfully";
    },
  });
  assert.match(capturedCmd, /--environment "https:\/\/staging\.crm\.dynamics\.com"/);
});

test('throws on pac list-settings failure', async () => {
  await assert.rejects(
    () => fixBlockedAttachments({
      extensions: ['js'],
      quiet: true,
      execImpl: () => { throw new Error('pac not authenticated'); },
    }),
    /pac env list-settings failed/,
  );
});

test('throws when blockedattachments line not found in output', async () => {
  await assert.rejects(
    () => fixBlockedAttachments({
      extensions: ['js'],
      quiet: true,
      execImpl: (cmd) => {
        if (cmd.includes('list-settings')) return 'Connected\nSetting not found here\n';
        return '';
      },
    }),
    /Could not parse blockedattachments/,
  );
});


// ===== --check-only envelope tests (V-11) =====

const { toCheckOnlyEnvelope } = require('../lib/fix-blocked-attachments');

test('toCheckOnlyEnvelope: ok=true when no extensions blocked', () => {
  const env = toCheckOnlyEnvelope({
    envUrl: 'https://x',
    wasBlocked: [],
    unchanged: ['js', 'css'],
  });
  assert.equal(env.ok, true);
  assert.equal(env.totalChecked, 2);
  assert.deepEqual(env.blocking, []);
  assert.deepEqual(env.warnings, []);
  assert.deepEqual(env.info, []);
  assert.deepEqual(env.scope, { envUrl: 'https://x' });
});

test('toCheckOnlyEnvelope: ok=false + one BLOCKER per wasBlocked extension', () => {
  const env = toCheckOnlyEnvelope({
    envUrl: 'https://x',
    wasBlocked: ['js'],
    unchanged: [],
  });
  assert.equal(env.ok, false);
  assert.equal(env.blocking.length, 1);
  assert.equal(env.blocking[0].severity, 'blocker');
  assert.equal(env.blocking[0].key, 'blocked-attachment-extension');
  assert.equal(env.blocking[0].ref, 'IL-012');
  assert.equal(env.blocking[0].details.extension, 'js');
  assert.equal(env.blocking[0].details.envUrl, 'https://x');
  assert.match(env.blocking[0].remediation, /without --check-only/);
});

test('toCheckOnlyEnvelope: emits one blocker per blocked extension (js + css)', () => {
  const env = toCheckOnlyEnvelope({
    envUrl: 'https://x',
    wasBlocked: ['js', 'css'],
    unchanged: [],
  });
  assert.equal(env.ok, false);
  assert.equal(env.blocking.length, 2);
  assert.equal(env.blocking[0].details.extension, 'js');
  assert.equal(env.blocking[1].details.extension, 'css');
});

test('toCheckOnlyEnvelope: tolerates missing wasBlocked/unchanged keys', () => {
  const env = toCheckOnlyEnvelope({ envUrl: 'https://x' });
  assert.equal(env.ok, true);
  assert.equal(env.totalChecked, 0);
});

test('fixBlockedAttachments + --check-only flow: result has wasBlocked but env DOES NOT change', async () => {
  let updateCalled = false;
  const result = await fixBlockedAttachments({
    extensions: ['js'],
    quiet: true,
    dryRun: true, // mimic what parseArgs sets when --check-only is given
    execImpl: (cmd) => {
      if (cmd.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      if (cmd.includes('update-settings')) { updateCalled = true; return ''; }
      return '';
    },
  });
  assert.deepEqual(result.wasBlocked, ['js']);
  assert.deepEqual(result.removed, []);   // dry-run: nothing removed
  assert.equal(result.dryRun, true);
  assert.equal(updateCalled, false, 'pac env update-settings must NOT be invoked in check-only/dry-run');
  // Envelope translates this into a blocker.
  const env = toCheckOnlyEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.blocking.length, 1);
});
