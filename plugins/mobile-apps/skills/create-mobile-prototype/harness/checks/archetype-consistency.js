'use strict';

function key(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function run(snapshot, context) {
  const expected = key(context.screenMeta?.Archetype);
  if (!expected) return { pass: true, failures: [], report: { applicable: false } };
  const roots = snapshot.elements.filter((element) => element.visible && /^archetype:/.test(element.testId));
  if (roots.length === 0) return { pass: false, notRun: true, failures: [`planned ${expected} screen has no archetype:<key> root`] };
  const actual = roots.map((element) => key(element.testId.slice('archetype:'.length)));
  const failures = actual.length === 1 && actual[0] === expected ? [] : [`rendered archetype ${actual.join(', ') || 'none'}, expected ${expected}`];
  return { pass: failures.length === 0, failures, report: { applicable: true, expected, actual } };
}

module.exports = { key, run };