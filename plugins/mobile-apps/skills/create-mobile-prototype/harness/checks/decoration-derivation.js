'use strict';

function run(snapshot) {
  const decorations = snapshot.elements.filter((element) => element.visible && /^decoration:/.test(element.testId));
  const failures = [];
  for (const decoration of decorations) {
    const source = decoration.attributes?.['data-derived-from'] || '';
    if (!/^(?:record|aggregate|state|media):[A-Za-z][A-Za-z0-9_.-]*$/.test(source)) failures.push(`${decoration.testId} has no record, aggregate, state, or media derivation source`);
  }
  return { pass: failures.length === 0, failures, report: { applicable: decorations.length > 0, decorations: decorations.length } };
}

module.exports = { run };