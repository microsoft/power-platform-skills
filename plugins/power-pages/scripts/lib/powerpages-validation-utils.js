function addFinding(findings, severity, message, details = {}) {
  findings.push({ severity, message, ...details });
}

function findUnexpectedKeys(record, allowedKeys) {
  return Object.keys(record)
    .filter(key => key !== 'filePath' && !allowedKeys.has(key))
    .sort();
}

function findMissingKeys(record, requiredKeys) {
  return [...requiredKeys]
    .filter(key => record[key] === undefined)
    .sort();
}

function summarize(findings) {
  return findings.reduce((summary, finding) => {
    summary[finding.severity] += 1;
    return summary;
  }, { error: 0, warning: 0, info: 0 });
}

module.exports = {
  addFinding,
  findUnexpectedKeys,
  findMissingKeys,
  summarize,
};
