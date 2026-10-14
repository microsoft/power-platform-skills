'use strict';

// The type generator, the page listing and the page download are the plugin's `scripts/genpage.js types | list | download`. A capture made before that script records the pac verbs it
// replaced (`pac model genpage generate-types | list | download`) and is still graded, so the graders read both forms. These tests hold them to reading the two the same way:
//
//   - a capture that records the pac verbs still passes the expectations about them, and, with the verbs rewritten to the script, earns every verdict it earned before;
//   - the verb patterns read both forms — the script also when its path is quoted — and nothing that only starts like one (`list-connector-tables` is no `list`);
//   - `genpage.js add-to-app | remove-from-app | delete` change an app or delete a page, so they are mutations: they need the latest successful auth gate, a current-contract
//     fixture records an event for each, and a refusal holds none.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { gradeFixture } = require('../run-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { GENERATE_TYPES, GENPAGE_LIST, GENPAGE_DOWNLOAD } = require('../lib/expectation-evidence.js');
const { isMutation, authGateProblems, refusalProblems, unassociatedCallProblems } = require('../lib/workflow-evidence.js');
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
