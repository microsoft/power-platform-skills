const test = require('node:test');
const assert = require('node:assert/strict');
const { fixBlockedAttachments } = require('../lib/fix-blocked-attachments');

const SAMPLE_BLOCKED = 'ade;adp;app;asa;bat;dll;exe;js;jse;vbs;wsh';
const SAMPLE_PAC_OUTPUT = `Connected as admin@example.onmicrosoft.com
Setting            Value
blockedattachments ${SAMPLE_BLOCKED}
`;

function fakeExec(listOut, updateOut) {
  return (file, args) => {
    assert.equal(file, 'pac');
    if (args.includes('list-settings')) return listOut;
    if (args.includes('update-settings')) return updateOut || "Setting 'blockedattachments' updated successfully";
    return '';
  };
}

test('removes js from blockedattachments', async () => {
  const result = await fixBlockedAttachments({
    extensions: ['js'],
    quiet: true,
    execFileImpl: fakeExec(SAMPLE_PAC_OUTPUT),
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
    execFileImpl: fakeExec(SAMPLE_PAC_OUTPUT),
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
    execFileImpl: fakeExec(SAMPLE_PAC_OUTPUT),
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
    execFileImpl: (file, args) => {
      assert.equal(file, 'pac');
      if (args.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      if (args.includes('update-settings')) { updateCalled = true; return 'ok'; }
      return '';
    },
  });
  assert.equal(updateCalled, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.wasBlocked, ['js']);
});

test('passes --environment as a separate argv element when envUrl is provided', async () => {
  const calls = [];
  await fixBlockedAttachments({
    envUrl: 'https://staging.crm.dynamics.com',
    extensions: ['js'],
    quiet: true,
    execFileImpl: (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      return "Setting 'blockedattachments' updated successfully";
    },
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, 'pac');
    assert.equal(call.options.shell, false);
    const environmentIndex = call.args.indexOf('--environment');
    assert.notEqual(environmentIndex, -1);
    assert.equal(call.args[environmentIndex + 1], 'https://staging.crm.dynamics.com');
  }
});

test('does not interpret shell metacharacters in the environment URL', async () => {
  const maliciousUrl = 'https://staging.crm.dynamics.com/"; touch PWNED; #';
  const calls = [];

  await fixBlockedAttachments({
    envUrl: maliciousUrl,
    extensions: ['js'],
    quiet: true,
    execFileImpl: (file, args) => {
      calls.push({ file, args });
      if (args.includes('list-settings')) return SAMPLE_PAC_OUTPUT;
      return "Setting 'blockedattachments' updated successfully";
    },
  });

  assert.equal(calls[0].file, 'pac');
  assert.ok(calls[0].args.includes(maliciousUrl));
});

test('throws on pac list-settings failure', async () => {
  await assert.rejects(
    () => fixBlockedAttachments({
      extensions: ['js'],
      quiet: true,
      execFileImpl: () => { throw new Error('pac not authenticated'); },
    }),
    /pac env list-settings failed/,
  );
});

test('throws when blockedattachments line not found in output', async () => {
  await assert.rejects(
    () => fixBlockedAttachments({
      extensions: ['js'],
      quiet: true,
      execFileImpl: (file, args) => {
        if (args.includes('list-settings')) return 'Connected\nSetting not found here\n';
        return '';
      },
    }),
    /Could not parse blockedattachments/,
  );
});
