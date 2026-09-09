'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readDocumentTree } = require('./helpers/workflow-documents');

test('workflow test reader visits only reachable documents once in declared order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-workflow-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'references'));
  fs.writeFileSync(path.join(root, 'SKILL.md'), [
    '[Active phase](references/phase.md#start)',
    '[Same phase](references/phase.md)',
    '[Outside workflow](../not-a-workflow.md)',
    '[External](https://example.invalid/guide.md)',
    '```markdown',
    '[Illustrative link](not-a-real-file.md)',
    '```',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'references/phase.md'), [
    '# Start',
    '[Mode-specific detail](detail.md)',
    '[Entry](../SKILL.md)',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'references/detail.md'), '# Detail\n');
  fs.writeFileSync(path.join(root, 'references/unreachable.md'), '# Never loaded\n');

  const documents = readDocumentTree(path.join(root, 'SKILL.md'));
  assert.deepEqual(documents.map(document => path.relative(root, document.path)), [
    'SKILL.md',
    path.join('references', 'phase.md'),
    path.join('references', 'detail.md'),
  ]);
});

test('workflow test reader fails on a missing active-phase reference', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-workflow-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'SKILL.md'), '[Phase](missing-phase.md)\n');
  assert.throws(() => readDocumentTree(path.join(root, 'SKILL.md')), { code: 'ENOENT' });
});
