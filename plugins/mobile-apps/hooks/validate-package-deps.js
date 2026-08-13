#!/usr/bin/env node

/**
 * Explicit validator: forbid bad dependencies in package.json writes.
 *
 * Triggers on Write/Edit/MultiEdit of any package.json. Blocks when the
 * resulting deps include known-bad packages, private vendor packages are
 * referenced via the npm registry instead of `file:` paths to vendor *.tgz,
 * OR native/runtime packages are added outside the current package baseline's
 * native/runtime allowlist. A reviewed exact-version exception may admit an
 * otherwise ambiguous `react-native-*` package that planning verified is JS-only.
 *
 * Allowed icon library: `@expo/vector-icons` only.
 *
 * Forbidden npm-registry packages:
 *   - lucide-react-native, lucide-react, @tamagui/lucide-icons, @tamagui/lucide-icons-2
 *   - react-native-vector-icons (use @expo/vector-icons)
 *   - axios, node-fetch (use generated services from src/generated/)
 *
 * Vendor-only packages (must use file: path):
 *   - expo-msal-intune
 *   - @microsoft/pa-client (and any @microsoft/pa-* family)
 *
 * Exit codes: 0 pass, 2 block + stderr message.
 */

const fs = require('fs');
const path = require('path');

const FORBIDDEN_DEPS = {
  'lucide-react-native': 'Use `@expo/vector-icons` (Ionicons family).',
  'lucide-react': 'Use `@expo/vector-icons` (Ionicons family).',
  '@tamagui/lucide-icons': 'Use `@expo/vector-icons` (Ionicons family).',
  '@tamagui/lucide-icons-2': 'Use `@expo/vector-icons` (Ionicons family).',
  'react-native-vector-icons': 'Use `@expo/vector-icons` (Ionicons family).',
  axios: 'Use generated connector services from `src/generated/` (connector-first rule).',
  'node-fetch': 'Use generated connector services from `src/generated/`. The runtime has global fetch.',
};

// Names that MUST resolve to a vendor *.tgz file: path.
const VENDOR_ONLY = [/^expo-msal-intune$/, /^@microsoft\/pa-/];

// These patterns identify packages known to require native runtime support. The
// broad `react-native-*` namespace is handled separately because it also contains
// pure-JavaScript packages; those stay blocked unless planning passes an exact
// reviewed name/version exception to explicit validation.
const NATIVE_PACKAGE_PATTERNS = [
  /^expo($|-)/,
  /^@expo\//,
  /^react-native$/,
  /^@react-native\//,
  /^@react-native-community\//,
  /^@shopify\/react-native-/,
  /^react-native-gesture-handler$/,
  /^react-native-reanimated$/,
  /^react-native-screens$/,
  /^react-native-safe-area-context$/,
  /^react-native-webview$/,
  /^react-native-svg$/,
  /^react-native-maps$/,
  /^react-native-camera$/,
  /^react-native-vision-camera$/,
  /^react-native-document-picker$/,
  /^react-native-fs$/,
  /^react-native-permissions$/,
  /^react-native-device-info$/,
  /^react-native-keychain$/,
  /^react-native-biometrics$/,
  /^react-native-nfc-manager$/,
  /^react-native-ble-/,
  /^@config-plugins\//,
  /^@sentry\/react-native$/,
];

const AMBIGUOUS_REACT_NATIVE_PACKAGE_PATTERN = /^react-native-/;

const BUNDLED_TEMPLATE_PACKAGE_PATH = path.resolve(__dirname, '..', 'template', 'package.json');

function packageDeps(pkg) {
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
}

function readPackageDepsFromContent(content) {
  try {
    return packageDeps(JSON.parse(content));
  } catch {
    return null;
  }
}

function readRequiredPackageDeps(packagePath) {
  const deps = readPackageDepsFromContent(fs.readFileSync(packagePath, 'utf8'));
  if (!deps) {
    throw new Error('package manifest is not valid JSON');
  }
  return deps;
}

function readPackageLockDeps(packageJsonPath) {
  if (typeof packageJsonPath !== 'string') return null;
  const lockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
  if (!fs.existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const rootPackage = lock.packages && lock.packages[''];
    if (rootPackage) {
      return packageDeps(rootPackage);
    }
    if (lock.dependencies && typeof lock.dependencies === 'object') {
      return Object.fromEntries(Object.keys(lock.dependencies).map((name) => [name, true]));
    }
  } catch {
    return null;
  }
  return null;
}

function reverseEdit(afterContent, newString, oldString) {
  if (typeof newString !== 'string' || typeof oldString !== 'string') return null;
  if (newString.length === 0) return null;
  if (!afterContent.includes(newString)) return null;
  return afterContent.replace(newString, oldString);
}

function reconstructBeforeContent(toolName, toolInput, afterContent) {
  if (!afterContent) return null;
  if (toolName === 'Edit') {
    return reverseEdit(afterContent, toolInput.new_string, toolInput.old_string);
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    let beforeContent = afterContent;
    for (const edit of [...toolInput.edits].reverse()) {
      beforeContent = reverseEdit(beforeContent, edit?.new_string, edit?.old_string);
      if (beforeContent === null) return null;
    }
    return beforeContent;
  }
  return null;
}

function getNativeAllowlistDeps(toolName, toolInput, afterContent, packageJsonPath) {
  if (toolInput.validation_mode === 'explicit-mobile-workflow') {
    // Explicit mobile validation is the final native-runtime gate. If the bundled
    // template is missing or malformed, allowing the write would silently turn a
    // verification failure into permission to add arbitrary native dependencies.
    return readRequiredPackageDeps(BUNDLED_TEMPLATE_PACKAGE_PATH);
  }

  const beforeContent = reconstructBeforeContent(toolName, toolInput, afterContent);
  const beforeDeps = beforeContent ? readPackageDepsFromContent(beforeContent) : null;
  return beforeDeps || readPackageLockDeps(packageJsonPath);
}

function approvedJsDependencyVersions(toolInput) {
  const approved = new Map();
  if (!Array.isArray(toolInput.approved_js_dependencies)) return approved;
  for (const entry of toolInput.approved_js_dependencies) {
    if (typeof entry?.name === 'string' && typeof entry?.version === 'string') {
      approved.set(entry.name, entry.version);
    }
  }
  return approved;
}

function isPackageJson(filePath) {
  return typeof filePath === 'string' && path.basename(filePath) === 'package.json';
}

function isWriteTool(t) {
  return t === 'Write' || t === 'Edit' || t === 'MultiEdit';
}

function readResult(toolName, toolInput) {
  // Prefer the file on disk because explicit validation runs after the write.
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fs.existsSync(fp)) {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      /* fallthrough */
    }
  }
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => (e && e.new_string) || '').join('\n');
  }
  return '';
}

function findViolations(content, filePath, nativeAllowlistDeps, approvedJsDependencies) {
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    return []; // mid-edit; let it be — tsc / npm install will catch
  }
  const allDeps = packageDeps(pkg);

  const violations = [];
  const editingBundledTemplatePackage =
    typeof filePath === 'string' && path.resolve(filePath) === BUNDLED_TEMPLATE_PACKAGE_PATH;

  for (const [name, version] of Object.entries(allDeps)) {
    if (FORBIDDEN_DEPS[name]) {
      violations.push({
        name,
        version,
        reason: `Forbidden dependency \`${name}\`. ${FORBIDDEN_DEPS[name]}`,
      });
    }
    if (VENDOR_ONLY.some((rx) => rx.test(name)) && !String(version).startsWith('file:')) {
      violations.push({
        name,
        version,
        reason: `\`${name}\` is a private vendor package. Reference must be a \`file:./vendor/<name>-<version>.tgz\` path, not \`${version}\`. Will 404 from npm registry.`,
      });
    }
    if (!editingBundledTemplatePackage && nativeAllowlistDeps && !nativeAllowlistDeps[name]) {
      if (NATIVE_PACKAGE_PATTERNS.some((rx) => rx.test(name))) {
        violations.push({
          name,
          version,
          reason: `Native/runtime dependency \`${name}\` was not present in this app/template package baseline. Start from a template/runtime that already ships it.`,
        });
      } else if (
        AMBIGUOUS_REACT_NATIVE_PACKAGE_PATTERN.test(name) &&
        approvedJsDependencies.get(name) !== String(version)
      ) {
        violations.push({
          name,
          version,
          reason: `Dependency \`${name}@${version}\` uses the ambiguous \`react-native-*\` namespace and is absent from the app/template baseline. Explicit validation requires the same exact name/version from the user-approved JavaScript Dependencies plan.`,
        });
      }
    }
  }
  return violations;
}

let buf = '';
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(buf || '{}');
  } catch {
    process.exit(0);
  }
  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};
  if (!isWriteTool(toolName)) process.exit(0);
  const fp = toolInput.file_path || toolInput.filePath;
  if (!isPackageJson(fp)) process.exit(0);

  const content = readResult(toolName, toolInput);
  if (!content) process.exit(0);

  let nativeAllowlistDeps;
  try {
    nativeAllowlistDeps = getNativeAllowlistDeps(toolName, toolInput, content, fp);
  } catch (error) {
    process.stderr.write(
      `BLOCKED: unable to load native dependency allowlist from ${BUNDLED_TEMPLATE_PACKAGE_PATH}: ${error.message}\n`,
    );
    process.exit(2);
  }
  const approvedJsDependencies = approvedJsDependencyVersions(toolInput);
  const violations = findViolations(content, fp, nativeAllowlistDeps, approvedJsDependencies);
  if (violations.length === 0) process.exit(0);

  const rel = path.relative(process.cwd(), fp) || fp;
  const lines = [`BLOCKED: forbidden dependencies in ${rel}`, ''];
  for (const v of violations) {
    lines.push(`  - ${v.reason}`);
  }
  lines.push('');
  lines.push('Re-issue the write with the dependency list corrected.');
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
});
