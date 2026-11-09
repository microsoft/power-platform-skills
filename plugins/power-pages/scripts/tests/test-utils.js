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

function createTempNonSpaSite(t) {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-declarative-'));
  t.after(() => fs.rmSync(siteRoot, { recursive: true, force: true }));

  for (const relativeDir of [
    '.portalconfig',
    'table-permissions',
    'site-settings',
    'web-roles',
    'web-files',
    'web-pages',
    'web-templates',
  ]) {
    fs.mkdirSync(path.join(siteRoot, relativeDir), { recursive: true });
  }
  fs.writeFileSync(
    path.join(siteRoot, 'website.yml'),
    'id: 11111111-1111-4111-8111-111111111111\nname: Non-SPA Test Site\n',
    'utf8'
  );

  return siteRoot;
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
  createTempNonSpaSite,
  writeProjectFile,
  findingMessages,
};
