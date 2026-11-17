'use strict';
// A wide declaration of each workflow family, with every name, label and description at its longest and in three-byte
// UTF-8 text, as the shared store's declaration bound is sized (managed-bindings.js, DECLARATION_MAX_BYTES). These are
// fixtures at the sizing model, not limits: no count is enforced, and a declaration whose completion the store cannot
// reserve is refused by its plan (workflow-drive.js completionWithin), whatever its counts:
//   - a process flow at the documented ceiling (references/app-spec-schema-advanced.md: 30 stages, 30 steps each),
//     64-character keys and field names, 100-character names and a 2,000-character description;
//   - a rule, which has no published ceiling, at the stated sizing model: 100 conditions and 100 actions, ten of them
//     recommendations with ten apply-actions each, every literal 250 characters.
// Field names are padded with 'z', not 'x': the tests' access token is 40 'x', and the store refuses a declaration
// that holds a token this process obtained.
const wideText = (n, i = 0) => `${i}${'完'.repeat(n)}`.slice(0, n);
const key64 = (p, i) => `${p}${i}`.padEnd(64, 'k');
const field64 = (i) => `contoso_field${i}`.padEnd(64, 'z');

function largestFlow(name) {
  return {
    name, entity: 'account', reconcile: 'declared', status: 'Active', description: wideText(2000),
    stages: Array.from({ length: 30 }, (_, i) => ({
      key: key64('s', i), name: wideText(100, i),
      steps: Array.from({ length: 30 }, (_, j) => ({ key: key64('p', j), name: wideText(100, j), field: field64(i * 30 + j), required: true })),
    })),
  };
}

function largestRule() {
  return {
    name: wideText(100), entity: 'account', reconcile: 'declared', status: 'Active', conditionLogic: 'AND', description: wideText(2000),
    conditions: Array.from({ length: 100 }, (_, i) => ({ key: key64('c', i), field: field64(i), operator: 'Equals', value: wideText(250, i), dataType: 'String' })),
    actions: Array.from({ length: 100 }, (_, i) => (i % 10 === 9
      ? {
        key: key64('a', i), type: 'Recommendation', field: field64(i), label: wideText(100, i), recommendationTitle: wideText(100, i),
        messageText: wideText(500, i), acceptanceText: wideText(100, i),
        applyActions: Array.from({ length: 10 }, (_, j) => ({ key: key64(`x${i}_`, j), field: field64(j), value: wideText(250, j), dataType: 'String' })),
      }
      : { key: key64('a', i), type: 'SetFieldValue', field: field64(i), label: wideText(100, i), value: wideText(250, i), dataType: 'String' })),
  };
}

module.exports = { largestFlow, largestRule };
