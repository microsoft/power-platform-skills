'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ASSERTIONS } = require('../lib/assertions-layer-2.js');
const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');

const COMPLETE = 'Generated .tsx passes the production completeness gate (complete module, JSX, brackets, strings, comments and no prose fences)';
const WORKER = 'Phase 5: A rejected worker artifact prevents upload until a stamped, complete regeneration passes the production gate';
const good = 'const GeneratedComponent = () => <div>Complete</div>;\nexport default GeneratedComponent;\n';

test('a valid export does not hide a truncated module', () => {
  const check = ASSERTIONS.get(COMPLETE);
  assert.equal(typeof check, 'function', 'production completeness scorer must be registered');
  const score = (content) => check({ files: [{ name: 'page.tsx', content }] });
  const captured = fs.readFileSync(path.join(__dirname, '..', 'fixtures', '17-weather-mock-data', 'weather-dashboard.tsx'), 'utf8');
  assert.equal(score(captured).status, 'pass');
  assert.equal(score(`${captured}\nconst unfinished = (`).status, 'fail');
  assert.equal(score(good).status, 'pass');
  for (const tail of ['const unfinished = (', 'const total = count *', 'const label = "unfinished', 'const label = `unfinished', '/* unfinished', 'const el = <div>unfinished']) {
    assert.equal(score(good + tail).status, 'fail', tail);
  }
  for (const code of ['```tsx\n' + good + '```\n', '~~~tsx\n' + good + '~~~\n', 'The worker should write export default GeneratedComponent here.\n', 'export default function GeneratedComponent(props: Props)']) {
    assert.equal(score(code).status, 'fail', code);
  }
  assert.equal(score('const help = `\n~~~md\nx\n~~~\n`;\n' + good).status, 'pass', 'a data fence is not a prose module');
});

function workerFixture() {
  const bad = good + 'const unfinished = (';
  return {
    contractVersion: 2,
    manifest: { worker: { targets: ['page.tsx'] } },
    files: [{ name: 'page.tsx', content: good }],
    artifacts: { 'attempts/truncated.tsx': bad, 'attempts/complete.tsx': good },
    events: [
      { id: 'stamp-1', command: 'node genpage-worker-output.js --stamp --file page.tsx', result: { ok: true, action: 'stamp', existed: false } },
      { id: 'write-1', command: 'Write page.tsx', artifact: 'attempts/truncated.tsx' },
      { id: 'gate-1', command: 'node genpage-worker-output.js --file page.tsx', artifact: 'attempts/truncated.tsx', result: { ok: false, problems: ['unbalanced brackets \u2014 the file looks truncated'] } },
      { id: 'stamp-2', command: 'node genpage-worker-output.js --stamp --file page.tsx', result: { ok: true, action: 'stamp', existed: true } },
      { id: 'write-2', command: 'Write page.tsx', artifact: 'attempts/complete.tsx' },
      { id: 'gate-2', command: 'node genpage-worker-output.js --file page.tsx', artifact: 'attempts/complete.tsx', result: { ok: true, problems: [] } },
      { id: 'upload', command: 'node genpage-upload.js --code-file page.tsx', result: { ok: true } },
    ],
  };
}

test('worker rejection requires fresh regeneration before the actual uploaded bytes are accepted', () => {
  const check = PHASE_EXPECTATIONS.get(WORKER);
  assert.equal(typeof check, 'function', 'worker lifecycle scorer must be registered');
  assert.equal(check({ fixture: workerFixture() }).status, 'pass');
  for (const mutate of [
    (fixture) => { fixture.events.splice(3, 0, fixture.events.at(-1)); },
    (fixture) => { fixture.events = fixture.events.filter((event) => event.id !== 'gate-2'); },
    (fixture) => { fixture.events = fixture.events.filter((event) => event.id !== 'write-2'); },
    (fixture) => { fixture.events = fixture.events.filter((event) => event.id !== 'stamp-2'); },
    (fixture) => { fixture.events[2].result = { ok: true, problems: [] }; },
    (fixture) => { fixture.events[5].artifact = 'attempts/truncated.tsx'; },
    (fixture) => { fixture.files[0].content += 'const unfinished = ('; },
    (fixture) => { fixture.events[0].result.ok = false; },
  ]) {
    const fixture = workerFixture();
    mutate(fixture);
    assert.equal(check({ fixture }).status, 'fail');
  }
});
