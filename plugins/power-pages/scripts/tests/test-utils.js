const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempProject(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-validator-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  for (const relativeDir of [
    '.powerpages-site/table-permissions',
    '.powerpages-site/site-settings',
    '.powerpages-site/web-roles',
  ]) {
    fs.mkdirSync(path.join(projectRoot, relativeDir), { recursive: true });
  }

  return projectRoot;
}

function writeProjectFile(projectRoot, relativePath, content) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function findingMessages(findings) {
  return findings.map(finding => finding.message);
}

module.exports = {
  createTempProject,
  writeProjectFile,
  findingMessages,
};
