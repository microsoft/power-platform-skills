'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { readScreenDataAudit } = require('../read-screen-data-audit');

const SCRIPT = path.resolve(__dirname, '../read-screen-data-audit.js');
const INTRO = '# App plan\n\n## Screens\n\n### Per-Screen Specs\n\n';
const STAGED = '.tmp/edit-native-app-plan.md';

function spec(id, body = '- **Data** — All visible fields and actions.\n', heading = id) {
  return `#### ${heading}\n\n- **Screen ID:** \`${id}\`\n${body}\n`;
}

function fixture(t) {
  // Keep fixtures within the checkout, not in an OS-wide temporary directory.
  const container = path.join(__dirname, `read-screen-data-audit-fixture-${crypto.randomUUID()}`);
  const projectRoot = path.join(container, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const write = (file, content) => {
    const absolute = path.resolve(projectRoot, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return absolute;
  };
  const read = (planPath = 'native-app-plan.md', screenIds = []) => readScreenDataAudit({ projectRoot, planPath, screenIds });
  return { container, projectRoot, write, read };
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '../..'),
  });
}

function symlink(t, target, link, type = 'file') {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This Windows account cannot create symlinks');
      return false;
    }
    throw error;
  }
}

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      entries.push([path.relative(root, file), stat.mtimeMs, entry.isDirectory() ? null : fs.readFileSync(file)]);
      if (entry.isDirectory()) visit(file);
    }
  }
  visit(root);
  return entries;
}

test('explicit staged plan wins over divergent root and graph scratch without dropping any spec text', t => {
  const { write, read } = fixture(t);
  const work = spec('work-list', [
    '- **Data** — title, owner, status, due date; generated WorkService.getAll.',
    '- **UX** — distinguish no records, filter-empty, permission denial and failed load.',
    '- **Actions** — open the selected record; retry only the failed read.',
    '- **Filters** — retain selected status and owner on Back.',
    '- **Metrics** — show the count within the current scope.',
    '- **Media** — show the item image with an accessible fallback.',
    '- **related_entity_fields** — owner.displayName, category.label.',
    '##### Interaction details',
    'Recover the selected row and scroll position after returning.',
    '| Information | Interaction |',
    '| --- | --- |',
    '| Owner label | Open owner context |',
    '',
  ].join('\n'), 'Work list');
  const settings = spec('preferences', '- **UX** — Local display settings; no related entity annotation.\n', 'Preferences');
  const staged = INTRO + work + settings + '### Shared Conventions\nNot a per-screen spec.\n';
  write(STAGED, staged);
  write('native-app-plan.md', INTRO + spec('work-list', 'Old approved root spec.\n'));
  write('_screens_section.md', INTRO + spec('work-list', 'Graph scratch is not the detailed staged plan.\n'));

  const result = read(STAGED);
  assert.deepEqual(result, {
    planPath: STAGED,
    planSha256: crypto.createHash('sha256').update(staged).digest('hex'),
    screens: [
      { screenId: 'work-list', heading: 'Work list', spec: work },
      { screenId: 'preferences', heading: 'Preferences', spec: settings },
    ],
  });
  assert.deepEqual(Object.keys(result), ['planPath', 'planSha256', 'screens']);
});

test('all specs are retained when none has related_entity_fields', t => {
  const { write, read } = fixture(t);
  const blocks = [spec('overview', 'Overview metrics and scope.\n'), spec('details', 'Detail data and actions.\n')];
  write('native-app-plan.md', INTRO + blocks.join(''));
  assert.deepEqual(read().screens.map(screen => screen.spec), blocks);
});

test('graph-only, empty and misplaced detailed sections are rejected, never replaced by siblings', t => {
  const { write, read } = fixture(t);
  write('native-app-plan.md', INTRO + spec('valid-root'));
  write('_screens_section.md', INTRO + spec('valid-scratch'));
  for (const invalid of [
    '# Plan\n## Screens\n### Screen Map\n| Screen | ID |\n| Home | home |\n',
    INTRO,
    '### Per-Screen Specs\n' + spec('outside-screens'),
    '## Other\n### Per-Screen Specs\n' + spec('wrong-parent'),
    '## Screens\n### Screen Map\n' + spec('not-detailed'),
    '## Screens\n### Per-Screen Specs\n## Other\n' + spec('outside-section'),
    '```markdown\n' + INTRO + spec('example-only') + '```\n',
  ]) {
    write(STAGED, invalid);
    assert.throws(() => read(STAGED), /No detailed per-screen specs/);
  }
});

test('a missing explicit staged plan fails through both API and CLI without fallback', t => {
  const { projectRoot, write, read } = fixture(t);
  write('native-app-plan.md', INTRO + spec('root'));
  write('_screens_section.md', INTRO + spec('scratch'));
  assert.throws(() => read(STAGED), /Plan path does not exist/);
  const result = runCli(['--project-root', projectRoot, '--plan', STAGED]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Plan path does not exist/);
});

test('section headings are case-insensitive and common Screen ID bullet spellings work', t => {
  const { write, read } = fixture(t);
  const fields = [
    '- **Screen ID:** `one`',
    '- **Screen ID**: `two`',
    '- **Screen ID** — `three`',
    '- **Screen ID:** four',
    '- **Screen ID**: five',
    '+ **screen id** — six',
    '* **Screen ID** — `seven`',
    '**Screen ID**: eight',
  ];
  const blocks = fields.map((field, index) => `#### Screen ${index} ####\n${field}\nData and interactions.\n\n`);
  write('PLAN.MD', '  ## sCrEeNs ##\n\n ### pEr-ScReEn SpEcS ###\n' + blocks.join(''));
  assert.deepEqual(read('PLAN.MD').screens.map(screen => screen.screenId),
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  assert.deepEqual(read('PLAN.MD').screens.map(screen => screen.spec), blocks);
  assert.equal(read('PLAN.MD').screens[0].heading, 'Screen 0');
});

test('fenced headings and Screen IDs neither split specs nor create duplicate sections or IDs', t => {
  const { write, read } = fixture(t);
  const fenced = [
    '````markdown',
    '## Screens',
    '### Per-Screen Specs',
    '#### Fake screen',
    '- **Screen ID:** `fake`',
    '```',
    '#### Still inside the longer fence',
    '~~~~',
    '- **Screen ID:** `also-fake`',
    '`````',
    '  ~~~ markdown',
    '## Not a real section boundary',
    '#### Still an example',
    '- **Screen ID:** `first`',
    '  ~~~~',
    '- **Data example**',
    '    ```markdown',
    '    #### Example nested inside a list item',
    '    - **Screen ID:** `nested-fake`',
    '    ```',
    '##### Actual nested interaction notes',
    'Keep all examples and notes verbatim.',
    '',
  ].join('\n');
  const first = spec('first', fenced);
  const last = spec('last');
  write('native-app-plan.md', '~~~\n' + INTRO + spec('fake-preamble') + '~~~\n' + INTRO + first + last);
  assert.deepEqual(read().screens.map(screen => screen.spec), [first, last]);
});

test('an unterminated fence fails rather than silently hiding following specs', t => {
  const { write, read } = fixture(t);
  write('native-app-plan.md', INTRO + spec('first', '```markdown\n') + spec('hidden'));
  assert.throws(() => read(), /Unterminated fenced code block/);
});

test('missing, duplicate and invalid Screen IDs fail, including in unselected specs', t => {
  const { write, read } = fixture(t);
  for (const [body, error] of [
    ['#### No ID\n- **Data** — Still detailed.\n', /Missing Screen ID/],
    ['#### Example ID only\n```\n- **Screen ID:** `fake`\n```\n', /Missing Screen ID/],
    [spec('repeated') + spec('repeated'), /Duplicate Screen ID: repeated/],
    [spec('same', '- **Screen ID**: same\n'), /Duplicate Screen ID field/],
    [spec('first', '- **Screen ID** — second\n'), /Duplicate Screen ID field/],
    ['#### No separator\n- **Screen ID** `id`\n', /Invalid Screen ID field/],
  ]) {
    write('native-app-plan.md', INTRO + spec('selected') + body);
    assert.throws(() => read('native-app-plan.md', ['selected']), error);
  }
  for (const value of ['', '`bad id`', 'Bad', 'snake_case', '../id', '123', 'two--parts', 'trailing-', '`unclosed', '`id` extra']) {
    write('native-app-plan.md', INTRO + `#### Invalid\n- **Screen ID:** ${value}\n`);
    assert.throws(() => read(), /Invalid Screen ID/);
  }
});

test('duplicate authoritative section headings are explicit errors rather than partial extraction', t => {
  const { write, read } = fixture(t);
  for (const suffix of ['## Screens\n', '### Per-Screen Specs\n']) {
    write('native-app-plan.md', INTRO + spec('first') + suffix + spec('second'));
    assert.throws(() => read(), /Duplicate .* section/);
  }
});

test('subsets retain plan order, deduplicate selection and reject unknown or invalid requested IDs', t => {
  const { projectRoot, write, read } = fixture(t);
  write('native-app-plan.md', INTRO + spec('first') + spec('middle') + spec('last'));
  assert.deepEqual(read('native-app-plan.md', ['last', 'first', 'last']).screens.map(screen => screen.screenId), ['first', 'last']);
  assert.throws(() => read('native-app-plan.md', ['missing']), /Unknown requested screen ID: missing/);
  for (const screenIds of [null, 'first', {}, [null], [''], ['Bad ID'], [42]]) {
    assert.throws(() => readScreenDataAudit({ projectRoot, planPath: 'native-app-plan.md', screenIds }), /screenIds|Invalid requested screen ID/);
  }
});

test('plan and root paths must be explicit, existing, contained and of the correct file type', t => {
  const { projectRoot, write, read } = fixture(t);
  const valid = write('native-app-plan.md', INTRO + spec('valid'));
  write('not-markdown.txt', INTRO + spec('wrong-type'));
  write('../project-other/outside.md', INTRO + spec('outside'));
  fs.mkdirSync(path.join(projectRoot, 'directory.md'));
  for (const planPath of ['', ' ', null, 42, 'bad\0.md']) {
    assert.throws(() => read(planPath), /Plan path .*explicit non-empty/);
  }
  for (const planPath of ['.', projectRoot, '../project-other/outside.md', path.resolve(projectRoot, '../project-other/outside.md')]) {
    assert.throws(() => read(planPath), /inside the project root/);
  }
  for (const planPath of ['not-markdown.txt', 'directory.md']) {
    assert.throws(() => read(planPath), /regular Markdown file/);
  }
  for (const root of ['', null, 42, 'bad\0']) {
    assert.throws(() => readScreenDataAudit({ projectRoot: root, planPath: valid }), /Project root .*explicit non-empty/);
  }
  assert.throws(() => readScreenDataAudit({ projectRoot: valid, planPath: valid }), /Project root must be a directory/);
  assert.throws(() => readScreenDataAudit({ projectRoot: path.join(projectRoot, 'missing'), planPath: valid }), /Project root does not exist/);
  assert.throws(() => readScreenDataAudit({ projectRoot }), /Plan path .*explicit non-empty/);
  assert.throws(() => readScreenDataAudit(), /Project root .*explicit non-empty/);
  assert.equal(read(valid).planPath, 'native-app-plan.md');
  assert.equal(read('./native-app-plan.md').planPath, 'native-app-plan.md');
  write('plan.markdown', INTRO + spec('alternate'));
  assert.equal(read('plan.markdown').screens[0].screenId, 'alternate');
});

test('file symlinks cannot escape the real root or disguise non-Markdown files', t => {
  const { projectRoot, write, read } = fixture(t);
  const outside = write('../project-other/outside.md', INTRO + spec('outside'));
  if (!symlink(t, outside, path.join(projectRoot, 'escape.md'))) return;
  assert.throws(() => read('escape.md'), /inside the project root/);
  const text = write('data.txt', INTRO + spec('not-markdown'));
  if (!symlink(t, text, path.join(projectRoot, 'disguised.md'))) return;
  assert.throws(() => read('disguised.md'), /regular Markdown file/);
});

test('ancestor directory symlinks cannot escape the real root', t => {
  const { projectRoot, write, read } = fixture(t);
  const outside = write('../project-other/outside.md', INTRO + spec('outside'));
  if (!symlink(t, path.dirname(outside), path.join(projectRoot, 'linked'), 'dir')) return;
  assert.throws(() => read('linked/outside.md'), /inside the project root/);
});

test('internal and root aliases resolve to real project-relative plans, but root self-links do not', t => {
  const { container, projectRoot, write, read } = fixture(t);
  const plan = write(STAGED, INTRO + spec('inside'));
  if (!symlink(t, plan, path.join(projectRoot, 'alias.md'))) return;
  assert.deepEqual(read('alias.md'), read(STAGED));
  const rootAlias = path.join(container, 'root-alias');
  if (!symlink(t, projectRoot, rootAlias, 'dir')) return;
  assert.deepEqual(readScreenDataAudit({ projectRoot: rootAlias, planPath: STAGED }), read(STAGED));
  assert.deepEqual(readScreenDataAudit({ projectRoot: rootAlias, planPath: path.join(rootAlias, STAGED) }), read(STAGED));
  if (!symlink(t, projectRoot, path.join(projectRoot, 'self.md'), 'dir')) return;
  assert.throws(() => read('self.md'), /inside the project root/);
});

test('dangling and looping symlinks fail without trying root or scratch alternatives', t => {
  const { projectRoot, write, read } = fixture(t);
  write('native-app-plan.md', INTRO + spec('root'));
  write('_screens_section.md', INTRO + spec('scratch'));
  if (!symlink(t, path.join(projectRoot, 'missing.md'), path.join(projectRoot, 'dangling.md'))) return;
  assert.throws(() => read('dangling.md'), /Plan path does not exist or cannot be resolved/);
  if (!symlink(t, 'loop.md', path.join(projectRoot, 'loop.md'))) return;
  assert.throws(() => read('loop.md'), /Plan path does not exist or cannot be resolved/);
});

test('CLI emits only the extraction JSON and preserves order for repeated --screen-id arguments', t => {
  const { projectRoot, write, read } = fixture(t);
  write(STAGED, INTRO + spec('first') + spec('middle') + spec('last'));
  const result = runCli(['--project-root', projectRoot, '--plan', STAGED, '--screen-id', 'last', '--screen-id', 'first']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), read(STAGED, ['first', 'last']));
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /not approval or proof of coverage or quality/);
});

test('malformed CLI arguments and invalid inputs exit nonzero without success JSON', t => {
  const { projectRoot, write } = fixture(t);
  write(STAGED, INTRO + spec('valid'));
  write('graph.md', '## Screens\n### Screen Map\nGraph only.\n');
  const valid = ['--project-root', projectRoot, '--plan', STAGED];
  for (const args of [
    [],
    ['--project-root', projectRoot],
    ['--plan', STAGED],
    ['--project-root'],
    ['--project-root', '--plan', STAGED],
    ['--project-root', projectRoot, '--plan'],
    ['--project-root', '', '--plan', STAGED],
    [...valid, '--screen-id'],
    [...valid, '--screen-id', ''],
    [...valid, '--screen-id', 'unknown'],
    [...valid, '--screen-id', 'Bad ID'],
    [...valid, '--unknown'],
    [...valid, 'unexpected.md'],
    [...valid, '--plan', 'native-app-plan.md'],
    [...valid, '--project-root', projectRoot],
    ['--project-root', projectRoot, '--plan', '.'],
    ['--project-root', projectRoot, '--plan', 'graph.md'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert.match(result.stderr, /required|Missing|Unknown|Duplicate|explicit|Invalid|inside|No detailed/);
  }
});

test('hashes exact plan bytes and leaves all files and directories unchanged on success and failure', t => {
  const { projectRoot, write, read } = fixture(t);
  const block = spec('review', '- **Data** — café, 東京, image 🖼️.\n- **Actions** — preserve all text.  \n').replace(/\n/g, '\r\n');
  const bytes = Buffer.from('\uFEFF' + INTRO.replace(/\n/g, '\r\n') + block);
  write(STAGED, bytes);
  write('native-app-plan.md', INTRO + spec('old'));
  write('_screens_section.md', 'Graph scratch bytes stay untouched.\n');
  write('brand/tokens.ts', 'export const tokens = {};\n');
  const before = snapshot(projectRoot);
  const result = read(STAGED);
  assert.equal(result.planSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.screens[0].spec, block);
  assert.throws(() => read(STAGED, ['unknown']), /Unknown requested screen ID/);
  for (const args of [[], ['--screen-id', 'unknown']]) {
    const cli = runCli(['--project-root', projectRoot, '--plan', STAGED, ...args]);
    assert.equal(cli.status, args.length ? 1 : 0, cli.stderr);
  }
  assert.deepEqual(snapshot(projectRoot), before);
});
