#!/usr/bin/env node
// Detects the SPA framework in the project, installs ESLint + framework plugins
// into <projectRoot>/.scan-code/, writes a flat ESLint config with ignore rules,
// runs ESLint, and emits unified findings JSON. ESLint severities are kept
// verbatim ("error", "warning") — no remapping.
//
// Run with --help for flags.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`lint.js — Runs ESLint against project source and emits findings JSON.

Usage:
  node lint.js --projectRoot <dir> [--output <path>] [--reinstall]

Flags:
  --projectRoot   Project directory (contains package.json) (required)
  --output        Write findings JSON to this path (optional, also echoed to stdout)
  --reinstall     Force re-creation of the .scan-code workspace
  --help          Show this help message

Exit codes:
  0  Success — findings emitted (status "ok" or "skipped")
  1  Invocation error or fatal install/lint failure

The script provisions <projectRoot>/.scan-code/ on first run:
  .scan-code/package.json       — pinned ESLint + plugin dependencies
  .scan-code/eslint.config.mjs  — flat config with framework rules + ignores
  .scan-code/node_modules/      — installed via npm install --prefix

Subsequent runs reuse the workspace unless --reinstall is given.

Source files scanned: <projectRoot>/src/** (framework-aware extensions).
Ignored: node_modules, dist, build, docs, coverage, .powerpages-site, .scan-code,
public, *.min.js, vendor.
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

// Framework descriptors. Versions are major-pinned ranges that resolve to current
// flat-config-compatible releases at install time. Plugin entry points used in the
// generated config:
//   - react:   eslint-plugin-react.configs.flat.recommended, react-hooks recommended-latest
//   - vue:     eslint-plugin-vue.configs['flat/recommended']
//   - angular: typescript-eslint baseline (no template/HTML linting)
//   - astro:   eslint-plugin-astro.configs.recommended (legacy-style flat configs)
const FRAMEWORKS = {
  react: {
    label: 'React',
    detect: (pkg) => Boolean(pkg.dependencies?.react || pkg.devDependencies?.react),
    deps: {
      'eslint': '^9.0.0',
      '@eslint/js': '^9.0.0',
      'typescript-eslint': '^8.0.0',
      'eslint-plugin-security': '^3.0.0',
      'eslint-plugin-react': '^7.34.0',
      'eslint-plugin-react-hooks': '^5.0.0',
      'globals': '^15.0.0',
    },
    extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
  },
  vue: {
    label: 'Vue',
    detect: (pkg) => Boolean(pkg.dependencies?.vue || pkg.devDependencies?.vue),
    deps: {
      'eslint': '^9.0.0',
      '@eslint/js': '^9.0.0',
      'typescript-eslint': '^8.0.0',
      'eslint-plugin-security': '^3.0.0',
      'eslint-plugin-vue': '^9.20.0',
      'vue-eslint-parser': '^9.4.0',
      'globals': '^15.0.0',
    },
    extensions: ['js', 'ts', 'mjs', 'cjs', 'vue'],
  },
  angular: {
    label: 'Angular',
    detect: (pkg) => Boolean(pkg.dependencies?.['@angular/core'] || pkg.devDependencies?.['@angular/core']),
    deps: {
      'eslint': '^9.0.0',
      '@eslint/js': '^9.0.0',
      'typescript-eslint': '^8.0.0',
      'eslint-plugin-security': '^3.0.0',
      'globals': '^15.0.0',
    },
    extensions: ['js', 'ts', 'mjs', 'cjs'],
  },
  astro: {
    label: 'Astro',
    detect: (pkg) => Boolean(pkg.dependencies?.astro || pkg.devDependencies?.astro),
    deps: {
      'eslint': '^9.0.0',
      '@eslint/js': '^9.0.0',
      'typescript-eslint': '^8.0.0',
      'eslint-plugin-security': '^3.0.0',
      'eslint-plugin-astro': '^1.2.0',
      'astro-eslint-parser': '^1.0.0',
      'globals': '^15.0.0',
    },
    extensions: ['js', 'ts', 'mjs', 'cjs', 'astro'],
  },
};

function detectFramework(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const key of ['react', 'vue', 'angular', 'astro']) {
    if (FRAMEWORKS[key].detect(pkg)) return key;
  }
  return null;
}

// Patterns excluded everywhere. Kept here so the workspace config file
// reflects the same list — single source of truth.
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.scan-code/**',
  '**/.powerpages-site/**',
  '**/dist/**',
  '**/build/**',
  '**/.output/**',
  '**/.astro/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/docs/**',
  '**/public/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.bundle.js',
];

function configForFramework(key) {
  const base = `import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import globals from 'globals';
`;

  const ignoresBlock = `  { ignores: ${JSON.stringify(IGNORE_PATTERNS, null, 2).replace(/\n/g, '\n    ')} },\n`;

  const securityBlock = `  {
    plugins: { security },
    rules: security.configs.recommended.rules,
  },\n`;

  const commonLanguage = `  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },\n`;

  if (key === 'react') {
    return base +
`import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
${ignoresBlock}  js.configs.recommended,
  ...tseslint.configs.recommended,
${securityBlock}${commonLanguage}  {
    files: ['**/*.{jsx,tsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
  },
  reactHooks.configs['recommended-latest'],
];
`;
  }
  if (key === 'vue') {
    return base +
`import vue from 'eslint-plugin-vue';

export default [
${ignoresBlock}  js.configs.recommended,
  ...tseslint.configs.recommended,
${securityBlock}${commonLanguage}  ...vue.configs['flat/recommended'],
];
`;
  }
  if (key === 'astro') {
    return base +
`import astro from 'eslint-plugin-astro';

export default [
${ignoresBlock}  js.configs.recommended,
  ...tseslint.configs.recommended,
${securityBlock}${commonLanguage}  ...astro.configs.recommended,
];
`;
  }
  // Angular and unknown frameworks: typescript-eslint baseline + security plugin.
  return base +
`export default [
${ignoresBlock}  js.configs.recommended,
  ...tseslint.configs.recommended,
${securityBlock}${commonLanguage}];
`;
}

function provisionWorkspace(projectRoot, frameworkKey, force) {
  const workspace = path.join(projectRoot, '.scan-code');
  const fw = FRAMEWORKS[frameworkKey];
  const pkgPath = path.join(workspace, 'package.json');
  const configPath = path.join(workspace, 'eslint.config.mjs');

  const pkgContents = {
    name: 'scan-code-workspace',
    private: true,
    type: 'module',
    description: 'Auto-generated by /scan-code — do not commit.',
    devDependencies: fw.deps,
  };

  fs.mkdirSync(workspace, { recursive: true });

  const pkgChanged = !fs.existsSync(pkgPath) ||
    fs.readFileSync(pkgPath, 'utf8') !== JSON.stringify(pkgContents, null, 2) + '\n';
  const configContents = configForFramework(frameworkKey);
  const configChanged = !fs.existsSync(configPath) ||
    fs.readFileSync(configPath, 'utf8') !== configContents;

  if (pkgChanged || force) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkgContents, null, 2) + '\n');
  }
  if (configChanged || force) {
    fs.writeFileSync(configPath, configContents);
  }
  // Write a .gitignore so the workspace stays untracked.
  fs.writeFileSync(path.join(workspace, '.gitignore'), '*\n');

  const needsInstall = force || pkgChanged || !fs.existsSync(path.join(workspace, 'node_modules', 'eslint'));
  if (needsInstall) {
    process.stderr.write('Installing ESLint workspace (this can take a minute)...\n');
    const result = spawnSync('npm', ['install', '--prefix', workspace, '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (result.status !== 0) {
      throw new Error(`npm install failed in ${workspace} (exit ${result.status}).`);
    }
  }

  return { workspace, configPath };
}

// Map ESLint message severity numbers to verbatim strings emitted by ESLint itself.
// 1 = warning, 2 = error. Anything else is dropped.
function eslintSeverity(num) {
  if (num === 2) return 'error';
  if (num === 1) return 'warning';
  return null;
}

function transformEslint(results, projectRoot) {
  const findings = [];
  let counter = 1;

  for (const file of results) {
    if (!Array.isArray(file.messages) || file.messages.length === 0) continue;
    const relPath = path.relative(projectRoot, file.filePath).split(path.sep).join('/');
    for (const msg of file.messages) {
      const severity = eslintSeverity(msg.severity);
      if (!severity) continue;
      const line = msg.line ? `:${msg.line}${msg.column ? `:${msg.column}` : ''}` : '';
      findings.push({
        id: `scan-code-lint-${counter++}`,
        severity,
        title: msg.message,
        tag: msg.ruleId || (msg.fatal ? 'parse-error' : null),
        location: `${relPath}${line}`,
        details: msg.ruleId
          ? `Rule: ${msg.ruleId}`
          : (msg.fatal ? 'Parser could not process this file.' : 'ESLint reported this issue.'),
        fix: msg.fix
          ? 'ESLint can auto-fix this — run `eslint --fix` in the project after the scan.'
          : (msg.suggestions && msg.suggestions.length > 0
              ? `Suggestions: ${msg.suggestions.map(s => s.desc).join('; ')}`
              : 'Review the code at the reported location and apply the rule guidance.'),
      });
    }
  }

  // Counts by severity for the side details panel.
  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  const filesScanned = results.length;
  const filesWithIssues = results.filter(r => Array.isArray(r.messages) && r.messages.length > 0).length;
  const detailsBlock = {
    kind: 'kv',
    label: 'Lint details',
    entries: [
      { key: 'Errors', value: String(counts.error || 0) },
      { key: 'Warnings', value: String(counts.warning || 0) },
      { key: 'Files scanned', value: String(filesScanned) },
      { key: 'Files with issues', value: String(filesWithIssues) },
    ],
  };

  return { status: 'ok', findings, details: detailsBlock };
}

function runEslint(projectRoot, workspace, configPath, extensions) {
  const eslintBin = path.join(workspace, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(eslintBin)) {
    throw new Error(`ESLint not found at ${eslintBin}. Re-run with --reinstall.`);
  }

  // ESLint flat config does not accept --ext, so file patterns are passed positionally.
  // Restrict scanning to src/** (project source) plus root-level config files.
  // Ignore patterns in eslint.config.mjs handle node_modules/.powerpages-site/dist/etc.
  const patterns = extensions.map(ext => `src/**/*.${ext}`);
  patterns.push('*.{js,mjs,cjs,ts}');

  const args = [
    eslintBin,
    '--config', configPath,
    '--no-error-on-unmatched-pattern',
    '--format', 'json',
    ...patterns,
  ];

  // ESLint exits 1 when issues exist — that is success for us. Anything else is failure.
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to spawn ESLint: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`ESLint exited with code ${result.status}.\n${(result.stderr || '').trim()}`);
  }
  if (!result.stdout || result.stdout.trim() === '') {
    return [];
  }
  return JSON.parse(result.stdout);
}

function writeOutput(payload, outputPath) {
  const text = JSON.stringify(payload) + '\n';
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text);
  }
  process.stdout.write(text);
}

function main() {
  const projectRoot = getArg('projectRoot');
  const outputPath = getArg('output');
  const force = process.argv.includes('--reinstall');

  if (!projectRoot) {
    process.stderr.write('Missing required flag: --projectRoot\n');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    writeOutput({ status: 'skipped', reason: 'No package.json in project root.' }, outputPath);
    return;
  }

  const frameworkKey = detectFramework(projectRoot);
  if (!frameworkKey) {
    writeOutput({
      status: 'skipped',
      reason: 'No supported framework detected — /scan-code supports React, Vue, Angular, and Astro.',
    }, outputPath);
    return;
  }

  let workspace, configPath;
  try {
    ({ workspace, configPath } = provisionWorkspace(projectRoot, frameworkKey, force));
  } catch (err) {
    writeOutput({ status: 'skipped', reason: err.message }, outputPath);
    return;
  }

  let results;
  try {
    results = runEslint(projectRoot, workspace, configPath, FRAMEWORKS[frameworkKey].extensions);
  } catch (err) {
    writeOutput({ status: 'skipped', reason: err.message }, outputPath);
    return;
  }

  const payload = transformEslint(results, projectRoot);
  payload.details.entries.unshift({ key: 'Framework', value: FRAMEWORKS[frameworkKey].label });
  writeOutput(payload, outputPath);
}

if (require.main === module) {
  main();
}

module.exports = { detectFramework, transformEslint, IGNORE_PATTERNS, FRAMEWORKS };
