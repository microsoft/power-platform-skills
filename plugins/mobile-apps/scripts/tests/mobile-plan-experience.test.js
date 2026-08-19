'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { experienceStatusFromPlan, updateStatus } = require('../mobile-plan-status');
const { renderMarkdown, renderPlan, splitSections } = require('../render-mobile-plan');
const { checkAgentPreflight } = require('../agent-preflight');

test('status updates preserve start time and set prompt awareness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-status-'));
  const file = path.join(dir, 'mobile-app-status.json');
  const first = updateStatus(file, { phase: 'architecture', completed: 1, total: 4 });
  const second = updateStatus(file, { awaitingInput: true, inputPrompt: 'approve architecture' });
  assert.strictEqual(second.startedAt, first.startedAt);
  assert.strictEqual(second.phase, 'architecture');
  assert.strictEqual(second.awaitingInput, true);
  assert.strictEqual(second.version, 2);
});

test('status synchronizes Product Experience fields from plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-status-plan-'));
  const plan = path.join(dir, 'native-app-plan.md');
  fs.writeFileSync(plan, `## Product Experience
- Contract version: 1
- Product archetype: asset-maintenance-cmms
- Visual personality: premium-brand-forward
- Home composition: asset-command
- Reference fidelity: high

### First Viewport Contract
| Field | Requirement |
|---|---|
| Signature component | EquipmentCommandHero |
`);
  assert.deepStrictEqual(experienceStatusFromPlan(plan), {
    productArchetype: 'asset-maintenance-cmms',
    visualPersonality: 'premium-brand-forward',
    homeComposition: 'asset-command',
    referenceFidelity: 'high',
  });
});

test('plan renderer creates structured navigation, experience status, progress, and input banner safely', () => {
  const markdown = '## Product Experience\n- Product archetype: `asset-maintenance-cmms`\n\n| Field | Requirement |\n|---|---|\n| Home | asset-command |\n<script>alert(1)</script>\n\n## Screens\n### Home\n**Composition:** asset-command';
  const html = renderPlan(markdown, {
    phase: 'architecture approval',
    completed: 2,
    total: 4,
    awaitingInput: true,
    inputPrompt: 'return to terminal',
    productArchetype: 'asset-maintenance-cmms',
    visualPersonality: 'premium-brand-forward',
    homeComposition: 'asset-command',
    visualQaState: 'pending',
  });
  assert.strictEqual(splitSections(markdown).length, 2);
  assert.match(html, /50% complete/);
  assert.match(html, /Input required/);
  assert.match(html, /asset-maintenance-cmms/);
  assert.match(html, /premium-brand-forward/);
  assert.match(html, /<table>/);
  assert.match(html, /<h2>Home<\/h2>/);
  assert.doesNotMatch(html, /<section[^>]*>[\s\S]*?<pre>&lt;script/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('markdown renderer produces semantic lists and code without executing HTML', () => {
  const html = renderMarkdown('- one\n- two\n\n```ts\nconst x = "<tag>";\n```');
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /class="code"/);
  assert.match(html, /&lt;tag&gt;/);
});

test('agent preflight selects fallback before dispatch when snapshot is missing', () => {
  const root = path.resolve(__dirname, '..', '..');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-preflight-'));
  const result = checkAgentPreflight({
    agent: 'data-model-architect',
    workingDir,
    pluginRoot: root,
    snapshot: path.join(workingDir, 'missing-snapshot.json'),
  });
  assert.strictEqual(result.status, 'fallback');
  assert.strictEqual(result.fallback, 'foreground-data-model-from-snapshot');
  assert.ok(result.missing.includes('normalized Dataverse snapshot'));
});
