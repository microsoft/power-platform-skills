'use strict';

const { execFileSync } = require('child_process');
const { compareVersions } = require('./bump-solution-version');

function decideReinstall({ installed, installedVersion, zipVersion, detectionFailed } = {}) {
  if (detectionFailed) return 'ask';
  if (!installed) return 'import';
  if (!installedVersion || !zipVersion) return 'ask';
  if (compareVersions(zipVersion, installedVersion) > 0) return 'confirm-update';
  return 'offer-clone';
}

function readSolutionXml(zipPath, deps = {}) {
  const execFile = deps.execFileSync || execFileSync;
  // `unzip -p <solution.zip> solution.xml` returns the Dataverse solution
  // descriptor, which includes fields like:
  //   <UniqueName>contoso_template</UniqueName>
  //   <Version>1.0.0.0</Version>
  //   <Managed>0</Managed>
  // Tags can have surrounding whitespace/newlines, so extract by tag name
  // rather than relying on line positions.
  return execFile('unzip', ['-p', zipPath, 'solution.xml'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
}

function getTag(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'i'));
  return match ? match[1].trim() : null;
}

function inspectSolutionZip(zipPath, deps = {}) {
  try {
    const xml = deps.solutionXml || readSolutionXml(zipPath, deps);
    const uniqueName = getTag(xml, 'UniqueName');
    const version = getTag(xml, 'Version');
    const managed = getTag(xml, 'Managed');
    if (!uniqueName || !version) {
      return { ok: false, error: 'solution.xml did not include UniqueName and Version' };
    }
    return { ok: true, uniqueName, version, managed: managed === '1' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { decideReinstall, readSolutionXml, inspectSolutionZip };
