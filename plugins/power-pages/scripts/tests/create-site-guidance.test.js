'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readCreateSiteGuidance, spaStages, nonSpaStages } = require('./helpers/create-site-guidance');

const root = path.resolve(__dirname, '../../skills/create-site');
const plugin = path.resolve(root, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const entry = read('SKILL.md');
const references = fs.readdirSync(path.join(root, 'references')).map((file) => `references/${file}`);
const instructions = ['SKILL.md', 'workflows/non-spa-site.md', ...references];
const links = [...entry.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);

test('create-site retains its original argument hint and bounded activation context', () => {
  const [, metadata, ...rest] = entry.split(/^---\r?$/m);
  assert.deepEqual([...metadata.matchAll(/^([a-z-]+):/gm)].map((match) => match[1]), ['name', 'description', 'argument-hint']);
  assert.match(metadata, /^name: create-site$/m);
  assert.match(metadata, /^argument-hint: Optional site description\r?$/m);
  const description = metadata.split('description: >-')[1].split(/^argument-hint:/m)[0].trim().replace(/\s+/g, ' ');
  assert.ok(description.length <= 400);
  assert.ok(entry.trimEnd().split(/\r?\n/).length < 500);
  // The estimate is a reproducible character budget, not measured tokenizer usage.
  assert.ok([...rest.join('---')].length / 4 < 5000);
});

test('all instruction resources and template inputs are directly reachable inside the installed plugin', () => {
  for (const link of links) {
    const target = path.resolve(root, link);
    assert.ok(target.startsWith(plugin + path.sep), `link escapes the plugin: ${link}`);
    assert.ok(fs.existsSync(target), `missing installed resource: ${link}`);
  }
  for (const file of [...references, 'workflows/non-spa-site.md', 'assets/plan-labels.example.json']) {
    assert.ok(links.includes(file), `resource requires a chained lookup: ${file}`);
  }
  for (const directory of ['react', 'vue', 'angular', 'astro', 'shared']) {
    assert.ok(links.includes(`assets/${directory}/`), directory);
  }
});

test('every instruction resource stays focused, host-neutral and syntactically complete', () => {
  for (const file of instructions) {
    const text = read(file);
    assert.ok(text.trimEnd().split(/\r?\n/).length < 300, file);
    assert.doesNotMatch(text, /\b(?:AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TodoWrite|WebFetch|WebSearch|activeForm|run_in_background|replace_all)\b|mcp__|\$ARGUMENTS/, file);
    assert.doesNotMatch(text, /`(?:Read|Write|Edit|Glob|Grep|Bash|Skill|Task)`|\bbrowser_(?:navigate|snapshot|evaluate|take_screenshot)\b/, file);
    assert.equal((text.match(/^\s*```/gm) || []).length % 2, 0, `dangling code fence: ${file}`);
    for (const match of text.matchAll(/\$\{PLUGIN_ROOT\}\/([^"`\s<>|]+\.js)/g)) {
      assert.ok(fs.statSync(path.join(plugin, match[1])).isFile(), `${file}: ${match[1]}`);
    }
  }
});

test('source-contract readers follow the actual entry stage order and keep branches isolated', () => {
  for (const stages of [spaStages, nonSpaStages]) {
    let previous = -1;
    for (const stage of stages) {
      const position = entry.indexOf(`](references/${stage}-workflow.md)`);
      assert.ok(position > previous, `stage out of entry order: ${stage}`);
      previous = position;
    }
  }
  const native = readCreateSiteGuidance('non-spa');
  assert.doesNotMatch(native, /capture-design-review\.js|axe-audit\.js|npm run dev/);
  assert.throws(() => readCreateSiteGuidance('unknown'), /Unknown creation branch/);
  assert.match(entry, /Do not continue into SPA scaffolding/);
});

test('all 21 approval IDs, categories and cancellation outcomes remain unique and unchanged', () => {
  const expected = [
    '1.purpose|plan|nothing',
    '1.5.confirm-environment|consent|template-cache',
    '1.5.unblock-js|consent|attachment-block-modified',
    '1.5.template-import|consent|template-cache',
    '1.5.update-installed|consent|template-cache',
    '1.5.reinstall-unknown|consent|template-cache',
    '1.5.clone-existing|consent|template-cache',
    '1.5.pack-failed|progress|template-cache',
    '1.5.import-failed|progress|partial-unmanaged-template-import',
    '1.5.clone-failed|progress|partial-template-clone',
    '3.requirements|plan|nothing',
    '4.7.plan-approval|plan|nothing',
    '5.7.critique-blocked|progress|nothing',
    '7.review|plan|nothing',
    '8.deploy|plan|nothing',
    'non-spa-1-select-model|plan|nothing',
    'non-spa-1-confirm-environment|consent|nothing',
    'non-spa-1-confirm-capability|progress|nothing',
    'non-spa-2-select-template|plan|nothing',
    'non-spa-4-provision|final|nothing',
    'non-spa-8-customize|plan|non-spa-baseline',
  ];
  const actual = instructions.flatMap((file) => {
    const text = read(file);
    const gates = [...text.matchAll(/<!-- gate: create-site:([^ |]+) \| category=([^ |]+) \| cancel-leaves=([^ |]+) -->/g)];
    if (gates.length) {
      assert.match(text, /^\s*Ask the user:/m, `gate owner lacks a portable prompt: ${file}`);
      assert.ok(file.endsWith('-workflow.md'), `gate is outside the lint-scanned resources: ${file}`);
    }
    return gates.map((match) => match.slice(1).join('|'));
  });
  assert.deepEqual(actual.sort(), expected.sort());
});

test('template mutations preserve consent, result collection, cleanup and join boundaries', () => {
  const preflight = read('references/template-preflight-workflow.md');
  const importing = read('references/template-import-workflow.md');
  const provisioning = read('references/template-provisioning-workflow.md');
  assert.ok(preflight.indexOf('create-site:1.5.confirm-environment') < preflight.indexOf('validate-cli-tenant'));
  assert.match(preflight, /--extensions js/);
  assert.match(preflight, /no option to override missing template language requirements/);
  assert.ok(importing.indexOf('scripts/pack-template-solution.js') < importing.indexOf('scripts/import-template-solution.js'));
  assert.match(importing, /Always run the owned temporary-directory cleanup after the import command returns/);
  assert.match(importing, /must return the wrapper's complete JSON result/);
  assert.match(importing, /do \*\*not\*\* auto-clean up the unmanaged partial import/);
  assert.match(provisioning, /--currencyCode/);
  assert.match(provisioning, /must not clone, build, upload, activate, update the shared status file, ask the user questions, or retry failed writes/);
  assert.match(provisioning, /Wait for both workstreams to finish before showing the inactive-site summary or starting activation/);
  assert.match(entry, /otherwise execute sequentially/);
});

test('non-SPA disclosure, single accepted operation and verified baseline precede completion', () => {
  const workflow = readCreateSiteGuidance('non-spa');
  assert.ok(workflow.indexOf('## Preview disclosure') < workflow.indexOf('## Progress tracking'));
  assert.match(workflow, /Before prerequisite checks, task creation, environment discovery or the first non-SPA question/);
  assert.match(workflow, /Never retry a Create Website POST after `202 Accepted`/);
  assert.match(workflow, /never authorizes a\s+second POST/);
  assert.ok(workflow.indexOf('--eventName non_spa_creation_success') > workflow.indexOf('Run the validator again after Git initialization.'));
  assert.match(workflow, /previewNoticeShown: true/);
  assert.match(workflow, /imageDelivery: "external-url"/);
  assert.match(workflow, /verifiedBootstrapMajor: 5/);
});

test('localized plan example retains the complete renderer label contract', () => {
  const labels = JSON.parse(read('assets/plan-labels.example.json'));
  assert.equal(typeof labels.navigation.overview, 'string');
  assert.ok(JSON.stringify(labels).includes('{siteName}'));
  assert.ok(JSON.stringify(labels).includes('{count}'));
  assert.match(read('references/plan-approval-workflow.md'), /Translate every value into `SITE_LOCALE`/);
  assert.match(read('references/plan-approval-workflow.md'), /--data - <<'PLAN'/);
  for (const section of ['navigation', 'overview', 'design', 'pages', 'bidirectional', 'deployment']) {
    assert.equal(typeof labels[section], 'object', section);
  }
});

test('completion remains explicit without depending on host lifecycle hooks', () => {
  assert.match(entry, /validate-site\.js" \\\n\s+--expectedLocale "<SITE_LOCALE>" --expectedDirection "<SITE_DIRECTION>"/);
  assert.match(read('references/review-workflow.md'), /validate-site-integrity\.js/);
  assert.match(read('references/verification-workflow.md'), /Chosen Google Fonts verified loaded by the font check/);
  assert.match(read('references/localization-workflow.md'), /\[FROM_CREATE_SITE\]/);
  assert.match(read('references/deployment-workflow.md'), /SAMPLE CONTENT/);
});
