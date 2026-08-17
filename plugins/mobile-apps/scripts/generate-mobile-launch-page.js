#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { escapeHtml, splitSections } = require('./render-mobile-plan');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function appNameFromPlan(planFile) {
  if (!planFile || !fs.existsSync(planFile)) return '';
  const markdown = fs.readFileSync(planFile, 'utf8');
  const overview = splitSections(markdown).find((section) => /overview/i.test(section.title));
  if (!overview) return '';
  const match = overview.body.match(/App name:\*{0,2}\s*([^\r\n]+)/i);
  return match ? match[1].replace(/\*\*/g, '').trim() : '';
}

function safeLaunchUrl(value) {
  return /^(?:https?:|exp\+[\w.-]+:)/i.test(value || '') ? value : '';
}

function fileLink(file) {
  return file && fs.existsSync(file) ? pathToFileURL(file).href : '';
}

function analyzeLaunch(projectRoot, options = {}) {
  const packageJson = readJson(path.join(projectRoot, 'package.json')) || {};
  const powerConfig = readJson(path.join(projectRoot, 'power.config.json')) || {};
  const authConfig = readJson(path.join(projectRoot, 'auth.config.json')) || {};
  const qrFile = options.qr ? path.resolve(options.qr) : '';
  const planFile = options.plan ? path.resolve(options.plan) : path.join(projectRoot, 'native-app-plan.md');
  const trustFile = options.trustReport
    ? path.resolve(options.trustReport)
    : path.join(projectRoot, 'mobile-app-trust-report.html');
  const qrData = qrFile && fs.existsSync(qrFile) ? fs.readFileSync(qrFile).toString('base64') : '';
  const metroUrl = safeLaunchUrl(options.metroUrl);
  return {
    appName: appNameFromPlan(planFile) || packageJson.displayName || packageJson.name || path.basename(projectRoot),
    appSlug: packageJson.name || '',
    environmentId: powerConfig.environmentId || (authConfig.environment && authConfig.environment.environmentId) || '',
    environmentUrl: (authConfig.environment && authConfig.environment.environmentUrl) || '',
    authenticationConfigured: Boolean(authConfig.msal && authConfig.msal.clientId),
    metroRunning: Boolean(metroUrl),
    metroUrl,
    terminalId: options.terminalId || '',
    qrData,
    qrFile,
    planUrl: fileLink(planFile),
    trustUrl: fileLink(trustFile),
    generatedAt: new Date().toISOString(),
  };
}

function renderLaunchPage(model) {
  const issues = [];
  if (!model.authenticationConfigured) issues.push('Authentication client ID is not configured.');
  if (!model.metroRunning) issues.push('Metro URL was not detected; restart Metro before scanning.');
  if (!model.qrData) issues.push('QR image is unavailable; use the Metro URL or regenerate the QR.');
  const issueHtml = issues.length
    ? `<div class="alert"><strong>Setup required</strong><ul>${issues.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '<div class="ready"><strong>Ready to launch</strong><span>Metro, QR, and authentication are available.</span></div>';
  const qr = model.qrData
    ? `<img src="data:image/png;base64,${model.qrData}" alt="Metro QR code">`
    : '<div class="qr-missing">QR unavailable</div>';
  const metroAction = model.metroUrl
    ? `<a class="button primary" href="${escapeHtml(model.metroUrl)}">Open in developer player</a>`
    : '<span class="button disabled">Metro unavailable</span>';
  const reports = [
    model.planUrl ? `<a href="${escapeHtml(model.planUrl)}">Review app plan</a>` : '',
    model.trustUrl ? `<a href="${escapeHtml(model.trustUrl)}">Open Trust Report</a>` : '',
  ].filter(Boolean).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run ${escapeHtml(model.appName)}</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#eef3f8;color:#172033}*{box-sizing:border-box}body{margin:0}
header{background:#0b2f4f;color:white;padding:34px max(24px,calc((100vw - 1120px)/2))}header small{color:#93c5fd;font-weight:800;letter-spacing:.12em}header h1{font-size:40px;line-height:1.05;margin:8px 0}header p{color:#dbeafe;max-width:720px}
main{max-width:1120px;margin:auto;padding:22px;display:grid;gap:18px}.facts{display:flex;gap:8px;flex-wrap:wrap}.pill{background:#dbeafe;color:#1e3a8a;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700}
.alert,.ready{border-radius:12px;padding:14px 16px}.alert{background:#fff7ed;border:1px solid #fdba74;color:#9a3412}.ready{background:#f0fdf4;border:1px solid #86efac;color:#166534;display:flex;gap:10px}.alert ul{margin:8px 0 0}
.layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,.7fr);gap:18px}.card{background:white;border:1px solid #dbe3ec;border-radius:14px;padding:20px}.steps{counter-reset:step;display:grid;gap:16px}.step{display:grid;grid-template-columns:34px 1fr;gap:12px}.step:before{counter-increment:step;content:counter(step);display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#0f5f9d;color:white;font-weight:800}.step h3{margin:2px 0 5px}.step p{margin:0;color:#475569}
.qr{text-align:center}.qr img{width:min(100%,310px);border:12px solid white;box-shadow:0 4px 18px #0f172a22}.qr-missing{height:280px;display:grid;place-items:center;background:#f1f5f9;color:#64748b}.button{display:inline-block;text-decoration:none;border-radius:9px;padding:11px 14px;font-weight:800;margin:8px 4px}.primary{background:#0f5f9d;color:white}.secondary{background:#e0f2fe;color:#075985}.disabled{background:#e2e8f0;color:#64748b}
.links{display:flex;flex-wrap:wrap;gap:10px}.links a{color:#0f5f9d;font-weight:700}.troubleshooting{width:100%;border-collapse:collapse}.troubleshooting th,.troubleshooting td{padding:10px;border:1px solid #dbe3ec;text-align:left;vertical-align:top}.troubleshooting th{background:#eff6ff}.meta{font-size:12px;color:#64748b;word-break:break-word}
@media(max-width:760px){.layout{grid-template-columns:1fr}header h1{font-size:32px}}
</style></head><body><header><small>POWER APPS NATIVE PREVIEW</small><h1>Run ${escapeHtml(model.appName)} on your phone</h1><p>Install the mobile player, confirm setup, then scan the live Metro QR code. Keep the Metro terminal open for hot reload and diagnostics.</p>
<div class="facts"><span class="pill">${escapeHtml(model.appSlug || 'mobile app')}</span><span class="pill">${escapeHtml(model.environmentId || 'environment pending')}</span><span class="pill">${model.authenticationConfigured ? 'Authentication ready' : 'Authentication pending'}</span><span class="pill">${model.metroRunning ? 'Metro running' : 'Metro unavailable'}</span></div></header>
<main>${issueHtml}<div class="layout"><section class="card"><h2>Setup and launch</h2><div class="steps">
<div class="step"><div><h3>Install the Power Apps Developer player</h3><p>Use the native developer player—not Expo Go—to load this app.</p><a class="button secondary" href="https://apps.apple.com/us/app/power-apps-developer/id6753083462">Install for iOS</a><a class="button secondary" href="https://install.appcenter.ms/orgs/appmagic-player-x6ys/apps/rn-dev-player-preview/distribution_groups/public_distribution/releases">Android preview</a></div></div>
<div class="step"><div><h3>Complete authentication setup</h3><p>${model.authenticationConfigured ? 'The app registration client ID is configured.' : 'Run /set-app-registration-native before expecting sign-in to succeed.'}</p></div></div>
<div class="step"><div><h3>Use the same reachable network</h3><p>The phone must be able to reach the Metro development computer. VPN, firewall, or guest Wi-Fi isolation can block it.</p></div></div>
<div class="step"><div><h3>Scan or open the app</h3><p>Scan the QR in the developer player, or use the direct launch action on this device.</p>${metroAction}</div></div>
</div></section><aside class="card qr"><h2>Scan ${escapeHtml(model.appName)}</h2>${qr}<p class="meta">${escapeHtml(model.metroUrl || 'Metro URL unavailable')}</p></aside></div>
<section class="card"><h2>Project review</h2><div class="links">${reports || 'Plan and Trust Report links are not available yet.'}</div></section>
<section class="card"><h2>Troubleshooting</h2><table class="troubleshooting"><thead><tr><th>Symptom</th><th>What to check</th></tr></thead><tbody>
<tr><td>QR does not open</td><td>Confirm Metro is still running, both devices share a reachable network, and the Power Apps Developer player is installed.</td></tr>
<tr><td>Sign-in fails</td><td>Run <code>/set-app-registration-native</code>, verify the selected environment tenant, then restart the app.</td></tr>
<tr><td>Bundle or red-screen error</td><td>Return to the Copilot session and run <code>/debug-app "&lt;symptom&gt;"</code>; Metro terminal ${escapeHtml(model.terminalId || 'output')} is the diagnostic source.</td></tr>
<tr><td>Data does not load</td><td>Check authentication, Dataverse permissions, environment selection, generated services, and current network connectivity.</td></tr>
</tbody></table></section><p class="meta">Generated ${escapeHtml(model.generatedAt)}. Environment URL: ${escapeHtml(model.environmentUrl || 'not cached')}. QR file: ${escapeHtml(model.qrFile || 'not available')}.</p></main></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args['project-root'] || !args.output) {
    process.stderr.write('Usage: node generate-mobile-launch-page.js --project-root <path> --output <mobile-app-launch.html> [--metro-url <url>] [--terminal-id <id>] [--qr <png>] [--plan <md>] [--trust-report <html>]\n');
    process.exit(1);
  }
  const projectRoot = path.resolve(args['project-root']);
  const model = analyzeLaunch(projectRoot, {
    metroUrl: args['metro-url'],
    terminalId: args['terminal-id'],
    qr: args.qr,
    plan: args.plan,
    trustReport: args['trust-report'],
  });
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderLaunchPage(model), 'utf8');
  fs.renameSync(temp, output);
  console.log(JSON.stringify({ status: 'ok', output, model: { ...model, qrData: model.qrData ? '[embedded]' : '' } }));
}

if (require.main === module) main();

module.exports = { analyzeLaunch, renderLaunchPage, safeLaunchUrl };
