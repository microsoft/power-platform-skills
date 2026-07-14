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
const pluginInputPath = path.join(ROOT, 'mobile-plugin-input.json');
if (fs.existsSync(pluginInputPath)) {
  const pluginInput = JSON.parse(fs.readFileSync(pluginInputPath, 'utf8'));
  for (const screen of pluginInput.screenPlan?.screens || []) {
    if (!screen?.name || typeof screen.file !== 'string') continue;
    const resolved = path.resolve(ROOT, screen.file);
    const relative = path.relative(ROOT, resolved);
    const contained = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (contained) SCREEN_FILE_BY_SOURCE.set(screen.name, resolved);
  }
}
const behaviors = Array.isArray(data)
  ? data.map((entry) => ({ ...entry, behaviorGroup: 'action' }))
  : [
      ...(data.actions || []).map((entry) => ({ ...entry, behaviorGroup: 'action' })),
      ...(data.visibility || []).map((entry) => ({ ...entry, behaviorGroup: 'visibility' })),
      ...(data.validations || []).map((entry) => ({ ...entry, behaviorGroup: 'validation' })),
      ...(data.derivations || []).map((entry) => ({ ...entry, behaviorGroup: 'derivation' })),
    ];

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
    /from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) paths.add(match[1]);
  }
  return [...paths];
}

function resolveLocalImport(fromFile, importPath) {
  const base = path.resolve(path.dirname(fromFile), importPath);
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
const CRITICAL_INTENTS = new Set([
  'patch', 'update', 'updateIf', 'remove', 'removeIf', 'collect',
  'navigate', 'back', 'submitForm', 'connectorCall', 'aiCall',
  'flow', 'flowRun', 'runFlow', 'flowCall',
]);
function isCriticalBehavior(behavior) {
  return behavior.behaviorGroup === 'visibility'
    || behavior.behaviorGroup === 'validation'
    || (behavior.behaviorGroup === 'action' && CRITICAL_INTENTS.has(inferIntent(behavior)));
}
for (const [screen, list] of byScreen.entries()) {
  const text = loadScreen(screen);
  let implemented = 0;
  let unsupported = 0;
  let screenCriticalUnwired = 0;
  for (const action of list) {
    const wiredAction = isWired(action, text);
    if (wiredAction) implemented += 1;
    else if (hasUnsupportedMarker(action, text)) unsupported += 1;
    else if (isCriticalBehavior(action)) screenCriticalUnwired += 1;
  }
  criticalUnwired += screenCriticalUnwired;
  const accounted = implemented + unsupported;
  const ratio = list.length === 0 ? 1 : accounted / list.length;
  results.push({ screen, total: list.length, implemented, unsupported, accounted, ratio, hasFile: Boolean(text), criticalUnwired: screenCriticalUnwired });
  if (ratio < MIN_COVERAGE || screenCriticalUnwired > 0) failing += 1;
}

results.sort((a, b) => a.ratio - b.ratio);
const pct = (value) => `${(value * 100).toFixed(0)}%`;
console.log('\n=== behavior coverage ===');
console.log('screen'.padEnd(36), 'accounted/total', '  ratio');
for (const result of results) {
  const marker = result.ratio < MIN_COVERAGE || result.criticalUnwired > 0 ? 'x' : 'v';
  const file = result.hasFile ? '' : ' (NO SCREEN FILE)';
  const critical = result.criticalUnwired ? ` (${result.criticalUnwired} critical unwired)` : '';
  const unsupported = result.unsupported ? ` (${result.unsupported} explicit unsupported)` : '';
  console.log(`${marker} ${result.screen.padEnd(34)} ${String(result.accounted).padStart(4)}/${String(result.total).padEnd(4)}  ${pct(result.ratio).padStart(5)}${file}${unsupported}${critical}`);
}
const totalBehaviors = results.reduce((sum, result) => sum + result.total, 0);
const totalAccounted = results.reduce((sum, result) => sum + result.accounted, 0);
const totalUnsupported = results.reduce((sum, result) => sum + result.unsupported, 0);
console.log(`\noverall: ${totalAccounted}/${totalBehaviors}  (${pct(totalAccounted / Math.max(totalBehaviors, 1))}); explicit unsupported: ${totalUnsupported}`);
console.log(`gate: MIN_COVERAGE=${pct(MIN_COVERAGE)}  failing screens: ${failing}`);
console.log(`critical behavior accounting: ${criticalUnwired === 0 ? 'PASS' : `FAIL (${criticalUnwired} unwired)`}`);

if (failing > 0) {
  console.error(`\n[coverage] ${failing} screen(s) below ${pct(MIN_COVERAGE)} gate`);
  process.exit(1);
}
process.exit(0);
