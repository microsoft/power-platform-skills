'use strict';

// The generated-project workflow is path-filtered. Its build entry point, pcf-ci-build.js, loads
// other plugin files at run time (copied model-apps helpers among them), so a change to any of them
// can change scaffolding, gating or packaging. Every file in that require closure must trigger the
// workflow, or a PR touching only that file merges without the template and recipe builds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'pcf-projects.yml');
const ENTRY = path.join(REPO_ROOT, 'plugins', 'pcf', 'scripts', 'pcf-ci-build.js');

function requireClosure(entry) {
  const pluginRoot = path.join(REPO_ROOT, 'plugins', 'pcf');
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // Relative requires only, as these scripts write them:
    //   require('./lib/pcf-build.js')   require('../vendor/cds-maker-sdk.cjs')   require('./xml-lite')
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const target = [base, `${base}.js`, `${base}.cjs`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (target && target.startsWith(pluginRoot + path.sep)) visit(target);
    }
    // Sibling scripts started as child processes count too, e.g. the gates:
    //   runNodeScript(path.join(SCRIPT_DIR, 'pcf-gates.js'), [...])
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/path\.join\(\s*SCRIPT_DIR\s*,\s*['"]([\w.-]+\.js)['"]\s*\)/g)) {
      const target = path.join(path.dirname(file), match[1]);
      if (fs.existsSync(target)) visit(target);
    }
  };
  visit(entry);
  return [...seen].map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/')).sort();
}

function pullRequestPathGlobs(workflowText) {
  // The pull_request `paths:` list, as the workflow writes it:
  //   pull_request:
  //       branches:
  //           - main
  //       paths:
  //           - "plugins/pcf/scripts/pcf-*.js"
  //           # a comment line
  const lines = workflowText.split(/\r?\n/);
  const start = lines.findIndex((line, i) => /^\s+paths:\s*$/.test(line) && lines.slice(0, i).some((l) => /^\s+pull_request:\s*$/.test(l)));
  assert.notEqual(start, -1, 'pcf-projects.yml must filter pull requests by path');
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (item) globs.push(item[1]);
    else if (!/^\s*(#.*)?$/.test(line)) break;
  }
  return globs;
}

function globToRegExp(glob) {
  // GitHub path filters: `**` crosses folders, `*` stays within one.
  const source = glob.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`);
}

test('pcf-projects runs for every file pcf-ci-build.js loads or starts', () => {
  const patterns = pullRequestPathGlobs(fs.readFileSync(WORKFLOW, 'utf8')).map(globToRegExp);
  const closure = requireClosure(ENTRY);
  assert.ok(closure.includes('plugins/pcf/scripts/pcf-gates.js'), 'the closure must follow the gates child process');
  assert.ok(closure.length > 5, `unexpectedly small require closure: ${closure.join(', ')}`);
  const missing = closure.filter((file) => !patterns.some((pattern) => pattern.test(file)));
  assert.deepEqual(missing, [], `add these to the pull_request paths of pcf-projects.yml: ${missing.join(', ')}`);
});
