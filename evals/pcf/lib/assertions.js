'use strict';

const PASS = { status: 'pass' };
const fail = (reason) => ({ status: 'fail', reason });
const ASSERTIONS = new Map();

function list(value) { return Array.isArray(value) ? value : []; }
function missingFrom(actual, expected) { return list(expected).filter((code) => !new Set(list(actual)).has(code)); }

ASSERTIONS.set('contract: every expected code is present', ({ facts, eval: ev }) => {
  const expected = list(ev.expect && ev.expect.presentCodes);
  if (!expected.length) return PASS;
  const missing = missingFrom(facts.allCodes, expected);
  return missing.length ? fail(`missing expected code(s): ${missing.join(', ')}; actual [${list(facts.allCodes).join(', ')}]`) : PASS;
});

ASSERTIONS.set('contract: every forbidden code is absent', ({ facts, eval: ev }) => {
  const forbidden = list(ev.expect && ev.expect.absentCodes);
  const actual = new Set(list(facts.allCodes));
  const present = forbidden.filter((code) => actual.has(code));
  return present.length ? fail(`forbidden code(s) present: ${present.join(', ')}`) : PASS;
});

ASSERTIONS.set('contract: expected ok/status fields match', ({ facts, eval: ev }) => {
  const expect = ev.expect || {};
  if (Object.prototype.hasOwnProperty.call(expect, 'ok') && facts.ok !== expect.ok) return fail(`ok expected ${expect.ok} got ${facts.ok}`);
  if (Object.prototype.hasOwnProperty.call(expect, 'status') && facts.status !== expect.status) return fail(`status expected ${expect.status} got ${facts.status}`);
  return PASS;
});

ASSERTIONS.set('contract: expected upgrade step ids are present', ({ facts, eval: ev }) => {
  const expected = list(ev.expect && ev.expect.presentStepIds);
  const absent = list(ev.expect && ev.expect.absentStepIds);
  if (facts.family !== 'upgrade') return expected.length || absent.length ? fail('upgrade step expectation used on non-upgrade fact') : PASS;
  const actual = new Set(list(facts.stepIds));
  const missing = expected.filter((id) => !actual.has(id));
  if (missing.length) return fail(`missing upgrade step id(s): ${missing.join(', ')}; actual [${list(facts.stepIds).join(', ')}]`);
  const forbidden = absent.filter((id) => actual.has(id));
  return forbidden.length ? fail(`forbidden upgrade step id(s) present: ${forbidden.join(', ')}`) : PASS;
});

ASSERTIONS.set('contract: expected manual step ids are present', ({ facts, eval: ev }) => {
  const expected = list(ev.expect && ev.expect.presentManualIds);
  if (facts.family !== 'upgrade') return expected.length ? fail('manual step expectation used on non-upgrade fact') : PASS;
  const missing = expected.filter((id) => !new Set(list(facts.manualIds)).has(id));
  return missing.length ? fail(`missing manual step id(s): ${missing.join(', ')}; actual [${list(facts.manualIds).join(', ')}]`) : PASS;
});

module.exports = { ASSERTIONS };
