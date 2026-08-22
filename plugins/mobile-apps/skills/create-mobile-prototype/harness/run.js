#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const checkRegistry = require('./registry');

const HARNESS_DIR = __dirname;
const CHECKS_DIR = path.join(HARNESS_DIR, 'checks');

function fail(message) {
  console.error(`prototype-harness: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { screens: [], viewport: { width: 390, height: 844 }, safeAreaBottom: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project') result.project = argv[++index];
    else if (value === '--screen') result.screens.push(argv[++index]);
    else if (value === '--check') result.check = argv[++index];
    else if (value === '--chrome') result.chrome = argv[++index];
    else if (value === '--safe-area-bottom') result.safeAreaBottom = Number(argv[++index]);
    else if (value === '--viewport') {
      const match = String(argv[++index]).match(/^(\d+)x(\d+)$/);
      if (!match) fail('--viewport must use WIDTHxHEIGHT');
      result.viewport = { width: Number(match[1]), height: Number(match[2]) };
    } else fail(`unknown argument ${value}`);
  }
  if (!result.project || !result.check) {
    fail('usage: node run.js --project <dir> --check <name> [--screen <tsx>] [--viewport 390x844]');
  }
  if (!Number.isFinite(result.safeAreaBottom) || result.safeAreaBottom < 0) {
    fail('--safe-area-bottom must be a non-negative number');
  }
  return result;
}

function walk(directory, predicate, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(entryPath, predicate, output);
    else if (predicate(entryPath)) output.push(entryPath);
  }
  return output;
}

function discoverScreens(projectDir) {
  return walk(path.join(projectDir, 'app', '(app)'), (filePath) => (
    filePath.endsWith('.tsx') && path.basename(filePath) !== '_layout.tsx'
  )).sort();
}

function collectStrings(value, output) {
  if (typeof value === 'string' && value.trim()) output.add(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
}

function seedOracle(projectDir) {
  const output = new Set();
  for (const filePath of walk(path.join(projectDir, 'src', 'generated'), (candidate) => candidate.endsWith('.seed.json'))) {
    try {
      collectStrings(JSON.parse(fs.readFileSync(filePath, 'utf8')), output);
    } catch (error) {
      fail(`${path.relative(projectDir, filePath)} is invalid JSON: ${error.message}`);
    }
  }
  return [...output];
}

function screenMetadata(projectDir, screenRelative) {
  const planPath = path.join(projectDir, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) return {};
  const markdown = fs.readFileSync(planPath, 'utf8');
  const sectionStart = markdown.indexOf('### Screen Map\n');
  if (sectionStart < 0) return {};
  const section = markdown.slice(sectionStart + '### Screen Map\n'.length).split(/^###\s/m)[0];
  const lines = section.split('\n').filter((line) => /^\s*\|/.test(line));
  if (lines.length < 3) return {};
  const parseLine = (line) => line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/^`|`$/g, ''));
  const headers = parseLine(lines[0]);
  for (const line of lines.slice(2)) {
    const cells = parseLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']));
    if (row.File === screenRelative) return row;
  }
  return {};
}

function screenSpecBody(projectDir, screenRelative) {
  const planPath = path.join(projectDir, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) return '';
  const markdown = fs.readFileSync(planPath, 'utf8');
  const headings = [...markdown.matchAll(/^#### Screen \d+ - .+$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const candidate = markdown.slice(
      headings[index].index,
      index + 1 < headings.length ? headings[index + 1].index : markdown.length,
    );
    if (candidate.includes(`**File:** \`${screenRelative}\``) || candidate.includes(`**File** — \`${screenRelative}\``)) return candidate;
  }
  return '';
}

function conditionalContracts(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const metadata = screenMetadata(projectDir, screenRelative);
  const line = (name) => body.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'))?.[1] || '';
  const parts = (name) => line(name).split(';').map((part) => part.trim()).filter(Boolean);
  const visibility = parts('Field visibility').map((part) => {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_]*)=([A-Za-z][A-Za-z0-9_]*)\s+in\s+\(([^)]+)\)$/);
    if (!match) fail(`invalid Field visibility entry for ${screenRelative}: ${part}`);
    return { field: match[1], stateField: match[2], states: match[3].split(/[|,]/).map((state) => state.trim()).filter(Boolean) };
  });
  const warnings = parts('Warning remedies').map((part) => {
    const match = part.match(/^([a-z][a-z0-9-]*)\s*->\s*([a-z][a-z0-9-]*)$/i);
    if (!match) fail(`invalid Warning remedies entry for ${screenRelative}: ${part}`);
    return { warning: match[1], remedy: match[2] };
  });
  const inputs = parts('Input roles').map((part) => {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_]*)=([a-z][a-z0-9-]*)\s*->\s*([a-z][a-z0-9-]*)$/i);
    if (!match) fail(`invalid Input roles entry for ${screenRelative}: ${part}`);
    return { field: match[1], role: match[2], control: match[3] };
  });
  const iconParts = [...parts('Entity icons')];
  if (metadata['Entity icon'] && !['-', '—'].includes(metadata['Entity icon'])) iconParts.push(metadata['Entity icon']);
  const icons = [...new Set(iconParts)].map((part) => {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_]*)=([a-z][a-z0-9-]*)$/i);
    if (!match) fail(`invalid Entity icon entry for ${screenRelative}: ${part}`);
    return { entity: match[1], icon: match[2] };
  });
  return { visibility, warnings, inputs, icons };
}

function sortOptions(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const value = body.match(/^- \*\*Sort options:\*\*\s*(.+)$/m)?.[1] || '';
  if (!value) return [];
  const options = value.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(asc|desc)=([^()]+?)(\s+\(default\))?$/i);
    if (!match) fail(`invalid Sort options entry for ${screenRelative}: ${part}`);
    return { field: match[1], direction: match[2].toLowerCase(), label: match[3].trim(), default: Boolean(match[4]) };
  });
  if (options.filter((option) => option.default).length !== 1) fail(`Sort options for ${screenRelative} must declare exactly one default`);
  return options;
}

function batchActions(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const value = body.match(/^- \*\*Batch actions:\*\*\s*(.+)$/m)?.[1] || '';
  if (!value) return [];
  return value.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^([a-z][a-z0-9-]*)=([^()]+?)(\s+\(destructive\))?$/i);
    if (!match) fail(`invalid Batch actions entry for ${screenRelative}: ${part}`);
    return { key: match[1], label: match[2].trim(), destructive: Boolean(match[3]) };
  });
}

function carouselContract(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const value = body.match(/^- \*\*Carousel:\*\*\s*(.+)$/m)?.[1] || '';
  if (!value) return null;
  const match = value.match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*);\s*items=(\d+)$/);
  if (!match) fail(`invalid Carousel entry for ${screenRelative}: ${value}`);
  const metadata = screenMetadata(projectDir, screenRelative);
  return {
    entity: match[1],
    field: match[2],
    items: Number(match[3]),
    queue: /queue|triage/i.test(`${metadata.Screen || ''} ${metadata.Purpose || ''} ${body}`),
  };
}

function heroContract(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const key = body.match(/^- \*\*Hero:\*\*\s*(state-hero|metric-hero|media-hero|queue-hero)\s*$/m)?.[1] || null;
  return key ? { key } : null;
}

function chartContract(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const value = body.match(/^- \*\*Chart:\*\*\s*(.+)$/m)?.[1] || '';
  if (!value) return null;
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const kind = parts.shift();
  if (!['sparkline', 'series-chart'].includes(kind)) fail(`invalid Chart kind for ${screenRelative}: ${kind}`);
  const values = Object.fromEntries(parts.map((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) fail(`invalid Chart entry for ${screenRelative}: ${part}`);
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const points = Number(values.points);
  if (!values.x || !values.y || !Number.isInteger(points) || points < 1 || points > 12 || !values.caption) fail(`Chart for ${screenRelative} requires x, y, points 1..12, and caption`);
  const form = kind === 'sparkline' ? 'sparkline' : values.form;
  if (kind === 'series-chart' && !['bar', 'area'].includes(form)) fail(`series-chart for ${screenRelative} requires form=bar|area`);
  return { kind, form, x: values.x, y: values.y, points, caption: values.caption, empty: values.empty || '' };
}

function cardinalityExpectations(projectDir, screenRelative) {
  const body = screenSpecBody(projectDir, screenRelative);
  const cardinalityLine = body.match(/^- \*\*Cardinality:\*\*\s*(.+)$/m)?.[1] || '';
  if (!cardinalityLine) return [];
  let rowCount = null;
  const vocabularyPath = path.join(projectDir, '.tmp', 'seed-vocabulary.json');
  if (fs.existsSync(vocabularyPath)) rowCount = Number(JSON.parse(fs.readFileSync(vocabularyPath, 'utf8')).rowCount);
  const choiceCounts = new Map();
  const contractPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
  if (fs.existsSync(contractPath)) {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    for (const table of contract.tables || []) {
      for (const column of table.columns || []) {
        if (Array.isArray(column.options)) choiceCounts.set(column.logicalName, column.options.length);
      }
    }
  }
  return cardinalityLine.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_-]*)=(\d+)\s*->\s*([a-z0-9-]+)(?:\s+because\s+(.+))?$/i);
    if (!match) fail(`invalid Cardinality entry for ${screenRelative}: ${part}`);
    const element = match[1];
    const plannedCount = Number(match[2]);
    const choiceName = element.startsWith('choice-') ? element.slice('choice-'.length) : null;
    const schemaChoiceCount = choiceName ? choiceCounts.get(choiceName) : null;
    const count = element === 'listRows' && Number.isInteger(rowCount)
      ? rowCount
      : Number.isInteger(schemaChoiceCount)
        ? schemaChoiceCount
        : plannedCount;
    const source = element === 'listRows' && Number.isInteger(rowCount)
      ? 'seed-vocabulary'
      : Number.isInteger(schemaChoiceCount)
        ? 'schema-contract'
        : 'plan';
    return {
      element,
      count,
      declaredPattern: match[3],
      overrideReason: match[4] || '',
      source,
    };
  });
}

function discoverProviders(projectDir) {
  const barrelPath = path.join(projectDir, 'src', 'hooks', 'index.ts');
  if (!fs.existsSync(barrelPath)) return [];
  const source = fs.readFileSync(barrelPath, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const nameMatch of match[1].matchAll(/\b([A-Z][A-Za-z0-9]*Provider)\b/g)) names.add(nameMatch[1]);
  }
  return [...names];
}

function resolveFile(basePath) {
  for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, `${basePath}.js`, path.join(basePath, 'index.ts'), path.join(basePath, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function aliasPlugin(projectDir) {
  const aliases = new Map([
    ['react', require.resolve('react', { paths: [projectDir] })],
    ['react/jsx-runtime', require.resolve('react/jsx-runtime', { paths: [projectDir] })],
    ['react-native', require.resolve('react-native-web', { paths: [projectDir] })],
    ['react-native-safe-area-context', path.join(HARNESS_DIR, 'shims', 'safe-area-context.jsx')],
    ['react-native-reanimated', path.join(HARNESS_DIR, 'shims', 'react-native-reanimated.jsx')],
    ['react-native-gesture-handler', path.join(HARNESS_DIR, 'shims', 'react-native-gesture-handler.jsx')],
    ['expo-router', path.join(HARNESS_DIR, 'shims', 'expo-router.jsx')],
    ['expo-status-bar', path.join(HARNESS_DIR, 'shims', 'expo-status-bar.jsx')],
    ['expo-linear-gradient', path.join(HARNESS_DIR, 'shims', 'expo-linear-gradient.jsx')],
    ['@expo/vector-icons', path.join(HARNESS_DIR, 'shims', 'vector-icons.jsx')],
    ['@microsoft/power-apps-native-host', path.join(HARNESS_DIR, 'shims', 'power-apps-native-host.jsx')],
  ]);
  return {
    name: 'prototype-harness-aliases',
    setup(build) {
      build.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: aliases.get(args.path) }));
      build.onResolve({ filter: /^(react-native|react-native-safe-area-context|react-native-reanimated|react-native-gesture-handler|expo-router|expo-status-bar|expo-linear-gradient|@expo\/vector-icons|@microsoft\/power-apps-native-host)(?:\/.*)?$/ }, (args) => ({
        path: aliases.get(args.path) || aliases.get(args.path.split('/').slice(0, args.path.startsWith('@') ? 2 : 1).join('/')),
      }));
      build.onResolve({ filter: /^@\// }, (args) => {
        const resolved = resolveFile(path.join(projectDir, 'src', args.path.slice(2)));
        return resolved ? { path: resolved } : null;
      });
    },
  };
}

function snapshotRuntime() {
  return `
function directText(element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || '')
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function effectiveBackground(element) {
  let current = element;
  while (current) {
    const value = getComputedStyle(current).backgroundColor;
    if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return value;
    current = current.parentElement;
  }
  return 'rgb(255, 255, 255)';
}

function effectiveVisibleRect(element) {
  const own = element.getBoundingClientRect();
  let left = own.left;
  let top = own.top;
  let right = own.right;
  let bottom = own.bottom;
  let current = element.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    const clipsX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
    const clipsY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY);
    if (clipsX || clipsY) {
      const rect = current.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (clipsY) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }
    current = current.parentElement;
  }
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function captureSnapshot() {
  const elements = Array.from(document.querySelectorAll('body *'));
  const indexes = new Map(elements.map((element, index) => [element, index]));
  return {
    errors: globalThis.__HARNESS_ERRORS || [],
    viewport: { width: innerWidth, height: innerHeight },
    elements: elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const visibleRect = effectiveVisibleRect(element);
      const style = getComputedStyle(element);
      const role = element.getAttribute('role') || '';
      const testId = element.getAttribute('data-testid') || '';
      const attributes = Object.fromEntries(Array.from(element.attributes)
        .filter((attribute) => attribute.name.startsWith('data-'))
        .map((attribute) => [attribute.name, attribute.value]));
      return {
        id: index,
        parentId: indexes.has(element.parentElement) ? indexes.get(element.parentElement) : null,
        tag: element.tagName.toLowerCase(),
        testId,
        role,
        text: directText(element),
        ariaLabel: element.getAttribute('aria-label') || '',
        src: element.getAttribute('src') || '',
        attributes,
        harnessIcon: element.getAttribute('data-harness-icon') || '',
        rendered: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0,
        visible: visibleRect.width > 0 && visibleRect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0,
        interactive: ['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName.toLowerCase()) || ['button', 'link', 'checkbox', 'switch', 'textbox'].includes(role) || testId.startsWith('cta-'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        visibleRect,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        style: {
          backgroundColor: effectiveBackground(element),
          ownBackgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderRadius: style.borderRadius,
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          overflow: style.overflow,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          bottom: style.bottom,
          paddingBottom: style.paddingBottom,
          position: style.position,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          webkitLineClamp: style.webkitLineClamp,
          zIndex: style.zIndex,
        },
      };
    }),
  };
}

function publishSnapshot() {
  try {
    const json = JSON.stringify(captureSnapshot());
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    document.querySelector('#harness-snapshot').setAttribute('data-value', btoa(binary));
  } catch (error) {
    document.querySelector('#harness-snapshot').setAttribute('data-error', String(error && error.stack || error));
  }
}
`;
}

function entrySource(projectDir, screenPaths, options) {
  const configPath = path.join(projectDir, 'tamagui.config.ts');
  if (!fs.existsSync(configPath)) fail('tamagui.config.ts is required for direct component rendering');
  const providers = discoverProviders(projectDir);
  const providerImport = providers.length > 0 ? `import { ${providers.join(', ')} } from '@/hooks';` : '';
  const screenImports = screenPaths.map((screenPath, index) => `import Screen${index} from ${JSON.stringify(screenPath)};`).join('\n');
  const screenMap = screenPaths.map((screenPath, index) => `${JSON.stringify(path.relative(projectDir, screenPath).split(path.sep).join('/'))}: Screen${index}`).join(',\n');
  const wrappedScreen = providers.reduceRight((child, provider) => `<${provider}>${child}</${provider}>`, '<Screen />');
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TamaguiProvider } from 'tamagui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import tamaguiConfig from ${JSON.stringify(configPath)};
${screenImports}
${providerImport}

const screens = { ${screenMap} };
const screenKey = new URLSearchParams(location.search).get('screen');
const Screen = screens[screenKey] || Object.values(screens)[0];

globalThis.__HARNESS_ERRORS = globalThis.__HARNESS_ERRORS || [];
addEventListener('error', (event) => globalThis.__HARNESS_ERRORS.push(String(event.error?.stack || event.message)));
addEventListener('unhandledrejection', (event) => globalThis.__HARNESS_ERRORS.push(String(event.reason?.stack || event.reason)));

class HarnessBoundary extends React.Component {
  componentDidCatch(error) { globalThis.__HARNESS_ERRORS.push(String(error?.stack || error)); }
  render() { return this.props.children; }
}

${snapshotRuntime()}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const root = createRoot(document.querySelector('#root'));
flushSync(() => root.render(
    <HarnessBoundary>
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: ${options.viewport.width}, height: ${options.viewport.height} }, insets: { top: 0, right: 0, bottom: ${options.safeAreaBottom}, left: 0 } }}>
        <QueryClientProvider client={queryClient}>
          <TamaguiProvider config={tamaguiConfig} defaultTheme="light">
            ${wrappedScreen}
          </TamaguiProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </HarnessBoundary>,
  ));
publishSnapshot();
setTimeout(publishSnapshot, 1000);
`;
}

function chromePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function decodeSnapshot(html) {
  const match = html.match(/<meta\s+id="harness-snapshot"\s+data-value="([A-Za-z0-9+/=]+)"/);
  if (!match) {
    const error = html.match(/<meta\s+id="harness-snapshot"[^>]*data-error="([^"]+)"/);
    throw new Error(error ? error[1] : 'browser did not publish a harness snapshot');
  }
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

function requestJson(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`Chrome HTTP ${response.statusCode}: ${body}`));
        else { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function launchChrome(chrome, userDataDir, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--allow-file-access-from-files',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      `--window-size=${options.viewport.width},${options.viewport.height}`, 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Chrome DevTools did not start: ${output}`)); }, 10000);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timeout); resolve({ child, port: Number(match[1]) }); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('exit', (code) => { if (!output.includes('DevTools listening')) { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}: ${output}`)); } });
  });
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); });
    this.socket.addEventListener('message', (message) => {
      const payload = JSON.parse(message.data);
      if (!payload.id || !this.pending.has(payload.id)) return;
      const { resolve, reject } = this.pending.get(payload.id); this.pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message)); else resolve(payload.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.socket.close(); }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function capturePage(port, url, options, { screenshot = true } = {}) {
  const target = await requestJson(port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: 1, mobile: false });
    let html = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await client.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      html = result.result.value || '';
      if (/id="harness-snapshot"[^>]+data-(?:value|error)="[^"]+"/.test(html)) break;
      await wait(100);
    }
    const image = screenshot ? (await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data : null;
    return { html, image: image ? Buffer.from(image, 'base64') : null };
  } finally {
    client.close();
    await requestJson(port, `/json/close/${target.id}`).catch(() => {});
  }
}

async function writeContactSheet(port, outputDir, captures, options, projectDir) {
  const columns = Math.min(3, Math.max(1, captures.length));
  const width = columns * options.viewport.width;
  const rows = Math.ceil(captures.length / columns);
  const html = `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${columns},${options.viewport.width}px);gap:12px;padding:12px;color:white;font:14px sans-serif}.item{display:grid;gap:6px}.label{overflow:hidden;white-space:nowrap}.item img{width:${options.viewport.width}px;height:${options.viewport.height}px;object-fit:cover;object-position:top;background:white}</style></head><body>${captures.map((capture) => `<div class="item"><div class="label">${capture.screenRelative}</div><img src="data:image/png;base64,${capture.image.toString('base64')}"></div>`).join('')}</body></html>`;
  const filePath = path.join(outputDir, 'contact-sheet.html');
  fs.writeFileSync(filePath, html);
  const target = await requestJson(port, `/json/new?${encodeURIComponent(pathToFileURL(filePath).href)}`, 'PUT');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: width + 24, height: rows * (options.viewport.height + 30) + 24, deviceScaleFactor: 1, mobile: false });
    await wait(300);
    const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const destination = path.join(projectDir, '.tmp', 'prototype-harness-contact-sheet.png');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(result.data, 'base64'));
    return destination;
  } finally {
    client.close();
    await requestJson(port, `/json/close/${target.id}`).catch(() => {});
  }
}

async function renderScreens(esbuild, projectDir, screenPaths, options, chrome) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-harness-render-'));
  const userDataDir = path.join(outputDir, 'chrome-profile');
  let browser;
  try {
    const bundlePath = path.join(outputDir, 'bundle.js');
    await esbuild.build({
      absWorkingDir: projectDir,
      bundle: true,
      define: { 'process.env.NODE_ENV': JSON.stringify('test') },
      format: 'iife',
      jsx: 'automatic',
      loader: { '.png': 'dataurl', '.ttf': 'dataurl' },
      logLevel: 'silent',
      outfile: bundlePath,
      platform: 'browser',
      plugins: [aliasPlugin(projectDir)],
      stdin: { contents: entrySource(projectDir, screenPaths, options), loader: 'tsx', resolveDir: projectDir, sourcefile: 'prototype-harness-entry.tsx' },
      banner: { js: 'globalThis.process = globalThis.process || { env: {} }; globalThis.global = globalThis;' },
    });
    fs.writeFileSync(path.join(outputDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta id="harness-snapshot" data-value=""><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}*{box-sizing:border-box}</style><script>globalThis.__HARNESS_ERRORS=[];addEventListener('error',function(event){globalThis.__HARNESS_ERRORS.push(String(event.error&&event.error.stack||event.message));document.querySelector('#harness-snapshot').setAttribute('data-error',globalThis.__HARNESS_ERRORS.join(' | '));});addEventListener('unhandledrejection',function(event){globalThis.__HARNESS_ERRORS.push(String(event.reason&&event.reason.stack||event.reason));document.querySelector('#harness-snapshot').setAttribute('data-error',globalThis.__HARNESS_ERRORS.join(' | '));});</script></head><body><div id="root"></div><script src="./bundle.js"></script></body></html>`);
    browser = await launchChrome(chrome, userDataDir, options);
    const captures = [];
    for (const screenPath of screenPaths) {
      const screenRelative = path.relative(projectDir, screenPath).split(path.sep).join('/');
      const url = `${pathToFileURL(path.join(outputDir, 'index.html')).href}?screen=${encodeURIComponent(screenRelative)}`;
      const captured = await capturePage(browser.port, url, options);
      captures.push({ screenPath, screenRelative, snapshot: decodeSnapshot(captured.html), image: captured.image });
    }
    const contactSheet = await writeContactSheet(browser.port, outputDir, captures, options, projectDir);
    return { captures, contactSheet };
  } finally {
    if (browser?.child && browser.child.exitCode === null) {
      const exited = new Promise((resolve) => browser.child.once('exit', resolve));
      browser.child.kill('SIGTERM');
      await Promise.race([exited, wait(1000)]);
      if (browser.child.exitCode === null) {
        browser.child.kill('SIGKILL');
        await Promise.race([exited, wait(1000)]);
      }
    }
    fs.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = checkRegistry.load();
  const projectDir = path.resolve(options.project);
  const entries = options.check === 'all'
    ? registry.filter((candidate) => candidate.tier === 2)
    : [checkRegistry.resolve(registry, options.check)];
  if (entries.some((entry) => !entry)) fail(`unknown or unregistered check ${options.check}`);
  if (entries.some((entry) => entry.tier !== 2)) fail(`${entries.find((entry) => entry.tier !== 2).id} is not a render-tier check`);
  const chrome = chromePath(options.chrome);
  if (!chrome) fail('Chrome is required; pass --chrome or set CHROME_PATH');
  let esbuild;
  try {
    esbuild = require(require.resolve('esbuild', { paths: [projectDir] }));
  } catch {
    fail('esbuild must be installed in the generated project');
  }
  const screens = options.screens.length > 0
    ? options.screens.map((screen) => path.resolve(projectDir, screen))
    : discoverScreens(projectDir);
  if (screens.length === 0) fail('no signed-in screen files were found');
  const brandTokenPath = path.join(projectDir, 'brand', 'tokens.ts');
  const baseContext = {
    projectDir,
    safeAreaBottom: options.safeAreaBottom,
    seedTexts: seedOracle(projectDir),
    brandTokenSource: fs.existsSync(brandTokenPath) ? fs.readFileSync(brandTokenPath, 'utf8') : '',
  };
  for (const screen of screens) if (!fs.existsSync(screen)) fail(`screen not found: ${screen}`);
  const renderedResult = await renderScreens(esbuild, projectDir, screens, options, chrome);
  console.log(`prototype-harness: CONTACT SHEET ${renderedResult.contactSheet}`);
  const rendered = renderedResult.captures.map(({ screenPath, screenRelative, snapshot }) => ({
    snapshot,
    context: {
      ...baseContext,
      screenPath,
      screenRelative,
      screenMeta: screenMetadata(projectDir, screenRelative),
      cardinalityExpectations: cardinalityExpectations(projectDir, screenRelative),
      conditionalContracts: conditionalContracts(projectDir, screenRelative),
      sortOptions: sortOptions(projectDir, screenRelative),
      batchActions: batchActions(projectDir, screenRelative),
      carouselContract: carouselContract(projectDir, screenRelative),
      chartContract: chartContract(projectDir, screenRelative),
      heroContract: heroContract(projectDir, screenRelative),
    },
  }));
  const renderFailures = rendered.flatMap((item) => item.snapshot.errors.map((error) => `${item.context.screenRelative}: render error: ${error}`));
  if (renderFailures.length > 0) fail(`render failed\n- ${renderFailures.join('\n- ')}`);

  const blockingFailures = [];
  for (const entry of entries) {
    const check = require(path.join(CHECKS_DIR, `${entry.module}.js`));
    if ((check.scope || 'screen') !== entry.scope) fail(`${entry.id} scope disagrees with its module`);
    const failures = [];
    const inspect = (result, label) => {
      if (result.notRun) {
        console.log(`prototype-harness: NOT RUN ${entry.id} ${label} reason=${JSON.stringify(result.failures.join('; '))}`);
        failures.push(`${label}: NOT RUN: ${result.failures.join('; ')}`);
      } else if (!result.pass) failures.push(`${label}: ${result.failures.join('; ')}`);
      else if (result.reportOnly || entry.scope === 'app') console.log(`prototype-harness: REPORT ${entry.id} ${label} details=${JSON.stringify(result.report || {})}`);
      else console.log(`prototype-harness: PASS ${entry.id} ${label}`);
    };
    if (entry.scope === 'app') inspect(check.runApp(rendered, baseContext), 'app');
    else for (const item of rendered) inspect(check.run(item.snapshot, item.context), item.context.screenRelative);
    if (failures.length > 0) {
      if (entry.blocking) blockingFailures.push(`${entry.id}: ${failures.join(' | ')}`);
      else console.log(`prototype-harness: REPORT ${entry.id} non-blocking findings=${JSON.stringify(failures)}`);
    }
  }
  if (blockingFailures.length > 0) fail(`blocking checks failed\n- ${blockingFailures.join('\n- ')}`);
}

if (require.main === module) main().catch((error) => fail(error.stack || error.message));

module.exports = { batchActions, cardinalityExpectations, carouselContract, chartContract, collectStrings, conditionalContracts, decodeSnapshot, discoverProviders, discoverScreens, entrySource, heroContract, parseArgs, renderScreens, screenMetadata, screenSpecBody, seedOracle, sortOptions };