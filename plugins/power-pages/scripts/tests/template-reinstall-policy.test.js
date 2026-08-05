'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { decideReinstall, inspectSolutionZip } = require('../lib/template-reinstall-policy');
const { compareVersions } = require('../lib/bump-solution-version');
const { parseArgs, run } = require('../inspect-template-solution');

function fakeZipWithFile(name, content, method = 0) {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  return Buffer.concat([local, nameBytes, data, central, nameBytes]);
}

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

test('inspectSolutionZip reads solution.xml directly from zip bytes without unzip', () => {
  const xml = `
<ImportExportXml>
  <SolutionManifest>
    <UniqueName>contoso_template</UniqueName>
    <Version>1.2.3.4</Version>
    <Managed>0</Managed>
  </SolutionManifest>
</ImportExportXml>`;

  assert.deepEqual(inspectSolutionZip('/tmp/template.zip', {
    fs: { readFileSync: () => fakeZipWithFile('solution.xml', xml, 8) },
  }), {
    ok: true,
    uniqueName: 'contoso_template',
    version: '1.2.3.4',
    managed: false,
  });
});

test('inspectSolutionZip reports corrupt or unreadable solution.xml as ok:false', () => {
  assert.deepEqual(inspectSolutionZip('/tmp/template.zip', {
    fs: { readFileSync: () => { throw new Error('not a zip'); } },
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
