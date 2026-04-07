const test = require('node:test');
const assert = require('node:assert/strict');

const { addFinding, summarize } = require('../lib/powerpages-validation-utils');

test('addFinding and summarize produce severity counts', () => {
  const findings = [];
  addFinding(findings, 'error', 'Bad config');
  addFinding(findings, 'warning', 'Odd config');
  addFinding(findings, 'info', 'FYI');

  assert.deepEqual(summarize(findings), { error: 1, warning: 1, info: 1 });
});
