'use strict';
// A persistent `.maker-workspace` belongs to the ONE environment it was first opened for: the vendored SDK
// records that environment in the workspace manifest and refuses an SDK for another one
// (`WORKSPACE_ORG_MISMATCH`) before it reads or writes anything. The plugin can be pointed at another
// environment from the same app folder, so the one entry point that opens the app folder's workspace — a build
// with --apply — has to turn that refusal into a halt an operator can act on. A dry run and the standalone verify
// never open it: their SDKs read only the server, in a throwaway workspace of their own, so a preview creates and
// binds nothing, and from a folder that belongs to another environment it previews as normal and only warns that an
// --apply would stop.
//
// What is pinned here, and why each part drives the REAL bundle rather than a stub:
//   - the halt names both environments (normalized origins only) and the safe remedies, and never offers to
//     clear or re-bind the workspace itself — the SDK's saved copies in it can hold unpushed edits, and the
//     receipts and baseline beside them are the other environment's;
//   - a workspace that was only ever OPENED for another environment (the SDK's empty folders and manifest, nothing
//     saved) is told apart from one a build saved into: nothing was built there, so there is no environment to go
//     back to and nothing for a teardown to remove;
//   - the teardown remedy clears the folder the halt names, and is offered only for ANOTHER environment: two
//     spellings of one environment (the `.api.` host, a manifest with a path or port) get a halt of their own;
//   - the folder is printed on its own line and the teardown command refers to it, never embeds it: no quoting of
//     a path is right for every shell;
//   - a manifest the JSON parser rejects gets a halt of its own, not the parser's message — and only a MANIFEST does: a saved
//     copy that is not JSON throws the same error when the SDK lists, so the dry run asks the folder for its manifest and
//     nothing else, and an --apply that opens the folder is not halted by a copy;
//   - nothing is read from or written to the foreign workspace, and no request is sent;
//   - a spelling of the SAME environment the bundle accepts is not a mismatch, so no run is halted that did not
//     need to be.
// The bundle's own decision (which URLs name one environment) is deliberately NOT re-implemented in the plugin:
// a stub that mimicked it would stay green if the SDK changed it.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { scriptsMatching } = require('./helpers/production-scripts.js');
const { isWorkspaceOrgMismatch, workspaceBindingError, workspaceBindingNote } = require('../lib/workspace-binding.js');
const { recordPageCreation } = require('../lib/page-ownership-records.js');

const scriptsDir = path.join(__dirname, '..');
const BUNDLE = path.join(scriptsDir, 'vendor', 'cds-maker-sdk.cjs');
const WORKSPACE_ENV = 'https://contoso.crm.dynamics.com';
const RUN_ENV = 'https://fabrikam.crm.dynamics.com';
// A folder that does not exist, for halts built from a hand-made error: nothing in the plugin looks inside it.
const NO_SUCH_FOLDER = path.join(os.tmpdir(), 'binding-no-such-workspace', '.maker-workspace');
// What `fs.symlinkSync` is given to link a folder without needing a privilege: a junction on Windows (a symbolic link needs
// one there), a symbolic link elsewhere. Node's directory listing reports either as a link, never as a directory.
const FOLDER_LINK = process.platform === 'win32' ? 'junction' : 'dir';

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// An HttpClient that fails the test the moment anything is sent: a refusal must come before any request.
function inertClient(requests = []) {
  const refuse = (verb) => async (url) => { requests.push(`${verb} ${url}`); throw new Error(`unexpected ${verb} ${url}`); };
  return { get: refuse('GET'), post: refuse('POST'), patch: refuse('PATCH'), delete: refuse('DELETE'), put: refuse('PUT'), postRaw: refuse('POST') };
}

// A workspace the real bundle created for `instanceUrl`. Alone it is exactly what OPENING a workspace leaves: the SDK's
// manifest and its empty folders, nothing saved. `built` adds the baseline a build that finished writes beside them, so
// the folder holds something, as one a build was run in does.
async function workspaceFor(instanceUrl, dir = tempDir('binding-ws-'), { built = false } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl, httpClient: inertClient() });
  await sdk.initWorkspace();
  if (built) fs.writeFileSync(path.join(dir, 'last-applied.json'), '{}\n');
  return dir;
}

// The error the bundle raises when an SDK for `instanceUrl` opens `dir` — the refusal of another environment's
// workspace, or whatever else it throws (a manifest that is not JSON surfaces the parser's SyntaxError).
async function mismatchFrom(dir, instanceUrl) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl, httpClient: inertClient() });
  try {
    await sdk.initWorkspace();
  } catch (err) {
    return err;
  }
  throw new Error('expected the bundle to refuse this workspace');
}

// Every file under `dir` with the hash of its bytes, so "nothing was written" is a comparison, not a hope.
function treeOf(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(dir, full)}/`] = 'dir'; walk(full); }
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// --- the helper ------------------------------------------------------------------------------------

test('isWorkspaceOrgMismatch recognizes the bundle\u2019s refusal and nothing else', async () => {
  const dir = await workspaceFor(WORKSPACE_ENV);
  const err = await mismatchFrom(dir, RUN_ENV);
  assert.strictEqual(err.code, 'WORKSPACE_ORG_MISMATCH', 'the bundle still reports the refusal by this code');
  assert.strictEqual(isWorkspaceOrgMismatch(err), true);
  for (const other of [null, undefined, 'WORKSPACE_ORG_MISMATCH', new Error('boom'), new TypeError('boom'), Object.assign(new Error('x'), { code: 'WORKSPACE_NOT_INITIALIZED' }), Object.assign(new Error('Unexpected token } in JSON at position 3'), { code: 'EACCES' })]) {
    assert.strictEqual(isWorkspaceOrgMismatch(other), false, String(other));
    assert.strictEqual(workspaceBindingError(other, { env: RUN_ENV, workspaceDir: dir }), null, 'any other error is left for the caller to rethrow as it is');
  }
});

test('the halt names both environments as normalized origins and the three safe remedies', async () => {
  // The workspace was opened with a trailing slash and capitals; the run's --env is spelled plainly.
  const dir = await workspaceFor('https://Contoso.crm.dynamics.com/', undefined, { built: true });
  const halt = workspaceBindingError(await mismatchFrom(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.ok(halt instanceof Error);
  assert.strictEqual(halt.code, 'WORKSPACE_ORG_MISMATCH');
  assert.strictEqual(halt.workspaceEnvironment, WORKSPACE_ENV, 'normalized: lower case, no trailing slash');
  assert.strictEqual(halt.environment, RUN_ENV);
  const text = halt.message;
  assert.match(text, /belongs to a different environment/);
  assert.ok(text.includes(WORKSPACE_ENV) && text.includes(RUN_ENV), `both environments are named: ${text}`);
  assert.ok(text.split('\n').some((line) => line.trim() === dir), 'the workspace folder is printed alone on a line, so the operator knows which folder it is and can copy it exactly');
  assert.ok(!/Contoso/.test(text), 'only the normalized spelling is shown, never the manifest\u2019s text');
  // Remedy 1: the environment it belongs to, as an exact --env the operator can paste.
  assert.ok(text.includes(`--env ${WORKSPACE_ENV}`), text);
  // Remedy 2: a fresh app folder or --workspace.
  assert.match(text, /fresh app folder/);
  assert.match(text, /--workspace <a new folder>/);
  // Remedy 3: the teardown that retires the old copy — said plainly to DELETE from the other environment — with the
  // rule that already protects the receipts. It names the folder it clears: teardown clears `--workspace`, else the
  // folder beside its spec, and without the flag it would clear a different one than the folder this halt is about.
  // The folder is the line above, not an argument: see the test of a path no shell would read back as it is.
  assert.match(text, /teardown-model-app\.js --env https:\/\/contoso\.crm\.dynamics\.com .*--clear-workspace/);
  assert.ok(text.includes('--workspace <the folder printed above> --apply --allow-destructive --clear-workspace'), text);
  assert.match(text, /only if that environment's copy of the app is no longer wanted/);
  assert.match(text, /DELETES what the spec declares from https:\/\/contoso\.crm\.dynamics\.com/);
  assert.match(text, /page-ownership receipt/);
  // The SDK's own advice is an API call this plugin's operator cannot make — and one the plugin must never make for them.
  assert.ok(!/cleanWorkspace/.test(text), text);
  assert.match(text, /never clears or re-binds/);
});

test('the halt says precisely what is in the folder and what clearing it would cost', async () => {
  // The SDK's own remedy discards ITS saved copies, metadata and baselines — only its own folders. What is at risk is
  // therefore those copies (an edit in one that was never pushed is lost with it); the page-ownership receipts and the
  // plugin's baseline live beside them and are the other environment's too. Neither more nor less is claimed.
  const dir = await workspaceFor(WORKSPACE_ENV, undefined, { built: true });
  const text = workspaceBindingError(await mismatchFrom(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir }).message;
  assert.match(text, /saved copies of this app's artifacts, their metadata and baselines in that folder are https:\/\/contoso\.crm\.dynamics\.com's/);
  assert.match(text, /discards those saved copies, including any edit made in them that was never pushed/);
  assert.match(text, /page-ownership receipts and the baseline \(last-applied\.json\) kept beside them are https:\/\/contoso\.crm\.dynamics\.com's too/);
  assert.ok(!/which no re-run can rebuild|its page-ownership receipts and its baseline, and the ids/.test(text), 'the claim that clearing deletes the receipts and the baseline is not made');
});

test('a folder given relative is named by its absolute path, alone on its line', () => {
  const err = Object.assign(new Error('sdk'), { code: 'WORKSPACE_ORG_MISMATCH', workspaceInstanceUrl: WORKSPACE_ENV, instanceUrl: RUN_ENV });
  const relative = path.join('my app', '.maker-workspace');
  const text = workspaceBindingError(err, { env: RUN_ENV, workspaceDir: relative }).message;
  const absolute = path.resolve(relative);
  assert.ok(text.split('\n').includes(`  ${absolute}`), text);
  assert.ok(!text.includes(`"${absolute}"`), 'and it is not wrapped in quotes a shell would read');
});

test('the teardown command refers to the folder instead of embedding it: a $ in a path is expanded inside double quotes by PowerShell and POSIX shells', () => {
  // `--workspace "C:\apps\$work\.maker-workspace"` reads `$work` as a variable in PowerShell and in bash/zsh, so teardown
  // would clear whatever folder the expansion names — or none, and then the build halts again. Single quotes avoid that
  // there but are not quotes in cmd.exe, so no quoting of the path is right for every shell. The folder is therefore
  // printed on its own line, and the operator is told to pass it as --workspace, quoted for the shell they use.
  const folder = path.join(path.resolve(os.tmpdir()), 'apps', '$work', 'it\u0027s `mine`', '.maker-workspace');
  const err = Object.assign(new Error('sdk'), { code: 'WORKSPACE_ORG_MISMATCH', workspaceInstanceUrl: WORKSPACE_ENV, instanceUrl: RUN_ENV });
  const text = workspaceBindingError(err, { env: RUN_ENV, workspaceDir: folder }).message;
  const lines = text.split('\n');
  assert.ok(lines.includes(`  ${folder}`), `the folder is printed alone on its line, exactly as it is: ${text}`);
  const teardown = lines.find((line) => /teardown-model-app\.js/.test(line));
  assert.ok(teardown, text);
  assert.ok(!teardown.includes(folder) && !teardown.includes('$work'), `the command carries no path for a shell to expand: ${teardown}`);
  assert.match(teardown, /--workspace <the folder printed above> --apply --allow-destructive --clear-workspace/);
  assert.ok(!/--workspace ["']/.test(text), 'no quoted path is offered anywhere');
  // What to do instead, and why: said where the operator reads the command.
  assert.match(text, /quoted for your shell/);
  assert.match(text, /single quotes in PowerShell, bash and zsh/);
  assert.match(text, /double quotes there still expand \$/);
  assert.match(text, /cmd\.exe/);
  assert.match(text, /clears the folder beside its spec/, 'and why --workspace is not optional');
});

test('a `.api.` label names the same environment on a Dataverse host in any cloud, and is just a label anywhere else', () => {
  const halt = (recorded, run) => workspaceBindingError(
    Object.assign(new Error('sdk'), { code: 'WORKSPACE_ORG_MISMATCH', workspaceInstanceUrl: recorded, instanceUrl: run }),
    { env: run, workspaceDir: NO_SUCH_FOLDER },
  ).message;
  for (const [recorded, run] of [
    ['https://contoso.api.crm.dynamics.com', 'https://contoso.crm.dynamics.com'],
    ['https://contoso.crm4.dynamics.com', 'https://contoso.api.crm4.dynamics.com'],
    ['https://contoso.crm.microsoftdynamics.us', 'https://contoso.api.crm.microsoftdynamics.us'],
    ['https://contoso.api.crm.dynamics.cn', 'https://contoso.crm.dynamics.cn'],
  ]) {
    assert.match(halt(recorded, run), /two host names of one environment/, `${recorded} / ${run}`);
  }
  for (const [recorded, run] of [
    ['https://tools.api.example.com', 'https://tools.example.com'],
    ['https://contoso.api.crm.dynamics.com', 'https://contoso2.crm.dynamics.com'],
    ['https://api.crm.dynamics.com', 'https://crm.dynamics.com'],
  ]) {
    assert.match(halt(recorded, run), /belongs to a different environment/, `${recorded} / ${run}`);
  }
});

test('a manifest URL carrying credentials, a path or a query is shown as its origin only', () => {
  const err = Object.assign(new Error('sdk text that must not be echoed'), {
    code: 'WORKSPACE_ORG_MISMATCH',
    workspaceInstanceUrl: 'https://user:hunter2@Contoso.crm.dynamics.com/main.aspx?token=abc123#frag',
    instanceUrl: RUN_ENV,
  });
  const halt = workspaceBindingError(err, { env: RUN_ENV, workspaceDir: 'C:\\apps\\desk\\.maker-workspace' });
  assert.strictEqual(halt.workspaceEnvironment, WORKSPACE_ENV);
  for (const secret of ['hunter2', 'abc123', 'main.aspx', 'frag', 'sdk text that must not be echoed']) {
    assert.ok(!halt.message.includes(secret), `${secret} must not reach the message: ${halt.message}`);
  }
});

test('a workspace that records no usable environment is described as such, offers no --env remedy, and is moved aside rather than deleted', () => {
  for (const recorded of ['', undefined, 'not a url at all', 'ftp://contoso.crm.dynamics.com']) {
    const err = Object.assign(new Error('sdk'), { code: 'WORKSPACE_ORG_MISMATCH', workspaceInstanceUrl: recorded, instanceUrl: RUN_ENV });
    const halt = workspaceBindingError(err, { env: RUN_ENV, workspaceDir: NO_SUCH_FOLDER });
    assert.strictEqual(halt.workspaceEnvironment, null, String(recorded));
    assert.strictEqual(halt.code, 'WORKSPACE_ORG_MISMATCH', 'it is the SDK\u2019s refusal, so it keeps its code');
    assert.ok(halt.message.includes(RUN_ENV), halt.message);
    assert.match(halt.message, /records no usable environment/);
    // No `--env` anywhere: there is no environment to go back to, and no other flag may be mistaken for one.
    assert.ok(!/--env\b/.test(halt.message), `there is no environment to go back to: ${halt.message}`);
    assert.ok(!/teardown-model-app|DELETES/.test(halt.message), 'and nothing to tear down');
    assert.ok(!/not a url at all/.test(halt.message), 'unparseable text is never echoed');
    assert.match(halt.message, /fresh app folder/);
    assertMovedAside(halt.message);
  }
});

// What the operator is told to do with a folder whose manifest names no environment. It is MOVED, not deleted: the folder can hold the
// page-ownership receipts (the proof a rebuild needs to update pages it created) and the baseline (last-applied.json), and neither is
// something a new workspace gets back.
function assertMovedAside(text) {
  assert.match(text, /move the folder aside \(rename it\)/);
  assert.match(text, /do not delete it/i);
  assert.match(text, /page-ownership receipts/);
  assert.match(text, /last-applied\.json/);
  assert.ok(!/remove the folder yourself|if you are sure nothing in this one is needed/.test(text), `deleting is not what is advised: ${text}`);
  assert.match(text, /never clears or re-binds/);
}

test('a manifest the JSON parser rejects is a halt of its own: the folder named, the parser\u2019s text not echoed, moved aside rather than deleted', () => {
  // The SDK reads manifest.json with JSON.parse and lets the SyntaxError out as it is — no code, a position, and on newer
  // Node versions a quote of the file. It is recognized by its name, not its text, which differs between versions.
  const folder = path.join(tempDir('binding-bad-'), '.maker-workspace');
  for (const raw of [new SyntaxError('Unterminated string in JSON at position 36'), Object.assign(new Error('Unexpected end of JSON input'), { name: 'SyntaxError' })]) {
    const halt = workspaceBindingError(raw, { env: RUN_ENV, workspaceDir: folder });
    assert.ok(halt instanceof Error && halt !== raw, 'the parser\u2019s error is turned into the halt');
    assert.strictEqual(halt.code, 'WORKSPACE_MANIFEST_INVALID');
    assert.strictEqual(halt.workspaceEnvironment, null);
    assert.strictEqual(halt.environment, RUN_ENV);
    const text = halt.message;
    assert.ok(text.split('\n').includes(`  ${folder}`), `the folder is named alone on its line: ${text}`);
    assert.match(text, /manifest\.json that is not valid JSON/);
    assert.ok(text.includes(RUN_ENV), 'and the environment this run targets');
    assert.ok(!/Unterminated|position 36|end of JSON input/.test(text), `the parser\u2019s text can quote the file and is never echoed: ${text}`);
    assert.ok(!/--env\b/.test(text), `there is no environment to go back to: ${text}`);
    assert.ok(!/teardown-model-app|DELETES/.test(text), 'and nothing to tear down');
    assert.match(text, /fresh app folder/);
    assertMovedAside(text);
  }
});

// --- a workspace nothing was ever saved in -------------------------------------------------------------

// What opening a workspace leaves alone: the SDK's manifest, with no artifact, and its empty folders. An earlier preview, or a
// build that stopped at its start, leaves exactly this for the environment it ran against — and nothing was built there.
test('a workspace that was only ever opened for another environment is described as that: nothing saved, nothing built there, nothing to tear down', async () => {
  const dir = await workspaceFor(WORKSPACE_ENV);
  const halt = workspaceBindingError(await mismatchFrom(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  const text = halt.message;
  assert.strictEqual(halt.code, 'WORKSPACE_ORG_MISMATCH');
  assert.strictEqual(halt.workspaceEnvironment, WORKSPACE_ENV);
  assert.ok(text.includes(WORKSPACE_ENV) && text.includes(RUN_ENV), `both environments are named: ${text}`);
  assert.ok(text.split('\n').includes(`  ${dir}`), 'the folder is named alone on its line');
  assert.match(text, /only ever opened for https:\/\/contoso\.crm\.dynamics\.com/);
  assert.match(text, /holds nothing a build saved/);
  assert.match(text, /nothing was built there/);
  // No build-there or teardown advice: there is nothing in that environment to go back to or to delete.
  assert.ok(!text.includes(`--env ${WORKSPACE_ENV}`), `no environment to go back to: ${text}`);
  assert.ok(!/teardown-model-app|DELETES|--clear-workspace/.test(text), text);
  assert.ok(!/saved copies of this app's artifacts|belongs to a different environment/.test(text), 'the account of a folder with saved work is not given for one without');
  // What is safe to do, and that the plugin leaves doing it to the operator.
  assert.match(text, /delete the folder \(it holds nothing\), or move it aside, and run again/);
  assert.match(text, /fresh app folder/);
  assert.match(text, /never clears or re-binds/);
});

// Anything besides the SDK's own empty scaffold is something a build left, and the full account comes back. Each of these
// is written by the code that really writes it; the manifest ones are what the SDK itself would record. The two links are
// not something a build writes: they are what the check refuses to guess about. A link can lead anywhere, so it is never taken
// for an empty folder — and these lead to one, so a check that followed links would find nothing in them and call the
// workspace "only opened".
const SOMETHING_SAVED = {
  'the baseline of a build that finished': (dir) => fs.writeFileSync(path.join(dir, 'last-applied.json'), '{}\n'),
  'a page-ownership receipt': (dir) => recordPageCreation(dir, 'new_app', 'overview', '11111111-1111-4111-8111-111111111111', 'Overview', WORKSPACE_ENV),
  'the build journal': (dir) => fs.writeFileSync(path.join(dir, 'build-log.jsonl'), '{"event":"start"}\n'),
  'the live progress file': (dir) => fs.writeFileSync(path.join(dir, 'build-status.json'), '{}\n'),
  'a destructive-approval record': (dir) => fs.writeFileSync(path.join(dir, 'destructive-approval.json'), '{}\n'),
  'a saved copy of an artifact': (dir) => fs.writeFileSync(path.join(dir, 'apps', '11111111-1111-4111-8111-111111111111.json'), '{}'),
  'the saved metadata of an artifact': (dir) => fs.writeFileSync(path.join(dir, '.metadata', 'views', 'v.meta.json'), '{}'),
  'cached table metadata': (dir) => fs.writeFileSync(path.join(dir, '.metadata', 'entities', 'new_ticket.json'), '{}'),
  'files the plugin staged for a deploy': (dir) => {
    fs.mkdirSync(path.join(dir, '.pageref-deploy', 'run-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pageref-deploy', 'run-1', 'page.tsx'), 'export {}\n');
  },
  'a manifest that lists an artifact': (dir) => {
    const file = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.artifacts.push({ type: 'app', id: '11111111-1111-4111-8111-111111111111', name: 'Support Desk' });
    fs.writeFileSync(file, JSON.stringify(manifest));
  },
  'a manifest that does not say it lists nothing': (dir) => {
    const file = path.join(dir, 'manifest.json');
    const { artifacts, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(rest));
  },
  'a file of the operator\u2019s own': (dir) => fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept\n'),
  // The two places the check looks at an entry's kind: the folder's own entries, and the entries inside a folder of the scaffold.
  'a link where one of the SDK\u2019s folders would be': (dir) => {
    fs.rmdirSync(path.join(dir, 'apps'));
    fs.symlinkSync(tempDir('binding-link-'), path.join(dir, 'apps'), FOLDER_LINK);
  },
  'a link inside one of the SDK\u2019s folders': (dir) => {
    fs.rmdirSync(path.join(dir, '.metadata', 'views'));
    fs.symlinkSync(tempDir('binding-link-'), path.join(dir, '.metadata', 'views'), FOLDER_LINK);
  },
};
for (const [what, add] of Object.entries(SOMETHING_SAVED)) {
  test(`a workspace holding ${what} gets the full account, not the only-opened one`, async () => {
    const dir = await workspaceFor(WORKSPACE_ENV);
    add(dir);
    const text = workspaceBindingError(await mismatchFrom(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir }).message;
    assert.match(text, /belongs to a different environment/);
    assert.ok(text.includes(`--env ${WORKSPACE_ENV}`), text);
    assert.match(text, /teardown-model-app\.js/);
    assert.ok(!/only ever opened|holds nothing a build saved/.test(text), text);
  });
}

// --- what a dry run says about the folder it did not use ----------------------------------------------

// The read-only probe a dry run puts to the folder: a real SDK over it, which the plugin asks for its manifest and nothing else.
function probeFor(dir, instanceUrl) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  return createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl, httpClient: inertClient() });
}

test('the preview note: a folder that belongs to this environment, or has no workspace yet, gets none — and asking opens and writes nothing', async () => {
  const nowhere = path.join(tempDir('binding-note-'), 'nowhere');
  assert.strictEqual(await workspaceBindingNote(probeFor(nowhere, RUN_ENV), { env: RUN_ENV, workspaceDir: nowhere }), null);
  assert.ok(!fs.existsSync(nowhere), 'a folder that is not there is not created');
  const empty = tempDir('binding-note-empty-');
  assert.strictEqual(await workspaceBindingNote(probeFor(empty, RUN_ENV), { env: RUN_ENV, workspaceDir: empty }), null);
  assert.deepStrictEqual(fs.readdirSync(empty), [], 'a folder with no manifest is not opened');
  // The bundle decides what is the same environment: case and trailing slashes are not a mismatch.
  for (const spelled of [RUN_ENV, 'https://Fabrikam.crm.dynamics.com//', 'HTTPS://FABRIKAM.CRM.DYNAMICS.COM']) {
    const own = await workspaceFor(spelled, undefined, { built: true });
    const before = treeOf(own);
    assert.strictEqual(await workspaceBindingNote(probeFor(own, RUN_ENV), { env: RUN_ENV, workspaceDir: own }), null, spelled);
    assert.deepStrictEqual(treeOf(own), before, 'and nothing in it is touched');
  }
});

test('the preview note for another environment\u2019s folder: the preview ran as normal, an --apply would stop, and no destructive remedy is offered', async () => {
  const dir = await workspaceFor(WORKSPACE_ENV, undefined, { built: true });
  const before = treeOf(dir);
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.deepStrictEqual(treeOf(dir), before, 'the probe wrote nothing');
  assert.match(note, /^this preview works in a temporary workspace, so it ran as normal; a build with --apply would stop before reading or writing anything in this app's workspace folder, which belongs to a different environment:\n/);
  assert.ok(note.split('\n').includes(`  ${dir}`), 'the folder is named alone on its line');
  assert.ok(note.includes(WORKSPACE_ENV) && note.includes(RUN_ENV), note);
  assert.ok(note.includes(`--env ${WORKSPACE_ENV}`), 'the way to apply here is named');
  assert.match(note, /fresh app folder/);
  assert.ok(!/teardown-model-app|DELETES|--clear-workspace/.test(note), 'a destructive remedy belongs to the --apply that is refused, not to a preview');
  assert.ok(!/stopped before/.test(note), 'nothing has stopped');
});

test('the preview note for a folder that was only ever opened says so, and that it can simply go', async () => {
  const dir = await workspaceFor(WORKSPACE_ENV);
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.match(note, /which was only ever opened for another environment:\n/);
  assert.match(note, /holds nothing a build saved/);
  assert.ok(!note.includes(`--env ${WORKSPACE_ENV}`) && !/teardown-model-app|DELETES/.test(note), note);
  assert.match(note, /delete the folder \(it holds nothing\), or move it aside/);
});

test('the preview note for a manifest the JSON parser rejects names the folder and says to move it aside', async () => {
  const dir = await workspaceFor(WORKSPACE_ENV, undefined, { built: true });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 36));
  const before = treeOf(dir);
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.deepStrictEqual(treeOf(dir), before, 'the probe wrote nothing');
  assert.match(note, /this preview works in a temporary workspace/);
  assert.match(note, /manifest\.json that is not valid JSON/);
  assert.ok(note.split('\n').includes(`  ${dir}`));
  assert.ok(!/Unterminated|position|JSON input/.test(note.replace('not valid JSON', '')), note);
  assertMovedAside(note);
});

// A saved copy is another matter. The preview is about which environment the folder belongs to, which only its manifest says —
// but the bundle's listing parses every copy it lists, and the metadata beside it, to flag the ones holding unpushed edits, so a
// copy that is not JSON throws the very SyntaxError a manifest that is not JSON throws. A probe that listed would take the one for
// the other, and tell the operator to move aside a folder an --apply opens without trouble.
const APP_COPY_ID = '11111111-1111-4111-8111-111111111111';

// A workspace the real bundle opened for `instanceUrl` and a build saved an app into: a valid manifest that lists the app, the
// app's saved copy, and the metadata the SDK keeps beside it. `copy` and `meta` are written as given, so a test can make either
// one something the JSON parser rejects.
async function workspaceWithAppCopy(instanceUrl, dir, { copy = '{"name":"Support Desk"}', meta = '{"etag":null,"snapshot":{"name":"Support Desk"}}' } = {}) {
  const folder = await workspaceFor(instanceUrl, dir, { built: true });
  const file = path.join(folder, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.artifacts.push({ type: 'app', id: APP_COPY_ID, name: 'Support Desk', isDirty: false });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'apps', `${APP_COPY_ID}.json`), copy);
  fs.writeFileSync(path.join(folder, '.metadata', 'apps', `${APP_COPY_ID}.meta.json`), meta);
  return folder;
}

test('the preview note: a corrupt saved copy in a folder that belongs to this environment is no manifest problem, and gets no note', async () => {
  const healthy = await workspaceWithAppCopy(RUN_ENV);
  assert.strictEqual((await probeFor(healthy, RUN_ENV).listArtifacts('app')).length, 1, 'the fixture is a folder the bundle can list');
  assert.strictEqual(await workspaceBindingNote(probeFor(healthy, RUN_ENV), { env: RUN_ENV, workspaceDir: healthy }), null);
  for (const [what, damage] of [
    ['a saved copy', { copy: '{"name": "Support' }],
    ['the metadata saved beside a copy', { meta: '{"etag":' }],
  ]) {
    const dir = await workspaceWithAppCopy(RUN_ENV, undefined, damage);
    // The bundle really does trip over it when it lists: that is what the probe must not be taken in by.
    await assert.rejects(probeFor(dir, RUN_ENV).listArtifacts('app'), (err) => err.name === 'SyntaxError', what);
    const before = treeOf(dir);
    assert.strictEqual(await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir }), null, `${what} that is not JSON`);
    assert.deepStrictEqual(treeOf(dir), before, 'and nothing in it is touched');
  }
});

test('the preview note for another environment\u2019s folder names that environment, whatever state its saved copies are in', async () => {
  for (const damage of [{}, { copy: '{"name": "Support' }, { meta: '{"etag":' }]) {
    const dir = await workspaceWithAppCopy(WORKSPACE_ENV, undefined, damage);
    const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
    assert.match(note, /which belongs to a different environment:\n/, JSON.stringify(damage));
    assert.ok(note.includes(`--env ${WORKSPACE_ENV}`) && !/not valid JSON/.test(note), note);
  }
});

test('the preview note still names a manifest.json the JSON parser rejects when a saved copy in the folder is corrupt as well', async () => {
  const dir = await workspaceWithAppCopy(RUN_ENV, undefined, { copy: '{"name": "Support' });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 36));
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.match(note, /manifest\.json that is not valid JSON/);
  assertMovedAside(note);
});

test('the preview note for this environment\u2019s other host name says it is the same environment', async () => {
  const dir = await workspaceFor('https://fabrikam.api.crm.dynamics.com', undefined, { built: true });
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.match(note, /two host names of one environment/);
  assert.ok(note.includes('--env https://fabrikam.api.crm.dynamics.com'), note);
  assert.ok(!/teardown-model-app|DELETES/.test(note), note);
});

test('the preview note for a URL recorded with more than an origin says no --env can match it, and names only the origin', async () => {
  const dir = await workspaceFor(`${RUN_ENV}/api/data/v9.2`, undefined, { built: true });
  const note = await workspaceBindingNote(probeFor(dir, RUN_ENV), { env: RUN_ENV, workspaceDir: dir });
  assert.match(note, /records this environment's URL in a form --env cannot take/);
  assert.match(note, /no --env value can match it/);
  assert.ok(!note.includes('/api/data'), note);
  assert.match(note, /fresh app folder/);
});

test('the preview note never fails a preview: a probe that breaks some other way gives no note', async () => {
  const ctx = { env: RUN_ENV, workspaceDir: NO_SUCH_FOLDER };
  const throwing = (err) => ({ getManifest: async () => { throw err; } });
  assert.strictEqual(await workspaceBindingNote(throwing(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })), ctx), null);
  assert.strictEqual(await workspaceBindingNote(throwing(Object.assign(new Error('not initialized'), { code: 'WORKSPACE_NOT_INITIALIZED' })), ctx), null);
  assert.strictEqual(await workspaceBindingNote(throwing('a string'), ctx), null);
  assert.strictEqual(await workspaceBindingNote({}, ctx), null, 'a probe without the call is no probe');
});

// --- the entry points -------------------------------------------------------------------------------

// A copy of a committed sample as the app folder, so the default workspace is `<folder>/.maker-workspace`.
function appFolder() {
  const dir = tempDir('binding-app-');
  fs.copyFileSync(path.join(scriptsDir, '..', 'samples', 'app-spec.support-desk.json'), path.join(dir, 'app-spec.json'));
  return { dir, spec: path.join(dir, 'app-spec.json'), workspace: path.join(dir, '.maker-workspace') };
}

// An HttpClient for a dry run's live plan: every read is answered with no rows (so the plan finds nothing deployed), and
// every write fails the test — a preview changes nothing in the environment.
function readOnlyClient(requests = []) {
  const refuse = (verb) => async (url) => { requests.push(`${verb} ${url}`); throw new Error(`a dry run must not ${verb} ${url}`); };
  return {
    get: async (url) => { requests.push(`GET ${url}`); return { status: 200, headers: {}, body: { value: [] } }; },
    post: refuse('POST'), patch: refuse('PATCH'), delete: refuse('DELETE'), put: refuse('PUT'), postRaw: refuse('POST'),
  };
}

// build-model-app.js with the real bundle and the real emitter (in its own sandbox, so exit is catchable).
// Only authentication and the language read are stubbed — they are network, and the run must stop before
// anything else is asked of the environment. `client` replaces the inert HTTP client, for a run that is to read.
function loadBuild(argv, { requests = [], sdkTempDirs = [], client = null } = {}) {
  const authCli = loadCli(path.join(scriptsDir, 'lib', 'dataverse-auth.js'));
  const real = require(BUNDLE);
  const cli = loadCli(path.join(scriptsDir, 'build-model-app.js'), {
    argv,
    env: { PATH: path.dirname(process.execPath), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': { ...authCli.exports, preflightAuth: async () => ({ ok: true }) },
      './lib/entity-provision.js': { resolveAuthoringLanguage: async () => 1033 },
      './lib/sdk-http-client.js': { createAzHttpClient: () => client || inertClient(requests), SQL_DEADLOCK_VICTIM: /Sql Number: 1205/ },
      './vendor/cds-maker-sdk.cjs': {
        createMakerSdk: real.createMakerSdk,
        createNodeWorkspaceStorage: (dir) => { sdkTempDirs.push(dir); return real.createNodeWorkspaceStorage(dir); },
      },
    },
  });
  return { cli, authCli };
}

test('build --apply against another environment\u2019s workspace halts before touching it, and says what to do', async () => {
  const app = appFolder();
  await workspaceFor('https://Contoso.crm.dynamics.com/', app.workspace, { built: true });
  const before = treeOf(app.workspace);
  const requests = [];
  const sdkTempDirs = [];
  const { cli } = loadBuild(['--env', RUN_ENV, '--spec', `@${app.spec}`, '--apply'], { requests, sdkTempDirs });

  await assert.rejects(cli.main(), (err) => {
    assert.strictEqual(err.code, 'WORKSPACE_ORG_MISMATCH');
    assert.ok(err.message.includes(WORKSPACE_ENV) && err.message.includes(RUN_ENV), err.message);
    assert.ok(err.message.includes(`--env ${WORKSPACE_ENV}`));
    assert.ok(!/cleanWorkspace/.test(err.message));
    return true;
  });
  assert.deepStrictEqual(requests, [], 'no request is sent to either environment');
  assert.deepStrictEqual(treeOf(app.workspace), before, 'nothing is written into the foreign workspace — no journal, no baseline, no manifest change');
  assert.ok(!fs.existsSync(path.join(app.workspace, 'build-log.jsonl')) && !fs.existsSync(path.join(app.workspace, 'build-status.json')));
  assert.ok(sdkTempDirs.length >= 1 && sdkTempDirs.every((d) => d === app.workspace || !fs.existsSync(d)), 'the throwaway workspace the build made is removed again');
});

// --- a dry run opens nothing --------------------------------------------------------------------------

// A dry run — the default mode — through the real entry point and the real bundle, resolved with what it printed: `stderr` as the
// separate writes it was made in (the note about the folder is one of them), `stdout` the JSON result. It is offline
// (`--no-live-plan`) unless a test passes its own `args` and a client that answers.
async function preview(app, env, { args = ['--no-live-plan'], ...options } = {}) {
  const { cli, authCli } = loadBuild(['--env', env, '--spec', `@${app.spec}`, ...args], options);
  await assert.rejects(cli.main(), (err) => err.exitCode === 0, 'a dry run exits 0');
  return { stderr: [...cli.stderr], stdout: authCli.stdoutText() };
}
const isFolderNote = (chunk) => chunk.startsWith('\u26a0 this preview works in a temporary workspace');

test('a dry run creates no workspace, in the app folder or in the folder --workspace names', async () => {
  // A preview builds nothing, so it has nothing to bind a folder to — and a folder it bound to the environment it only
  // previewed would later refuse the environment the operator meant.
  const app = appFolder();
  const sdkTempDirs = [];
  await preview(app, RUN_ENV, { sdkTempDirs });
  assert.ok(!fs.existsSync(app.workspace), 'no .maker-workspace is created');
  assert.deepStrictEqual(fs.readdirSync(app.dir), ['app-spec.json'], 'the app folder holds what it held');
  const elsewhere = path.join(tempDir('binding-none-'), 'nowhere');
  await preview(app, RUN_ENV, { args: ['--no-live-plan', '--workspace', elsewhere], sdkTempDirs });
  assert.ok(!fs.existsSync(elsewhere), 'nor is the folder --workspace names');
  assert.ok(sdkTempDirs.length >= 2, 'the SDKs were built');
  assert.ok(sdkTempDirs.every((dir) => dir === app.workspace || dir === elsewhere || (dir.startsWith(os.tmpdir()) && !fs.existsSync(dir))),
    `an SDK is only ever pointed at the folder to ask it a question, or at a temporary workspace that is gone again: ${JSON.stringify(sdkTempDirs)}`);
});

test('a dry run against the wrong environment does not bind the folder to it: a preview or a build against the intended one is not halted', async () => {
  // Preview against the wrong environment, then against the intended one, then apply — the order an operator works in. Only
  // an --apply opens the workspace, so the previews leave nothing for the next run to be refused by.
  const app = appFolder();
  await preview(app, WORKSPACE_ENV);
  const second = await preview(app, RUN_ENV);
  assert.ok(!second.stderr.some(isFolderNote), 'there is no workspace for the second preview to be warned about');
  await opensWith(app, RUN_ENV);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app.workspace, 'manifest.json'), 'utf8')).instanceUrl, RUN_ENV, 'the folder is bound by the build, to the build\u2019s environment');
});

test('a dry run from a folder that belongs to another environment previews as normal, warns that --apply would stop, and leaves the folder alone', async () => {
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace, { built: true });
  const before = treeOf(app.workspace);
  const plain = appFolder();
  const reference = await preview(plain, RUN_ENV);
  assert.ok(!reference.stderr.some(isFolderNote), 'a folder with no workspace gets no note');

  const requests = [];
  const sdkTempDirs = [];
  const result = await preview(app, RUN_ENV, { requests, sdkTempDirs });
  assert.deepStrictEqual(treeOf(app.workspace), before, 'the folder is exactly as the preview found it');
  assert.deepStrictEqual(requests, [], 'no request is sent');
  assert.ok(sdkTempDirs.every((dir) => dir === app.workspace || !fs.existsSync(dir)), 'the temporary workspaces are gone');
  const note = result.stderr.find(isFolderNote);
  assert.ok(note, `a warning is printed: ${JSON.stringify(result.stderr)}`);
  assert.match(note, /^\u26a0 this preview works in a temporary workspace, so it ran as normal; a build with --apply would stop before reading or writing anything in this app's workspace folder, which belongs to a different environment:\n/);
  assert.ok(note.includes(WORKSPACE_ENV) && note.includes(RUN_ENV) && note.includes(`--env ${WORKSPACE_ENV}`), note);
  // Everything else it printed is what it prints from any folder: the plan it logs, and its result. (What changed since
  // the folder's baseline is the one line that depends on the folder, and is pinned below.)
  const logged = (run, folder) => run.stderr
    .filter((chunk) => !isFolderNote(chunk) && !chunk.startsWith('\n\u25b8 '))
    .map((chunk) => chunk.split(folder.dir).join('<app folder>'));
  assert.deepStrictEqual(logged(result, app), logged(reference, plain), 'the plan it logs is the same');
  assert.strictEqual(result.stdout.split(app.dir).join('<app folder>'), reference.stdout.split(plain.dir).join('<app folder>'), 'and so is its result');
});

test('a dry run from a folder that was only ever opened for another environment says it can simply go, and runs as normal', async () => {
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace);
  const before = treeOf(app.workspace);
  const { stderr } = await preview(app, RUN_ENV);
  const note = stderr.find(isFolderNote);
  assert.ok(note, 'warned');
  assert.match(note, /which was only ever opened for another environment/);
  assert.match(note, /delete the folder \(it holds nothing\), or move it aside/);
  assert.deepStrictEqual(treeOf(app.workspace), before);
});

test('a dry run from a folder whose manifest.json is not valid JSON previews as normal and says to move the folder aside', async () => {
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace, { built: true });
  const manifest = path.join(app.workspace, 'manifest.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 36));
  const before = treeOf(app.workspace);
  const { stderr } = await preview(app, RUN_ENV);
  const note = stderr.find(isFolderNote);
  assert.ok(note, `warned: ${JSON.stringify(stderr)}`);
  assert.match(note, /manifest\.json that is not valid JSON/);
  assertMovedAside(note);
  assert.deepStrictEqual(treeOf(app.workspace), before);
});

test('a dry run from a folder that belongs to its own environment, under any spelling of the host, says nothing about the folder', async () => {
  for (const spelled of [RUN_ENV, 'https://Fabrikam.crm.dynamics.com//']) {
    const app = appFolder();
    await workspaceFor(spelled, app.workspace, { built: true });
    const before = treeOf(app.workspace);
    const { stderr } = await preview(app, RUN_ENV);
    assert.ok(!stderr.some(isFolderNote), `${spelled}: ${JSON.stringify(stderr)}`);
    assert.deepStrictEqual(treeOf(app.workspace), before);
  }
});

test('a dry run from a folder that belongs to its own environment says nothing about a corrupt saved copy in it', async () => {
  // Not a binding problem, and not the manifest: the folder belongs here, and an --apply opens it (see below). The preview reads
  // no saved copy, so it has nothing to say about one — least of all that the manifest is the trouble.
  for (const damage of [{ copy: '{"name": "Support' }, { meta: '{"etag":' }]) {
    const app = appFolder();
    await workspaceWithAppCopy(RUN_ENV, app.workspace, damage);
    const before = treeOf(app.workspace);
    const { stderr } = await preview(app, RUN_ENV);
    assert.ok(!stderr.some(isFolderNote), JSON.stringify(stderr));
    assert.ok(!stderr.some((chunk) => /not valid JSON/.test(chunk)), JSON.stringify(stderr));
    assert.deepStrictEqual(treeOf(app.workspace), before);
  }
});

test('a dry run still reports what changed since the last apply, from the folder\u2019s baseline, without opening the folder', async () => {
  const { writeBaseline } = require('../lib/deployed-baseline.js');
  const { migrateAppSpec } = require('../lib/app-spec.js');
  const { appUniqueName } = require('../lib/sdk-build.js');
  const app = appFolder();
  const spec = migrateAppSpec(JSON.parse(fs.readFileSync(app.spec, 'utf8')));
  // A folder a build finished in, as far as the preview can tell: the baseline, and no SDK workspace in it.
  fs.mkdirSync(app.workspace);
  writeBaseline(app.workspace, spec, { appDir: app.dir, environment: RUN_ENV, appUniqueName: appUniqueName(spec) });
  const before = treeOf(app.workspace);
  assert.ok(Object.keys(before).includes('last-applied.json'));

  const unchanged = await preview(app, RUN_ENV);
  assert.ok(unchanged.stderr.some((chunk) => /\u25b8 No spec changes since the last apply/.test(chunk)), JSON.stringify(unchanged.stderr));

  const edited = JSON.parse(fs.readFileSync(app.spec, 'utf8'));
  edited.app.name = `${edited.app.name} (edited)`;
  fs.writeFileSync(app.spec, JSON.stringify(edited));
  const changed = await preview(app, RUN_ENV);
  assert.ok(changed.stderr.some((chunk) => /\u25b8 Changed since last apply: /.test(chunk)), JSON.stringify(changed.stderr));

  assert.deepStrictEqual(treeOf(app.workspace), before, 'only the baseline is in the folder: no manifest, no empty folders, nothing else was added');
});

test('a dry run\u2019s live plan reads the environment through a temporary workspace: the folder it is run from is no part of it', async () => {
  // The live plan's reads all go to the server (it deliberately skips the metadata read that would cache into a workspace),
  // so a folder that belongs to another environment — which the SDK would refuse to read through — is no obstacle.
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace, { built: true });
  const before = treeOf(app.workspace);
  const requests = [];
  const sdkTempDirs = [];
  const result = await preview(app, RUN_ENV, { args: [], client: readOnlyClient(requests), sdkTempDirs });
  assert.ok(requests.length > 0 && requests.every((request) => request.startsWith('GET ')), `it reads the environment, and only reads: ${JSON.stringify(requests.slice(0, 3))}`);
  assert.ok(requests.every((request) => request.includes('/api/data/')), JSON.stringify(requests.slice(0, 3)));
  assert.ok(!result.stderr.some((chunk) => /no live probe/.test(chunk)), 'it is the live plan, not the offline listing');
  assert.ok(result.stderr.some(isFolderNote), 'the folder it did not use is still reported');
  assert.deepStrictEqual(treeOf(app.workspace), before, 'the folder is exactly as it was — nothing the live plan read was cached into it');
  assert.ok(sdkTempDirs.every((dir) => dir === app.workspace || !fs.existsSync(dir)), 'the temporary workspaces are gone');
});

test('a dry run still refuses a link, or a file, where the workspace would be', async () => {
  const linked = appFolder();
  fs.symlinkSync(tempDir('binding-real-'), linked.workspace, FOLDER_LINK);
  const viaLink = loadBuild(['--env', RUN_ENV, '--spec', `@${linked.spec}`, '--no-live-plan']);
  await assert.rejects(viaLink.cli.main(), (err) => err.exitCode === 1);
  assert.match(`${viaLink.authCli.stdoutText()}${viaLink.authCli.stderrText()}`, /symbolic link or junction/);

  const occupied = appFolder();
  fs.writeFileSync(occupied.workspace, 'not a folder');
  const viaFile = loadBuild(['--env', RUN_ENV, '--spec', `@${occupied.spec}`, '--no-live-plan']);
  await assert.rejects(viaFile.cli.main(), (err) => err.exitCode === 1);
  assert.match(`${viaFile.authCli.stdoutText()}${viaFile.authCli.stderrText()}`, /not a directory/);
});

test('--workspace pointing at another environment\u2019s workspace is refused the same way, and the teardown it offers clears THAT folder', async () => {
  const app = appFolder();
  const elsewhere = await workspaceFor(WORKSPACE_ENV, undefined, { built: true });
  const { cli } = loadBuild(['--env', RUN_ENV, '--spec', `@${app.spec}`, '--workspace', elsewhere, '--apply']);
  await assert.rejects(cli.main(), (err) => {
    assert.strictEqual(err.code, 'WORKSPACE_ORG_MISMATCH');
    const lines = err.message.split('\n');
    assert.ok(lines.includes(`  ${elsewhere}`), 'the folder it was given is the one named, alone on its line');
    assert.ok(err.message.includes(`--env ${WORKSPACE_ENV}`), err.message);
    // Teardown clears `--workspace`, else `<spec dir>/.maker-workspace` — here a different folder. Left out, the
    // command would clear (or find nothing to clear in) the wrong one and this build would halt again.
    const teardown = lines.find((line) => /teardown-model-app\.js/.test(line));
    assert.match(teardown, /--workspace <the folder printed above>/, 'the command takes the folder the halt prints');
    assert.ok(!teardown.includes(elsewhere), 'and never embeds it');
    assert.notStrictEqual(elsewhere, app.workspace, 'the fixture really names a folder other than the default one');
    return true;
  });
});

test('build --apply against a folder that was only ever opened for another environment halts, and says nothing was built there', async () => {
  // The folder an earlier preview (or a build that stopped at its start) opened for the wrong environment: only the
  // SDK's manifest and empty folders. The halt must not send the operator back to an environment nothing was built in,
  // or offer to tear down what was never there.
  const { halt } = await buildHalt({ recorded: WORKSPACE_ENV, env: RUN_ENV, built: false });
  const text = halt.message;
  assert.match(text, /only ever opened for https:\/\/contoso\.crm\.dynamics\.com/);
  assert.match(text, /nothing was built there/);
  assert.ok(!text.includes(`--env ${WORKSPACE_ENV}`) && !/teardown-model-app|DELETES/.test(text), text);
});

test('build --apply against a folder whose manifest.json is not valid JSON halts with the folder named and advice, not the parser\u2019s message', async () => {
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace, { built: true });
  const manifest = path.join(app.workspace, 'manifest.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 36)); // cut inside the URL
  const raw = await mismatchFrom(app.workspace, RUN_ENV);
  assert.strictEqual(raw.name, 'SyntaxError', 'the bundle lets the JSON parser\u2019s own error out: that is what the plugin recognizes');
  const before = treeOf(app.workspace);
  const requests = [];
  const { cli } = loadBuild(['--env', RUN_ENV, '--spec', `@${app.spec}`, '--apply'], { requests });
  await assert.rejects(cli.main(), (err) => {
    assert.strictEqual(err.code, 'WORKSPACE_MANIFEST_INVALID', `not the parser's message: ${err.message}`);
    assert.ok(!err.message.includes(raw.message), 'the parser\u2019s text is not echoed');
    assert.ok(err.message.split('\n').includes(`  ${app.workspace}`), `the folder is named: ${err.message}`);
    assert.match(err.message, /manifest\.json that is not valid JSON/);
    assertMovedAside(err.message);
    return true;
  });
  assert.deepStrictEqual(requests, [], 'no request is sent');
  assert.deepStrictEqual(treeOf(app.workspace), before, 'the folder is exactly as it was: moved aside by the operator, never cleared by the build');
});

// The halt for a folder recorded as `recorded`, by a build run with `env`: the real bundle through the real entry point.
// `built` is whether anything beyond the SDK's own empty folders was saved in it (see `workspaceFor`).
async function buildHalt({ recorded, env, built = true }) {
  const app = appFolder();
  await workspaceFor(recorded, app.workspace, { built });
  const before = treeOf(app.workspace);
  const requests = [];
  const { cli } = loadBuild(['--env', env, '--spec', `@${app.spec}`, '--apply'], { requests });
  let halt = null;
  await assert.rejects(cli.main(), (err) => { halt = err; return true; });
  assert.strictEqual(halt.code, 'WORKSPACE_ORG_MISMATCH', String(halt && halt.message));
  assert.deepStrictEqual(requests, [], 'no request is sent');
  assert.deepStrictEqual(treeOf(app.workspace), before, 'the folder is exactly as it was');
  return { halt, app };
}

// The same folder, built again with `--apply` and `env`: the one thing that opens a workspace, so the one thing that can meet
// a folder that belongs elsewhere. The HTTP client is inert, so a build the workspace lets through stops at its first read of
// the environment — the safety probe before a destructive apply — and exits 1 for that; one the workspace refuses throws the
// halt instead, which is how the two are told apart.
async function opensWith(app, env) {
  const { cli, authCli } = loadBuild(['--env', env, '--spec', `@${app.spec}`, '--apply']);
  await assert.rejects(cli.main(), (err) => err.exitCode === 1 && err.code !== 'WORKSPACE_ORG_MISMATCH', `--env ${env} opens the folder`);
  assert.match(`${authCli.stdoutText()}${authCli.stderrText()}`, /preflight safety check could not run/, 'it got as far as its first read of the environment');
}

// Two spellings of ONE environment are not "another environment": the halt must not say so, and must not offer the
// teardown, whose target is then this run's own environment. The bundle's decision is real here — these are the
// recordings it refuses.
for (const [recorded, env] of [
  ['https://contoso.api.crm.dynamics.com', 'https://contoso.crm.dynamics.com'],
  ['https://contoso.crm.dynamics.com', 'https://contoso.api.crm.dynamics.com'],
]) {
  test(`a workspace opened as ${recorded} is the same environment as ${env}: the halt says so and gives the host to go back to`, async () => {
    const { halt, app } = await buildHalt({ recorded, env });
    const text = halt.message;
    assert.ok(text.includes(recorded) && text.includes(env), text);
    assert.match(text, /two host names of one environment/);
    assert.ok(!/different environment/.test(text), text);
    assert.ok(!/teardown-model-app|DELETES|--clear-workspace/.test(text), `no teardown: it would delete from this run\u2019s own environment: ${text}`);
    assert.ok(text.includes(`--env ${recorded}`), `the exact --env that matches the folder: ${text}`);
    assert.match(text, /fresh app folder/);
    // The promise is kept: that --env opens this very folder.
    await opensWith(app, recorded);
  });
}

// A manifest written by another tool can carry more than an origin. `--env` takes the origin only, so no value can
// match it — and printing two identical origins, or offering the teardown, would be wrong.
for (const recorded of [
  'https://contoso.crm.dynamics.com/api/data/v9.2',
  'https://contoso.crm.dynamics.com:443',
  'https://contoso.crm.dynamics.com:8443',
  'http://contoso.crm.dynamics.com',
]) {
  test(`a workspace recorded as ${recorded} is this environment under a spelling no --env can match: a fresh folder is the only way, and nothing is offered to delete`, async () => {
    const { halt } = await buildHalt({ recorded, env: 'https://contoso.crm.dynamics.com' });
    const text = halt.message;
    assert.match(text, /records this environment's URL in a form --env cannot take/);
    assert.match(text, /no --env value can match it/);
    assert.ok(!/different environment/.test(text), text);
    assert.ok(!/teardown-model-app|DELETES|--clear-workspace/.test(text), text);
    assert.ok(!/--env https:\/\/contoso/.test(text), `no --env remedy: ${text}`);
    assert.ok(!text.includes('/api/data') && !text.includes(':8443'), `only an origin is ever printed: ${text}`);
    assert.match(text, /fresh app folder/);
    assert.match(text, /this run targets: https:\/\/contoso\.crm\.dynamics\.com\b/);
  });
}

test('the .api. host recorded together with more than an origin has no --env to go back to either', async () => {
  const { halt } = await buildHalt({ recorded: 'https://contoso.api.crm.dynamics.com/api/data/v9.2', env: 'https://contoso.crm.dynamics.com' });
  const text = halt.message;
  assert.match(text, /two host names of one environment/);
  assert.match(text, /no --env value can match it/);
  assert.ok(!/teardown-model-app|DELETES/.test(text) && !/--env https:\/\/contoso\.api/.test(text), text);
  assert.match(text, /fresh app folder/);
});

test('another environment recorded with more than an origin offers a fresh folder only: no --env or teardown could name it exactly', async () => {
  const { halt } = await buildHalt({ recorded: 'https://fabrikam.crm.dynamics.com/api/data/v9.2', env: 'https://contoso.crm.dynamics.com' });
  const text = halt.message;
  assert.match(text, /belongs to a different environment/);
  assert.match(text, /workspace belongs to: https:\/\/fabrikam\.crm\.dynamics\.com\n/);
  assert.ok(!text.includes('/api/data'), text);
  assert.match(text, /no --env value can match it/);
  assert.ok(!/teardown-model-app|DELETES/.test(text) && !/ --env https:\/\/fabrikam/.test(text), text);
  assert.match(text, /fresh app folder/);
});

test('a different host is another environment even when it differs from this one only by a label', async () => {
  // `.api.` is the one label that names the same environment; any other is a different one.
  const { halt } = await buildHalt({ recorded: 'https://contoso2.crm.dynamics.com', env: 'https://contoso.crm.dynamics.com' });
  assert.match(halt.message, /belongs to a different environment/);
  assert.ok(halt.message.includes('--env https://contoso2.crm.dynamics.com'));
  assert.match(halt.message, /DELETES what the spec declares from https:\/\/contoso2\.crm\.dynamics\.com/);
});

test('the same environment spelled differently is not a mismatch', async () => {
  // Case and a trailing slash name one environment; halting the run for it would be a false alarm. The
  // decision is the bundle's, so this drives the real bundle through the real entry point.
  const app = appFolder();
  await workspaceFor(RUN_ENV, app.workspace, { built: true });
  await opensWith(app, 'https://Fabrikam.crm.dynamics.com/');
});

test('build --apply opens a folder that belongs to its environment although a saved copy in it is corrupt: that is no halt for a manifest', async () => {
  // Opening a workspace parses its manifest and nothing else, so a corrupt saved copy is not met here — which is what makes the
  // parser's error name enough to recognize a corrupt MANIFEST (lib/workspace-binding.js): nothing asked of a workspace at this
  // point can throw it for a copy. The SDK meets the copy when it first reads it, later in the build.
  for (const damage of [{ copy: '{"name": "Support' }, { meta: '{"etag":' }]) {
    const app = appFolder();
    await workspaceWithAppCopy(RUN_ENV, app.workspace, damage);
    await opensWith(app, RUN_ENV);
  }
});

test('a fresh app folder (no workspace yet) is bound to the environment of the first build, not refused', async () => {
  const app = appFolder();
  await opensWith(app, RUN_ENV);
  const manifest = JSON.parse(fs.readFileSync(path.join(app.workspace, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.instanceUrl, RUN_ENV);
});

test('a folder the build bound under one spelling of the host is reopened under another spelling of the same host', async () => {
  // The build hands the SDK the `--env` text as it was typed (after the HTTP client has checked it is an https Dataverse
  // origin), so a manifest can carry capitals or a trailing slash. The SDK compares URLs ignoring both, so the plugin
  // does not have to canonicalize what it passes: no spelling the plugin can write meets a mismatch except the
  // `.api.` host, which the halt above tells apart.
  const app = appFolder();
  const typed = 'https://Fabrikam.crm.dynamics.com//';
  await opensWith(app, typed);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app.workspace, 'manifest.json'), 'utf8')).instanceUrl, typed, 'the manifest carries what was typed');
  await opensWith(app, RUN_ENV);
  await opensWith(app, 'HTTPS://FABRIKAM.CRM.DYNAMICS.COM');
});

// --- verify: never the app folder's persistent workspace ---------------------------------------------

// verify-model-app.js with the real bundle, and the verification itself optionally replaced to see what it is handed.
// The HTTP client is inert: every read is refused, so a run that gets past the workspace stops at its first read,
// with the transport failure that read raised.
function loadVerify(argv, { requests = [], sdkDirs = [], verifySpec = null } = {}) {
  const authCli = loadCli(path.join(scriptsDir, 'lib', 'dataverse-auth.js'));
  const real = require(BUNDLE);
  const requires = {
    './lib/dataverse-auth.js': authCli.exports,
    './lib/sdk-http-client.js': { createAzHttpClient: () => inertClient(requests) },
    './vendor/cds-maker-sdk.cjs': {
      createMakerSdk: real.createMakerSdk,
      createNodeWorkspaceStorage: (dir) => { sdkDirs.push(dir); return real.createNodeWorkspaceStorage(dir); },
    },
  };
  if (verifySpec) requires['./lib/verify-spec.js'] = { verifySpec };
  const cli = loadCli(path.join(scriptsDir, 'verify-model-app.js'), { argv, requires });
  return { cli, output: () => `${authCli.stdoutText()}${authCli.stderrText()}` };
}

test('verify runs against any environment: a folder bound to another one is neither refused nor touched', async () => {
  // Build in one environment, import the solution into another, verify there from the same folder. Every read verify
  // makes goes to the server, so nothing in that folder's workspace could answer one — and the SDK would refuse it.
  const app = appFolder();
  await workspaceFor(WORKSPACE_ENV, app.workspace);
  const before = treeOf(app.workspace);
  const requests = [];
  const sdkDirs = [];
  const { cli } = loadVerify(['--env', RUN_ENV, '--spec', `@${app.spec}`], { requests, sdkDirs });
  await assert.rejects(cli.main(), (err) => {
    assert.notStrictEqual(err.code, 'WORKSPACE_ORG_MISMATCH', 'verify is not halted by the folder\u2019s binding');
    assert.match(err.message, /unexpected GET .*EntityDefinitions/, 'it got as far as its first read of the environment');
    return true;
  });
  assert.ok(requests.length > 0);
  assert.deepStrictEqual(treeOf(app.workspace), before, 'the folder is exactly as verify found it');
  assert.ok(sdkDirs.length >= 1 && sdkDirs.every((dir) => path.dirname(dir) === os.tmpdir() && !fs.existsSync(dir)), `every SDK worked in a temporary workspace that is gone again: ${JSON.stringify(sdkDirs)}`);
});

test('verify does not bind a folder that has no workspace yet to the environment it verified', async () => {
  const app = appFolder();
  const { cli } = loadVerify(['--env', RUN_ENV, '--spec', `@${app.spec}`]);
  await assert.rejects(cli.main(), /unexpected GET/);
  assert.ok(!fs.existsSync(app.workspace), 'verify creates no .maker-workspace');
  // ...so the first thing to open the folder, a build, binds it to ITS environment.
  await opensWith(app, WORKSPACE_ENV);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app.workspace, 'manifest.json'), 'utf8')).instanceUrl, WORKSPACE_ENV);
});

test('verify still reads the build\u2019s baseline from the folder, for the environment it describes', async () => {
  const { writeBaseline } = require('../lib/deployed-baseline.js');
  const { migrateAppSpec } = require('../lib/app-spec.js');
  const { appUniqueName } = require('../lib/sdk-build.js');
  const app = appFolder();
  const spec = migrateAppSpec(JSON.parse(fs.readFileSync(app.spec, 'utf8')));
  // A folder built against WORKSPACE_ENV: the SDK's own workspace is bound to it, and the baseline is stamped with it.
  await workspaceFor(WORKSPACE_ENV, app.workspace);
  writeBaseline(app.workspace, spec, { appDir: app.dir, environment: WORKSPACE_ENV, appUniqueName: appUniqueName(spec) });
  const baselineFor = async (env) => {
    const seen = [];
    const { cli } = loadVerify(['--env', env, '--spec', `@${app.spec}`], { verifySpec: async (s, reader, opts) => { seen.push(opts); return { ok: true, checks: [], missing: [] }; } });
    await assert.rejects(cli.main(), (err) => err.exitCode === 0);
    assert.strictEqual(seen.length, 1);
    return seen[0].baselineSpec;
  };
  const own = await baselineFor(WORKSPACE_ENV);
  assert.ok(own && own.app && own.app.name === spec.app.name, 'the environment the baseline describes gets it');
  assert.strictEqual(await baselineFor(RUN_ENV), undefined, 'another environment gets none: what the designer changed there says nothing about this snapshot');
});

test('verify refuses a link where the baseline would be read from, and a folder that is not there is just one with no baseline', async () => {
  const app = appFolder();
  const real = tempDir('binding-real-');
  fs.symlinkSync(real, app.workspace, FOLDER_LINK);
  const linked = loadVerify(['--env', RUN_ENV, '--spec', `@${app.spec}`]);
  await assert.rejects(linked.cli.main(), (err) => err.exitCode === 1);
  assert.match(linked.output(), /symbolic link or junction/);

  const missing = path.join(tempDir('binding-none-'), 'nowhere');
  const absent = loadVerify(['--env', RUN_ENV, '--spec', `@${app.spec}`, '--workspace', missing]);
  await assert.rejects(absent.cli.main(), /unexpected GET/, 'it goes on to verify, with no baseline');
  assert.ok(!fs.existsSync(missing), 'and creates nothing');
});

// --- the rule the halt rests on ---------------------------------------------------------------------

test('no script clears or re-binds an SDK workspace', () => {
  // `cleanWorkspace()` is the bundle's remedy for a mismatch: it discards the SDK's saved copies, metadata and
  // baselines of the workspace (and so any edit in a copy that was never pushed) and binds it to the new
  // environment, leaving the page-ownership receipts and the plugin's baseline beside them describing the old one.
  // Choosing to do that is the operator's decision (a teardown that ends in --clear-workspace, which refuses while
  // a receipt remains), never something a halt does on its behalf.
  assert.deepStrictEqual(scriptsMatching(/\bcleanWorkspace\s*\(/), [], 'a script calls cleanWorkspace()');
});
