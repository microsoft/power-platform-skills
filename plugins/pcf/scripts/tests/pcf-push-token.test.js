'use strict';
// pcf-push.js writes a receipt, `pcf-receipt.json`, after a push — and what it says about the registration is the service's own words: when the read that confirms the push is refused, the reason is the refusal's text, which a
// service may fill with the access token it was sent (whole, or by a part, folded onto several lines the way a gateway wraps a long header, or spelled with a JSON escape). The token is kept out of everything the process
// writes by lib/output-redaction.js: the two streams (once a token is known) and every file a script writes with a service's words in it. The receipt is such a file, and this holds it — in a REAL process, with the real SDK bundle
// and the production client — together with the list of every other write of file content in this plugin and why none of them can carry a token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TOKEN, SECRETS, PARTS, leaksIn, base64Of } = require('./helpers/push-token.js');

const SCRIPTS = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'helpers', 'push-token-child.js');
const MARK = '<token>';

function filesUnder(root, out = new Map()) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else out.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
  }
  return out;
}

// The push, in a real process, against a service that refuses the confirming read with a diagnostic that says the token as `how` spells it. Returns what reached stdout and stderr, how the process ended, and every file it
// left in the project folder and the SDK's workspace.
function pushWith(how) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-push-token-'));
  try {
    const project = path.join(dir, 'project');
    const run = spawnSync(process.execPath, [CHILD, project, how], {
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1', POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
      encoding: 'utf8',
      timeout: 120000,
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, files: filesUnder(project) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

for (const [how, name] of [['folded', 'folded onto several lines'], ['escaped-fold', 'folded with a JSON-escaped line break'], ['plain', 'plainly']]) {
  test(`a push whose confirming read is refused with a diagnostic that repeats the access token ${name} writes a receipt, and a result, without it`, () => {
    const ran = pushWith(how);
    assert.equal(ran.status, 1, `the push is not confirmed, so the script ends with 1: ${ran.stderr.slice(0, 500)}`);
    assert.ok(ran.files.has('pcf-receipt.json'), 'the receipt is written');
    assert.deepEqual(leaksIn(ran.stdout), [], 'stdout holds the token');
    assert.deepEqual(leaksIn(ran.stderr), [], 'stderr holds the token');
    for (const [name, text] of ran.files) assert.deepEqual(leaksIn(text), [], `${name} holds the token, or a part of it, in some spelling`);
    const receipt = JSON.parse(ran.files.get('pcf-receipt.json'));
    // The plugin's own scrubber (`scrubSecrets`) reads a token that is whole and shaped like a JWT, and the guard on what the process writes reads the rest: the token folded, or spelled with an escape.
    assert.match(receipt.registered.reason, /^HTTP 403 from \S+: Header check failed for value (?:<token>|<redacted-jwt>)$/, 'what the service said is still there, with the token taken out');
    assert.equal(receipt.control, 'new_Contoso.Controls.StarRating', 'the rest of the receipt is what it was');
    assert.equal(receipt.version, '1.2.3');
    assert.equal(receipt.registered.ok, false);
    const result = JSON.parse(ran.stdout);
    assert.equal(result.registered.reason, receipt.registered.reason, 'the receipt says what the result says');
  });
}

test('a refusal that does not repeat the token is written to the receipt as the service said it', () => {
  const ran = pushWith('none');
  assert.equal(ran.status, 1);
  const receipt = JSON.parse(ran.files.get('pcf-receipt.json'));
  assert.match(receipt.registered.reason, /^HTTP 403 from \S+: Header check failed for value nothing secret here$/);
  assert.deepEqual(leaksIn(ran.stdout), []);
});

// The base64 of one part of the token — the signature — in the diagnostic: the characters made of its own bits are taken out; a complete encoding keeps the character that also holds the padding's bits, and the padding.
test('a refusal that repeats the BASE64 of a part of the token writes a receipt without it: exactly its own characters become the marker, and a complete encoding keeps only its fringe and padding — JSON still', () => {
  const own = base64Of(PARTS[2]);
  const spellings = [...own, ...base64Of(PARTS[2], 'base64url')];
  const windows = (secret) => Array.from({ length: Math.max(0, secret.length - 23) }, (_, i) => secret.slice(i, i + 24));
  const left = (text) => spellings.flatMap(windows).filter((window) => text.includes(window));
  const complete = Buffer.from(PARTS[2]).toString('base64');
  const fringe = complete.slice(own[0].length);
  assert.ok(complete.startsWith(own[0]) && fringe.length > 0, 'the complete encoding is the signature\'s own characters, a fringe character and padding');
  for (const [how, ending] of [['part-base64', MARK], ['part-base64-complete', `${MARK}${fringe}`]]) {
    const ran = pushWith(how);
    assert.equal(ran.status, 1, `${how}: ${ran.stderr.slice(0, 500)}`);
    const receipt = JSON.parse(ran.files.get('pcf-receipt.json'));
    assert.ok(receipt.registered.reason.startsWith('HTTP 403 from '), receipt.registered.reason);
    assert.ok(receipt.registered.reason.endsWith(`: Header check failed for value ${ending}`), `${how}: ${receipt.registered.reason}`);
    assert.deepEqual(left(ran.files.get('pcf-receipt.json')), [], `${how}: the receipt holds a piece of 24 characters of the signature's base64`);
    assert.deepEqual(left(ran.stdout), [], `${how}: stdout`);
    assert.deepEqual(left(ran.stderr), [], `${how}: stderr`);
    assert.equal(JSON.parse(ran.stdout).registered.reason, receipt.registered.reason, 'the receipt says what the result says');
  }
});

test('the receipt is the one file this plugin writes that carries a service\'s words, and it is written through the guard — every other write of file content is listed, with the reason it cannot carry a token', () => {
  const files = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['tests', 'vendor', 'node_modules'].includes(entry.name)) files(full, out); } else if (/\.js$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  // A call that writes or copies a file's content.
  const WRITES = /\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeSync|copyFileSync|copyFile|cpSync)\s*\(/;
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = files(SCRIPTS).filter((file) => WRITES.test(withoutComments(fs.readFileSync(file, 'utf8')))).map((file) => path.relative(SCRIPTS, file).split(path.sep).join('/')).sort();
  const OTHER = {
    'lib/pcf-scaffold.js': 'writes the files of a new project from templates and the answers a person gave; it calls no service',
    'lib/pcf-upgrade.js': 'rewrites a project\'s own files (package.json, the manifest, the pcfproj) with versions it computed; it calls no service',
    'pcf-ci-build.js': 'builds a bundle and sets the version in the project\'s own manifest and solution files; it calls no service',
    'write-pcf-plan.js': 'writes the plan the agent gave; it calls no service',
    'lib/telemetry/lib/emit-dispatcher.js': 'telemetry events, in a hook process that obtains no token, limited to the approved fields',
    'lib/telemetry/lib/local-log.js': 'the local mirror of those events',
    'lib/telemetry/lib/user-config.js': 'the telemetry choice a person made',
    'lib/telemetry/region/region-cache.js': 'a cached region name',
  };
  assert.deepEqual(found, ['pcf-push.js', ...Object.keys(OTHER)].sort(), 'a writer was added or removed: say which kind it is');
  // The receipt is cleaned by the one function that cleans what a process writes.
  const push = withoutComments(fs.readFileSync(path.join(SCRIPTS, 'pcf-push.js'), 'utf8'));
  assert.match(push, /redactOutput\(/, 'pcf-push.js cleans the text of its receipt');
  assert.match(push, /require\('\.\/lib\/output-redaction\.js'\)/);
  // The others run in processes that obtain no token: none of them calls anything that does.
  const OBTAINS = /\b(?:getAuthToken|getAuthTokenAsync|getPowerAppsToken|dataverseRequest|preflightAuth|createMakerSdk|createAzHttpClient|makePcfSdk|noteToken)\b/;
  for (const label of Object.keys(OTHER)) assert.doesNotMatch(withoutComments(fs.readFileSync(path.join(SCRIPTS, label), 'utf8')), OBTAINS, `${label} obtains no token`);
});

test('the SDK\'s workspace the push makes is guarded like the receipt — what the SDK writes into it holds no token — and the reads of this plugin write nothing into it but the manifest', async () => {
  const { makePcfSdk, findCustomControl, listCustomControls } = require('../lib/pcf-dataverse.js');
  const { noteToken } = require('../lib/output-redaction.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-workspace-token-'));
  try {
    noteToken(TOKEN);
    // Answers that SUCCEED and repeat the token in every place a read can put it.
    const answer = (body) => ({ status: 200, headers: {}, body });
    const http = {
      get: async (url) => {
        const text = String(url);
        if (/EntityDefinitions\(LogicalName='customcontrol'\)/i.test(text)) return answer({ EntitySetName: 'customcontrols', LogicalName: 'customcontrol', note: TOKEN });
        if (/\/customcontrols\?/i.test(text)) return answer({ value: [{ customcontrolid: '11111111-1111-1111-1111-111111111111', name: `Contoso ${TOKEN}`, version: '1.0.0', componentstate: 0, ismanaged: false }] });
        return answer({ note: TOKEN });
      },
      post: async () => answer({}), patch: async () => answer({}), put: async () => answer({}), delete: async () => answer({}),
    };
    // The manifest the SDK writes names the instance it works on: here an address that holds the token, which is the one place a text the process knows can reach the workspace of a read.
    const workspace = path.join(dir, 'workspace');
    const sdk = await makePcfSdk(`https://contoso.crm.dynamics.com/${TOKEN}`, workspace, http);
    assert.equal((await findCustomControl(sdk, 'new_Contoso.Controls.StarRating')).name, `Contoso ${TOKEN}`, 'the data a read returns is the caller\'s, as it came');
    assert.equal((await listCustomControls(sdk)).length, 1);
    const written = filesUnder(workspace);
    assert.deepEqual([...written.keys()], ['manifest.json'], 'a read writes nothing into the workspace but the manifest');
    for (const [name, text] of written) assert.deepEqual(leaksIn(text), [], `${name} holds the token`);
    assert.equal(JSON.parse(written.get('manifest.json')).instanceUrl, `https://contoso.crm.dynamics.com/${MARK}`, 'the marker stands where the token was');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
