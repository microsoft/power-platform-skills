'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runPreflight } = require('../ai-preflight.js');

test('runPreflight lists features and produces admin actions for disabled ones', () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: false, setting: 'NLChartVisualizationSetting', value: 'false' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: false, setting: 'm365copilotmodelappenabled', value: '0' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.features.length, 5);
  assert.ok(r.features.find((f) => f.feature === 'nlSearch').enabled === true);
  assert.ok(r.adminActions.length === 3); // formFill, nlChart, m365 disabled
  assert.ok(r.adminActions.some((a) => /form.?fill/i.test(a)));
});

test('runPreflight returns no admin actions when all features are enabled', () => {
  const readiness = {
    formFill: { enabled: true, setting: 'FormFillBarUXEnabled', value: '1' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.features.length, 5);
  assert.strictEqual(r.adminActions.length, 0);
});

test('runPreflight summaries admin action mentions AI insight cards', () => {
  const readiness = {
    formFill: { enabled: true, setting: 'FormFillBarUXEnabled', value: '1' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: false, setting: 'EnableFormInsights', value: 'false' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.adminActions.length, 1);
  assert.ok(/ai insight cards/i.test(r.adminActions[0]), 'summaries action mentions "AI insight cards"');
});

test('runPreflight features include feature name, enabled flag, and setting', () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  const ff = r.features.find((f) => f.feature === 'formFill');
  assert.ok(ff, 'formFill feature present');
  assert.strictEqual(ff.enabled, false);
  assert.strictEqual(ff.setting, 'FormFillBarUXEnabled');
});
