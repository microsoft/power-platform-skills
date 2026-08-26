'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareDesignContext, referenceAllowlist } = require('../prepare-design-context');

test('automatic prototype design loads only its compact universal allowlist', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-context-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { output, evidence } = prepareDesignContext(root, 'automatic', {
    modelCalls: 1,
    now: '2026-08-26T00:00:00.000Z',
  });
  assert.deepEqual(evidence.referenceFiles.map((item) => item.path), [
    'skills/design-system/references/design-system-schema.md',
    'skills/design-system/references/preview-template.md',
  ]);
  assert.equal(evidence.referenceFiles.every((item) => item.bytes > 0), true);
  assert.equal(evidence.totalReferenceBytes < 150 * 1024, true);
  assert.equal(evidence.designModelCalls, 1);
  assert.equal(fs.existsSync(output), true);
  assert.equal(evidence.referenceFiles.some((item) => /input-modes|reference-intake|vibe|extraction/.test(item.path)), false);
});

test('optional design modes load only references owned by that mode', () => {
  const reference = referenceAllowlist('reference');
  assert.ok(reference.includes('skills/design-system/references/reference-intake.md'));
  assert.ok(reference.includes('shared/references/reference-fidelity.md'));
  assert.equal(reference.some((item) => /style-picker|brand-examples/.test(item)), false);

  const figma = referenceAllowlist('figma');
  assert.ok(figma.includes('skills/design-system/references/figma-extraction.md'));
  assert.equal(figma.some((item) => /canvas-app-extraction|code-app-extraction/.test(item)), false);
  assert.throws(() => referenceAllowlist('unknown'), /Unsupported design context mode/);
});