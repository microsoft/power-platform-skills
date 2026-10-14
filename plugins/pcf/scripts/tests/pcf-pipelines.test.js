'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PIPELINES = path.join(ROOT, 'pipelines');

function read(name) {
  return fs.readFileSync(path.join(PIPELINES, name), 'utf8');
}

function assertOrdered(text, labels) {
  let at = -1;
  for (const label of labels) {
    const next = text.indexOf(label, at + 1);
    assert.ok(next > at, `${label} should appear after previous pipeline step`);
    at = next;
  }
}

function assertNoInlineSecrets(text) {
  assert.doesNotMatch(text, /(client[_-]?secret|password|tenant[_-]?id|app[_-]?id)\s*:\s*['"]?[A-Za-z0-9_.~+/=-]{8,}/i);
  assert.doesNotMatch(text, /https:\/\/org[0-9a-f]{8}\.crm/i);
}

function expandPaths(text, variables) {
  return text
    .replace(/\$\{\{\s*env\.([A-Za-z_]+)\s*\}\}/g, (match, name) => variables[name] ?? match)
    .replace(/\$\(([A-Za-z_.]+)\)/g, (match, name) => variables[name] ?? match)
    .replace(/\$\{([A-Za-z_]+)\}|\$([A-Za-z_]+)/g, (match, braced, plain) => variables[braced || plain] ?? match);
}

function githubSolutionPaths(text, solutionName) {
  const variables = { SOLUTION_NAME: solutionName };
  // Accept both "SOLUTION_PROJECT: build/..." and SOLUTION_PROJECT="build/$SOLUTION_NAME".
  // Capturing through LF and trimming keeps CRLF checkouts equivalent without changing the paths.
  for (const match of text.matchAll(/^\s*(SOLUTION_PROJECT|SOLUTION_ZIP)(?:=|:\s*)([^\n]+)/gm)) {
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    variables[match[1]] = expandPaths(value, variables);
  }
  return variables;
}

test('GitHub Actions uses a non-default solution name in every solution path', () => {
  const text = read('github-actions.yml');
  const name = 'FabrikamWidgetControls';
  const paths = githubSolutionPaths(text, name);
  const project = `build/${name}`;
  const zip = `${project}/bin/Release/${name}_managed.zip`;

  assert.equal(paths.SOLUTION_PROJECT, project);
  assert.equal(paths.SOLUTION_ZIP, zip);
  const expanded = expandPaths(text, paths);
  assert.match(expanded, new RegExp(`mkdir -p "\\$\\(dirname "${project}"\\)"`));
  assert.match(expanded, new RegExp(`pac solution init[^\\n]+--outputDirectory "${project}"`));
  assert.ok(expanded.includes(`cd "${project}"`));
  assert.ok(expanded.includes(`path: ${zip}`));
  assert.ok(expanded.includes(`solution-file: ${zip}`));
  assert.equal((text.match(/ContosoPcfControls/g) || []).length, 1, 'only the default name declaration may use the default solution name');
  assert.match(text, /SOLUTION_PROJECT=.*\r?\n[\s\S]*SOLUTION_PROJECT[^\n]*GITHUB_ENV/);
  assert.match(text, /SOLUTION_ZIP=.*\r?\n[\s\S]*SOLUTION_ZIP[^\n]*GITHUB_ENV/);
});

test('Azure DevOps uses a non-default solution name in every solution path', () => {
  const text = read('azure-devops.yml');
  const name = 'FabrikamWidgetControls';
  const variables = { SolutionName: name, 'Build.ArtifactStagingDirectory': 'staging' };
  for (const match of text.matchAll(/^\s*(SolutionProject|SolutionZip):\s*'([^']+)'/gm)) {
    variables[match[1]] = expandPaths(match[2], variables);
  }
  const project = `staging/${name}`;
  const zip = `${project}/bin/Release/${name}_managed.zip`;
  assert.equal(variables.SolutionProject, project);
  assert.equal(variables.SolutionZip, zip);
  const expanded = expandPaths(text, variables);
  assert.match(expanded, new RegExp(`mkdir -p "\\$\\(dirname "${project}"\\)"`));
  assert.match(expanded, new RegExp(`pac solution init[^\\n]+--outputDirectory "${project}"`));
  assert.ok(expanded.includes(`cd "${project}"`));
  assert.ok(expanded.includes(`publish: '${zip}'`));
  assert.ok(expanded.includes(`SolutionInputFile: '${zip}'`));
  assert.equal((text.match(/ContosoPcfControls/g) || []).length, 1, 'only the default name declaration may use the default solution name');
});

test('GitHub Actions example has installer, build, test, pack, publish, and import steps in order', () => {
  const text = read('github-actions.yml');

  assert.match(text, /microsoft\/powerplatform-actions\/actions-install@/);
  assert.match(text, /add-tools-to-path:\s*true/);
  assert.match(text, /microsoft\/powerplatform-actions\/import-solution@/);
  assert.match(text, /SOLUTION_PROJECT="build\/\$SOLUTION_NAME"/);
  assert.match(text, /pac solution init[^\n]+--outputDirectory "\$SOLUTION_PROJECT"/);
  assertOrdered(text, ['Power Platform Tool Installer', 'Build PCF control', 'Test PCF control', 'Pack managed solution', 'Publish artifact', 'Import managed solution']);
  assertNoInlineSecrets(text);
});

test('Azure DevOps example has installer, build, test, pack, publish, and import tasks in order', () => {
  const text = read('azure-devops.yml');

  assert.match(text, /PowerPlatformToolInstaller@2/);
  assert.match(text, /PowerPlatformImportSolution@2/);
  assert.match(text, /SolutionProject: '\$\(Build\.ArtifactStagingDirectory\)\/\$\(SolutionName\)'/);
  assert.match(text, /SolutionZip: '\$\(Build\.ArtifactStagingDirectory\)\/\$\(SolutionName\)\/bin\/Release\/\$\(SolutionName\)_managed\.zip'/);
  assert.match(text, /pac solution init[^\n]+--outputDirectory "\$\(SolutionProject\)"/);
  assertOrdered(text, ['PowerPlatformToolInstaller', 'Build PCF control', 'Test PCF control', 'Pack managed solution', 'Publish pipeline artifact', 'Import managed solution']);
  assertNoInlineSecrets(text);
});

test('pipeline README documents service-connection customization without inline credentials', () => {
  const text = read('README.md');

  assert.match(text, /service connection/i);
  assert.match(text, /https:\/\/contoso\.crm\.dynamics\.com/);
  assertNoInlineSecrets(text);
});
