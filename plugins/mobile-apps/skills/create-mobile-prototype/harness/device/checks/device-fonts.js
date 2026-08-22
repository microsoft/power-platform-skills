'use strict';

function run(evidence, contract) {
  const probes = contract?.fonts;
  if (!Array.isArray(probes)) return { pass: false, notRun: true, failures: ['device contract has no fonts array'] };
  if (probes.length < 2 || !['heading', 'body'].every((role) => probes.some((probe) => probe.role === role && probe.family && probe.id))) {
    return { pass: false, notRun: true, failures: ['heading and body font probes with resolved families are required'] };
  }
  if (!evidence?.executed) return { pass: false, notRun: true, failures: [evidence?.reason || 'native font flow did not run'] };
  if (evidence.exitCode !== 0) return { pass: false, failures: [`native font flow failed: ${evidence.output || `exit ${evidence.exitCode}`}`] };
  if (!evidence.screenshot) return { pass: false, notRun: true, failures: ['native font screenshot is missing'] };
  return { pass: true, failures: [], report: { families: Object.fromEntries(probes.map((probe) => [probe.role, probe.family])), screenshot: evidence.screenshot } };
}

module.exports = { run };
