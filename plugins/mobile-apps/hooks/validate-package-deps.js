#!/usr/bin/env node
'use strict';

// Explicit workflows admit a version-matched reviewed release, never package
// names from the newest bundled template. Legacy edits retain a conservative
// before/lock comparison, but cannot silently change detected native versions.
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveProjectRelease, dependencySections, inspectInstalledPackages, isRuntimePackage, resolveInstalledDependency, npmAliasTarget,
} = require('../scripts/lib/mobile-release');

const FORBIDDEN_DEPS = {
  'lucide-react-native': 'Use `@expo/vector-icons` (Ionicons family).',
  'lucide-react': 'Use `@expo/vector-icons` (Ionicons family).',
  '@tamagui/lucide-icons': 'Use `@expo/vector-icons` (Ionicons family).',
  '@tamagui/lucide-icons-2': 'Use `@expo/vector-icons` (Ionicons family).',
  'react-native-vector-icons': 'Use `@expo/vector-icons` (Ionicons family).',
  axios: 'Use generated connector services from `src/generated/` (connector-first rule).',
  'node-fetch': 'Use generated connector services from `src/generated/`. The runtime has global fetch.',
};
const VENDOR_ONLY = [/^expo-msal-intune$/, /^@microsoft\/pa-/];
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function parseJson(content, label) {
  try {
    const result = JSON.parse(content);
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail(`Invalid ${label}.`);
    return result;
  } catch (error) {
    if (error.code === 'MOBILE_RELEASE_BLOCKED') throw error;
    fail(`Cannot validate malformed ${label}. Correct the JSON before continuing.`);
  }
}

function packageDeps(pkg) {
  return Object.assign({}, ...Object.values(dependencySections(pkg)));
}

function reverseEdit(afterContent, edit) {
  if (typeof edit?.new_string !== 'string' || typeof edit?.old_string !== 'string'
    || !edit.new_string || !afterContent.includes(edit.new_string)) return null;
  return afterContent.replace(edit.new_string, edit.old_string);
}

function reconstructBefore(toolName, toolInput, afterContent) {
  if (toolName === 'Edit') return reverseEdit(afterContent, toolInput);
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    let before = afterContent;
    for (const edit of [...toolInput.edits].reverse()) {
      before = reverseEdit(before, edit);
      if (before === null) return null;
    }
    return before;
  }
  return null;
}

function readResult(toolName, toolInput, filePath) {
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  fail('The resulting package.json must be available for validation.');
}

function approvedJsDependencies(input) {
  const approved = new Map();
  if (!Array.isArray(input.approved_js_dependencies)) return approved;
  for (const entry of input.approved_js_dependencies) {
    if (typeof entry?.name === 'string' && typeof entry.version === 'string'
      && EXACT_VERSION.test(entry.version)) {
      approved.set(entry.name, entry.version);
    }
  }
  return approved;
}

function hasNativeClosure(installed, installPath, unchangedPeers, seen = new Set()) {
  if (!installPath || seen.has(installPath)) return false;
  seen.add(installPath);
  const item = installed.get(installPath);
  if (!item) return false;
  if (item.native) return true;
  const dependencies = { ...item.pkg.dependencies, ...item.pkg.optionalDependencies };
  if (Object.keys(dependencies).some((name) => isRuntimePackage(name)
    || hasNativeClosure(installed, resolveInstalledDependency(installed, installPath, name), unchangedPeers, seen))) return true;
  return Object.keys(item.pkg.peerDependencies || {}).some((name) => {
    const peer = resolveInstalledDependency(installed, installPath, name);
    // A JS UI consuming the app's unchanged React/RN peer does not add native
    // code. Nested, new, changed, or uninstalled peers cannot use that exception.
    if (peer && unchangedPeers.has(peer)) return false;
    return isRuntimePackage(name) || hasNativeClosure(installed, peer, unchangedPeers, seen);
  });
}

function legacyBaseline(toolName, toolInput, content, projectRoot, installed) {
  const before = reconstructBefore(toolName, toolInput, content);
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const lock = fs.existsSync(lockPath) ? parseJson(fs.readFileSync(lockPath, 'utf8'), 'package-lock.json') : null;
  const baseline = before !== null ? packageDeps(parseJson(before, 'previous package.json'))
    : lock?.packages?.[''] ? packageDeps(lock.packages[''])
      : Object.fromEntries(Object.entries(lock?.dependencies || {}).map(([name, value]) => [name, value.version]));
  for (const [installPath, item] of installed) {
    if (!item.native) continue;
    const locked = lock?.packages?.[installPath]
      || (installPath === `node_modules/${item.name}` ? lock?.dependencies?.[item.name] : null);
    const direct = installPath === `node_modules/${item.name}`;
    const pinnedBefore = direct && EXACT_VERSION.test(baseline[item.name] || '');
    if (!locked || locked.version !== item.version || (pinnedBefore && baseline[item.name] !== item.version)) {
      fail('Detected native dependency drift between the installation and app lock. Restore the approved runtime and validate a verified release.');
    }
  }
  return baseline;
}

function main(input) {
  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};
  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) return;
  const filePath = toolInput.file_path || toolInput.filePath;
  if (typeof filePath !== 'string' || path.basename(filePath) !== 'package.json') return;

  const content = readResult(toolName, toolInput, filePath);
  const pkg = parseJson(content, 'package.json');
  const dependencies = packageDeps(pkg);
  const sections = dependencySections(pkg);
  // Inspect every section: a safe optional/dev declaration must not shadow a
  // forbidden or registry-only declaration in dependencies.
  for (const section of Object.values(sections)) {
    for (const [name, version] of Object.entries(section)) {
      if (Object.hasOwn(FORBIDDEN_DEPS, name)) fail(`Forbidden dependency \`${name}\`. ${FORBIDDEN_DEPS[name]}`);
      const canonical = npmAliasTarget(version);
      if (canonical && Object.hasOwn(FORBIDDEN_DEPS, canonical)) fail(`Forbidden dependency \`${canonical}\`. ${FORBIDDEN_DEPS[canonical]}`);
      if (canonical && VENDOR_ONLY.some((pattern) => pattern.test(canonical))) {
        fail(`Vendor-only dependency \`${canonical}\` cannot use an npm alias.`);
      }
      if (VENDOR_ONLY.some((pattern) => pattern.test(name))
        && !/^file:\.\/vendor\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(version)) {
        fail(`Vendor-only dependency \`${name}\` must reference a file:./vendor package archive.`);
      }
    }
  }

  const projectRoot = path.dirname(path.resolve(filePath));
  const explicit = toolInput.validation_mode === 'explicit-mobile-workflow';
  let baseline;
  let installed;
  if (explicit) {
    const release = resolveProjectRelease(projectRoot);
    baseline = packageDeps(release.managedDependencies);
  } else {
    installed = inspectInstalledPackages(projectRoot);
    baseline = legacyBaseline(toolName, toolInput, content, projectRoot, installed);
  }
  const approved = approvedJsDependencies(toolInput);
  const unchangedPeers = new Set(Object.entries(baseline).filter(([name, version]) => dependencies[name] === version
    && installed?.has(`node_modules/${name}`)).map(([name]) => `node_modules/${name}`));
  for (const [name, version] of Object.entries(dependencies)) {
    const actual = installed?.get(`node_modules/${name}`);
    if (actual?.alias) {
      if (Object.hasOwn(FORBIDDEN_DEPS, actual.canonicalName)) fail(`Forbidden dependency \`${actual.canonicalName}\`. ${FORBIDDEN_DEPS[actual.canonicalName]}`);
      if (npmAliasTarget(version) !== actual.canonicalName) fail('Installed npm alias canonical identity does not match its dependency declaration.');
    }
    const native = isRuntimePackage(name)
      || (installed && hasNativeClosure(installed, `node_modules/${name}`, unchangedPeers));
    if (native && baseline[name] !== version) {
      fail(`Native/runtime dependency \`${name}\` differs from this app's reviewed baseline. Restore its declaration or select a verified release.`);
    }
    if (!native && !Object.hasOwn(baseline, name) && /^react-native-/.test(name)
      && approved.get(name) !== version) {
      fail(`Dependency \`${name}\` requires the same exact name/version from the user-approved JavaScript Dependencies plan.`);
    }
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => { buffer += chunk; });
process.stdin.on('end', () => {
  try {
    main(parseJson(buffer, 'validator input'));
  } catch (error) {
    const message = error.code === 'MOBILE_RELEASE_BLOCKED'
      ? error.message : 'Unable to verify package dependencies. Restore valid project files and the reviewed installation.';
    process.stderr.write(`BLOCKED: ${message}\n`);
    process.exitCode = 2;
  }
});
