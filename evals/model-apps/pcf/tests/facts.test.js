'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeFacts } = require('../lib/facts.js');

const ROOT = path.join(__dirname, '..');
const fixture = (name) => path.join(ROOT, 'fixtures', name);

function codes(items, key = 'code') {
  return (items || []).map((item) => item[key]).sort();
}

test('facts: clean intent fixture validates, lints cleanly, and renders plan sections', async () => {
  const facts = await computeFacts({ family: 'intent', fixture: fixture('001-intent-field-clean') });
  assert.equal(facts.family, 'intent');
  assert.equal(facts.valid, true, JSON.stringify(facts.validationErrors));
  assert.deepEqual(codes(facts.findings), []);
  assert.deepEqual(facts.hosts, ['model', 'pages']);
  assert.equal(facts.template, 'field-standard');
  assert.ok(facts.planSections.includes('Bindings'));
  assert.ok(facts.planSections.includes('What will be verified'));
});

test('facts: generated source fixture reports source and feature gate findings', async () => {
  const facts = await computeFacts({ family: 'generated', fixture: fixture('026-generated-xrm-webapi'), hosts: ['model'] });
  assert.equal(facts.family, 'generated');
  assert.equal(facts.ok, false);
  assert.ok(codes(facts.errors).includes('PCF_CODE_XRM'));
  assert.ok(codes(facts.errors).includes('PCF_FEATURE_UNDECLARED'));
  assert.ok(!codes(facts.errors).includes('PCF_PAGES_VIRTUAL'));
});
