#!/usr/bin/env node
'use strict';

// Fails the build when a plugin's physical copy of another source drifts.
//
// WHY THIS EXISTS
// Marketplace installs copy one plugin directory, not the whole repository. The pcf plugin therefore
// carries local copies of model-apps helpers, the model-apps vendored SDK bundle, and a shared
// report-issue workflow. A PR can touch only the source side or only the copy side, and plugin CI is
// path-filtered by design, so a plugin-local drift test is not enough. This root validator is the
// single source of truth for those copy sets; it runs on every PR and is invoked by both plugin test
// suites so whichever side changes must refresh the other in the same PR.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const COPY_SETS = [
  {
    name: 'pcf-from-model-apps',
    verbatim: [
      ['scripts/lib/process-runner.js', 'scripts/lib/process-runner.js'],
      ['scripts/lib/sdk-http-client.js', 'scripts/lib/sdk-http-client.js'],
      ['scripts/lib/odata.js', 'scripts/lib/odata.js'],
      ['scripts/lib/source-literals.js', 'scripts/lib/source-literals.js'],
      ['scripts/lib/interaction-mode.js', 'scripts/lib/interaction-mode.js'],
      ['scripts/lib/nearest-name.js', 'scripts/lib/nearest-name.js'],
      ['scripts/lib/utf8-stream.js', 'scripts/lib/utf8-stream.js'],
      ['scripts/lib/cli-failure.js', 'scripts/lib/cli-failure.js'],
      ['scripts/check-auth.js', 'scripts/check-auth.js'],
      ['scripts/resolve-interaction-mode.js', 'scripts/resolve-interaction-mode.js'],
      ['scripts/vendor/cds-maker-sdk.cjs', 'scripts/vendor/cds-maker-sdk.cjs'],
      ['scripts/vendor/PROVENANCE.json', 'scripts/vendor/PROVENANCE.json'],
      ['scripts/vendor/.gitattributes', 'scripts/vendor/.gitattributes'],
    ].map(([source, copy]) => ({
      source: path.posix.join('plugins/model-apps', source),
      copy: path.posix.join('plugins/pcf', copy),
    })).concat([
      {
        source: 'shared/skills/report-issue/report-issue-workflow.md',
        copy: 'plugins/pcf/skills/report-issue/report-issue-workflow.md',
      },
    ]),
    wrappers: [
      {
        copy: 'plugins/pcf/skills/report-issue/SKILL.md',
        requiredFragments: [
          'with the pcf plugin to the GitHub repository.',
          '**Workflow: [report-issue-workflow.md](${PLUGIN_ROOT}/skills/report-issue/report-issue-workflow.md)**',
        ],
      },
    ],
    subset: {
      source: 'plugins/model-apps/scripts/lib/dataverse-auth.js',
      copy: 'plugins/pcf/scripts/lib/dataverse-auth.js',
      exceptExport: 'emitResult',
      requiredExports: [
        'dataverseOrigin',
        'requireDataverseOrigin',
        'getAuthToken',
        'getAuthTokenAsync',
        'tokenFailureKind',
        'tokenFailureMessage',
        'azIdentity',
        'preflightAuth',
        'makeRequest',
        'dataverseRequest',
        'ensureOk',
        'parseArgs',
        'validateFlags',
        'readAliasedFlag',
        'readJsonArg',
        'emitResult',
      ],
      requiredDeclarations: [
        'DATAVERSE_HOST',
        'authTokenMemo',
      ],
    },
  },
];

function toNative(repoRoot, relPath) {
  return path.join(repoRoot, ...String(relPath).split('/'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function normalizeText(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function normalizeDeclaration(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function copyFileFix(finding) {
  if (/^plugins\/pcf\/scripts\/vendor\//.test(finding.copy || '')) {
    return 'Re-vendor the SDK in plugins/model-apps first, then copy the resulting vendor file into plugins/pcf.';
  }
  return `Copy ${finding.source} over ${finding.copy}.`;
}

function subsetFix(name) {
  return `Copy the ${name} function or declaration from plugins/model-apps/scripts/lib/dataverse-auth.js into plugins/pcf/scripts/lib/dataverse-auth.js.`;
}

function finding(set, kind, source, copy, fix) {
  return { set, source, copy, kind, fix };
}

function checkVerbatimPair(repoRoot, setName, pair) {
  const sourcePath = toNative(repoRoot, pair.source);
  const copyPath = toNative(repoRoot, pair.copy);
  if (!fs.existsSync(sourcePath)) {
    return finding(setName, 'missing-source', pair.source, pair.copy, `Restore ${pair.source}, then copy it over ${pair.copy}.`);
  }
  if (!fs.existsSync(copyPath)) {
    return finding(setName, 'missing-copy', pair.source, pair.copy, copyFileFix(pair));
  }
  if (normalizeText(readText(sourcePath)) !== normalizeText(readText(copyPath))) {
    return finding(setName, 'drift', pair.source, pair.copy, copyFileFix(pair));
  }
  return null;
}

function checkWrapper(repoRoot, setName, wrapper) {
  const copyPath = toNative(repoRoot, wrapper.copy);
  if (!fs.existsSync(copyPath)) {
    return finding(setName, 'missing-copy', '(required wrapper fragments)', wrapper.copy, `Restore ${wrapper.copy} with the pcf report-issue wrapper.`);
  }
  const content = readText(copyPath);
  const missing = wrapper.requiredFragments.filter((fragment) => !content.includes(fragment));
  if (missing.length > 0) {
    return finding(
      setName,
      'drift',
      '(required wrapper fragments)',
      wrapper.copy,
      `Refresh ${wrapper.copy} so it keeps the pcf report-issue description and bundled workflow link.`,
    );
  }
  return null;
}

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

function declarationNames(block) {
  const body = block.replace(/^(?:const|let|var)\s+/, '').replace(/=[\s\S]*$/, '').trim();
  if (body.startsWith('{')) {
    return body
      .replace(/[{}]/g, '')
      .split(',')
      .map((part) => part.trim().split(/\s*:\s*/).pop().trim())
      .filter(Boolean);
  }
  const match = /^([A-Za-z_$][\w$]*)/.exec(body);
  return match ? [match[1]] : [];
}

function identifiersInSource(source) {
  // Strip comments and quotes before scanning so a name that appears only in prose is not treated
  // as a binding. Function source looks like:
  //   function validateFlags() { const near = nearestName(k, knownSet); return near; }
  // Template text is removed too; a substitution-only reference is rare in this subset and would
  // still show up in the surrounding expression.
  const stripped = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ');
  return stripped.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
}

function referencedDeclarations(sourcePath, sourceModule, copyModule, subset, sourceDeclarations = topLevelDeclarations(sourcePath)) {
  const referenced = new Set(subset.requiredDeclarations || []);
  const names = new Set(subset.requiredExports || []);
  for (const exportName of Object.keys(copyModule)) {
    if (exportName !== subset.exceptExport) names.add(exportName);
  }
  for (const name of names) {
    const fn = sourceModule[name];
    if (typeof fn !== 'function') continue;
    for (const ident of identifiersInSource(Function.prototype.toString.call(fn))) {
      if (sourceDeclarations.has(ident)) referenced.add(ident);
    }
  }
  return referenced;
}

function topLevelDeclarations(file) {
  const source = normalizeText(readText(file));
  const declarations = new Map();
  const re = /^(?:const|let|var)\s+[\s\S]*?;/gm;
  for (const match of source.matchAll(re)) {
    for (const name of declarationNames(match[0])) {
      declarations.set(name, normalizeDeclaration(match[0]));
    }
  }
  return declarations;
}

function checkSubset(repoRoot, setName, subset) {
  const sourcePath = toNative(repoRoot, subset.source);
  const copyPath = toNative(repoRoot, subset.copy);
  if (!fs.existsSync(sourcePath)) {
    return [finding(setName, 'missing-source', subset.source, subset.copy, `Restore ${subset.source}; the subset cannot be checked without it.`)];
  }
  if (!fs.existsSync(copyPath)) {
    return [finding(setName, 'missing-copy', subset.source, subset.copy, `Restore ${subset.copy} from the documented subset of ${subset.source}.`)];
  }

  const findings = [];
  const sourceModule = requireFresh(sourcePath);
  const copyModule = requireFresh(copyPath);
  for (const name of subset.requiredExports || []) {
    if (!(name in copyModule)) {
      findings.push(finding(setName, 'missing-export', name, subset.copy, subsetFix(name)));
    }
  }
  for (const name of Object.keys(copyModule).filter((exportName) => exportName !== subset.exceptExport)) {
    if (normalizeText(String(copyModule[name])) !== normalizeText(String(sourceModule[name]))) {
      findings.push(finding(setName, 'export-drift', name, subset.copy, subsetFix(name)));
    }
  }

  const sourceDeclarations = topLevelDeclarations(sourcePath);
  const copyDeclarations = topLevelDeclarations(copyPath);
  // A retained function can close over a binding that is not itself exported. Removing
  // `const { nearestName } = require('./nearest-name.js')` left validateFlags' body identical, so
  // export comparison passed and the copy then threw ReferenceError at runtime. Require every
  // top-level declaration those function bodies actually reference, not only the two names listed
  // in requiredDeclarations.
  for (const name of referencedDeclarations(sourcePath, sourceModule, copyModule, subset, sourceDeclarations)) {
    if (!copyDeclarations.has(name)) {
      findings.push(finding(setName, 'missing-declaration', name, subset.copy, subsetFix(name)));
    }
  }
  for (const [name, declaration] of copyDeclarations) {
    if (sourceDeclarations.get(name) !== declaration) {
      findings.push(finding(setName, 'declaration-drift', name, subset.copy, subsetFix(name)));
    }
  }

  const copyEmit = copyModule[subset.exceptExport];
  const sourceEmit = sourceModule[subset.exceptExport];
  if (
    typeof copyEmit !== 'function'
    || String(copyEmit) === String(sourceEmit)
    || !/\bok\s*:\s*false\s*,\s*error\b/.test(String(copyEmit))
  ) {
    findings.push(finding(
      setName,
      'emitResult-contract',
      subset.exceptExport,
      subset.copy,
      'Keep pcf emitResult intentionally different from model-apps and preserve the { ok: false, error } JSON stdout contract.',
    ));
  }
  return findings;
}

function checkCopySets({ repoRoot = REPO_ROOT, sets = COPY_SETS } = {}) {
  const findings = [];
  let checked = 0;
  for (const set of sets) {
    for (const pair of set.verbatim || []) {
      checked += 1;
      const result = checkVerbatimPair(repoRoot, set.name, pair);
      if (result) findings.push(result);
    }
    for (const wrapper of set.wrappers || []) {
      checked += 1;
      const result = checkWrapper(repoRoot, set.name, wrapper);
      if (result) findings.push(result);
    }
    if (set.subset) {
      checked += 1;
      findings.push(...checkSubset(repoRoot, set.name, set.subset));
    }
  }
  return { ok: findings.length === 0, checked, findings };
}

function formatFinding(item) {
  const source = item.source ? ` source=${item.source}` : '';
  const copy = item.copy ? ` copy=${item.copy}` : '';
  return `[${item.set}] ${item.kind}${source}${copy}\n  Fix: ${item.fix}`;
}

function main() {
  const result = checkCopySets({ repoRoot: REPO_ROOT, sets: COPY_SETS });
  if (!result.ok) {
    console.error('Plugin copy drift detected:\n');
    for (const item of result.findings) {
      console.error(formatFinding(item));
    }
    process.exit(1);
  }
  console.log(`Plugin copies are in sync (${result.checked} files in ${COPY_SETS.length} set(s)).`);
}

if (require.main === module) {
  main();
}

module.exports = {
  COPY_SETS,
  checkCopySets,
  checkVerbatimPair,
  checkSubset,
  topLevelDeclarations,
  referencedDeclarations,
  normalizeDeclaration,
  formatFinding,
};
