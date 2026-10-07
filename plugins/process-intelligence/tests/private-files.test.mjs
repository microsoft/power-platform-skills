// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { PrivateDirectory } from '../src/private-files.mjs';
import { runProcess } from '../src/process.mjs';

const windows = { skip: process.platform !== 'win32' };
const syntheticSid = 'S-1-5-21-111-222-333-1001';

async function fixture(t, sid, sddl) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-acl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spawn = childProcess.spawn;
  const calls = [];
  // Exercise the real preparation/parser without switching OS users or changing
  // real ACLs. Alias resolution still executes the native Windows SID conversion.
  const mock = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const name = path.basename(executable).toLowerCase();
    calls.push(name);
    if (name === 'powershell.exe') return spawn(executable, args, options);
    assert.ok(['whoami.exe', 'icacls.exe'].includes(name));
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null
    });
    setImmediate(async () => {
      try {
        if (name === 'whoami.exe') child.stdout.write(`"fixture\\user","${sid}"\r\n`);
        if (args.includes('/save')) {
          await fs.writeFile(args[args.indexOf('/save') + 1],
            `${path.basename(root)}\r\n${sddl}\r\n`, 'utf16le');
        }
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 0;
        child.emit('close', 0);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return { directory: new PrivateDirectory(root), root, calls };
}

test('Windows numeric SID verification needs no alias resolver', windows, async t => {
  const { directory, calls } = await fixture(t, syntheticSid,
    `D:P(A;OICI;FA;;;${syntheticSid})`);
  await directory.prepare();
  assert.equal(calls.includes('powershell.exe'), false);
});

test('Windows local Administrator SDDL alias resolves to the exact native SID', windows, async t => {
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "[System.Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)').DiscretionaryAcl[0].SecurityIdentifier.Value";
  const native = await runProcess(executable,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  assert.equal(native.code, 0);
  const sid = native.stdout.trim();
  assert.match(sid, /^S-1-5-21-\d+-\d+-\d+-500$/);
  const { directory, root } = await fixture(t, sid, 'D:P(A;OICI;FA;;;LA)');
  await directory.prepare();
  assert.deepEqual(await fs.readdir(root), [], 'ACL exports must be cleaned up');
});

for (const [name, sddl, sid = syntheticSid] of [
  ['another local account', 'D:P(A;OICI;FA;;;LA)'],
  ['another domain Administrator with the same RID', 'D:P(A;OICI;FA;;;LA)',
    'S-1-5-21-111-222-333-500'],
  ['an administrator group', 'D:P(A;OICI;FA;;;BA)'],
  ['an unknown alias', 'D:P(A;OICI;FA;;;ZZ)'],
  ['additional access', `D:P(A;OICI;FA;;;${syntheticSid})(A;OICI;FA;;;BA)`],
  ['inherited access', `D:P(A;OICIID;FA;;;${syntheticSid})`],
  ['unprotected DACL', `D:(A;OICI;FA;;;${syntheticSid})`],
  ['different rights', `D:P(A;OICI;FR;;;${syntheticSid})`],
  ['a different numeric SID', 'D:P(A;OICI;FA;;;S-1-5-21-111-222-333-500)']
]) {
  test(`Windows private ACL rejects ${name}`, windows, async t => {
    const { directory, root } = await fixture(t, sid, sddl);
    await assert.rejects(directory.prepare(), { errorCode: 'STATE_ACCESS_DENIED' });
    assert.deepEqual(await fs.readdir(root), []);
  });
}
