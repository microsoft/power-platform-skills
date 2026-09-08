'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..', '..');
const runtimePath = path.join(pluginRoot, 'assets', 'self-contained', 'mcp-app-runtime.min.js');
const provenancePath = path.join(pluginRoot, 'assets', 'self-contained', 'PROVENANCE.json');
const templatePath = path.join(pluginRoot, 'samples', 'self-contained-widget.template.html');
const composerPath = path.join(pluginRoot, 'scripts', 'inline-self-contained-runtime.js');
const cdnSamplePath = path.join(pluginRoot, 'samples', 'weather-refresh-widget.html');
const skillPath = path.join(pluginRoot, 'skills', 'generate-mcp-app-ui', 'SKILL.md');
const {
  RUNTIME_MARKER,
  assertNoExternalResources,
  inlineRuntime,
  prepareDraft,
} = require('../inline-self-contained-runtime.js');

test('vendored runtime matches provenance and exposes the stable global', () => {
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const digest = crypto.createHash('sha256').update(runtime).digest('hex');

  assert.equal(digest, provenance.sha256);
  assert.equal(provenance.packages['@modelcontextprotocol/ext-apps'].version, '1.7.5');
  assert.equal(provenance.packages['@fluentui/tokens'].version, '1.0.0-alpha.22');
  assert.match(runtime, /globalThis\.McpAppsRuntime/);
  assert.match(runtime, /Self-contained MCP Apps runtime third-party licenses/);
  for (const packageName of provenance.licensePackagesEmbeddedInArtifact) {
    assert.match(runtime, new RegExp(packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(runtime, /<\/script/i);
  assert.doesNotMatch(runtime, /\bimport\s*(?:\(|[^;\n]*?\bfrom\s*)["']/);

  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(runtime, context);
  assert.equal(typeof context.McpAppsRuntime.App, 'function');
  assert.ok(Object.keys(context.McpAppsRuntime.webLightTheme).length > 100);
  assert.ok(Object.keys(context.McpAppsRuntime.webDarkTheme).length > 100);
});

test('third-party license texts are committed for bundled packages', () => {
  const licenseDir = path.join(pluginRoot, 'assets', 'self-contained', 'licenses');
  for (const file of [
    'fluentui-tokens.txt',
    'modelcontextprotocol-ext-apps.txt',
    'modelcontextprotocol-sdk.txt',
    'standard-schema-spec.txt',
    'swc-helpers.txt',
    'zod.txt',
  ]) {
    const text = fs.readFileSync(path.join(licenseDir, file), 'utf8');
    assert.ok(text.length > 500, `${file} should contain the distributed license text`);
  }
});

test('composer creates one HTML file with an embedded runtime and no public resources', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-widget-'));
  const outputPath = path.join(tempDir, 'widget.html');
  try {
    const result = spawnSync(process.execPath, [
      composerPath,
      '--input',
      templatePath,
      '--output',
      outputPath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const output = fs.readFileSync(outputPath, 'utf8');
    assert.ok(output.startsWith('<!DOCTYPE html>'));
    assert.doesNotMatch(output, new RegExp(RUNTIME_MARKER));
    assert.match(output, /MCP_APPS_EMBEDDED_RUNTIME_START/);
    assert.match(output, /globalThis\.McpAppsRuntime/);
    assert.equal((output.match(/<script type="module">/g) || []).length, 1);
    assert.ok(output.length > fs.statSync(runtimePath).size);
    assertNoExternalResources(prepareDraft(output));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('embedded widgets can be prepared and re-inlined without editing vendor bytes', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  const firstOutput = inlineRuntime(template, runtime);
  const prepared = prepareDraft(firstOutput);
  const secondOutput = inlineRuntime(prepared, runtime);

  assert.match(prepared, new RegExp(RUNTIME_MARKER));
  assert.doesNotMatch(prepared, /MCP_APPS_EMBEDDED_RUNTIME_START/);
  assert.equal(secondOutput, firstOutput);
});

test('composer fails closed for missing or duplicate markers', () => {
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  assert.throws(
    () => inlineRuntime('<!DOCTYPE html><script type="module"></script>', runtime),
    /Expected exactly one/,
  );
  assert.throws(
    () => inlineRuntime(`${RUNTIME_MARKER}${RUNTIME_MARKER}<script type="module"></script>`, runtime),
    /found 2/,
  );
});

test('self-contained validation rejects remote runtime and resource loading', () => {
  for (const html of [
    '<script src="https://cdn.example/app.js"></script>',
    '<script src=https://cdn.example/app.js></script>',
    '<script src="./runtime.js"></script>',
    '<link rel="stylesheet" href="https://cdn.example/app.css">',
    '<img src="https://cdn.example/map.png">',
    '<img srcset="data:image/gif;base64,x 1x, https://cdn.example/map.png 2x">',
    '<script type="module">import { App } from "https://cdn.example/app.js";</script>',
    '<script type="module">import App from "./local-runtime.js";</script>',
    '<script type="module">import "//cdn.example/register.js";</script>',
    '<script type="module">import "./local-runtime.js";</script>',
    '<style>.map { background: url(https://cdn.example/tile.png); }</style>',
    '<style>.map { background: url(./tile.png); }</style>',
    '<script>fetch("https://cdn.example/data.json")</script>',
    '<script>fetch(endpoint)</script>',
  ]) {
    assert.throws(() => assertNoExternalResources(html), /external|disallowed/);
  }
});

test('CDN sample and skill retain an explicit opt-in path', () => {
  const sample = fs.readFileSync(cdnSamplePath, 'utf8');
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert.match(sample, /import \{ App \} from 'https:\/\/cdn\.jsdelivr\.net\//);
  assert.match(sample, /https:\/\/unpkg\.com\/@fluentui\/web-components/);
  assert.match(skill, /No CDNs \/ self-contained \(recommended\)/);
  assert.match(skill, /CDNs allowed/);
  assert.match(skill, /Do not silently choose CDN mode/);
});

test('eval suite covers both delivery modes', () => {
  const evalPath = path.resolve(pluginRoot, '..', '..', 'evals', 'mcp-apps', 'generate-mcp-app-ui', 'evals.json');
  const suite = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  const modes = new Set(suite.evals.map((entry) => entry.delivery_mode).filter(Boolean));

  assert.deepEqual([...modes].sort(), ['cdn', 'self-contained']);
  assert.ok(Array.isArray(suite.mode_assertions['self-contained']));
  assert.ok(Array.isArray(suite.mode_assertions.cdn));
});
