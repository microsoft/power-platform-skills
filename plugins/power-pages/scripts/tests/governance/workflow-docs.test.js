const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skillRoot = path.join(__dirname, '../../../skills/manage-governance');
const entry = 'SKILL.disabled.md';
const read = (file) => fs.readFileSync(path.join(skillRoot, file), 'utf8');
const documents = [
  entry,
  'references/selection.md',
  'references/apply.md',
  'references/status.md',
  'HOW_IT_WORKS.md',
];

test('governance stays undiscoverable until its entry point is explicitly restored', () => {
  assert.equal(fs.existsSync(path.join(skillRoot, 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(skillRoot, entry)), true);
  const catalog = fs.readFileSync(path.join(skillRoot, '../../references/approval-gates.md'), 'utf8');
  assert.doesNotMatch(catalog, /^\|\s*`manage-governance:[^`]+`\s*\|\s*gate\s*\|/m);
  assert.match(catalog, /`manage-governance:2\.2\.consent`\s*\|\s*disabled/);
  assert.match(catalog, /`manage-governance:4\.2\.3\.consent`\s*\|\s*disabled/);
});

test('governance is documented as disabled outside the user-invocable inventory', () => {
  const agents = fs.readFileSync(path.join(skillRoot, '../../AGENTS.md'), 'utf8');
  const skillsStart = agents.indexOf('### Skills');
  const disabledStart = agents.indexOf('### Temporarily disabled skills');
  const hooksStart = agents.indexOf('### Hooks', disabledStart);
  assert.ok(skillsStart >= 0 && disabledStart > skillsStart && hooksStart > disabledStart);
  assert.doesNotMatch(agents.slice(skillsStart, disabledStart), /`manage-governance`/);
  const disabled = agents.slice(disabledStart, hooksStart);
  assert.match(disabled, /`manage-governance`/);
  assert.match(disabled, /Disabled pending Product approval/);
  assert.match(disabled, /not user-invocable or automatically discoverable/);
  assert.match(disabled, /HOW_IT_WORKS\.md#temporary-disablement/);
});

test('preserved governance workflow stays concise and requires each branch procedure', () => {
  const skill = read(entry);
  assert.ok(skill.split(/\r?\n/).length < 500, 'keep procedural detail out of the entry point');
  for (const file of documents.filter((file) => file.startsWith('references/'))) {
    assert.ok(skill.includes(`](${file})`), `entry point must load ${file}`);
  }
  assert.match(skill, /before executing its branch/);
  assert.match(skill, /References are mandatory instructions/);
  assert.doesNotMatch(skill, /\| Policy \| What it does \|/);
  for (const file of documents) {
    assert.doesNotMatch(read(file), /\$\{CLAUDE_PLUGIN_ROOT\}/);
  }
});

test('governance procedure links and phase anchors resolve inside the installed skill', () => {
  for (const file of documents) {
    for (const match of read(file).matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      const [target, anchor] = match[1].split('#');
      const absolute = path.resolve(skillRoot, path.dirname(file), target || path.basename(file));
      const relative = path.relative(skillRoot, absolute);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file}: portable link`);
      assert.ok(fs.existsSync(absolute), `${file}: missing link ${match[1]}`);
      if (anchor) {
        const headings = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) => line.replace(/^#{1,6} /, '').toLowerCase()
            .replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
        assert.ok(headings.includes(anchor), `${file}: missing anchor ${match[1]}`);
      }
    }
  }
});

test('governance selection preserves full environments and separate site-display rules', () => {
  const selection = read('references/selection.md');
  for (const required of [
    'complete fresh output verbatim',
    'assistant message before the selection form',
    'require explicit `keep`',
    'Never filter',
    'orderPortalsForDisplay()',
    'parser always validates against the **full** list',
    'do not apply',
    'parse-portal-input.js',
  ]) {
    assert.ok(selection.toLowerCase().includes(required.toLowerCase()), required);
  }
});

test('empty environments require explicit all-only selection without bypassing Apply consent', () => {
  const selection = read('references/selection.md');
  const empty = selection.slice(selection.indexOf('If there are zero sites'), selection.indexOf('Resolve site input with:'));
  assert.match(empty, /Accept only `all`/);
  assert.match(empty, /Do not silently choose\s+`all`/);
  assert.match(empty, /enable\/disable intent mapping/);
  assert.match(empty, /explicit Apply now \/ Cancel\s+approval/);
  assert.match(empty, /Fetch Site stops/);
  assert.match(read('references/apply.md'), /empty inventory is not a list of blocked sites/);
});

test('ambiguous site names require exact IDs without automatic or partial selection', () => {
  const selection = read('references/selection.md');
  assert.match(selection, /When a name is ambiguous, display every matching site's name, URL, and site ID/);
  assert.match(selection, /ask for the exact site\s+ID or cancel/);
  assert.match(selection, /Never choose the first or last\s+match automatically/);
  assert.match(selection, /do not\s+retain a partial selection/);
});

test('explicit environments skip redundant selection but retain fresh validation and consent', () => {
  const selection = read('references/selection.md');
  const supplied = selection.slice(
    selection.indexOf('### Supplied environment name or ID'),
    selection.indexOf('### Missing or unresolved environment'),
  );
  for (const required of [
    'fresh inventory',
    'case-insensitively',
    '**exact matches only**',
    '**Exact environment ID:**',
    '**Unique exact environment name:**',
    'Duplicate exact names, conflicting name and ID, or only partial/fuzzy',
    '**Unknown name or ID:**',
    'Never silently fall',
    'Using <display name> (<envId>)',
    'Do not show the environment picker or ask the user',
    'Apply now / Cancel',
  ]) {
    assert.ok(supplied.includes(required), required);
  }
  assert.match(supplied, /Apply,\s+Fetch Env, Fetch Site/);
  assert.match(selection, /If no environment was supplied, or resolution above requires user input/);
  assert.match(selection, /reuse only this operation's fresh result/);
  assert.doesNotMatch(selection, /Even an environment named in the original request must be\s+confirmed/);
  const skill = read(entry);
  assert.match(skill, /skip re-selection for an exact ID or unique exact name/);
  assert.match(skill, /resolution \(picker only when needed\)/);
});

test('governance apply keeps dependency, resumption, impact, and delta safeguards', () => {
  const apply = read('references/apply.md');
  for (const required of [
    'availabilityDependsOn',
    'no force/anyway override',
    'remediationChain',
    '<PENDING_CHILD_INTENT>',
    'verification succeeds',
    'Redundant-operation guard',
    'Disclose collateral changes before approval',
    '--removePortalIds',
    'render-impact-summary.js',
    'currentState: "Unknown"',
    'Sign-in failures still stop',
  ]) {
    assert.ok(apply.includes(required), required);
  }
});

test('governance consent displays Markdown outside the plain-text approval form', () => {
  const skill = read(entry);
  const consent = skill.slice(
    skill.indexOf('#### 4.2.3 Confirm before posting'),
    skill.indexOf('#### 4.2.4 Apply and watch'),
  );
  assert.match(consent, /First send an \*\*assistant message\*\*/);
  assert.ok(consent.indexOf('First send') < consent.indexOf('Then use `AskUserQuestion`:'));
  assert.match(consent, /short plain-text\s+confirmation/);
  assert.match(consent, /do not put the impact summary, table, warnings, or cascades in\s+the form's message, question, or field\/option descriptions/);
  assert.match(consent, /before calling the tool in the same turn/);
  assert.match(consent, /do not add a separate acknowledgement prompt/);
  assert.match(consent, /Only selected \*\*Apply now\*\* authorizes the POST/);

  const apply = read('references/apply.md');
  assert.match(apply, /full output verbatim in an \*\*assistant message\*\*/);
  assert.match(apply, /before calling the approval tool in the same\s+turn/);
  assert.match(apply, /Do not put the summary or its disclosures in the form's message,\s+question, or field\/option descriptions/);
  assert.match(apply, /only "Proceed with this change\?" in the form/);
});

test('governance selection and follow-up forms never contain the displayed tables', () => {
  const skill = read(entry);
  const display = skill.slice(
    skill.indexOf('### Table display across all branches'),
    skill.indexOf('## Workflow and task tracking'),
  );
  assert.match(display, /environment, site-selection, eligibility, impact, and status/);
  assert.match(display, /assistant message\*\*, not inside an input form/);
  assert.match(display, /before calling\s+the question tool in the same turn/);

  const selection = read('references/selection.md');
  assert.match(selection, /Do not put the environment table in\s+the form's message, question, or field\/option descriptions/);
  assert.match(selection, /Do not put the site\/eligibility table or eligibility explanation\s+in the form's message, question, or field\/option descriptions/);
  assert.match(selection, /free-text\s+environment value, not an option menu/);
  assert.match(selection, /free-text scope value, not an\s+option menu/);
  assert.match(read('references/status.md'), /Never embed the table in the\s+form's message, question, or field\/option descriptions/);
});

test('governance read procedures retain canonical output and distinct batch readers', () => {
  const status = read('references/status.md');
  for (const required of [
    'own AND every',
    'fail closed',
    '# | Name | URL | Site ID | State',
    '--markdown --no-color',
    'per policy in',
    'fetch-env-status.js',
    'get-effective-status.js',
    'Poll success alone is insufficient',
    'do not automatically retry the POST',
  ]) {
    assert.ok(status.toLowerCase().includes(required.toLowerCase()), required);
  }
  assert.match(status, /unfenced Markdown table/);
  assert.match(status, /one physical line/);
  assert.doesNotMatch(status, /--unicode/);
});
