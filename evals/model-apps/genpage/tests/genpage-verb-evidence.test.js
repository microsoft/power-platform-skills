'use strict';

// The type generator, the page listing and the page download are the plugin's `scripts/genpage.js types | list | download`. A capture made before that script records the pac verbs it
// replaced (`pac model genpage generate-types | list | download`) and is still graded, so the graders read both forms. These tests hold them to reading the two the same way:
//
//   - a capture that records the pac verbs still passes the expectations about them, and, with the verbs rewritten to the script, earns every verdict it earned before;
//   - the verb patterns read both forms — the script also when its path is quoted — and nothing that only starts like one (`list-connector-tables` is no `list`);
//   - `genpage.js add-to-app | remove-from-app | delete` change an app or delete a page, so they are mutations: they need the latest successful auth gate, a current-contract
//     fixture records an event for each, and a refusal holds none;
//   - a flag's value quoted after its `=` (`--env='https://…'`) is one argument, as the shell passes it, so no write verb hides behind it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { gradeFixture } = require('../run-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { GENERATE_TYPES, GENPAGE_LIST, GENPAGE_DOWNLOAD } = require('../lib/expectation-evidence.js');
const { isMutation, authGateProblems, refusalProblems, unassociatedCallProblems } = require('../lib/workflow-evidence.js');
const { commandInfo } = require('../lib/evidence-utils.js');
const evalsData = require('../evals.json');

const FIXTURES = loadFixtures(path.join(__dirname, '..', 'fixtures'));
const evalById = new Map(evalsData.evals.map((entry) => [entry.id, entry]));

const SCRIPT = "node 'D:/repo/plugins/model-apps/scripts/genpage.js'";
const ENV = "--env 'https://contoso.crm.dynamics.com'";
const PAC_FORM = /\bpac model genpage (?:generate-types|list(?![\w-])|download)\b/;

// A capture's log with each pac verb said the way the script says it. A command is rewritten with its flags (the script needs `--env`, and calls the download's folder `--output-directory`
// where pac called it `--path`); a line that only names the verb, such as "generate-types not run (mock data)", names the script's command and gains no flag — as a log written
// today would put it.
function toScriptForm(log) {
  const verb = (script) => (_, rest) => (/^\s+--/.test(rest)
    ? `${SCRIPT} ${script} ${ENV}${rest.replace(/--path\b/, '--output-directory')}`
    : `genpage.js ${script}${rest}`);
  return log
    .replace(/\bpac model genpage generate-types\b([^\n]*)/g, verb('types'))
    .replace(/\bpac model genpage list(?![\w-])([^\n]*)/g, verb('list'))
    .replace(/\bpac model genpage download\b([^\n]*)/g, verb('download'));
}

test('toScriptForm rewrites a command with its flags and a bare mention without any', () => {
  assert.equal(toScriptForm('- `pac model genpage list --app-id 1` → 2 pages'), `- \`${SCRIPT} list ${ENV} --app-id 1\` → 2 pages`);
  assert.equal(toScriptForm('- pac model genpage generate-types not run (mock data)'), '- genpage.js types not run (mock data)');
  assert.equal(toScriptForm('- `pac model genpage download --app-id 1 --page-id 2 --path out`'), `- \`${SCRIPT} download ${ENV} --app-id 1 --page-id 2 --output-directory out\``);
  // `list-connector-tables` has no script, so it stays what it is.
  assert.equal(toScriptForm('- `pac model genpage list-connector-tables --environment x`'), '- `pac model genpage list-connector-tables --environment x`');
});

test('a capture that records the pac verbs still passes their expectations, and grades the same once they are rewritten to the script', () => {
  const captured = FIXTURES.filter((fixture) => PAC_FORM.test(fixture.workflowLog || ''));
  assert.ok(captured.length >= 1, 'a committed capture still records a pac verb for this test to read');
  const passed = new Set();
  for (const fixture of captured) {
    const entry = evalById.get(fixture.id);
    const rewritten = toScriptForm(fixture.workflowLog);
    assert.ok(!PAC_FORM.test(rewritten), `${fixture.dirName}: no pac verb is left to rewrite`);
    const before = gradeFixture(fixture, entry, evalsData);
    const after = gradeFixture({ ...fixture, workflowLog: rewritten }, entry, evalsData);
    assert.deepEqual(after.map((r) => [r.text, r.result.status]), before.map((r) => [r.text, r.result.status]), `${fixture.dirName}: the verdicts changed with the form`);
    for (const { text, result } of before.filter((r) => /genpage\.js (?:types|list|download)/.test(r.text))) {
      assert.notEqual(result.status, 'fail', `${fixture.dirName}: ${text}: ${result.reason}`);
      if (result.status === 'pass') passed.add(/genpage\.js (types|list|download)/.exec(text)[1]);
    }
  }
  assert.deepEqual([...passed].sort(), ['list', 'types'], 'a capture earns a pass from the type-generator and the page-listing expectations');
});

test('the verb patterns read the script — also with a quoted path — and the pac verb it replaced, and nothing that only starts like them', () => {
  const read = (pattern, accepted, refused) => {
    for (const command of accepted) assert.ok(pattern.test(command), `reads: ${command}`);
    for (const command of refused) assert.ok(!pattern.test(command), `does not read: ${command}`);
  };
  const quoted = (verb) => [
    `node 'D:/repo/plugins/model-apps/scripts/genpage.js' ${verb} --env 'https://contoso.crm.dynamics.com'`,
    `node "\${PLUGIN_ROOT}/scripts/genpage.js" ${verb} --env https://contoso.crm.dynamics.com`,
    `node D:\\repo\\plugins\\model-apps\\scripts\\genpage.js ${verb} --env https://contoso.crm.dynamics.com`,
    `node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com`,
  ];
  const others = [
    'pac model genpage upload --code-file p.tsx',
    'node scripts/genpage-upload.js --env https://contoso.crm.dynamics.com --code-file p.tsx',
    'node scripts/genpage.js add-to-app --env https://contoso.crm.dynamics.com --app-id 1 --page-id 2',
    'pac model genpage list-connector-tables --environment https://contoso.crm.dynamics.com',
  ];
  read(GENERATE_TYPES, [...quoted('types'), "pac model genpage generate-types --data-sources 'account' --output-file RuntimeTypes.ts", 'pac.exe model genpage generate-types --data-sources account'],
    [...quoted('list'), ...quoted('download'), ...quoted('typesafe'), ...others]);
  read(GENPAGE_LIST, [...quoted('list'), 'pac model genpage list --app-id 1'],
    [...quoted('types'), ...quoted('download'), ...quoted('list-all'), ...others, 'pac model list --search sales']);
  read(GENPAGE_DOWNLOAD, [...quoted('download'), 'pac model genpage download --app-id 1 --page-id 2 --path out'],
    [...quoted('types'), ...quoted('list'), ...quoted('download-all'), ...others]);
});

test('genpage.js add-to-app, remove-from-app and delete are mutations; list, download and types only read', () => {
  for (const verb of ['add-to-app', 'remove-from-app', 'delete']) {
    assert.ok(isMutation(`node 'D:/repo/plugins/model-apps/scripts/genpage.js' ${verb} --env 'https://contoso.crm.dynamics.com' --app-id 1 --page-id 2`), `${verb} (quoted path)`);
    assert.ok(isMutation(`node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com --app-id 1 --page-id 2`), verb);
  }
  for (const verb of ['list', 'download', 'types']) {
    assert.equal(isMutation(`node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com`), false, verb);
    assert.equal(isMutation(`node scripts/genpage.js --env https://contoso.crm.dynamics.com ${verb}`), false, `${verb} (flags first)`);
  }
  // The script reads its flags before the verb as well, so a write is one whichever comes first.
  for (const verb of ['add-to-app', 'remove-from-app', 'delete']) {
    assert.ok(isMutation(`node scripts/genpage.js --env https://contoso.crm.dynamics.com ${verb} --app-id 1 --page-id 2`), `${verb} (flags first)`);
    assert.ok(isMutation(`node 'D:/repo/plugins/model-apps/scripts/genpage.js' --env=https://contoso.crm.dynamics.com ${verb} --page-id 2`), `${verb} (flags first, = form, quoted path)`);
  }
  // An upload is still one; a script that only reads the auth state is not.
  assert.ok(isMutation('node scripts/genpage-upload.js --env https://contoso.crm.dynamics.com --code-file p.tsx'));
  assert.equal(isMutation('node scripts/check-auth.js --require-pac'), false);
});

test('a genpage.js mutation needs the latest successful auth gate, as an upload does; the verbs that only read do not', () => {
  const log = (ok, verb) => `- \`node check-auth.js --require-pac\` → returned \`{ ok: ${ok}, ... }\`\n- \`node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com --app-id 1 --page-id 2\`\n`;
  for (const verb of ['add-to-app', 'remove-from-app', 'delete']) {
    assert.deepEqual(authGateProblems({ workflowLog: log(true, verb) }), [], verb);
    assert.match(authGateProblems({ workflowLog: log(false, verb) }).join('\n'), /genpage\.js .* mutation attempted without the latest successful auth gate/s, verb);
  }
  for (const verb of ['list', 'download', 'types']) assert.deepEqual(authGateProblems({ workflowLog: log(false, verb) }), [], verb);
});

test('a current-contract fixture that logs a genpage.js mutation records an event for it', () => {
  const command = 'node scripts/genpage.js delete --env https://contoso.crm.dynamics.com --page-id 2';
  const fixture = (events) => ({ contractVersion: 2, workflowLog: `- \`${command}\`\n`, events });
  assert.deepEqual(unassociatedCallProblems(fixture([{ command, result: { ok: true } }])), []);
  assert.deepEqual(unassociatedCallProblems(fixture([])), ['genpage: logged command has no associated result event']);
});

test('a refusal that went on to add, remove or delete a page is not a refusal', () => {
  const refused = (workflowLog) => ({ manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog });
  const halted = '- `node check-auth.js` → returned `{ ok: false, ... }`\n';
  const problem = 'refused workflow generated a page or attempted a mutation';
  assert.ok(!refusalProblems(refused(halted)).includes(problem), 'a halt after the failed gate is a refusal');
  for (const verb of ['add-to-app', 'remove-from-app', 'delete']) {
    const problems = refusalProblems(refused(`${halted}- \`node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com --app-id 1 --page-id 2\`\n`));
    assert.ok(problems.includes(problem), verb);
  }
  for (const verb of ['list', 'types']) {
    assert.ok(!refusalProblems(refused(`${halted}- \`node scripts/genpage.js ${verb} --env https://contoso.crm.dynamics.com\`\n`)).includes(problem), verb);
  }
});

test('apps.js create is a mutation whether its flags come before or after the verb; apps.js list is not', () => {
  const writes = [
    'node scripts/apps.js create --env https://contoso.crm.dynamics.com --name X --solution Default --page-id 1',
    'node scripts/apps.js --env https://contoso.crm.dynamics.com create --name X --solution Default --page-id 1',
    "node 'D:/repo/plugins/model-apps/scripts/apps.js' --env 'https://contoso.crm.dynamics.com' create --name 'Account Metrics' --solution Default --page-id 1",
    'node D:\\repo\\plugins\\model-apps\\scripts\\apps.js --solution Default create --name X --page-id 1',
    'pac model create --name X',
  ];
  for (const command of writes) assert.ok(isMutation(command), command);
  const reads = [
    'node scripts/apps.js list --env https://contoso.crm.dynamics.com',
    'node scripts/apps.js --env https://contoso.crm.dynamics.com list --search create',
    'node scripts/myapps.js create --name X',
  ];
  for (const command of reads) assert.equal(isMutation(command), false, command);
});

test('a write whose flags come first still needs the latest successful auth gate, is matched to its event, and breaks a refusal', () => {
  const gate = (ok) => `- \`node check-auth.js --require-pac\` → returned \`{ ok: ${ok}, ... }\`\n`;
  for (const command of [
    'node scripts/apps.js --env https://contoso.crm.dynamics.com create --name X --solution Default --page-id 1',
    'node scripts/genpage.js --env https://contoso.crm.dynamics.com delete --page-id 2 --allow-destructive',
  ]) {
    const line = `- \`${command}\`\n`;
    assert.deepEqual(authGateProblems({ workflowLog: gate(true) + line }), [], command);
    assert.match(authGateProblems({ workflowLog: gate(false) + line }).join('\n'), /mutation attempted without the latest successful auth gate/, command);
    const fixture = (events) => ({ contractVersion: 2, workflowLog: line, events });
    assert.deepEqual(unassociatedCallProblems(fixture([{ command, result: { ok: true } }])), [], command);
    assert.equal(unassociatedCallProblems(fixture([])).length, 1, command);
    const refused = { manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog: gate(false) + line };
    assert.ok(refusalProblems(refused).includes('refused workflow generated a page or attempted a mutation'), command);
  }
});

// A shell joins a quoted value to the text before it, so `--env='https://…'` reaches the script as the ONE argument `--env=https://…`. Split at the quote,
// the URL read as the first positional argument, so the graders took it for the verb and a write after it went unseen.
const QUOTED_ENVS = ["--env='https://contoso.crm.dynamics.com'", '--env="https://contoso.crm.dynamics.com"'];
const writesBehind = (env) => [
  `node scripts/apps.js ${env} create --name X --solution Default --page-id 1`,
  ...['add-to-app', 'remove-from-app', 'delete'].map((verb) => `node scripts/genpage.js ${env} ${verb} --app-id 1 --page-id 2`),
];

test("commandInfo reads a value quoted after its flag's = as one argument, the way the shell passes it", () => {
  for (const env of QUOTED_ENVS) {
    const info = commandInfo({ command: `node scripts/apps.js ${env} create --name X` });
    assert.equal(info.flags.env, 'https://contoso.crm.dynamics.com', env);
    assert.deepEqual(info.positional, ['node', 'scripts/apps.js', 'create'], env);
  }
  const upload = commandInfo({ command: `node scripts/genpage-upload.js --code-file="pages/Account Metrics.tsx" --data-sources='account,contact' --app-id 1` });
  assert.deepEqual(upload.flags, { 'code-file': 'pages/Account Metrics.tsx', 'data-sources': 'account,contact', 'app-id': '1' });
  assert.deepEqual(upload.positional, ['node', 'scripts/genpage-upload.js']);
  // The forms that were read right before are read the same: a value after a space, a quoted path, a bare value after `=`.
  const before = commandInfo({ command: "node 'D:/repo/plugins/model-apps/scripts/apps.js' --env 'https://contoso.crm.dynamics.com' --solution=Default create" });
  assert.deepEqual(before.flags, { env: 'https://contoso.crm.dynamics.com', solution: 'Default' });
  assert.deepEqual(before.positional, ['node', 'D:/repo/plugins/model-apps/scripts/apps.js', 'create']);
  // A log writes the command inside markdown backticks; the closing one, right after a quoted value, is no part of that value.
  const logged = commandInfo({ command: "`node scripts/genpage.js --env='https://contoso.crm.dynamics.com' list --app-id '11111111-2222-3333-4444-555555555555'` → 2 pages" });
  assert.deepEqual(logged.flags, { env: 'https://contoso.crm.dynamics.com', 'app-id': '11111111-2222-3333-4444-555555555555' });
});

test('a write behind a quoted --flag=value is still a mutation: apps.js create and each genpage.js write; the reads stay reads', () => {
  for (const env of QUOTED_ENVS) {
    for (const command of writesBehind(env)) assert.ok(isMutation(command), command);
    for (const verb of ['list', 'download', 'types']) assert.equal(isMutation(`node scripts/genpage.js ${env} ${verb}`), false, `${verb} ${env}`);
    assert.equal(isMutation(`node scripts/apps.js ${env} list`), false, `apps.js list ${env}`);
  }
});

test('a write behind a quoted --flag=value needs the latest successful auth gate, is matched to its event, and breaks a refusal', () => {
  const gate = (ok) => `- \`node check-auth.js --require-pac\` → returned \`{ ok: ${ok}, ... }\`\n`;
  for (const command of QUOTED_ENVS.flatMap((env) => writesBehind(env))) {
    const line = `- \`${command}\`\n`;
    assert.deepEqual(authGateProblems({ workflowLog: gate(true) + line }), [], command);
    assert.match(authGateProblems({ workflowLog: gate(false) + line }).join('\n'), /mutation attempted without the latest successful auth gate/, command);
    const fixture = (events) => ({ contractVersion: 2, workflowLog: line, events });
    assert.deepEqual(unassociatedCallProblems(fixture([{ command, result: { ok: true } }])), [], command);
    assert.equal(unassociatedCallProblems(fixture([])).length, 1, command);
    const refused = { manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog: gate(false) + line };
    assert.ok(refusalProblems(refused).includes('refused workflow generated a page or attempted a mutation'), command);
  }
});
