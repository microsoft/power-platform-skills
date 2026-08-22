'use strict';

function run(evidence, contract) {
  const forms = contract?.forms;
  if (!Array.isArray(forms)) return { pass: false, notRun: true, failures: ['device contract has no forms array'] };
  if (forms.length === 0) return { pass: true, failures: [], report: { applicable: false, reason: 'app has no form screens' } };
  if (!forms.every((form) => form.route && form.inputId && form.ctaId)) return { pass: false, notRun: true, failures: ['every form requires route, inputId, and ctaId'] };
  if (!evidence?.executed) return { pass: false, notRun: true, failures: [evidence?.reason || 'native keyboard flow did not run'] };
  if (evidence.exitCode !== 0) return { pass: false, failures: [`native keyboard/CTA flow failed: ${evidence.output || `exit ${evidence.exitCode}`}`] };
  if (!evidence.screenshot) return { pass: false, notRun: true, failures: ['keyboard-open CTA screenshot is missing'] };
  return { pass: true, failures: [], report: { applicable: true, forms: forms.map((form) => form.id), screenshot: evidence.screenshot } };
}

module.exports = { run };
