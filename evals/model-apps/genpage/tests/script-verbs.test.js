'use strict';

// How the graders read the plugin's scripts that take a verb — `apps.js list | create`, `genpage.js list | download | types | add-to-app | remove-from-app | delete` and
// `solution-settings.js template | import` — in recorded command text, and what they make of the one line of JSON those scripts print. The graders read TEXT; they are not a shell
// (lib/evidence-utils.js, "How the graders read a recorded command"). Four things are held here, and then the limits of reading text:
//
//   - every occurrence of a script counts: a call that reads and then writes is a mutation, for the auth-gate, refusal and result-event checks as for `isMutation` — in the command
//     text and in the argv an event records;
//   - the phase expectations read a verb the way the script does, the first positional argument after its flags, so `genpage.js --env <url> types …` is the run `genpage.js types
//     --env <url> …` is — and a "skipped" phase is not credited to a run that did it that way;
//   - `solution-settings.js import` writes to the environment (and so does the `pac solution import` it falls back to); `template` only prints a settings file;
//   - a listing recorded as the scripts print it, one line of JSON, is read as data when it is captured as text.
//
// Each section also pins what must NOT change around it: the verb-first forms, a quoted mention, a flag's value that spells a verb, the pac forms of an older capture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { gradeFixture } = require('../run-layer-1.js');
const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { scriptRuns, scriptSwitches } = require('../lib/evidence-utils.js');
const {
  LIST_APPS, CREATE_APP, GENERATE_TYPES, GENPAGE_LIST, GENPAGE_DOWNLOAD, listingRows, generateTypesCalls,
} = require('../lib/expectation-evidence.js');
const { isMutation, authGateProblems, refusalProblems, unassociatedCallProblems, workflowCalls } = require('../lib/workflow-evidence.js');
const evalsData = require('../evals.json');

const FIXTURES = loadFixtures(path.join(__dirname, '..', 'fixtures'));
const evalById = new Map(evalsData.evals.map((entry) => [entry.id, entry]));

const ENV = 'https://contoso.crm.dynamics.com';
const PAGE = '11111111-2222-4333-8444-555555555555';
const APP = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const APP_B = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

const CREATE_FLAGS = `--env ${ENV} --name Metrics --solution Default --page-id ${PAGE}`;
const PLACE_FLAGS = `--env ${ENV} --app-id ${APP} --page-id ${PAGE}`;
const TYPES_FLAGS = '--data-sources account --output-file RuntimeTypes.ts';

const verbsOf = (source, script) => scriptRuns(source, script).map((run) => run.verb);

// --- scriptRuns: the one reader --------------------------------------------------------------------------------------------------------------------------------------------------

test('scriptRuns: one run for every occurrence of a script, in order, each with its own verb', () => {
  assert.deepEqual(verbsOf(`node scripts/apps.js list --env ${ENV}; node scripts/apps.js create ${CREATE_FLAGS}`, 'apps.js'), ['list', 'create']);
  assert.deepEqual(verbsOf(`node scripts/apps.js create ${CREATE_FLAGS} && node scripts/apps.js list --env ${ENV}`, 'apps.js'), ['create', 'list']);
  assert.deepEqual(verbsOf(`node scripts/genpage.js list --env ${ENV}\nnode scripts/genpage.js delete --env ${ENV} --page-id ${PAGE}`, 'genpage.js'), ['list', 'delete']);
  assert.deepEqual(verbsOf(`node scripts/genpage.js list --env ${ENV} | head -5\r\nnode scripts/genpage.js --env ${ENV} remove-from-app --app-id ${APP} --page-id ${PAGE}`, 'genpage.js'), ['list', 'remove-from-app']);
  // Another script's run is not this one's.
  assert.deepEqual(verbsOf(`node scripts/apps.js list --env ${ENV}; node scripts/genpage.js delete --env ${ENV} --page-id ${PAGE}`, 'apps.js'), ['list']);
  assert.deepEqual(verbsOf(`node scripts/apps.js list --env ${ENV}; node scripts/genpage.js delete --env ${ENV} --page-id ${PAGE}`, 'genpage.js'), ['delete']);
  assert.deepEqual(verbsOf('git status --short', 'apps.js'), []);
  assert.deepEqual(verbsOf('', 'apps.js'), []);
  assert.deepEqual(verbsOf(undefined, 'apps.js'), []);
});

test('scriptRuns reads the verb the way the script does: after its flags, skipping the value of a flag that takes one', () => {
  const read = (text, script = 'apps.js') => verbsOf(text, script);
  assert.deepEqual(read(`node scripts/apps.js list --env ${ENV}`), ['list']);
  assert.deepEqual(read(`node scripts/apps.js --env ${ENV} list`), ['list']);
  assert.deepEqual(read(`node scripts/apps.js --env=${ENV} --solution Default create --name Metrics --page-id ${PAGE}`), ['create']);
  // A value that spells a verb is a value: the script takes `--search create` for a search term.
  assert.deepEqual(read(`node scripts/apps.js --env ${ENV} --search create list`), ['list']);
  assert.deepEqual(read(`node scripts/apps.js --search=create --env ${ENV} list`), ['list']);
  assert.deepEqual(read(`node scripts/genpage.js --env ${ENV} --output-file types list`, 'genpage.js'), ['list']);
  assert.deepEqual(read(`node scripts/genpage.js --env ${ENV} --output-directory delete download --page-id ${PAGE}`, 'genpage.js'), ['download']);
  // An empty value is still the flag's value (`--description ''` reaches the script as an argument).
  assert.deepEqual(read(`node scripts/apps.js --description '' --env ${ENV} create --name Metrics --solution Default --page-id ${PAGE}`), ['create']);
  // A call with no verb has none; a flag that is the last word takes nothing.
  assert.deepEqual(read(`node scripts/apps.js --env ${ENV}`), [null]);
  assert.deepEqual(read('node scripts/apps.js'), [null]);
  assert.deepEqual(read(`node scripts/apps.js --env`), [null]);
});

test('scriptRuns: a switch takes no value, so a switch in front of the verb does not hide it — the switches are the scripts\' own', () => {
  assert.deepEqual(verbsOf(`node scripts/apps.js --publish create ${CREATE_FLAGS}`, 'apps.js'), ['create']);
  assert.deepEqual(verbsOf(`node scripts/genpage.js --include-unpublished list --env ${ENV} --app-id ${APP}`, 'genpage.js'), ['list']);
  assert.deepEqual(verbsOf(`node scripts/genpage.js --allow-destructive delete --env ${ENV} --page-id ${PAGE}`, 'genpage.js'), ['delete']);
  assert.deepEqual(verbsOf(`node scripts/genpage.js --env ${ENV} --allow-empty-navigation remove-from-app --app-id ${APP} --page-id ${PAGE}`, 'genpage.js'), ['remove-from-app']);
  // Every flag but those takes the next word, as the script's argument reader does for any flag it is given.
  assert.deepEqual(verbsOf(`node scripts/genpage.js --not-a-flag delete --env ${ENV} --page-id ${PAGE}`, 'genpage.js'), [null]);
  assert.deepEqual(verbsOf(`node scripts/genpage.js --not-a-flag x delete --env ${ENV} --page-id ${PAGE}`, 'genpage.js'), ['delete']);
  // The lists are read from the scripts: a flag their declarations give no value to.
  const { VERBS } = require('../../../../plugins/model-apps/scripts/genpage.js');
  const { COMMANDS } = require('../../../../plugins/model-apps/scripts/apps.js');
  const switchesOf = (table) => [...new Set(Object.values(table).flatMap(({ known, needValue }) => known.filter((flag) => !needValue.includes(flag))))].sort();
  assert.deepEqual([...scriptSwitches('apps.js')].sort(), switchesOf(COMMANDS));
  assert.deepEqual([...scriptSwitches('genpage.js')].sort(), switchesOf(VERBS));
  assert.deepEqual([...scriptSwitches('apps.js')], ['publish']);
  assert.deepEqual([...scriptSwitches('genpage.js')].sort(), ['allow-destructive', 'allow-empty-navigation', 'include-unpublished']);
});

test('scriptRuns reads a script\'s path as it is written: quoted, relative, absolute, Windows, in a Markdown code span', () => {
  const at = (path) => `node ${path} --env ${ENV} list`;
  for (const command of [
    at('scripts/apps.js'),
    at('./scripts/apps.js'),
    at("'D:/repo/plugins/model-apps/scripts/apps.js'"),
    at('"${PLUGIN_ROOT}/scripts/apps.js"'),
    at('D:\\repo\\plugins\\model-apps\\scripts\\apps.js'),
    at('.\\scripts\\apps.js'),
    at('apps.js'),
    `- \`${at('scripts/apps.js')}\` → 2 apps`,
    `- Planner ran \`${at("'D:/repo/plugins/model-apps/scripts/apps.js'")}\` → 2 apps (Sales, Service)`,
  ]) assert.deepEqual(verbsOf(command, 'apps.js'), ['list'], command);
  assert.deepEqual(verbsOf(`- \`node scripts/apps.js --env ${ENV} create ${CREATE_FLAGS.replace(`--env ${ENV} `, '')}\``, 'apps.js'), ['create']);
});

test('scriptRuns: what is not a run of the script — a quoted mention, another name, the script as a file argument with no verb after it', () => {
  for (const command of [
    `node scripts/apps.js list --env ${ENV} --search "apps.js create"`,
    `node scripts/apps.js list --env ${ENV} --search 'node scripts/apps.js create'`,
    'node scripts/myapps.js create --name X',
    'node scripts/apps.json create',
    'node scripts/apps.js.bak create',
    'echo "node scripts/apps.js create"',
  ]) assert.ok(!verbsOf(command, 'apps.js').includes('create'), command);
  for (const command of ['cat scripts/apps.js', 'Get-Content scripts/apps.js', 'grep -n create scripts/apps.js', 'git diff -- scripts/apps.js', 'type scripts\\apps.js | findstr create']) {
    assert.ok(!verbsOf(command, 'apps.js').some((verb) => verb === 'create'), command);
  }
});

test('scriptRuns reads the argv an event records, after its text: the verb may be in either', () => {
  assert.deepEqual(verbsOf({ command: 'node scripts/apps.js', argv: ['create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] }, 'apps.js'), ['create']);
  assert.deepEqual(verbsOf({ command: 'node', argv: ['scripts/genpage.js', '--env', ENV, 'delete', '--page-id', PAGE] }, 'genpage.js'), ['delete']);
  assert.deepEqual(verbsOf({ command: `node scripts/apps.js list --env ${ENV}`, argv: ['scripts/apps.js', 'create', '--env', ENV] }, 'apps.js'), ['list', 'create']);
  assert.deepEqual(verbsOf({ command: 'node scripts/apps.js list', argv: ['--env', ENV] }, 'apps.js'), ['list']);
  // The text and its argv that repeat each other name the run twice, with the same verb.
  assert.deepEqual(verbsOf({ command: `node scripts/apps.js list --env ${ENV}`, argv: ['scripts/apps.js', 'list', '--env', ENV] }, 'apps.js'), ['list', 'list']);
  assert.deepEqual(verbsOf({ command: 'node scripts/apps.js list', argv: 'not a list' }, 'apps.js'), ['list']);
});

test("scriptRuns reads solution-settings.js's verb as its first argument, the way the script does", () => {
  assert.deepEqual(verbsOf(`node scripts/solution-settings.js import --env ${ENV} --package app.zip --settings settings.json`, 'solution-settings.js'), ['import']);
  assert.deepEqual(verbsOf(`node scripts/solution-settings.js template --env ${ENV} --solution Sales --out settings.json`, 'solution-settings.js'), ['template']);
  assert.deepEqual(verbsOf(`node scripts/solution-settings.js template --solution Sales --out settings.json; node scripts/solution-settings.js import --env ${ENV} --package app.zip --settings s.json`, 'solution-settings.js'), ['template', 'import']);
  // The script answers `--env` with "unknown command", so there is no verb in `solution-settings.js --env <url> import`.
  assert.deepEqual(verbsOf(`node scripts/solution-settings.js --env ${ENV} import --package app.zip --settings s.json`, 'solution-settings.js'), ['--env']);
});

// --- every run of a script counts ---------------------------------------------------------------------------------------------------------------------------------

const WRITES = {
  'apps.js create': `node scripts/apps.js create ${CREATE_FLAGS}`,
  'genpage.js add-to-app': `node scripts/genpage.js add-to-app ${PLACE_FLAGS}`,
  'genpage.js remove-from-app': `node scripts/genpage.js remove-from-app ${PLACE_FLAGS}`,
  'genpage.js delete': `node scripts/genpage.js delete --env ${ENV} --page-id ${PAGE} --allow-destructive`,
};
const READS = {
  'apps.js list': `node scripts/apps.js list --env ${ENV}`,
  'genpage.js list': `node scripts/genpage.js list --env ${ENV}`,
  'genpage.js download': `node scripts/genpage.js download --env ${ENV} --page-id ${PAGE} --output-directory out`,
  'genpage.js types': `node scripts/genpage.js types --env ${ENV} ${TYPES_FLAGS}`,
};
// What joins two commands in one tool call: a PowerShell or bash `;`, `&&`, `||`, a pipe, a newline.
const JOINERS = [' ; ', '; ', ' && ', ' || ', ' | ', '\n', '\r\n'];

test('every run counts: a call that reads and then writes is a mutation, in either order and however the commands are joined', () => {
  for (const [write, writeCommand] of Object.entries(WRITES)) {
    for (const [read, readCommand] of Object.entries(READS)) {
      for (const joiner of JOINERS) {
        assert.ok(isMutation(`${readCommand}${joiner}${writeCommand}`), `${read}${JSON.stringify(joiner)}${write}`);
        assert.ok(isMutation(`${writeCommand}${joiner}${readCommand}`), `${write}${JSON.stringify(joiner)}${read}`);
      }
    }
  }
  // More than two: the write is last, in the middle, or one of several reads' neighbours.
  assert.ok(isMutation(`${READS['apps.js list']}; ${READS['genpage.js list']}; ${WRITES['apps.js create']}`));
  assert.ok(isMutation(`${READS['apps.js list']}; ${WRITES['genpage.js delete']}; ${READS['genpage.js list']}`));
  // The second run writes with its flags first, or after a quoted path, or a switch before the verb.
  assert.ok(isMutation(`${READS['apps.js list']}; node scripts/apps.js --env ${ENV} create --name Metrics --solution Default --page-id ${PAGE}`));
  assert.ok(isMutation(`${READS['genpage.js list']}; node 'D:/repo/plugins/model-apps/scripts/genpage.js' --env='${ENV}' --allow-destructive delete --page-id ${PAGE}`));
  assert.ok(isMutation(`${READS['apps.js list']}; node scripts/apps.js --publish create ${CREATE_FLAGS}`));
  // A write recorded in a Markdown log line beside a read, as a log records two commands in one line.
  for (const [name, write] of Object.entries(WRITES)) {
    const [call] = workflowCalls({ workflowLog: `- \`${READS['apps.js list']}\` then \`${write}\`\n` });
    assert.ok(isMutation(call), name);
    assert.ok(isMutation(call.command), name);
  }
});

test('every run counts: reads, however many and however joined, are not mutations; neither is a write verb that is only a value or a mention', () => {
  for (const [first, firstCommand] of Object.entries(READS)) {
    assert.equal(isMutation(firstCommand), false, first);
    for (const [second, secondCommand] of Object.entries(READS)) {
      for (const joiner of JOINERS) assert.equal(isMutation(`${firstCommand}${joiner}${secondCommand}`), false, `${first}${JSON.stringify(joiner)}${second}`);
    }
  }
  for (const command of [
    `${READS['apps.js list']} --search create`,
    `node scripts/apps.js --env ${ENV} --search delete list`,
    `${READS['apps.js list']}; ${READS['apps.js list']} --search create`,
    `${READS['genpage.js list']}; echo delete`,
    `${READS['apps.js list']} --search "apps.js create"`,
    `${READS['apps.js list']} --search 'node scripts/genpage.js delete'`,
    `${READS['genpage.js download']}; ${READS['genpage.js download'].replace('--output-directory out', '--output-directory delete')}`,
    'Get-Content scripts/apps.js; Get-Content scripts/genpage.js',
    'cat scripts/apps.js | grep create',
    'type scripts\\genpage.js | findstr delete',
    'git diff -- scripts/apps.js scripts/genpage.js',
    'node scripts/myapps.js create --name X',
    `node scripts/check-auth.js --require-pac; ${READS['apps.js list']}`,
  ]) assert.equal(isMutation(command), false, command);
});

test('every run counts: the verb-first and flags-first writes, alone, are what they were', () => {
  for (const command of [
    ...Object.values(WRITES),
    `node scripts/apps.js --env ${ENV} create --name Metrics --solution Default --page-id ${PAGE}`,
    `node 'D:/repo/plugins/model-apps/scripts/apps.js' create ${CREATE_FLAGS}`,
    `node scripts/genpage.js --env ${ENV} delete --page-id ${PAGE} --allow-destructive`,
    'pac model create --name Metrics --solution Default',
    `node scripts/genpage-upload.js --env ${ENV} --code-file page.tsx`,
    `node scripts/provision-entities.js --env ${ENV} --input @spec.json --apply`,
  ]) assert.ok(isMutation(command), command);
});

test('every run counts: a node option before the script does not hide it — `--no-warnings` is no flag of the script, and takes no word of its own', () => {
  assert.deepEqual(verbsOf(`node --no-warnings scripts/apps.js list --env ${ENV}`, 'apps.js'), ['list']);
  assert.deepEqual(verbsOf(`node --env-file settings.env scripts/genpage.js --env ${ENV} types ${TYPES_FLAGS}`, 'genpage.js'), ['types']);
  for (const [name, write] of Object.entries(WRITES)) {
    assert.ok(isMutation(write.replace('node ', 'node --no-warnings ')), name);
    assert.ok(isMutation(write.replace('node ', 'node --env-file settings.env ')), name);
  }
  for (const read of Object.values(READS)) assert.equal(isMutation(read.replace('node ', 'node --no-warnings ')), false, read);
});

test('every run counts: the write that follows a read needs the latest successful auth gate, is matched to its event, and breaks a refusal', () => {
  const gate = (ok) => `- \`node check-auth.js --require-pac\` → returned \`{ ok: ${ok}, ... }\`\n`;
  for (const [name, write] of Object.entries(WRITES)) {
    for (const command of [`${READS['apps.js list']}; ${write}`, `${READS['genpage.js list']} && ${write}`]) {
      const line = `- \`${command}\`\n`;
      assert.deepEqual(authGateProblems({ workflowLog: gate(true) + line }), [], command);
      assert.match(authGateProblems({ workflowLog: gate(false) + line }).join('\n'), /mutation attempted without the latest successful auth gate/, command);
      const fixture = (events) => ({ contractVersion: 2, workflowLog: line, events });
      assert.deepEqual(unassociatedCallProblems(fixture([{ command, result: { ok: true } }])), [], command);
      assert.equal(unassociatedCallProblems(fixture([])).length, 1, command);
      const refused = { manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog: gate(false) + line };
      assert.ok(refusalProblems(refused).includes('refused workflow generated a page or attempted a mutation'), `${name}: ${command}`);
    }
  }
  // A chain of reads after a failed gate is no mutation, and the refusal holds.
  const reads = `- \`${READS['apps.js list']}; ${READS['genpage.js list']}\`\n`;
  assert.deepEqual(authGateProblems({ workflowLog: gate(false) + reads }), []);
  const refused = { manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog: gate(false) + reads };
  assert.ok(!refusalProblems(refused).includes('refused workflow generated a page or attempted a mutation'));
});

test('every run counts: an event that records its argv is read from its text and its argv', () => {
  const written = [
    { command: 'node scripts/apps.js', argv: ['create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] },
    { command: 'node', argv: ['scripts/apps.js', 'create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] },
    { command: 'node scripts/genpage.js', argv: ['--env', ENV, 'delete', '--page-id', PAGE, '--allow-destructive'] },
    { command: 'node', argv: ['scripts/genpage.js', 'add-to-app', '--env', ENV, '--app-id', APP, '--page-id', PAGE] },
    { command: 'node scripts/solution-settings.js', argv: ['import', '--env', ENV, '--package', 'app.zip', '--settings', 'settings.json'] },
    { command: `node scripts/apps.js list --env ${ENV}`, argv: ['scripts/apps.js', 'create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] },
    { command: `node scripts/apps.js create ${CREATE_FLAGS}`, argv: ['scripts/apps.js', 'create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] },
  ];
  const read = [
    { command: 'node scripts/apps.js', argv: ['list', '--env', ENV] },
    { command: 'node', argv: ['scripts/genpage.js', '--env', ENV, 'types', ...TYPES_FLAGS.split(' ')] },
    { command: `node scripts/apps.js list --env ${ENV}`, argv: ['scripts/apps.js', 'list', '--env', ENV] },
    { command: 'node scripts/solution-settings.js', argv: ['template', '--solution', 'Sales', '--out', 'settings.json'] },
  ];
  for (const call of written) assert.ok(isMutation(call), JSON.stringify(call));
  for (const call of read) assert.equal(isMutation(call), false, JSON.stringify(call));
  // The checks that ask whether a call mutated read the event whole.
  const gate = { id: 'gate', command: 'node scripts/check-auth.js --require-pac', result: { ok: false } };
  for (const call of written) {
    const fixture = { events: [gate, { id: 'write', ...call, result: { ok: true } }], workflowLog: '' };
    assert.match(authGateProblems(fixture).join('\n'), /mutation attempted without the latest successful auth gate/, JSON.stringify(call));
    assert.ok(refusalProblems({ ...fixture, manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [] }).includes('refused workflow generated a page or attempted a mutation'), JSON.stringify(call));
  }
  for (const call of read) {
    const fixture = { events: [gate, { id: 'read', ...call, result: { ok: true } }], workflowLog: '' };
    assert.deepEqual(authGateProblems(fixture), [], JSON.stringify(call));
  }
});

// --- a verb after the flags ---------------------------------------------------------------------------------------------------------------------------------------

const PATTERNS = [
  ['apps.js', 'list', LIST_APPS], ['apps.js', 'create', CREATE_APP],
  ['genpage.js', 'types', GENERATE_TYPES], ['genpage.js', 'list', GENPAGE_LIST], ['genpage.js', 'download', GENPAGE_DOWNLOAD],
];
const VERBS_OF = { 'apps.js': ['list', 'create'], 'genpage.js': ['list', 'download', 'types', 'add-to-app', 'remove-from-app', 'delete'] };
// A command that runs `verb` of `script`: with its flags written after the verb (the form the skills give, and the one the patterns always read) and before it, and with the script's path
// as a shell, a log or a Windows prompt writes it.
const verbFirst = (script, verb) => [
  `node scripts/${script} ${verb} --env ${ENV} --app-id ${APP}`,
  `node 'D:/repo/plugins/model-apps/scripts/${script}' ${verb} --env '${ENV}' --app-id '${APP}'`,
  `- \`node scripts/${script} ${verb} --env ${ENV}\` → ok`,
];
const flagsBeforeVerb = (script, verb) => [
  `node scripts/${script} --env ${ENV} ${verb}`,
  `node scripts/${script} --env=${ENV} --app-id ${APP} ${verb} --page-id ${PAGE}`,
  `node scripts/${script} --env ${ENV} --app-id=${APP} --page-id ${PAGE} ${verb}`,
  `node 'D:/repo/plugins/model-apps/scripts/${script}' --env '${ENV}' --app-id '${APP}' ${verb}`,
  `node "\${PLUGIN_ROOT}/scripts/${script}" --env='${ENV}' ${verb}`,
  `node D:\\repo\\plugins\\model-apps\\scripts\\${script} --env ${ENV} ${verb}`,
  `- \`node scripts/${script} --env ${ENV} ${verb}\` → ok`,
  `- Planner ran \`node 'D:/repo/plugins/model-apps/scripts/${script}' --env '${ENV}' ${verb}\` → 2 results`,
];
const forms = (script, verb) => [...verbFirst(script, verb), ...flagsBeforeVerb(script, verb)];

test('verb after flags: the verb patterns read a run whose flags come first as the same run, the script\'s path quoted or not', () => {
  for (const [script, verb, pattern] of PATTERNS) {
    for (const command of forms(script, verb)) assert.ok(pattern.test(command), `${script} ${verb}: ${command}`);
  }
});

test('verb after flags: a verb is only its own — another verb, a verb that only starts like it, another script, a flag\'s value that spells it', () => {
  for (const [script, verb, pattern] of PATTERNS) {
    for (const other of VERBS_OF[script].filter((name) => name !== verb)) {
      for (const command of forms(script, other)) assert.ok(!pattern.test(command), `${script} ${other} is no ${verb}: ${command}`);
    }
    for (const longer of [`${verb}s`, `${verb}safe`]) {
      for (const command of forms(script, longer)) assert.ok(!pattern.test(command), `${script} ${longer} is no ${verb}: ${command}`);
    }
    // The apps.js patterns have always read `apps.js list-all` as a list (the pattern wants a word boundary, and `-` is one), so only a verb after flags is held to being exact.
    for (const command of flagsBeforeVerb(script, `${verb}-all`)) assert.ok(!pattern.test(command), `${script} ${verb}-all is no ${verb}: ${command}`);
    const otherScript = script === 'apps.js' ? 'genpage.js' : 'apps.js';
    for (const command of forms(otherScript, verb)) assert.ok(!pattern.test(command), `${otherScript} ${verb} is no ${script} ${verb}: ${command}`);
  }
  // `--search create` is a search term and `--output-file types` a file name: the verb that follows is the verb.
  assert.ok(LIST_APPS.test(`node scripts/apps.js --env ${ENV} --search create list`));
  assert.ok(!CREATE_APP.test(`node scripts/apps.js --env ${ENV} --search create list`));
  assert.ok(GENPAGE_LIST.test(`node scripts/genpage.js --env ${ENV} --output-file types list`));
  assert.ok(!GENERATE_TYPES.test(`node scripts/genpage.js --env ${ENV} --output-file types list`));
  assert.ok(GENPAGE_DOWNLOAD.test(`node scripts/genpage.js --env ${ENV} --output-directory list download --page-id ${PAGE}`));
  assert.ok(!GENPAGE_LIST.test(`node scripts/genpage.js --env ${ENV} --output-directory list download --page-id ${PAGE}`));
  // A switch before the verb is not that verb's value.
  assert.ok(GENPAGE_LIST.test(`node scripts/genpage.js --include-unpublished list --env ${ENV} --app-id ${APP}`));
  assert.ok(CREATE_APP.test(`node scripts/apps.js --publish create ${CREATE_FLAGS}`));
  // The legacy pac forms of an older capture are still read, and `list-connector-tables` is no `list`.
  assert.ok(LIST_APPS.test('pac model list --search sales'));
  assert.ok(CREATE_APP.test('pac model create --name Metrics --solution Default'));
  assert.ok(GENERATE_TYPES.test("pac model genpage generate-types --data-sources 'account' --output-file RuntimeTypes.ts"));
  assert.ok(GENPAGE_LIST.test('pac.exe model genpage list --app-id 1'));
  assert.ok(GENPAGE_DOWNLOAD.test('pac model genpage download --app-id 1 --page-id 2 --path out'));
  assert.ok(!GENPAGE_LIST.test('pac model genpage list-connector-tables --environment x'));
});

test('verb after flags: a mention that is quoted, or a file the script is only an argument of, is no run of its verb', () => {
  assert.ok(LIST_APPS.test('options from the `apps.js list` output'), 'a mention in a sentence reads, as it always did');
  assert.ok(!GENPAGE_LIST.test('node scripts/apps.js --env x --search "genpage.js --env y list"'));
  assert.ok(!GENPAGE_LIST.test(`node scripts/apps.js list --env ${ENV} --search 'node scripts/genpage.js --env y list'`));
  assert.ok(!GENERATE_TYPES.test('Get-Content scripts/genpage.js'));
  assert.ok(!GENERATE_TYPES.test(`Select-String -Path scripts/genpage.js -Pattern types`));
  assert.ok(!CREATE_APP.test('cat scripts/apps.js'));
  assert.ok(!CREATE_APP.test('grep -n create scripts/apps.js'));
});


const SKIPPED = 'Phase 4: RuntimeTypes generation is SKIPPED (mock data)';
const TYPES_IS_RUN = "Phase 4: genpage.js types --data-sources 'account' --output-file <working-dir>/RuntimeTypes.ts is run";
const grade = (text, fixture) => PHASE_EXPECTATIONS.get(text)({ fixture, eval: {} });

test('verb after flags: a skipped phase cannot pass — the type generator run with its flags first fails "RuntimeTypes generation is SKIPPED"', () => {
  const log = (command) => `# Phase 4\n- \`${command}\` → RuntimeTypes.ts written\n`;
  for (const command of [
    `node scripts/genpage.js types --env ${ENV} ${TYPES_FLAGS}`,
    `node scripts/genpage.js --env ${ENV} types ${TYPES_FLAGS}`,
    `node 'D:/repo/plugins/model-apps/scripts/genpage.js' --env='${ENV}' types ${TYPES_FLAGS}`,
    `node scripts/genpage.js --env ${ENV} --data-sources account types --output-file RuntimeTypes.ts`,
    `node scripts/genpage.js --env ${ENV} types`,
    `pac model genpage generate-types ${TYPES_FLAGS}`,
  ]) assert.equal(grade(SKIPPED, { workflowLog: log(command) }).status, 'fail', command);
  // Prose that says it was not run, with or without the script's name, is no run.
  for (const prose of [
    '- genpage.js types not run (mock data)',
    '- pac model genpage generate-types not run (mock data)',
    '- SKIPPED (mock data — no RuntimeTypes needed)',
    '- RuntimeTypes generation SKIPPED (no Dataverse data sources)',
    '- Reading `genpage.js` is not needed: the page uses mock data',
  ]) assert.equal(grade(SKIPPED, { workflowLog: `${prose}\n` }).status, 'pass', prose);
  assert.equal(grade(SKIPPED, { workflowLog: '' }).status, 'fail', 'no workflow-log.md');
});

test('verb after flags: "types … is run" is credited to a run with its flags first, and not to a run without the tables', () => {
  const log = (command) => `- \`${command}\`\n`;
  assert.equal(grade(TYPES_IS_RUN, { workflowLog: log(`node scripts/genpage.js types --env ${ENV} --data-sources 'account' --output-file RuntimeTypes.ts`) }).status, 'pass');
  assert.equal(grade(TYPES_IS_RUN, { workflowLog: log(`node scripts/genpage.js --env ${ENV} types --data-sources 'account' --output-file RuntimeTypes.ts`) }).status, 'pass');
  assert.equal(grade(TYPES_IS_RUN, { workflowLog: log(`node scripts/genpage.js --env ${ENV} --data-sources 'account' types --output-file RuntimeTypes.ts`) }).status, 'pass');
  assert.match(grade(TYPES_IS_RUN, { workflowLog: log(`node scripts/genpage.js --env ${ENV} types --data-sources 'contact' --output-file RuntimeTypes.ts`) }).reason, /missing --data-sources account/);
  assert.match(grade(TYPES_IS_RUN, { workflowLog: '- genpage.js types not run\n' }).reason, /was not invoked/);
});

test('verb after flags: a run of the type generator with its flags first counts once, as the same run with its verb first does', () => {
  const ONCE = "Phase 4: genpage.js types is run ONCE with --data-sources 'contact,appointment'; a single RuntimeTypes.ts is generated";
  const types = (id, command) => ({ id, command, result: { ok: true } });
  const flags = "--data-sources 'contact,appointment' --output-file RuntimeTypes.ts";
  const verbThenFlags = `node scripts/genpage.js types --env ${ENV} ${flags}`;
  const flagsThenVerb = `node scripts/genpage.js --env ${ENV} types ${flags}`;
  const fixture = (...commands) => ({ workflowLog: '', events: commands.map((command, at) => types(`t${at}`, command)) });
  assert.equal(grade(ONCE, fixture(flagsThenVerb)).status, 'pass');
  assert.equal(generateTypesCalls(fixture(flagsThenVerb)).length, 1);
  assert.equal(grade(ONCE, fixture(verbThenFlags)).status, 'pass');
  assert.match(grade(ONCE, fixture(verbThenFlags, flagsThenVerb)).reason, /ran 2 time\(s\), expected once/);
  assert.match(grade(ONCE, fixture(flagsThenVerb, flagsThenVerb)).reason, /ran 2 time\(s\), expected once/);
  assert.match(grade(ONCE, fixture()).reason, /ran 0 time\(s\), expected once/);
});

// A committed fixture with every verb of `apps.js` and `genpage.js` that its commands put right after the script moved behind the `--env` that follows it. The commands are the same runs.
const VERBED = /(\b(?:apps|genpage)\.js'?) (list|create|types|download)( --env '[^']*')/g;
const verbBehindEnv = (text) => String(text).replace(VERBED, '$1$3 $2');
function withVerbsBehindEnv(fixture) {
  return {
    ...fixture,
    workflowLog: verbBehindEnv(fixture.workflowLog),
    ...(Array.isArray(fixture.events) ? { events: fixture.events.map((event) => ({ ...event, command: verbBehindEnv(event.command) })) } : {}),
  };
}
const statuses = (fixture) => gradeFixture(fixture, evalById.get(fixture.id), evalsData).map(({ text, result }) => [text, result.status]);

test('verb after flags: every committed fixture earns the verdicts it earned once its apps.js and genpage.js verbs follow their flags', () => {
  const rewritten = FIXTURES.filter((fixture) => withVerbsBehindEnv(fixture).workflowLog !== fixture.workflowLog
    || (fixture.events || []).some((event) => verbBehindEnv(event.command) !== event.command));
  assert.ok(rewritten.length >= 6, `fixtures that run the scripts: ${rewritten.map((fixture) => fixture.dirName).join(', ')}`);
  const verbs = new Set();
  for (const fixture of rewritten) {
    for (const event of fixture.events || []) for (const match of String(event.command).matchAll(VERBED)) verbs.add(`${match[1].replace(/'$/, '')} ${match[2]}`);
    assert.deepEqual(statuses(withVerbsBehindEnv(fixture)), statuses(fixture), `${fixture.dirName}: the verdicts changed with the order of flags and verb`);
  }
  // The rewrite reaches the runs the expectations grade: the app listing, the app create, the page listing, the download and the type generator.
  for (const run of ['apps.js list', 'apps.js create', 'genpage.js list', 'genpage.js download', 'genpage.js types']) assert.ok(verbs.has(run), `a committed fixture runs ${run}`);
});

test('verb after flags: the new-app and edit-flow expectations accept an app create, listings, a download and a type run with their flags first', () => {
  const committed = (name) => FIXTURES.find((fixture) => fixture.dirName === name);
  const apps = 'Edit Phase 1a: Apps are presented to the user via AskUserQuestion using the actual app name and app-id GUID from the apps.js list output';
  const pages = 'Edit Phase 1b: Pages are presented to the user via AskUserQuestion using the actual page names and page-id GUIDs from genpage.js list output';
  const created = "Phase 6 (new app): apps.js create --name 'Account Metrics' --solution '<Solution from plan>' --page-id <first page> --publish is run after the first page's upload; --solution is ALWAYS passed (apps.js create refuses a call without it)";
  const typesRun = "Edit Phase 3: config.json is read; since dataSources contains 'contact', RuntimeTypes.ts is generated";
  const edit = withVerbsBehindEnv(committed('3-contacts-edit-search-sort'));
  const newApp = withVerbsBehindEnv(committed('8-account-metrics-new-app'));
  for (const text of [apps, pages, typesRun]) assert.equal(grade(text, edit).status, 'pass', text);
  assert.equal(grade(created, newApp).status, 'pass', created);
  assert.equal(grade('Edit Phase 2: genpage.js download produces <working-dir>/<page-id>/ with page.tsx, config.json, prompt.txt', edit).status, 'pass');
});

// --- solution-settings.js import --------------------------------------------------------------------------------------------------------------------------------

const IMPORT = `node scripts/solution-settings.js import --env ${ENV} --package app.zip --settings settings.json`;
const TEMPLATE = `node scripts/solution-settings.js template --env ${ENV} --solution Sales --out settings.json`;

test('solution import: solution-settings.js import is a mutation; template, which only prints a settings file, is not', () => {
  assert.ok(isMutation(IMPORT));
  assert.ok(isMutation(`node 'D:/repo/plugins/model-apps/scripts/solution-settings.js' import --env '${ENV}' --package 'app.zip' --settings 'settings.json'`));
  assert.ok(isMutation(`${TEMPLATE}; ${IMPORT}`));
  assert.ok(isMutation(`${IMPORT}; ${TEMPLATE}`));
  assert.equal(isMutation(TEMPLATE), false);
  assert.equal(isMutation(`node scripts/solution-settings.js template --package app.zip --out settings.json`), false);
  assert.equal(isMutation(`${TEMPLATE} --force`), false);
  // The script reads its verb first, so `--env` there is a usage error, not an import.
  assert.equal(isMutation(`node scripts/solution-settings.js --env ${ENV} import --package app.zip --settings settings.json`), false);
  // Neither a quoted mention nor a file that only has the name is a run.
  assert.equal(isMutation(`cat scripts/solution-settings.js`), false);
  assert.equal(isMutation(`node scripts/apps.js list --env ${ENV} --search "solution-settings.js import"`), false);
});

test('solution import: pac solution import, which the script falls back to, is a mutation as well; the pac solution commands that only read are not', () => {
  assert.ok(isMutation('pac solution import --path Solution.zip'));
  assert.ok(isMutation('pac.exe solution import --path Solution.zip --settings-file settings.json'));
  assert.ok(isMutation(`${READS['apps.js list']}; pac solution import --path Solution.zip`));
  for (const command of ['pac solution list', 'pac solution export --path out.zip --name Sales', 'pac solution create-settings --solution-zip Solution.zip --settings-file s.json', 'pac auth list']) {
    assert.equal(isMutation(command), false, command);
  }
});

test('solution import: an import needs the latest successful auth gate, is matched to its event, and breaks a refusal', () => {
  const gate = (ok) => `- \`node check-auth.js --require-pac\` → returned \`{ ok: ${ok}, ... }\`\n`;
  for (const command of [IMPORT, `${TEMPLATE}; ${IMPORT}`, 'pac solution import --path Solution.zip']) {
    const line = `- \`${command}\`\n`;
    assert.deepEqual(authGateProblems({ workflowLog: gate(true) + line }), [], command);
    assert.match(authGateProblems({ workflowLog: gate(false) + line }).join('\n'), /mutation attempted without the latest successful auth gate/, command);
    const fixture = (events) => ({ contractVersion: 2, workflowLog: line, events });
    assert.deepEqual(unassociatedCallProblems(fixture([{ command, result: { ok: true } }])), [], command);
    assert.equal(unassociatedCallProblems(fixture([])).length, 1, command);
    const refused = { manifest: { expectedOutcome: 'refused', refusal: { stage: 'auth' } }, files: [], workflowLog: gate(false) + line };
    assert.ok(refusalProblems(refused).includes('refused workflow generated a page or attempted a mutation'), command);
  }
  // The template is offline: no gate is asked of it.
  const line = `- \`${TEMPLATE}\`\n`;
  assert.deepEqual(authGateProblems({ workflowLog: gate(false) + line }), []);
  assert.deepEqual(unassociatedCallProblems({ contractVersion: 2, workflowLog: line, events: [] }), []);
  // A logged line carries prose after the command, an event the bare command: the same operation either way.
  const prose = `- \`pac solution import --path Solution.zip\` → imported, 12 components\n`;
  assert.deepEqual(unassociatedCallProblems({ contractVersion: 2, workflowLog: prose, events: [{ command: 'pac solution import --path Solution.zip', result: { ok: true } }] }), []);
});

// --- a listing captured as text ------------------------------------------------------------------------------------------------------------------------------------

const appListing = {
  ok: true, count: 2,
  apps: [
    { id: APP, name: 'Sales', uniqueName: 'sales', description: null, published: true, unpublishedChanges: false },
    { id: APP_B, name: 'Service', uniqueName: 'service', description: null, published: true, unpublishedChanges: false },
  ],
};
const pageListing = {
  ok: true, scope: 'app', appId: APP, layer: 'published', count: 2,
  pages: [{ pageId: PAGE, name: 'Overview', title: 'Overview (nav)' }, { pageId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', name: 'Detail', title: 'Detail' }],
};
const appRows = [{ id: APP, name: 'Sales' }, { id: APP_B, name: 'Service' }];
const pageRows = [{ id: PAGE, name: 'Overview' }, { id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', name: 'Detail' }];
const LIST_COMMAND = `node scripts/apps.js list --env ${ENV}`;
const PAGES_COMMAND = `node scripts/genpage.js list --env ${ENV} --app-id ${APP}`;

test('listing as text: a listing is read as data, as the object it is or as the JSON text a capture keeps of it', () => {
  for (const [command, listing, rows] of [[LIST_COMMAND, appListing, appRows], [PAGES_COMMAND, pageListing, pageRows]]) {
    assert.deepEqual(listingRows({ command, result: listing }), rows, 'a parsed result');
    assert.deepEqual(listingRows({ command, result: JSON.stringify(listing) }), rows, 'the one line the script prints');
    assert.deepEqual(listingRows({ command, result: `${JSON.stringify(listing)}\n` }), rows, 'with its newline');
    assert.deepEqual(listingRows({ command, result: `  ${JSON.stringify(listing, null, 2)}  ` }), rows, 'pretty-printed');
    assert.deepEqual(listingRows({ command, result: `⚠ a warning the script wrote to stderr\n${JSON.stringify(listing)}\n` }), rows, 'beside what it wrote to stderr');
  }
  assert.deepEqual(listingRows({ command: LIST_COMMAND, result: JSON.stringify({ ok: true, count: 0, apps: [] }) }), []);
  assert.deepEqual(listingRows({ command: LIST_COMMAND, result: JSON.stringify({ ok: false, code: 'CONNECTION_ERROR', error: 'the read failed' }) }), []);
  // The ids an older capture's structured result names are read too.
  assert.deepEqual(listingRows({ command: 'pac model list', result: JSON.stringify({ apps: [{ appId: APP, displayName: 'Sales' }] }) }), [{ id: APP, name: 'Sales' }]);
});

test("listing as text: a log's Result: line, or the result after an arrow, is read as data too", () => {
  for (const [command, listing, rows] of [[LIST_COMMAND, appListing, appRows], [PAGES_COMMAND, pageListing, pageRows]]) {
    const json = JSON.stringify(listing);
    for (const log of [
      `- \`${command}\`\nResult: ${json}\n`,
      `- \`${command}\`\n  Result: ${json}\n`,
      `- \`${command}\` → ${json}\n`,
      `- \`${command}\` → \`${json}\`\n`,
      `- \`${command}\` → returned ${json}\n`,
      `- \`${command}\` -> ${json}\n`,
    ]) {
      const [call] = workflowCalls({ workflowLog: log });
      assert.deepEqual(listingRows(call), rows, log);
    }
  }
});

test('listing as text: JSON that does not parse lists nothing, and output that is not JSON still goes to the table reader', () => {
  const broken = `{"ok":true,"count":1,"apps":[{"id":"${APP}","name":"Sales"`;
  assert.deepEqual(listingRows({ command: LIST_COMMAND, result: broken }), []);
  assert.deepEqual(listingRows({ command: LIST_COMMAND, result: `[{"id":"${APP}"` }), []);
  // The PAC table, the bullets of a log and a prose line are not JSON.
  const table = `App ID                                Display Name   Unique Name\n${APP}  Sales Hub      SalesHub\n${APP_B}  Service Hub    ServiceHub`;
  assert.deepEqual(listingRows({ command: 'pac model list', result: table }), [{ id: APP, name: 'Sales Hub' }, { id: APP_B, name: 'Service Hub' }]);
  assert.deepEqual(listingRows({ command: LIST_COMMAND, result: `- Sales Hub — ${APP} (SalesHub)\n- Service Hub — ${APP_B} (ServiceHub)` }), [{ id: APP, name: 'Sales Hub' }, { id: APP_B, name: 'Service Hub' }]);
  const [logged] = workflowCalls({ workflowLog: `- \`pac model list\` → 2 apps\n${table}\n` });
  assert.deepEqual(listingRows(logged), [{ id: APP, name: 'Sales Hub' }, { id: APP_B, name: 'Service Hub' }]);
  // A summary a log decodes (`ok=true`, `{ ok: true, ... }`) holds no list: the lines under the command are the listing.
  const [summarised] = workflowCalls({ workflowLog: `- \`pac model list\` → { ok: true, ... }\n${table}\n` });
  assert.deepEqual(listingRows(summarised), [{ id: APP, name: 'Sales Hub' }, { id: APP_B, name: 'Service Hub' }]);
});

test('listing as text: the presentation expectations pass for a listing recorded as the text the script printed', () => {
  const apps = 'Edit Phase 1a: Apps are presented to the user via AskUserQuestion using the actual app name and app-id GUID from the apps.js list output';
  const pages = 'Edit Phase 1b: Pages are presented to the user via AskUserQuestion using the actual page names and page-id GUIDs from genpage.js list output';
  const fixture = (command, result, options) => ({
    contractVersion: 2,
    events: [
      { id: 'list', command, result },
      { id: 'ask', command: 'AskUserQuestion', result: { options, answer: options[0] } },
      { id: 'download', command: `node scripts/genpage.js download --env ${ENV} --app-id ${APP} --page-id ${PAGE} --output-directory out`, result: { ok: true } },
    ],
  });
  const appOptions = appListing.apps.map(({ name, id }) => `${name} (${id})`);
  const pageOptions = pageListing.pages.map(({ name, pageId }) => `${name} (${pageId})`);
  for (const result of [appListing, JSON.stringify(appListing), `${JSON.stringify(appListing)}\n`]) {
    assert.equal(grade(apps, fixture(LIST_COMMAND, result, appOptions)).status, 'pass', typeof result);
  }
  for (const result of [pageListing, JSON.stringify(pageListing)]) {
    assert.equal(grade(pages, fixture(PAGES_COMMAND, result, pageOptions)).status, 'pass', typeof result);
  }
  // The check still fails for a question that names an app the listing does not hold, or the wrong name.
  assert.match(grade(apps, fixture(LIST_COMMAND, JSON.stringify(appListing), [`Sales (${APP})`, 'Ghost (00000000-0000-4000-8000-000000000000)'])).reason, /which the listing does not contain/);
  assert.match(grade(apps, fixture(LIST_COMMAND, JSON.stringify(appListing), [`Revenue Desk (${APP})`])).reason, /without its listed name "Sales"/);
  assert.match(grade(apps, fixture(LIST_COMMAND, '{"ok":true,"apps":[', appOptions)).reason, /recorded no apps to present/);
});

test('listing as text: every committed fixture earns the verdicts it earned with its listings recorded as text', () => {
  const asText = (fixture) => ({
    ...fixture,
    events: (fixture.events || []).map((event) => (event.result && typeof event.result === 'object' && /\b(?:apps|genpage)\.js'?\s+list\b/.test(event.command)
      ? { ...event, result: JSON.stringify(event.result) } : event)),
  });
  const textual = FIXTURES.filter((fixture) => asText(fixture).events.some((event, at) => event.result !== fixture.events[at].result));
  assert.ok(textual.length >= 3, `fixtures with a listing event: ${textual.map((fixture) => fixture.dirName).join(', ')}`);
  for (const fixture of textual) assert.deepEqual(statuses(asText(fixture)), statuses(fixture), `${fixture.dirName}: the verdicts changed with the listing recorded as text`);
});

// --- What the graders do not read ----------------------------------------------------------------------------------------------------------------------------------------
//
// The graders read recorded text; they are not a shell (lib/evidence-utils.js, "How the graders read a recorded command", which lists these limits). They are pinned here as the answers the
// graders give today — limits, not goals — so that a change to the reading model has to change that comment, the guides and these tests together.

test('limits: a command line handed to a wrapper as one string is one quoted word, so a script verb inside it is not read; the names that only write still are', () => {
  assert.equal(isMutation(`bash -c '${WRITES['apps.js create']}'`), false);
  assert.equal(isMutation(`cmd /c "${WRITES['genpage.js delete']}"`), false);
  assert.equal(isMutation(`pwsh -NoProfile -Command '${IMPORT}'`), false);
  assert.ok(isMutation(`bash -c 'node scripts/provision-entities.js --env ${ENV} --input @spec.json --apply'`));
  assert.ok(isMutation("bash -c 'pac solution import --path Solution.zip'"));
  // The verb-first phase patterns have always read the raw text, so a wrapped run in the form the skills give counts; one with its flags first does not.
  assert.ok(LIST_APPS.test(`bash -c 'node scripts/apps.js list --env ${ENV}'`));
  assert.ok(!LIST_APPS.test(`bash -c 'node scripts/apps.js --env ${ENV} list'`));
});

test('limits: prose is not told from a command — a write named after a read, in a sentence or a here-document, is graded as the write', () => {
  assert.ok(isMutation(`${READS['apps.js list']}; then apps.js create needs the first page`));
  assert.ok(isMutation(`cat > note.md <<'EOF'\napps.js create is the next step\nEOF\n${READS['apps.js list']}`));
  assert.ok(isMutation(`- \`${READS['apps.js list']}\` — afterwards apps.js create ${CREATE_FLAGS}`));
});

test('limits: a quote with no partner on its line is dropped, and a stray one in prose hides the words up to its partner', () => {
  const write = `node scripts/apps.js create --name Metrics --solution Default --page-id ${PAGE}`;
  assert.ok(isMutation(`echo it's; ${write}`), 'no partner on the line: the apostrophe is dropped');
  assert.ok(isMutation(`echo it's\n${write.replace('Metrics', "'Metrics'")}`), 'the line is the unit: a quote left open does not reach into the next');
  assert.equal(isMutation(`echo it's; ${write.replace('Metrics', "'Metrics'")}`), false, "`'s; node scripts/apps.js create --name '` is one quoted word");
});

test('limits: the environment a write is compared with its auth gate by is the last --env of its call, and a write in the call of its gate is not judged against it', () => {
  const OTHER = 'https://fabrikam.crm.dynamics.com';
  const gate = { id: 'gate', command: 'node scripts/check-auth.js --require-pac', result: { ok: true, blocker: null, message: 'Ready.', warnings: [], envUrl: ENV, identitiesMatch: true, whoAmI: { ok: true } } };
  const strict = (command) => authGateProblems({ contractVersion: 2, manifest: { contractVersion: 2 }, workflowLog: '', events: [gate, { id: 'write', command, result: { ok: true } }] });
  const create = (env) => `node scripts/apps.js create --env ${env} --name Metrics --solution Default --page-id ${PAGE}`;
  const differs = 'mutation environment differs from the latest successful auth gate';
  assert.ok(strict(create(OTHER)).includes(differs), 'alone, a write to another environment is caught');
  assert.ok(!strict(create(ENV)).includes(differs));
  assert.ok(strict(`${READS['apps.js list']}; ${create(OTHER)}`).includes(differs), 'the last --env of the call is the write\'s');
  assert.ok(!strict(`${create(OTHER)}; ${READS['apps.js list']}`).includes(differs), 'the last --env of the call is the read\'s, so the write to the other environment is not compared');
  assert.ok(!authGateProblems({ workflowLog: `- \`node check-auth.js --require-pac; ${WRITES['apps.js create']}\` → returned \`{ ok: false, ... }\`\n` }).some((problem) => /without the latest successful auth gate/.test(problem)),
    'a write in the call of its gate is not judged against that gate');
});

test('limits: a variable, a command substitution and a line continuation are not expanded or followed', () => {
  assert.equal(isMutation('$cmd'), false);
  assert.equal(isMutation(`eval "$cmd"`), false);
  assert.equal(isMutation(`node scripts/apps.js $(echo create) ${CREATE_FLAGS.replace('--name Metrics ', '')}`), false);
  assert.equal(isMutation(`node scripts/apps.js $VERB ${CREATE_FLAGS}`), false);
  // A command that goes on in the next line is two lines to the reader: the verb on the second has no script before it.
  assert.equal(isMutation(`node scripts/apps.js \\\ncreate ${CREATE_FLAGS}`), false);
  assert.equal(isMutation(`node scripts/apps.js \`\ncreate ${CREATE_FLAGS}`), false);
});

test('limits: the phase expectations count a call once and read its text; the mutation check also reads an event\'s argv', () => {
  const twice = `node scripts/genpage.js types --env ${ENV} ${TYPES_FLAGS}; node scripts/genpage.js --env ${ENV} types ${TYPES_FLAGS}`;
  assert.equal(generateTypesCalls({ events: [{ command: twice, result: { ok: true } }] }).length, 1);
  const argv = { command: 'node scripts/genpage.js', argv: ['types', '--env', ENV, ...TYPES_FLAGS.split(' ')], result: { ok: true } };
  assert.equal(generateTypesCalls({ events: [argv] }).length, 0);
  assert.ok(!GENERATE_TYPES.test(argv.command));
  assert.ok(isMutation({ command: 'node scripts/apps.js', argv: ['create', '--env', ENV, '--name', 'Metrics', '--solution', 'Default', '--page-id', PAGE] }));
});

test('script names are matched in any letter case, as the file systems the scripts run on match them', () => {
  assert.ok(isMutation(`node scripts/Apps.js create ${CREATE_FLAGS}`));
  assert.ok(isMutation(`node .\\Scripts\\GENPAGE.JS delete --env ${ENV} --page-id ${PAGE} --allow-destructive`));
  assert.deepEqual(verbsOf('node scripts/APPS.JS list', 'apps.js'), ['list']);
  assert.equal(isMutation('node scripts/Apps.js list --env https://contoso.crm.dynamics.com'), false);
});
