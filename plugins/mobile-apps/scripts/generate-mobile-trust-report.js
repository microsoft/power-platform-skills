#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml, splitSections } = require('./render-mobile-plan');

const CAPABILITIES = [
  { id: 'camera', label: 'Camera / barcode capture', pattern: /\b(expo-camera|CameraView|BarcodeScanner|barcodeTypes?)\b/i, permission: 'Requested on demand when the user starts a capture or scan.' },
  { id: 'photos', label: 'Photo library', pattern: /\b(expo-image-picker|launchImageLibraryAsync)\b/i, permission: 'Requested only when the user chooses an existing photo.' },
  { id: 'location', label: 'Location', pattern: /\b(expo-location|LocationObject|startLocationUpdatesAsync)\b/i, permission: 'Location access must be associated with a visible workflow and its approved scope.' },
  { id: 'notifications', label: 'Notifications', pattern: /\b(expo-notifications|requestPermissionsAsync\(\).+notification)\b/is, permission: 'Requested only when the app exposes an approved notification workflow.' },
  { id: 'microphone', label: 'Microphone / audio', pattern: /\b(expo-audio|expo-av|Audio\.Recording|requestRecordingPermissionsAsync)\b/i, permission: 'Requested only when the user starts an approved recording workflow.' },
  { id: 'contacts', label: 'Contacts', pattern: /\b(expo-contacts|getContactsAsync)\b/i, permission: 'Requested only from an explicit contact-selection workflow.' },
  { id: 'calendar', label: 'Calendar', pattern: /\b(expo-calendar|getCalendarsAsync)\b/i, permission: 'Requested only from an explicit calendar workflow.' },
  { id: 'documents', label: 'Documents / files', pattern: /\b(expo-document-picker|getDocumentAsync|expo-file-system)\b/i, permission: 'File access is user initiated or limited to app-owned storage.' },
  { id: 'sharing', label: 'System sharing', pattern: /\b(expo-sharing|Sharing\.shareAsync)\b/i, permission: 'The platform share sheet opens only after an explicit user action.' },
  { id: 'secure-storage', label: 'Secure storage', pattern: /\b(expo-secure-store|SecureStore)\b/i, permission: 'Stores app secrets or tokens in platform-protected storage; never include them in this report.' },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.expo', 'dist', 'build']);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function walkFiles(root, relative = '') {
  const current = path.join(root, relative);
  if (!fs.existsSync(current)) return [];
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.datamodel-manifest.json') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const nextRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, nextRelative));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name === '.datamodel-manifest.json') {
      files.push(nextRelative);
    }
  }
  return files;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sectionText(markdown, titlePattern) {
  const section = splitSections(markdown).find((item) => titlePattern.test(item.title));
  return section ? section.body : '';
}

function analyzeProject(projectRoot, planMarkdown = '') {
  const sourceFiles = walkFiles(projectRoot).filter((file) =>
    /^(app|src|brand)[/\\]/.test(file) || ['app.config.js', 'auth.config.json', 'offline-profile.json', '.datamodel-manifest.json'].includes(file));
  const evidence = [];
  for (const file of sourceFiles) {
    const fullPath = path.join(projectRoot, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      evidence.push({ file, content });
    } catch {
      // Binary or unreadable files are outside this static source report.
    }
  }

  const nativePlan = sectionText(planMarkdown, /Native Capabilities/i);
  const connectorPlan = sectionText(planMarkdown, /Connectors/i);
  const capabilities = CAPABILITIES.map((capability) => {
    const matches = evidence.filter((item) => capability.pattern.test(item.content));
    const planned = capability.pattern.test(nativePlan);
    return {
      ...capability,
      state: matches.length ? 'used' : planned ? 'planned' : 'not-used',
      evidence: matches.slice(0, 4).map((item) => item.file),
    };
  });

  const executableEvidence = evidence.filter((item) => /\.(?:[jt]sx?)$/.test(item.file));
  const backgroundPatterns = /\b(defineTask|TaskManager|BackgroundFetch|startLocationUpdatesAsync|setNotificationHandler)\b/i;
  const backgroundEvidence = executableEvidence.filter((item) => backgroundPatterns.test(item.content)).map((item) => item.file);
  const directNetworkEvidence = executableEvidence
    .filter((item) => !/^src[/\\]generated[/\\]/.test(item.file))
    .filter((item) => /(^|[^\w])fetch\s*\(|\baxios\.|\bXMLHttpRequest\b/im.test(item.content))
    .map((item) => item.file);

  const offline = readJson(path.join(projectRoot, 'offline-profile.json'));
  const manifest = readJson(path.join(projectRoot, '.datamodel-manifest.json'));
  const auth = readJson(path.join(projectRoot, 'auth.config.json'));
  const generatedServices = sourceFiles.filter((file) => /^src[/\\]generated[/\\]services[/\\]/.test(file));

  return {
    generatedAt: new Date().toISOString(),
    capabilities,
    backgroundEvidence,
    directNetworkEvidence,
    connectorPlan,
    hasDataverse: Boolean(manifest || generatedServices.length),
    generatedServiceCount: generatedServices.length,
    offline: offline ? {
      configured: true,
      tableCount: Array.isArray(offline.tables) ? offline.tables.length : 0,
    } : { configured: false, tableCount: 0 },
    authenticationConfigured: Boolean(auth && auth.msal && auth.msal.clientId),
    evidenceFiles: sourceFiles.length,
  };
}

function renderReport(report) {
  const used = report.capabilities.filter((item) => item.state === 'used');
  const notUsed = report.capabilities.filter((item) => item.state === 'not-used');
  const capabilityCards = report.capabilities.map((item) => `
    <article class="capability ${item.state}">
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.state)}</span></div>
      <p>${escapeHtml(item.permission)}</p>
      ${item.evidence.length ? `<code>${escapeHtml(item.evidence.join(', '))}</code>` : ''}
    </article>`).join('');
  const backgroundSummary = report.backgroundEvidence.length
    ? `Background-capable APIs were found in ${report.backgroundEvidence.join(', ')}. Review their runtime configuration before release.`
    : 'No app-created background task, background fetch, or continuous location registration was found.';
  const networkSummary = report.directNetworkEvidence.length
    ? `Direct network code was found outside generated services in ${report.directNetworkEvidence.join(', ')}. Verify every endpoint and data boundary.`
    : report.hasDataverse
      ? `Business data uses generated Dataverse services (${report.generatedServiceCount} service files detected); no direct external network code was found outside generated services.`
      : 'No generated Dataverse services or direct external network code was found.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mobile app trust report</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f4f7fb;color:#172033}*{box-sizing:border-box}body{margin:0}
header{background:#12395b;color:white;padding:36px max(24px,calc((100vw - 1200px)/2))}header h1{font-size:36px;margin:0 0 8px}header p{max-width:760px;color:#dbeafe}
main{max-width:1200px;margin:auto;padding:24px;display:grid;gap:18px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.summary article,section{background:white;border:1px solid #dbe3ec;border-radius:14px;padding:18px}.summary strong{display:block;font-size:26px;color:#0f5f9d}.summary span{color:#64748b;font-size:12px}
h2{margin-top:0}.capabilities{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.capability{border:1px solid #dbe3ec;border-left:5px solid #94a3b8;border-radius:10px;padding:12px}.capability.used{border-left-color:#16a34a}.capability.planned{border-left-color:#2563eb}.capability>div{display:flex;justify-content:space-between;gap:12px}.capability span{text-transform:uppercase;font-size:11px;font-weight:800}.capability p{color:#475569}.capability code{font-size:11px;word-break:break-word}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.good{border-left:5px solid #16a34a}.review{border-left:5px solid #d97706}li{margin:8px 0;color:#334155}.footer{font-size:12px;color:#64748b}@media(max-width:760px){.summary,.grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.summary,.grid{grid-template-columns:1fr}}
</style></head><body><header><h1>Purposeful access. Nothing extra.</h1><p>Static evidence report for device capabilities, permissions, data boundaries, offline behavior, background work, and resource-conscious defaults.</p></header>
<main>
  <div class="summary">
    <article><strong>${used.length}</strong><span>Capabilities used</span></article>
    <article><strong>${notUsed.length}</strong><span>Capabilities not used</span></article>
    <article><strong>${report.offline.configured ? report.offline.tableCount : 0}</strong><span>Offline tables</span></article>
    <article><strong>${report.authenticationConfigured ? 'Ready' : 'Pending'}</strong><span>Authentication</span></article>
  </div>
  <section><h2>Device capability inventory</h2><div class="capabilities">${capabilityCards}</div></section>
  <div class="grid">
    <section class="${report.backgroundEvidence.length ? 'review' : 'good'}"><h2>Background and battery behavior</h2><p>${escapeHtml(backgroundSummary)}</p><ul><li>Visible, user-driven work should be preferred over persistent polling.</li><li>Offline scheduling is owned by the Power Apps runtime, not an app-created timer.</li></ul></section>
    <section class="${report.directNetworkEvidence.length ? 'review' : 'good'}"><h2>Network and data boundaries</h2><p>${escapeHtml(networkSummary)}</p><ul><li>Authentication is ${report.authenticationConfigured ? 'configured' : 'not yet configured'}.</li><li>Offline is ${report.offline.configured ? `configured for ${report.offline.tableCount} table(s)` : 'not configured'}.</li></ul></section>
  </div>
  <section><h2>Privacy and least privilege</h2><ul><li>Capabilities marked <strong>not-used</strong> should not be requested by app workflows.</li><li>Permission prompts must be contextual and tied to a visible user action.</li><li>This report records paths and configuration state, never tokens, secrets, record values, or user identity data.</li><li>Capabilities considered but not enabled: ${escapeHtml(notUsed.map((item) => item.label).join(', ') || 'none')}.</li></ul></section>
  <p class="footer">Generated ${escapeHtml(report.generatedAt)} from ${report.evidenceFiles} project evidence files. Static analysis does not prove runtime permission-dialog wording, operating-system enforcement, or measured battery/network consumption; verify those on a device only when release assurance requires it.</p>
</main></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args['project-root'] || !args.output) {
    process.stderr.write('Usage: node generate-mobile-trust-report.js --project-root <path> [--plan <native-app-plan.md>] --output <mobile-app-trust-report.html>\n');
    process.exit(1);
  }
  const projectRoot = path.resolve(args['project-root']);
  const planMarkdown = args.plan && fs.existsSync(path.resolve(args.plan))
    ? fs.readFileSync(path.resolve(args.plan), 'utf8')
    : '';
  const report = analyzeProject(projectRoot, planMarkdown);
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderReport(report), 'utf8');
  fs.renameSync(temp, output);
  console.log(JSON.stringify({ status: 'ok', output, report }));
}

if (require.main === module) main();

module.exports = { analyzeProject, renderReport };
