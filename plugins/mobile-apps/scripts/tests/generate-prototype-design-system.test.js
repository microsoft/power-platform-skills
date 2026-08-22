'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'generate-prototype-design-system.js');
const { statusTone } = require(script);

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function project(t, domain = 'corporate access control') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-design-system-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.tmp/seed-vocabulary.json', { domain });
  write(root, '.tmp/dataverse-schema-contract.json', {
    schemaVersion: 1,
    tables: [{
      logicalName: 'cr_request',
      columns: [{
        logicalName: 'cr_status', displayName: 'Status', type: 'choice',
        options: [
          { value: 100000000, label: 'Draft' },
          { value: 100000001, label: 'Approved' },
          { value: 100000002, label: 'Rejected' },
        ],
      }],
    }],
  });
  return root;
}

test('writes semantic tokens and schema-keyed status colours before screens', (t) => {
  const root = project(t);
  assert.equal(fs.existsSync(path.join(root, 'app')), false);
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const tokens = fs.readFileSync(path.join(root, 'brand/tokens.ts'), 'utf8');
  const design = fs.readFileSync(path.join(root, 'brand/design-system.md'), 'utf8');
  for (const token of ['accentBase', 'accentSoft', 'accentOn', 'surface0', 'surface1', 'surface2', 'ink', 'inkMuted', 'inkFaint', 'warnFg', 'warnBg']) {
    assert.match(tokens, new RegExp(`["']?${token}["']?\\s*:`));
  }
  assert.match(tokens, /statusByValue: Record<string, StatusToken>/);
  assert.match(tokens, /"100000000"/);
  assert.match(tokens, /"label":"Draft"|label:\s*"Draft"/);
  assert.match(tokens, /export function day\(/);
  assert.match(tokens, /export function dayTime\(/);
  assert.match(tokens, /export const typeScale/);
  assert.match(tokens, /export const fontStack/);
  assert.match(tokens, /headlineLarge: \{ fontSize: 32, lineHeight: 40, fontWeight: '400' \}/);
  assert.match(tokens, /export const shapeScale = \{ xs: 4, sm: 8, md: 12, lg: 16, xl: 24 \}/);
  assert.match(tokens, /imageScrim/);
  assert.match(tokens, /export const chartTokens/);
  assert.match(tokens, /seriesPrimary: '#147D92'/);
  assert.match(tokens, /axisLabelRole: 'labelSmall'/);
  assert.match(tokens, /chartArea/);
  assert.match(design, /never use the accent as a status colour/);
  assert.match(design, /never place status colour on chrome/);
  assert.match(design, /no card borders on list rows/);
  assert.match(design, /red-branded organisations/);
  assert.match(design, /## Discipline/);
  assert.match(design, /https:\/\/m3\.material\.io\/styles\/typography\/type-scale-tokens/);
  assert.match(design, /no gradient without a declared source/);
});

test('maps common workflow and inventory labels to semantic tones', () => {
  assert.equal(statusTone('Available'), 'success');
  assert.equal(statusTone('Confirmed'), 'success');
  assert.equal(statusTone('Low stock'), 'warning');
  assert.equal(statusTone('Sold out'), 'alarm');
});

test('preserves conflicting local-choice labels in field-scoped maps', (t) => {
  const root = project(t);
  const contractPath = path.join(root, '.tmp/dataverse-schema-contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.tables.push({
    logicalName: 'cr_history',
    columns: [{
      logicalName: 'cr_state', displayName: 'State', type: 'choice',
      options: [{ value: 100000001, label: 'Denied' }],
    }],
  });
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const tokens = fs.readFileSync(path.join(root, 'brand/tokens.ts'), 'utf8');
  assert.match(tokens, /statusByFieldValue/);
  assert.match(tokens, /"cr_request\.cr_status"/);
  assert.match(tokens, /"cr_history\.cr_state"/);
  assert.match(tokens, /"Approved"/);
  assert.match(tokens, /"Denied"/);
  assert.match(tokens, /export function statusToken/);
});

test('augments approved design artifacts without replacing their palette or direction', (t) => {
  const root = project(t);
  write(root, 'brand/tokens.ts', `// Approved by /design-system.\nexport const tokens = { color: { primary: '#C62828' } } as const;\n`);
  write(root, 'brand/design-system.md', '# Approved Direction\n\nKeep this approved visual direction.\n');
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const tokens = fs.readFileSync(path.join(root, 'brand/tokens.ts'), 'utf8');
  const design = fs.readFileSync(path.join(root, 'brand/design-system.md'), 'utf8');
  assert.match(tokens, /Approved by \/design-system/);
  assert.match(tokens, /#C62828/);
  assert.match(tokens, /statusByValue/);
  assert.match(tokens, /export function dayTime/);
  assert.match(tokens, /"Rejected","fg":"#7A3700","bg":"#FBEAD9","stripe":"#CA5010"/);
  assert.equal(tokens.match(/PROTOTYPE SEMANTICS START/g)?.length, 1);
  assert.match(design, /# Approved Direction/);
  assert.match(design, /Keep this approved visual direction/);
  assert.match(design, /Prototype Status Map/);
  assert.equal(design.match(/PROTOTYPE SEMANTICS START/g)?.length, 1);
  assert.equal(tokens.match(/PROTOTYPE DISCIPLINE START/g)?.length, 1);
  assert.equal(design.match(/PROTOTYPE DISCIPLINE START/g)?.length, 1);
});

test('prototype workflow authors brand files before navigation and builders', () => {
  const skill = fs.readFileSync(path.resolve(__dirname, '..', '..', 'skills/create-mobile-prototype/SKILL.md'), 'utf8');
  const approval = skill.indexOf('Run `/design-system` in orchestrator mode unless `--no-design`');
  const generation = skill.indexOf('generate-prototype-design-system.js');
  const navigation = skill.indexOf('### Step 7 - Navigation');
  const builders = skill.indexOf('### Step 8 - Build Screens');
  assert.ok(approval > 0 && approval < generation && generation < navigation && navigation < builders);
  assert.match(skill, /do not bypass or pre-answer its gate/);
});