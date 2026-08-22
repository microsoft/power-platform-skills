'use strict';

const RAW_PATTERNS = [
  { label: 'raw exception', pattern: /\b(?:Error|TypeError|ReferenceError|RangeError|SyntaxError):\s/i },
  { label: 'stack trace', pattern: /\bat\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*\([^\n]+:\d+:\d+\)/ },
  { label: 'unresolved value', pattern: /(?:^|\s)(?:undefined|null|\[object Object\])(?:$|\s)/i },
  { label: 'raw optionset integer', pattern: /\b100000\d{3}\b/ },
];

function run(snapshot) {
  const failures = [];
  for (const element of snapshot.elements) {
    if (!element.visible || !element.text.trim()) continue;
    for (const entry of RAW_PATTERNS) {
      if (entry.pattern.test(element.text)) {
        failures.push(`${element.testId || element.tag} exposes ${entry.label}: ${JSON.stringify(element.text)}`);
      }
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { RAW_PATTERNS, run };