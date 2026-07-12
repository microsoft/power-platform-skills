'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideReinstall, inspectSolutionZip } = require('../lib/template-reinstall-policy');
const { compareVersions } = require('../lib/bump-solution-version');
const { parseArgs, run } = require('../inspect-template-solution');

test('compareVersions orders dotted Dataverse solution versions numerically', () => {
  assert.equal(compareVersions('1.0.1.0', '1.0.0.9'), 1);
  assert.equal(compareVersions('1.0.0.0', '1.0.0.0'), 0);
  assert.equal(compareVersions('1.0.0.0', '1.0.0.1'), -1);
});

test('decideReinstall covers import, update, clone, and ask cases', () => {
  const cases = [
    [{ installed: false, zipVersion: '1.0.0.0' }, 'import'],
    [{ installed: true, installedVersion: '1.0.0.0', zipVersion: '1.0.1.0' }, 'confirm-update'],
    [{ installed: true, installedVersion: '1.0.1.0', zipVersion: '1.0.0.0' }, 'offer-clone'],
    [{ installed: true, installedVersion: null, zipVersion: '1.0.0.0' }, 'ask'],
    [{ detectionFailed: true }, 'ask'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(decideReinstall(input), expected);
  }
});

test('inspectSolutionZip extracts unique name, version, and managed flag from solution.xml', () => {
  const xml = `
<ImportExportXml>
  <SolutionManifest>
    <UniqueName>contoso_template</UniqueName>
    <Version>1.2.3.4</Version>
    <Managed>0</Managed>
  </SolutionManifest>
</ImportExportXml>`;

  assert.deepEqual(inspectSolutionZip('/tmp/template.zip', { solutionXml: xml }), {
    ok: true,
    uniqueName: 'contoso_template',
    version: '1.2.3.4',
    managed: false,
  });

});

test('inspectSolutionZip reports corrupt or unreadable solution.xml as ok:false', () => {
  assert.deepEqual(inspectSolutionZip('/tmp/template.zip', {
    execFileSync: () => { throw new Error('not a zip'); },
  }), { ok: false, error: 'not a zip' });
  assert.deepEqual(inspectSolutionZip('/tmp/template.zip', {
    solutionXml: '<SolutionManifest><UniqueName>missing_version</UniqueName></SolutionManifest>',
  }), { ok: false, error: 'solution.xml did not include UniqueName and Version' });
});

test('inspect-template-solution CLI parser and runner return decision when installed state is supplied', () => {
  assert.deepEqual(parseArgs(['--zipPath', '/tmp/template.zip', '--installed', 'true', '--installedVersion', '1.0.0.0']), {
    zipPath: '/tmp/template.zip',
    installed: true,
    installedVersion: '1.0.0.0',
  });
  assert.equal(run([]).ok, false);
});
