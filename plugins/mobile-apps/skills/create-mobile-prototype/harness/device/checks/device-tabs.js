'use strict';

function run(evidence, contract) {
  const tabs = contract?.tabs;
  if (!Array.isArray(tabs)) return { pass: false, notRun: true, failures: ['device contract has no tabs array'] };
  if (tabs.length === 0) return { pass: true, failures: [], report: { applicable: false, reason: 'app has no tab navigation' } };
  if (!tabs.every((tab) => tab.id && tab.label)) return { pass: false, notRun: true, failures: ['every planned tab requires an id and label'] };
  if (!evidence?.executed) return { pass: false, notRun: true, failures: [evidence?.reason || 'native tab flow did not run'] };
  if (evidence.exitCode !== 0) return { pass: false, failures: [`native tab visibility flow failed: ${evidence.output || `exit ${evidence.exitCode}`}`] };
  if (!evidence.screenshot) return { pass: false, notRun: true, failures: ['native tab screenshot is missing'] };
  return { pass: true, failures: [], report: { applicable: true, tabs: tabs.map((tab) => tab.id), screenshot: evidence.screenshot } };
}

module.exports = { run };
