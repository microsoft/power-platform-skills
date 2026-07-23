#!/usr/bin/env node
/**
 * check-behavior-coverage.js
 *
 * Verifies every screen wires >= MIN_COVERAGE of the behaviors declared in
 * behaviors.json. Designed for adapted Canvas/MSAPP ports where Power Fx
 * actions are the behavioral source of truth.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const minArg = process.argv.find((arg) => arg.startsWith('--min='));
const minArgIndex = process.argv.indexOf('--min');
const minCoverageRaw = Number(
  (minArg && minArg.slice('--min='.length))
  || (minArgIndex >= 0 && process.argv[minArgIndex + 1])
  || process.env.MIN_COVERAGE
  || 0.8
);
if (!Number.isFinite(minCoverageRaw) || minCoverageRaw <= 0 || minCoverageRaw > 100) {
  console.error('[coverage] --min/MIN_COVERAGE must be a number in (0, 100]');
  process.exit(2);
}
const MIN_COVERAGE = minCoverageRaw > 1 ? (minCoverageRaw / 100) : minCoverageRaw;
const SCREEN_DIRS = [path.join(ROOT, 'app/(app)'), path.join(ROOT, 'app'), path.join(ROOT, 'src/appScreens')];

const BEHAVIORS_PATH = path.join(ROOT, 'behaviors.json');
if (!fs.existsSync(BEHAVIORS_PATH)) {
  console.error('[coverage] behaviors.json not found - skipping');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(BEHAVIORS_PATH, 'utf8'));
const SCREEN_FILE_BY_SOURCE = new Map();
for (const command of data.componentCommands || []) {
  if (!command?.behaviorOwner || typeof command.target?.module !== 'string') continue;
  const resolved = path.resolve(ROOT, command.target.module);
  const relative = path.relative(ROOT, resolved);
  const contained = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (contained) SCREEN_FILE_BY_SOURCE.set(command.behaviorOwner, resolved);
}
const pluginInputPath = path.join(ROOT, 'mobile-plugin-input.json');
let pluginInput = null;
if (fs.existsSync(pluginInputPath)) {
  pluginInput = JSON.parse(fs.readFileSync(pluginInputPath, 'utf8'));
  for (const screen of pluginInput.screenPlan?.screens || []) {
    if (!screen?.name || typeof screen.file !== 'string') continue;
    const resolved = path.resolve(ROOT, screen.file);
    const relative = path.relative(ROOT, resolved);
    const contained = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (contained) SCREEN_FILE_BY_SOURCE.set(screen.name, resolved);
  }
}
const behaviorContractPath = path.join(ROOT, 'behavior-contract.json');
let behaviorContract = null;
if (fs.existsSync(behaviorContractPath)) {
  behaviorContract = JSON.parse(fs.readFileSync(behaviorContractPath, 'utf8'));
} else if (pluginInput?.behaviorPlan) {
  console.error('[coverage] behavior-contract.json is required by mobile-plugin-input.json');
  process.exit(2);
}
const CLASSIFICATION_BY_ID = new Map((behaviorContract?.classifications || []).map((row) => [row.behaviorId, row]));
const HINT_BY_BEHAVIOR_ID = new Map();
for (const hint of behaviorContract?.intentHints || []) {
  for (const behaviorId of hint.sourceBehaviorIds || []) HINT_BY_BEHAVIOR_ID.set(behaviorId, hint);
}
const behaviors = Array.isArray(data)
  ? data.map((entry) => ({ ...entry, behaviorGroup: 'action' }))
  : [
      ...(data.actions || []).map((entry) => ({ ...entry, behaviorGroup: 'action' })),
      ...(data.visibility || []).map((entry) => ({ ...entry, behaviorGroup: 'visibility' })),
      ...(data.validations || []).map((entry) => ({ ...entry, behaviorGroup: 'validation' })),
      ...(data.derivations || []).map((entry) => ({ ...entry, behaviorGroup: 'derivation' })),
    ];

if (behaviorContract) {
  const behaviorIds = new Set(behaviors.map((entry) => entry.behaviorId).filter(Boolean));
  const classificationIds = new Set((behaviorContract.classifications || []).map((entry) => entry.behaviorId).filter(Boolean));
  const missing = [...behaviorIds].filter((id) => !classificationIds.has(id));
  const extra = [...classificationIds].filter((id) => !behaviorIds.has(id));
  const invalidHints = (behaviorContract.classifications || []).filter((entry) =>
    entry.tier === 'regenerable' && !HINT_BY_BEHAVIOR_ID.has(entry.behaviorId));
  if (missing.length || extra.length || invalidHints.length) {
    console.error(`[coverage] behavior contract accounting mismatch: missing=${missing.length}, extra=${extra.length}, regenerable-without-hint=${invalidHints.length}`);
    process.exit(2);
  }
}

const byScreen = new Map();
for (const behavior of behaviors) {
  if (!behavior.screen) continue;
  if (!byScreen.has(behavior.screen)) byScreen.set(behavior.screen, []);
  byScreen.get(behavior.screen).push(behavior);
}

function walkTsFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkTsFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && entry.name !== '_layout.tsx') files.push(full);
  }
  return files;
}

function candidatePaths(screenName) {
  const names = [
    `${screenName}Screen.tsx`,
    `${screenName}.tsx`,
    `${screenName}View.tsx`,
    `${screenName}.ts`,
  ];
  const out = new Set();
  if (SCREEN_FILE_BY_SOURCE.has(screenName)) out.add(SCREEN_FILE_BY_SOURCE.get(screenName));
  for (const dir of SCREEN_DIRS) {
    for (const name of names) out.add(path.join(dir, name));
  }
  for (const dir of [path.join(ROOT, 'app'), path.join(ROOT, 'app/(app)')]) {
    for (const file of walkTsFiles(dir)) {
      if (names.includes(path.basename(file))) out.add(file);
    }
  }
  if (screenName === 'App') {
    out.add(path.join(ROOT, 'src/bootstrap.ts'));
    out.add(path.join(ROOT, 'app/_layout.tsx'));
  }
  return Array.from(out);
}

function loadScreen(screenName) {
  for (const candidate of candidatePaths(screenName)) {
    if (!fs.existsSync(candidate)) continue;
    return loadFileWithLocalImports(candidate);
  }
  // Modernized routes commonly normalize `CustomerList` to
  // `customer-list.tsx`. Compare alphanumeric stems so the coverage gate does
  // not report a false missing screen solely because the native route uses
  // idiomatic kebab-case.
  const key = normalizeScreenKey(screenName);
  for (const dir of [path.join(ROOT, 'app'), path.join(ROOT, 'app/(app)')]) {
    for (const file of walkTsFiles(dir)) {
      if (normalizeScreenKey(path.basename(file).replace(/\.(tsx|ts)$/, '')) === key) {
        return loadFileWithLocalImports(file);
      }
    }
  }
  return null;
}

function normalizeScreenKey(value) {
  return String(value || '')
    .replace(/(?:Screen|View)$/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function loadFileWithLocalImports(entryFile) {
  const seen = new Set();
  function visit(file, depth) {
    if (!file || seen.has(file) || depth > 6 || !fs.existsSync(file)) return '';
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    let combined = text;
    for (const importPath of localImportPaths(text)) {
      const resolved = resolveLocalImport(file, importPath);
      if (resolved) combined += '\n' + visit(resolved, depth + 1);
    }
    return combined;
  }
  return visit(entryFile, 0);
}

function localImportPaths(text) {
  const paths = new Set();
  const patterns = [
    /from\s+['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]/g,
    /import\s*\(\s*['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) paths.add(match[1]);
  }
  return [...paths];
}

function resolveLocalImport(fromFile, importPath) {
  if (importPath.startsWith('@/') && !/^@\/features\/[A-Za-z0-9_.-]+\/workflows\/[A-Za-z0-9_./-]+$/.test(importPath)) {
    return null;
  }
  const sourceRoot = path.join(ROOT, 'src');
  const base = importPath.startsWith('@/')
    ? path.resolve(sourceRoot, importPath.slice(2))
    : path.resolve(path.dirname(fromFile), importPath);
  const allowedRoot = importPath.startsWith('@/') ? sourceRoot : ROOT;
  const relative = path.relative(allowedRoot, base);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isFile() && /\.(tsx|ts)$/.test(candidate) && path.basename(candidate) !== '_layout.tsx') {
      return candidate;
    }
  }
  return null;
}

function inferIntent(action) {
  if (action.intent) return action.intent;
  const event = String(action.event || '').toLowerCase();
  const actionType = String(action.actionType || '').toLowerCase();
  if (actionType.includes('setvar')) return 'setVar';
  if (actionType.includes('navigate')) return 'navigate';
  if (actionType.includes('notify')) return 'notify';
  if (actionType.includes('patch')) return 'patch';
  if (event === 'onselect' || event === 'oncheck' || event === 'onuncheck') return 'select';
  if (event === 'onchange') return 'setVar';
  return '';
}

function hasExactMarker(prefix, action, text) {
  if (!action.behaviorId) return true; // Backward-compatible with pre-v3 artifacts.
  const escaped = String(action.behaviorId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${prefix}:\\s*${escaped}(?![a-z0-9-])`, 'i').test(text);
}

function textAfterMarker(prefix, action, text) {
  if (!action.behaviorId) return '';
  const escaped = String(action.behaviorId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${prefix}:\\s*${escaped}(?![a-z0-9-])`, 'i').exec(text);
  if (!match) return '';
  const afterMarker = match.index + match[0].length;
  const afterCommentLine = text.indexOf('\n', afterMarker);
  if (afterCommentLine < 0) return '';
  return text.slice(afterCommentLine + 1, afterCommentLine + 2001);
}

function hasBehaviorMarker(action, text) {
  return hasExactMarker('source-behavior', action, text);
}

function hasUnsupportedMarker(action, text) {
  if (!action.behaviorId) return false;
  return hasExactMarker('source-unsupported', action, text)
    && /unsupported|unavailable|not available/i.test(textAfterMarker('source-unsupported', action, text));
}

function intentMarkerMatch(hint, text) {
  if (!hint?.hintId || !text) return null;
  const escaped = String(hint.hintId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*//\\s*source-intent:\\s*${escaped}(?![a-z0-9-])`, 'im').exec(text);
}

function textAfterIntentMarker(hint, text) {
  const marker = intentMarkerMatch(hint, text);
  if (!marker) return '';
  const lineEnd = text.indexOf('\n', marker.index + marker[0].length);
  if (lineEnd < 0) return '';
  return text.slice(lineEnd + 1, lineEnd + 2501);
}

function isIntentWired(hint, text) {
  const after = textAfterIntentMarker(hint, text);
  if (!after) return false;
  if (/^\s*(?:\/\/|\/\*)?\s*(?:TODO|placeholder|not[ -]implemented)/i.test(after)) return false;
  switch (hint.nativeIntent) {
    case 'native-navigation':
    case 'dismiss-current-surface':
      return /router\.(?:push|replace|navigate|back)\s*\(/.test(after);
    case 'native-feedback':
      return /notify(?:Success|Error)?\s*\(|Toast\.show|Snackbar|Alert\.alert|set(?:Error|Message|Status)\s*\(/.test(after);
    case 'query-refresh':
      return /invalidateQueries\s*\(|refetch\s*\(|onRefresh\s*=|refresh\s*\(/.test(after);
    case 'native-confirmation':
      return /Alert\.alert|confirm\s*\(|<Sheet\b|<Dialog\b/.test(after);
    case 'native-form-mode':
    case 'clear-transient-input':
      return /\.reset\s*\(|reset\s*\(|setValue\s*\(|router\.(?:push|replace|navigate)\s*\(/.test(after);
    case 'native-focus-or-selection':
      return /\.focus\s*\(|onPress\s*=|setSelected|setActive/.test(after);
    case 'native-control-state':
      return /disabled\s*=|editable\s*=|set[A-Z]\w*\s*\(|useMemo\s*\(/.test(after);
    case 'native-visibility-state':
      return /(?:isLoading|isPending|loading|saving|show|visible|open|expanded)\w*\s*(?:&&|\?|===)|useMemo\s*\(/i.test(after);
    case 'transient-ui-state':
      return /isPending|isLoading|loading|saving|submitting|disabled\s*=|useState\s*\(|useReducer\s*\(/i.test(after);
    case 'native-query-or-list-state':
      return /useQuery|useInfiniteQuery|useListData|useCursorListData|setQueryData|set[A-Z]\w*\s*\(/.test(after);
    case 'native-diagnostic':
      return /console\.(?:debug|info|warn|error)\s*\(/.test(after);
    case 'discard-no-side-effect':
      // The deterministic disposition itself is the implementation: the
      // source expression had no side effect and intentionally emits no code.
      return true;
    default:
      return /useState\s*\(|useMemo\s*\(|onPress\s*=|set[A-Z]\w*\s*\(/.test(after);
  }
}

function isWired(action, text) {
  if (!text) return false;
  if (!hasBehaviorMarker(action, text)) return false;
  // Stable markers are the exact accounting contract for declarative source
  // rules. Builders may emit them only next to a real visibility, validation,
  // or derivation implementation — never next to a TODO or placeholder.
  if (action.behaviorGroup !== 'action') return true;
  const name = action.name || '';
  switch (inferIntent(action)) {
    case 'patch':        return /\.(create|update)\s*\(|setAppState\([\s\S]*\bcol_/.test(text);
    case 'clearCollect': return /useInfiniteQuery|useCursorListData|setQueryData|setAppState\([\s\S]*\bcol_|\.(getAll|get)\s*\(/.test(text);
    case 'collect':      return /\.create\s*\(|setAppState\([\s\S]*\bcol_/.test(text);
    case 'clear':        return /setAppState\(\s*\{|clearFilters|reset\s*\(/.test(text);
    case 'removeIf':     return /\.delete\s*\(|removeIf|setAppState\([\s\S]*\bcol_/.test(text);
    case 'remove':       return /\.delete\s*\(|\.filter\s*\(|setAppState\(\s*\{/.test(text);
    case 'updateIf':     return /\.update\s*\(|setAppState\([\s\S]*\bcol_|\.map\s*\(/.test(text);
    case 'update':       return /\.update\s*\(/.test(text);
    case 'setVar':
      if (name && new RegExp(`setAppState\\([\\s\\S]*\\b${name}\\b`, 'i').test(text)) return true;
      return /set[A-Z]\w*\s*\(|dispatch\s*\(|setAppState\(\s*\{/.test(text);
    case 'setContext':   return /useState|useReducer|setAppState\(/.test(text);
    case 'select':       return /onPress|onSelect|onPressIn|TouchableOpacity|Pressable/.test(text);
    case 'reset':
    case 'resetForm':    return /\.reset\s*\(|set[A-Z]\w+\s*\(|setAppState\(\s*\{/.test(text);
    case 'newForm':      return /\.reset\s*\(|setAppState\(\s*\{|selected\w+Id:\s*undefined/.test(text);
    case 'navigate':     return /router\.(push|replace|back|navigate)/.test(text);
    case 'back':         return /router\.back\s*\(/.test(text);
    case 'notify':       return /notifySuccess|notifyError|notify\(|Toast\.show/.test(text);
    case 'refresh':      return /\brefresh\s*\(|onRefresh=|refetch\s*\(|invalidateQueries\s*\(/.test(text);
    case 'submitForm':   return /handleSubmit|onSubmit|router\.(push|replace|navigate)/.test(text);
    case 'flow':
    case 'flowRun':
    case 'runFlow':
    case 'flowCall':     return /FlowService|\.run\s*\(/.test(text);
    case 'launch':       return /Linking\.openURL|openBrowserAsync/.test(text);
    case 'download':
    case 'downloadJson': return /download(File|Async|Json)|shareAsync|writeAsStringAsync/.test(text);
    case 'print':        return /print(ToFile)?Async/.test(text);
    case 'read':         return /useDataSourceRows|\.get(All)?\s*\(/.test(text);
    case 'literal':
    case 'predicate-only':
    case 'dead-code-assignment':
      return true;
    default:
      return false;
  }
}

const results = [];
let failing = 0;
let criticalUnwired = 0;
let missingIntentHints = 0;
const CRITICAL_INTENTS = new Set([
  'patch', 'update', 'updateIf', 'remove', 'removeIf', 'collect',
  'navigate', 'back', 'submitForm', 'connectorCall', 'aiCall',
  'flow', 'flowRun', 'runFlow', 'flowCall',
]);
function isCriticalBehavior(behavior) {
  if (CLASSIFICATION_BY_ID.get(behavior.behaviorId)?.tier === 'regenerable') return false;
  return behavior.behaviorGroup === 'visibility'
    || behavior.behaviorGroup === 'validation'
    || (behavior.behaviorGroup === 'action' && CRITICAL_INTENTS.has(inferIntent(behavior)));
}
for (const [screen, list] of byScreen.entries()) {
  const text = loadScreen(screen);
  let implemented = 0;
  let unsupported = 0;
  let regenerated = 0;
  let screenCriticalUnwired = 0;
  let screenMissingIntentHints = 0;
  for (const action of list) {
    const classification = CLASSIFICATION_BY_ID.get(action.behaviorId);
    if (classification?.tier === 'regenerable') {
      const hint = HINT_BY_BEHAVIOR_ID.get(action.behaviorId);
      if (hint && isIntentWired(hint, text)) regenerated += 1;
      else screenMissingIntentHints += 1;
      continue;
    }
    const wiredAction = isWired(action, text);
    if (wiredAction) implemented += 1;
    else if (hasUnsupportedMarker(action, text)) unsupported += 1;
    else if (isCriticalBehavior(action)) screenCriticalUnwired += 1;
  }
  criticalUnwired += screenCriticalUnwired;
  missingIntentHints += screenMissingIntentHints;
  const accounted = implemented + unsupported + regenerated;
  const ratio = list.length === 0 ? 1 : accounted / list.length;
  results.push({ screen, total: list.length, implemented, unsupported, regenerated, accounted, ratio, hasFile: Boolean(text), criticalUnwired: screenCriticalUnwired, missingIntentHints: screenMissingIntentHints });
  if (ratio < MIN_COVERAGE || screenCriticalUnwired > 0 || screenMissingIntentHints > 0) failing += 1;
}

results.sort((a, b) => a.ratio - b.ratio);
const pct = (value) => `${(value * 100).toFixed(0)}%`;
console.log('\n=== behavior coverage ===');
console.log('screen'.padEnd(36), 'accounted/total', '  ratio');
for (const result of results) {
  const marker = result.ratio < MIN_COVERAGE || result.criticalUnwired > 0 || result.missingIntentHints > 0 ? 'x' : 'v';
  const file = result.hasFile ? '' : ' (NO SCREEN FILE)';
  const critical = result.criticalUnwired ? ` (${result.criticalUnwired} critical unwired)` : '';
  const unsupported = result.unsupported ? ` (${result.unsupported} explicit unsupported)` : '';
  const regenerated = result.regenerated ? ` (${result.regenerated} native intent)` : '';
  const missingIntent = result.missingIntentHints ? ` (${result.missingIntentHints} intent missing)` : '';
  console.log(`${marker} ${result.screen.padEnd(34)} ${String(result.accounted).padStart(4)}/${String(result.total).padEnd(4)}  ${pct(result.ratio).padStart(5)}${file}${unsupported}${regenerated}${critical}${missingIntent}`);
}
const totalBehaviors = results.reduce((sum, result) => sum + result.total, 0);
const totalAccounted = results.reduce((sum, result) => sum + result.accounted, 0);
const totalUnsupported = results.reduce((sum, result) => sum + result.unsupported, 0);
const totalRegenerated = results.reduce((sum, result) => sum + result.regenerated, 0);
console.log(`\noverall: ${totalAccounted}/${totalBehaviors}  (${pct(totalAccounted / Math.max(totalBehaviors, 1))}); explicit unsupported: ${totalUnsupported}; native intent: ${totalRegenerated}`);
console.log(`gate: MIN_COVERAGE=${pct(MIN_COVERAGE)}  failing screens: ${failing}`);
console.log(`critical behavior accounting: ${criticalUnwired === 0 ? 'PASS' : `FAIL (${criticalUnwired} unwired)`}`);
console.log(`regenerable intent accounting: ${missingIntentHints === 0 ? 'PASS' : `FAIL (${missingIntentHints} missing)`}`);

if (failing > 0) {
  console.error(`\n[coverage] ${failing} screen(s) failed coverage/core/intent accounting`);
  process.exit(1);
}
process.exit(0);
