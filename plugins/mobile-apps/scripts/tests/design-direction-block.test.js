'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const validatorPath = path.join(pluginRoot, 'scripts', 'validate-design-direction.js');
const writerPath = path.join(pluginRoot, 'scripts', 'write-design-direction.js');
const block = require(path.join(pluginRoot, 'scripts', 'lib', 'design-direction-block.js'));
const writer = require(writerPath);
const catalogue = require(path.join(pluginRoot, 'scripts', 'lib', 'design-direction-catalogue.js'));

function bundle(overrides = {}) {
  return {
    direction: 'product',
    surface: 'editorial',
    background: 'warm-cream',
    palette: 'cream + sage',
    typography: 'display-headings + sans-body',
    heading_font: 'Fraunces',
    body_font: 'Inter',
    body_size: '16pt',
    heading_letter_spacing: '0',
    list_style: 'sentence',
    density: 'sparse',
    motion: 'liberal-tasteful',
    status_saturation: 'monochrome-plus-accent',
    empty_state: 'type-led',
    primary_action_shape: 'pill',
    primary_action_position: 'in-flow-or-bottom-center',
    accent_color: 'sage (#7D9B76)',
    tone: 'conversational',
    ...overrides,
  };
}

function designBlock(options = {}) {
  const values = bundle(options.bundle);
  const lines = block.REQUIRED_KEYS.filter((key) => !options.omit?.includes(key)).map((key) => `${key}: ${values[key]}`);
  return `## Design Direction

**Picked:** ${options.picked || 'Product'}
**Reference apps:** ${options.references || 'Linear, Notion'}
**Picked at:** ${options.pickedAt || '2026-08-22T12:34:56Z (via /design-system style picker)'}

${lines.join('\n')}

> Downstream agents inherit this bundle.
`;
}

function plan(directionBlock = designBlock(), options = {}) {
  const before = options.before || '## Connectors\n\nNone.\n\n';
  const after = options.after || '## Design\n\nInherited.\n\n## Screens\n';
  return `# Plan\n\n${before}${directionBlock}\n${after}`;
}

test('valid block parses all required fields and becomes effective', () => {
  const result = block.inspect(plan());
  assert.equal(result.present, true);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.effective, 'bundle');
  assert.equal(result.bundle.direction, 'product');
  assert.deepEqual(Object.keys(result.bundle), block.REQUIRED_KEYS);
});

test('absent or malformed blocks fall back without partial bundle parsing', () => {
  const absent = block.inspect('# Plan\n\n## Connectors\n\nNone.\n\n## Screens\n');
  assert.deepEqual({ present: absent.present, valid: absent.valid, effective: absent.effective }, { present: false, valid: true, effective: 'fallback' });
  const malformed = block.inspect(plan(designBlock({ omit: ['motion', 'tone'], references: 'Only One' })));
  assert.equal(malformed.present, true);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.effective, 'fallback');
  assert.equal(malformed.bundle, null);
  assert.match(malformed.errors.join('\n'), /missing bundle key motion/);
  assert.match(malformed.errors.join('\n'), /at least 2/);
});

test('direction, timestamp, color, duplicate, and placement validation fail closed', () => {
  const invalid = designBlock({
    bundle: { direction: 'unregistered', accent_color: 'sage' },
    pickedAt: 'tomorrow',
  }).replace('tone: conversational', 'tone: conversational\ntone: direct');
  const result = block.inspect(plan(invalid, { before: '## Project\n\nDemo.\n\n' }));
  const errors = result.errors.join('\n');
  assert.match(errors, /not registered/);
  assert.match(errors, /ISO 8601/);
  assert.match(errors, /accent_color/);
  assert.match(errors, /duplicate keys: tone/);
  assert.match(errors, /must follow/);
  assert.equal(result.bundle, null);
});

test('hybrid inline provenance comments parse without damaging hex colors', () => {
  const value = designBlock({ bundle: {
    direction: 'hybrid',
    surface: 'editorial # from Product',
    accent_color: 'sage (#7D9B76)',
  }, picked: 'Hybrid (Product base + Inspection density)' });
  const result = block.inspect(plan(value));
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.bundle.surface, 'editorial');
  assert.equal(result.bundle.accent_color, 'sage (#7D9B76)');
});

test('invalid calendar dates, undocumented hybrids, duplicate blocks, and late placement fail', () => {
  const badDate = block.inspect(plan(designBlock({ pickedAt: '2026-02-30T12:00:00Z' })));
  assert.match(badDate.errors.join('\n'), /ISO 8601/);
  const hybrid = block.inspect(plan(designBlock({ bundle: { direction: 'hybrid' }, picked: 'Hybrid' })));
  assert.match(hybrid.errors.join('\n'), /document its composition/);
  const duplicated = block.inspect(plan(`${designBlock()}\n${designBlock()}`));
  assert.match(duplicated.errors.join('\n'), /exactly one/);
  const late = `# Plan\n\n## Native Capabilities\n\nNone.\n\n${designBlock()}\n## Connectors\n\nNone.\n\n## Screens\n`;
  assert.match(block.inspect(late).errors.join('\n'), /must follow/);
});

test('replacement overwrites one block and insertion uses the documented anchor', () => {
  const first = plan();
  const replacement = designBlock({ bundle: { direction: 'saas' }, picked: 'SaaS' });
  const updated = block.replace(first, replacement);
  assert.equal((updated.match(/^## Design Direction$/gm) || []).length, 1);
  assert.equal(block.inspect(updated).bundle.direction, 'saas');
  const inserted = block.replace('# Plan\n\n## Connectors\n\nNone.\n\n## Screens\n', replacement);
  assert.ok(inserted.indexOf('## Connectors') < inserted.indexOf('## Design Direction'));
  assert.ok(inserted.indexOf('## Design Direction') < inserted.indexOf('## Screens'));
});

test('CLI rejects malformed blocks unless fallback is explicitly allowed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-direction-block-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(planPath, plan(designBlock({ omit: ['motion'] })));
  const strict = spawnSync(process.execPath, [validatorPath, planPath, '--json'], { encoding: 'utf8' });
  assert.equal(strict.status, 2);
  assert.equal(JSON.parse(strict.stdout).effective, 'fallback');
  const allowed = spawnSync(process.execPath, [validatorPath, planPath, '--allow-fallback'], { encoding: 'utf8' });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /MALFORMED \(fallback\)/);
});

test('writer atomically inserts and replaces a validated complete block', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-direction-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'native-app-plan.md');
  const inputPath = path.join(root, 'direction.json');
  fs.writeFileSync(planPath, '# Plan\n\n## Connectors\n\nNone.\n\n## Screens\n');
  const input = { picked: 'Product', referenceApps: ['Linear', 'Notion'], pickedAt: '2026-08-22T12:34:56Z', bundle: bundle({ heading_letter_spacing: 0 }) };
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const inserted = spawnSync(process.execPath, [writerPath, '--plan', planPath, '--input', inputPath], { encoding: 'utf8' });
  assert.equal(inserted.status, 0, inserted.stderr);
  assert.match(inserted.stdout, /product \(inserted\)/);
  assert.match(fs.readFileSync(planPath, 'utf8'), /^heading_letter_spacing: 0$/m);
  input.picked = 'SaaS';
  input.bundle = bundle({ direction: 'saas' });
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const replaced = writer.write(planPath, input);
  assert.deepEqual(replaced, { direction: 'saas', previousDirection: 'product', replaced: true });
  const markdown = fs.readFileSync(planPath, 'utf8');
  assert.equal((markdown.match(/^## Design Direction$/gm) || []).length, 1);
  assert.equal(block.inspect(markdown).bundle.direction, 'saas');
});

test('writer rejects incomplete input without changing the plan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-direction-write-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'native-app-plan.md');
  const original = '# Plan\n\n## Connectors\n\nNone.\n\n## Screens\n';
  fs.writeFileSync(planPath, original);
  assert.throws(() => writer.write(planPath, { picked: 'Product', referenceApps: ['Linear'], pickedAt: 'bad', bundle: { direction: 'product' } }), /invalid Design Direction block/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), original);
});

test('every registered direction source supplies the complete bundle', () => {
  for (const entry of catalogue.load()) {
    const source = fs.readFileSync(path.join(catalogue.DIRECTIONS_DIR, entry.source), 'utf8');
    const yaml = source.match(/^## Bundle\s*$\n+```yaml\n([\s\S]*?)\n```/m)?.[1];
    assert.ok(yaml, `${entry.slug} has no YAML Bundle`);
    const parsed = block.parseBody(yaml).bundle;
    for (const key of block.REQUIRED_KEYS) assert.ok(parsed[key], `${entry.slug} is missing ${key}`);
    assert.equal(parsed.direction, entry.slug, `${entry.slug} direction key`);
    assert.equal(block.validAccentColor(parsed.accent_color), true, `${entry.slug} accent_color`);
  }
});

test('planner and builder validate before consuming and never salvage malformed blocks', () => {
  for (const relativePath of ['agents/screen-planner.md', 'agents/screen-builder.md']) {
    const source = fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
    assert.match(source, /validate-design-direction\.js/);
    assert.match(source, /--allow-fallback/);
    assert.match(source, /never (?:parse|salvage).*partial|never salvage individual keys/i);
  }
});

test('all direction writers use atomic replacement followed by strict validation', () => {
  for (const relativePath of [
    'skills/design-system/SKILL.md',
    'skills/design-system/references/vibe/style-picker.md',
    'skills/edit-plan/SKILL.md',
  ]) {
    const source = fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
    assert.match(source, /write-design-direction\.js/, relativePath);
    assert.match(source, /validate-design-direction\.js/, relativePath);
  }
});

test('every design-system branch invokes the required persistence procedure', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'skills/design-system/SKILL.md'), 'utf8');
  for (const marker of ['- **(b)**', '- **(c) Brand apply**', '- **(c) Apply defaults / (d) — no-brand path**']) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, marker);
    const next = source.indexOf('\n- **', start + marker.length);
    const branch = source.slice(start, next < 0 ? source.length : next);
    assert.match(branch, /persist direction procedure|Persist direction/, marker);
  }
});

test('style-picker sub-step returns every required bundle key', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'skills/design-system/references/vibe/style-picker.md'), 'utf8');
  const resultBlock = source.match(/DESIGN_VIBE_RESULT\n([\s\S]*?)\n```/)?.[1] || '';
  for (const key of block.REQUIRED_KEYS) assert.match(resultBlock, new RegExp(`^${key}:`, 'm'), key);
  assert.match(resultBlock, /^reference_apps:/m);
});

test('schema reference names executable strict-writer and fallback-consumer contracts', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'skills/design-system/references/vibe/design-bundle-schema.md'), 'utf8');
  assert.match(source, /write-design-direction\.js/);
  assert.match(source, /validate-design-direction\.js/);
  assert.match(source, /present=true AND valid=true AND effective="bundle"/);
  assert.match(source, /invalid legacy block behaves exactly like an absent block/);
});
