'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PAC_LOG_SCAN_CHUNK_BYTES,
  PAC_LOG_TAIL_BYTES,
  runPac,
} = require('../lib/pac-command');

const VALID_GUID = '11111111-2222-3333-4444-555555555555';
const MISSING_COMPONENT = `Entity 'powerpagecomponent' With Id = ${VALID_GUID} Does Not Exist`;
const UPLOAD_FAILURE = 'PortalFileContentUploadFailed';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pac-command-test-'));
}

function runFailedPacWithLog(t, log) {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return runPac(['pages', 'upload-code-site'], {
    tmpRoot: root,
    runCommand(command, args, options) {
      fs.writeSync(options.stdio[2], log);
      const error = new Error('PAC command failed');
      error.status = 1;
      throw error;
    },
  });
}

test('runPac classifies stale-manifest signatures across the full bounded log scan', (t) => {
  const result = runFailedPacWithLog(
    t,
    `${MISSING_COMPONENT}\n${'x'.repeat(PAC_LOG_TAIL_BYTES * 2)}\n${UPLOAD_FAILURE}`
  );

  assert.equal(result.diagnostics.staleManifestUploadFailure, true);
  assert.ok(Buffer.byteLength(result.stderr) <= PAC_LOG_TAIL_BYTES);
  assert.match(result.stderr, new RegExp(`${UPLOAD_FAILURE}$`, 'i'));
  assert.doesNotMatch(result.stderr, /powerpagecomponent/i);
});

test('runPac matches a diagnostic signature split across scan chunks', (t) => {
  const splitAt = Math.floor(MISSING_COMPONENT.length / 2);
  const prefix = 'x'.repeat(PAC_LOG_SCAN_CHUNK_BYTES - splitAt);
  const result = runFailedPacWithLog(
    t,
    `${prefix}${MISSING_COMPONENT}\n${UPLOAD_FAILURE}`
  );

  assert.equal(result.diagnostics.staleManifestUploadFailure, true);
});

test('runPac does not classify either stale-manifest signature alone', async (t) => {
  for (const [name, log] of [
    ['missing component only', MISSING_COMPONENT],
    ['upload failure only', UPLOAD_FAILURE],
  ]) {
    await t.test(name, (subtest) => {
      const result = runFailedPacWithLog(subtest, log);
      assert.equal(result.diagnostics.staleManifestUploadFailure, false);
    });
  }
});

test('runPac validates GUIDs and matches stale-manifest signatures case-insensitively', async (t) => {
  await t.test('valid GUID and mixed case', (subtest) => {
    const result = runFailedPacWithLog(
      subtest,
      [
        `eNtItY 'PoWeRpAgEcOmPoNeNt' wItH iD = ${VALID_GUID.toUpperCase()} dOeS nOt ExIsT`,
        'pOrTaLfIlEcOnTeNtUpLoAdFaIlEd',
      ].join('\n')
    );
    assert.equal(result.diagnostics.staleManifestUploadFailure, true);
  });

  await t.test('malformed GUID', (subtest) => {
    const result = runFailedPacWithLog(
      subtest,
      [
        "Entity 'powerpagecomponent' With Id = 11111111-2222-3333-4444-55555555555Z Does Not Exist",
        UPLOAD_FAILURE,
      ].join('\n')
    );
    assert.equal(result.diagnostics.staleManifestUploadFailure, false);
  });
});

test('runPac excludes authentication and blocked-attachment failures from recovery', async (t) => {
  for (const [name, exclusion] of [
    ['authentication failure', 'Authentication failed. Run pac auth create.'],
    ['blocked attachment', 'Blocked file type: .js attachment'],
  ]) {
    await t.test(name, (subtest) => {
      const result = runFailedPacWithLog(
        subtest,
        [MISSING_COMPONENT, UPLOAD_FAILURE, exclusion].join('\n')
      );
      assert.equal(result.diagnostics.staleManifestUploadFailure, false);
    });
  }
});

test('runPac diagnostic metadata contains only the non-sensitive classification', (t) => {
  const fakeToken = 'upload-continuation-token=example-sensitive-value';
  const result = runFailedPacWithLog(
    t,
    [
      fakeToken,
      MISSING_COMPONENT,
      'x'.repeat(PAC_LOG_TAIL_BYTES * 2),
      UPLOAD_FAILURE,
    ].join('\n')
  );

  assert.deepEqual(result.diagnostics, { staleManifestUploadFailure: true });
  const metadata = JSON.stringify(result.diagnostics);
  assert.doesNotMatch(metadata, /continuation-token|powerpagecomponent|11111111/i);
  assert.doesNotMatch(result.stderr, /continuation-token/i);
});

test('runPac preserves the command failure and fails closed when diagnostic scanning fails', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let readCalls = 0;
  const fsImpl = {
    ...fs,
    readSync(...args) {
      readCalls++;
      if (readCalls === 1) throw new Error('diagnostic scan failed');
      return fs.readSync(...args);
    },
  };

  const result = runPac(['pages', 'upload-code-site'], {
    fs: fsImpl,
    tmpRoot: root,
    runCommand(command, args, options) {
      fs.writeSync(options.stdio[2], `${MISSING_COMPONENT}\n${UPLOAD_FAILURE}`);
      const error = new Error('PAC command failed');
      error.status = 7;
      throw error;
    },
  });

  assert.equal(result.status, 7);
  assert.equal(result.diagnostics.staleManifestUploadFailure, false);
  assert.match(result.stderr, /PortalFileContentUploadFailed/);
  assert.deepEqual(fs.readdirSync(root), []);
});
