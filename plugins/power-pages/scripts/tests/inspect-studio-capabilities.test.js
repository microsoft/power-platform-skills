'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./style-site-fixtures');
const { main } = require('../../skills/style-site/scripts/inspect-studio-capabilities');

const script = path.resolve(__dirname, '../../skills/style-site/scripts/inspect-studio-capabilities.js');

test('CLI looks up only requested properties without dumping the reference', () => {
  const result = spawnSync(process.execPath, [script, '--component', 'Button', '--properties', 'text-shadow,text-align,background-color'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.properties.map((entry) => entry.status), ['unsupported', 'unsupported', 'supported']);
  assert.equal(report.truncated, false);
  assert.ok(Buffer.byteLength(result.stdout) <= 4096);
  assert.equal(main(['--component', 'Text', '--properties', 'gap', '--flex', 'available']).properties[0].status, 'supported');
});

test('batch lookup reports unknown and conditional support without rewriting a request', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { studioComponent: 'Text', declarations: { gap: '8px' } });
  const file = path.join(f.work, 'request.json');
  const content = JSON.stringify(f.request);
  fs.writeFileSync(file, content);
  const result = main(['--request', file]);
  assert.equal(result.assessments[0].properties[0].status, 'conditional');
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.throws(() => main(['--request', file, '--component', 'Text']), /not both/);
});

test('invalid lookup arguments fail explicitly', () => {
  assert.throws(() => main([]), /Usage/);
  assert.throws(() => main(['--component', 'Text', '--properties', 'gap,']), /non-empty/);
  assert.throws(() => main(['--component', 'Text', '--properties', 'gap', '--flex', 'yes']), /availability/);
  const result = spawnSync(process.execPath, [script, '--component', 'Text'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Studio capabilities: Usage/);
});
