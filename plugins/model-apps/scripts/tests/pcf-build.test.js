'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const {
  findControlProject,
  buildControl,
  bundleFindings,
  classifyOutputFiles,
} = require('../lib/pcf-build.js');

const cliPath = path.join(__dirname, '..', 'pcf-build.js');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-build-test-'));
  fs.writeFileSync(path.join(dir, 'Control.pcfproj'), '<Project />');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"control"}\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pcf-scripts', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pcf-scripts', 'package.json'), JSON.stringify({
    name: 'pcf-scripts',
    bin: { 'pcf-scripts': 'bin/pcf-scripts.js' },
  }));
  const bin = path.join(dir, 'node_modules', 'pcf-scripts', 'bin', 'pcf-scripts.js');
  fs.writeFileSync(bin, 'console.log("pcf-scripts");\n');

  const controlDir = path.join(dir, 'Controls', 'Star');
  fs.mkdirSync(path.join(controlDir, 'strings'), { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.Input.xml'), manifestXml('index.ts'));
  fs.writeFileSync(path.join(controlDir, 'index.ts'), 'export class Control {}\n');
  fs.writeFileSync(path.join(dir, 'pcfconfig.json'), JSON.stringify({ outDir: 'dist/controls' }));
  return { dir, controlDir, bin };
}

function manifestXml(codePath) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<manifest>
  <control namespace="Contoso.Controls" constructor="Star" version="1.0.0" display-name-key="Star" description-key="Star">
    <resources>
      <code path="${codePath}" order="1" />
      <css path="css/control.css" order="1" />
      <resx path="strings/Control.1033.resx" version="1.0.0" />
      <img path="img/icon.svg" />
    </resources>
  </control>
</manifest>`;
}

function writeBuiltControl(projectDir, { bundleBytes = 128, extraFiles = true } = {}) {
  const out = path.join(projectDir, 'dist', 'controls', 'Star');
  fs.mkdirSync(path.join(out, 'css'), { recursive: true });
  fs.mkdirSync(path.join(out, 'strings'), { recursive: true });
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  fs.writeFileSync(path.join(out, 'ControlManifest.xml'), manifestXml('bundle.js'));
  fs.writeFileSync(path.join(out, 'bundle.js'), Buffer.alloc(bundleBytes, 1));
  fs.writeFileSync(path.join(out, 'bundle.js.LICENSE.txt'), 'license\n');
  fs.writeFileSync(path.join(out, 'css', 'control.css'), 'body{}\n');
  fs.writeFileSync(path.join(out, 'strings', 'Control.1033.resx'), '<root />\n');
  fs.writeFileSync(path.join(out, 'strings', 'Control.1036.resx'), '<root />\n');
  fs.writeFileSync(path.join(out, 'img', 'icon.svg'), '<svg />\n');
  fs.writeFileSync(path.join(out, 'preview.png'), 'png\n');
  if (extraFiles) fs.writeFileSync(path.join(out, 'debug.map'), '{}\n');
}

test('buildControl runs pcf-scripts build through node with shell-free production argv', () => {
  const { dir, bin } = tempProject();
  const calls = [];
  try {
    const result = buildControl({ projectDir: dir }, {
      fs,
      resolvePackageBin: () => bin,
      runNodeScript: (scriptPath, args, opts) => {
        calls.push({ scriptPath, args, opts });
        writeBuiltControl(dir);
        return { status: 0, stdout: 'built', stderr: '' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scriptPath, bin);
    assert.deepEqual(calls[0].args, ['build', '--buildMode', 'production']);
    assert.equal(calls[0].opts.cwd, dir);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(result.controls.length, 1);
    assert.equal(result.controls[0].bundleBytes, 128);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildControl cleans old output and classifies unexplained files without rejecting localized/legal/preview sidecars', () => {
  const { dir, bin } = tempProject();
  const stale = path.join(dir, 'dist', 'controls', 'Star', 'bundle.js.LICENSE.txt');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'stale\n');

  try {
    const result = buildControl({ projectDir: dir, clean: true }, {
      fs,
      resolvePackageBin: () => bin,
      runNodeScript: () => {
        assert.equal(fs.existsSync(stale), false);
        writeBuiltControl(dir);
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const control = result.controls[0];
    assert.equal(control.files.find((item) => item.path.endsWith('strings/Control.1036.resx') || item.path.endsWith('strings\\Control.1036.resx')).classification, 'localizedResx');
    assert.equal(control.files.find((item) => item.path.endsWith('bundle.js.LICENSE.txt')).classification, 'legalSidecar');
    assert.equal(control.files.find((item) => item.path.endsWith('preview.png')).classification, 'previewImage');
    assert.deepEqual(control.unexplained.map((item) => path.basename(item.path)), ['debug.map']);
    assert.ok(bundleFindings(result, { bundle: { webpackDefaultMaxBytes: 5 * 1024 * 1024, warnAtFraction: 0.8 } })
      .some((finding) => finding.code === 'PCF_OUT_UNEXPLAINED_FILE' && /debug\.map/.test(finding.message) && /remove|declare|exclude/i.test(finding.fix)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildControl refuses absolute, parent, and project-root outDir values without deleting sentinels', () => {
  for (const item of ['absolute outDir', 'parent sibling outDir', 'project root outDir']) {
    const { dir, bin } = tempProject();
    const parentSibling = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    const absoluteOut = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-build-absolute-out-'));
    const outDir = item === 'absolute outDir' ? absoluteOut : item === 'parent sibling outDir' ? '../x' : '.';
    const resolvedTarget = item === 'absolute outDir'
      ? absoluteOut
      : item === 'parent sibling outDir'
        ? path.resolve(dir, '..', 'x')
        : dir;
    fs.mkdirSync(item === 'parent sibling outDir' ? resolvedTarget : path.dirname(resolvedTarget), { recursive: true });
    const sentinel = path.join(resolvedTarget, 'sentinel.txt');
    fs.writeFileSync(sentinel, item);
    fs.writeFileSync(path.join(dir, 'pcfconfig.json'), JSON.stringify({ outDir }));

    try {
      const result = buildControl({ projectDir: dir, clean: true }, {
        fs,
        resolvePackageBin: () => bin,
        runNodeScript: () => {
          throw new Error('build must not run for unsafe outDir');
        },
      });

      assert.equal(result.ok, false, item);
      assert.match(result.error, /pcfconfig\.json outDir/i);
      assert.match(result.error, /inside the PCF project/i);
      assert.match(result.error, new RegExp(escapeRegExp(String(outDir))));
      assert.equal(fs.readFileSync(sentinel, 'utf8'), item);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(absoluteOut, { recursive: true, force: true });
      fs.rmSync(parentSibling, { recursive: true, force: true });
      fs.rmSync(path.resolve(dir, '..', 'x'), { recursive: true, force: true });
    }
  }
});

test('classifyOutputFiles is reusable without reading a project build directory', () => {
  const resources = {
    code: [{ path: 'bundle.js' }],
    css: [{ path: 'css/control.css' }],
    resx: [{ path: 'strings/Control.1033.resx' }],
    img: [{ path: 'img/icon.svg' }],
  };

  const classified = classifyOutputFiles(resources, [
    { path: 'bundle.js', bytes: 100 },
    { path: 'strings/Control.1036.resx', bytes: 10 },
    { path: 'preview.png', bytes: 10 },
    { path: 'bundle.js.LICENSE.txt', bytes: 10 },
    { path: 'diagnostics.json', bytes: 10 },
  ]);

  assert.deepEqual(classified.map((item) => [item.path, item.classification]), [
    ['bundle.js', 'explicit'],
    ['strings/Control.1036.resx', 'localizedResx'],
    ['preview.png', 'previewImage'],
    ['bundle.js.LICENSE.txt', 'legalSidecar'],
    ['diagnostics.json', 'unexplained'],
  ]);
});

test('pcf-build emits JSON on stdout when a non-usage runtime failure is thrown', async () => {
  const cli = loadCli(cliPath, {
    argv: ['--project', 'D:\\tmp\\pcf-project'],
    requires: {
      './lib/pcf-build': {
        findControlProject: () => ({ projectDir: 'D:\\tmp\\pcf-project', pcfproj: 'Control.pcfproj', manifests: ['ControlManifest.Input.xml'], packageJson: 'package.json' }),
        buildControl: () => { throw new Error('boom from build'); },
        bundleFindings: () => [],
      },
      './lib/pcf-matrix': {
        loadMatrix: () => ({ bundle: { webpackDefaultMaxBytes: 5 * 1024 * 1024, warnAtFraction: 0.8 } }),
      },
    },
  });

  try {
    await cli.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /boom from build/);
  assert.match(cli.stderrText(), /boom from build/);
});

test('bundleFindings reports over-limit and near-limit bundles with both upload limits named', () => {
  const matrix = { bundle: { webpackDefaultMaxBytes: 5 * 1024 * 1024, warnAtFraction: 0.8 } };

  const over = bundleFindings({ ok: true, mode: 'production', controls: [{ bundleBytes: 6 * 1024 * 1024, unexplained: [], manifestPath: 'ControlManifest.xml' }] }, matrix);
  assert.ok(over.some((finding) => finding.code === 'PCF_BUNDLE_OVER_LIMIT' && finding.severity === 'error'));
  assert.match(over[0].message, /5 MiB webpack default/i);
  assert.match(over[0].message, /MaxUploadFileSize/i);
  assert.match(over[0].fix, /reduce|split|upload/i);

  const near = bundleFindings({ ok: true, mode: 'production', controls: [{ bundleBytes: Math.floor(4.5 * 1024 * 1024), unexplained: [], manifestPath: 'ControlManifest.xml' }] }, matrix);
  assert.ok(near.some((finding) => finding.code === 'PCF_BUNDLE_NEAR_LIMIT' && finding.severity === 'warning'));
});

test('findControlProject walks up from a nested folder to the nearest pcfproj root', () => {
  const { dir } = tempProject();
  const nested = path.join(dir, 'Controls', 'Star', 'src', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  try {
    const found = findControlProject(nested);
    assert.equal(found.projectDir, dir);
    assert.equal(path.basename(found.pcfproj), 'Control.pcfproj');
    assert.equal(found.manifests.length, 1);
    assert.equal(found.packageJson, path.join(dir, 'package.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
