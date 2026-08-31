'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const skill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
  'utf8',
);
const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
const templateReadme = fs.readFileSync(
  path.join(pluginRoot, 'template', 'README.md'),
  'utf8',
);

function section(startHeading, endHeading) {
  const start = skill.indexOf(startHeading);
  const end = skill.indexOf(endHeading, start + startHeading.length);
  assert.notStrictEqual(start, -1, `missing section: ${startHeading}`);
  assert.notStrictEqual(end, -1, `missing section: ${endHeading}`);
  return skill.slice(start, end);
}

test('target resolution happens before preview without mutating the destination', () => {
  const targetResolution = section('### Step 2 — Gather requirements', '### Step 2b — Requirements discovery');
  const preview = section('### Step 2c — Plan preview', '### Step 2d — Materialize/adopt template');
  const preApproval = skill.slice(
    skill.indexOf('### Step 0 — Capture launch directory'),
    skill.indexOf('### Step 2d — Materialize/adopt template'),
  );

  assert.match(targetResolution, /resolve-mobile-app-target\.js/);
  assert.match(targetResolution, /WORKING_DIR=.*workingDir/);
  assert.match(preview, /last point.*zero side effects/);
  assert.match(preview, /Target\s+<absolute working_dir>/);
  assert.doesNotMatch(targetResolution, /\bdegit\b|npm install|mkdir -p/);
  assert.match(
    preApproval,
    /ENV_JSON=\$\(cd "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/" && node scripts\/resolve-environment\.js/,
  );
  assert.doesNotMatch(preApproval, /^\s*(?:npx .*degit|npm install|mkdir -p)\b/m);
  assert.doesNotMatch(preApproval, />\s*["']?\$?WORKING_DIR\/\.resolved-environment\.json/);
});

test('template materialization precedes a retained background install', () => {
  const scaffold = section(
    '### Step 2d — Materialize/adopt template',
    '### Step 3 — Plan',
  );

  assert.match(scaffold, /degit@2\.8\.4/);
  assert.match(scaffold, /plugins\/mobile-apps\/template#main/);
  assert.match(scaffold, /test "\$\(pwd -P\)" = "\$WORKING_DIR"/);
  assert.match(scaffold, /background\/async mode/);
  assert.match(scaffold, /cd "\$WORKING_DIR" && npm install/);
  assert.match(scaffold, /NPM_INSTALL_TERMINAL_ID/);
  assert.match(scaffold, /continue immediately\s+to Step 3 without polling/);
  assert.match(scaffold, /every fresh `materialize` or `adopt` action/);
  assert.doesNotMatch(scaffold, /npm install\s*&/);
});

test('template preparation joins the exact install before package mutation', () => {
  const prepare = section(
    '### Step 5 — Join dependency install',
    '### Step 6 — Initialize',
  );
  const joinIndex = prepare.indexOf('$NPM_INSTALL_TERMINAL_ID');
  const mutationIndex = prepare.indexOf('Then apply these **safe idempotent** prep steps');

  assert.ok(joinIndex >= 0);
  assert.ok(mutationIndex > joinIndex);
  assert.match(prepare, /Do not launch another `npm install`/);
  assert.match(prepare, /Non-zero\/start failure.*STOP/s);
  assert.match(prepare, /test -d node_modules\/expo/);
  assert.match(prepare, /authoritative app-name collision check/);
  assert.match(prepare, /Step 5\.9 — Seed the recovery memory bank/);
});

test('planned JavaScript dependencies are reconciled in one exact install', () => {
  const dependencyStep = section(
    '### Step 9a — Reconcile approved pure-JavaScript dependencies',
    '### Step 9b — Apply design system',
  );

  assert.match(dependencyStep, /missing or version-mismatched/);
  assert.match(
    dependencyStep,
    /npm install --save-exact <package-a>@<exact-version> <package-b>@<exact-version>/,
  );
  assert.match(dependencyStep, /If every approved dependency is already present/);
  assert.match(dependencyStep, /using all approved rows/);
  assert.match(dependencyStep, /package\.before-js-dependencies\.json/);
  assert.match(dependencyStep, /npm install --ignore-scripts/);
});

test('setup documentation presents create-mobile-app as the one-command entry point', () => {
  const readmeSetup = readme.slice(
    readme.indexOf('## Setup'),
    readme.indexOf('## License and notices'),
  );
  const templateSetup = templateReadme.slice(
    templateReadme.indexOf('## Setup'),
    templateReadme.indexOf('## Upgrade the Native Host'),
  );

  assert.match(readmeSetup, /creates `\.\/<app-slug>`/);
  assert.match(readmeSetup, /--working-dir \.\/apps\/my-mobile-app/);
  assert.match(readmeSetup, /continues in parallel with planning/);
  assert.doesNotMatch(readmeSetup, /npx degit/);
  assert.doesNotMatch(readmeSetup, /^\s*npm install\s*$/m);

  assert.match(templateSetup, /adopts\s+the current directory/);
  assert.match(templateSetup, /`--working-dir <path>`/);
  assert.doesNotMatch(templateSetup, /npx degit/);
  assert.doesNotMatch(templateSetup, /^\s*npm install\s*$/m);
});
