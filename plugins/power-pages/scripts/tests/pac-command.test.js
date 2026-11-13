const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPac, PAC_LOG_TAIL_BYTES } = require('../lib/pac-command');

function options(t, output, extra = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-capture-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  return {
    tmpRoot,
    runCommand(command, args, opts) {
      assert.equal(opts.shell, false);
      fs.writeSync(opts.stdio[1], output);
    },
    ...extra,
  };
}

test('default PAC capture retains the existing bounded-tail behavior', (t) => {
  const output = 'first anchor\n' + 'x'.repeat(PAC_LOG_TAIL_BYTES) + '\nlast anchor';
  const result = runPac(['solution', 'list'], options(t, output));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, output.slice(-PAC_LOG_TAIL_BYTES));
});

test('opt-in full capture retains leading anchors and every verbose record', (t) => {
  const output = 'first anchor\n' + 'x'.repeat(PAC_LOG_TAIL_BYTES) + '\nlast anchor';
  const result = runPac(['solution', 'list'], options(t, output, { captureAll: true }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, output);
});

test('full capture retains failed command output without hiding the failure', (t) => {
  const output = 'details\n' + 'x'.repeat(PAC_LOG_TAIL_BYTES);
  const deps = options(t, output, { captureAll: true });
  const writeOutput = deps.runCommand;
  deps.runCommand = (...args) => {
    writeOutput(...args);
    throw Object.assign(new Error('PAC failed'), { status: 3 });
  };
  const result = runPac(['solution', 'list'], deps);
  assert.equal(result.status, 3);
  assert.equal(result.stderr, output);
  assert.equal(result.stdout, '');
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`PAC uses direct argument arrays on ${platform}`, (t) => {
    const args = ['pages', 'migrate-datamodel', '--webSiteId', 'site $name & (literal)'];
    const deps = options(t, 'result', { captureAll: true, platform });
    const writeOutput = deps.runCommand;
    deps.runCommand = (command, actual, opts) => {
      assert.equal(command, platform === 'win32' ? 'pac.exe' : 'pac');
      assert.deepEqual(actual, args);
      assert.equal(opts.shell, false);
      writeOutput(command, actual, opts);
    };
    assert.equal(runPac(args, deps).status, 0);
  });
}
