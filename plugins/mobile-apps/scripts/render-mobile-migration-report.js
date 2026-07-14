#!/usr/bin/env node
'use strict';

/** Render a self-contained migration assessment from a validated adapter package. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MAX_REPORT_INPUT_BYTES = 64 * 1024 * 1024;

function args(argv) {
  const out = { dir: '', output: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i] || '';
    else if (argv[i] === '--out') out.output = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node scripts/render-mobile-migration-report.js --dir <mobile-plugin-input-dir> [--out <report.html>]\n');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!out.dir) throw new Error('Missing --dir');
  out.dir = path.resolve(out.dir);
  if (fs.existsSync(out.dir)) out.dir = fs.realpathSync(out.dir);
  out.output = path.resolve(out.output || path.join(out.dir, 'migration-assessment.html'));
  return out;
}

function readJson(root, name, fallback) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return fallback;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Report input must be a regular file: ${file}`);
  if (stat.size > MAX_REPORT_INPUT_BYTES) throw new Error(`Report input exceeds ${MAX_REPORT_INPUT_BYTES} bytes: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function list(values, render) {
  if (!values.length) return '<p class="empty">None detected.</p>';
  return `<ul>${values.map((value) => `<li>${render(value)}</li>`).join('')}</ul>`;
}

function badge(text, tone = '') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function main() {
  const cli = args(process.argv.slice(2));
  if (!fs.existsSync(cli.dir) || !fs.statSync(cli.dir).isDirectory()) throw new Error(`Package not found: ${cli.dir}`);

  const input = readJson(cli.dir, 'mobile-plugin-input.json', {});
  const behaviors = readJson(cli.dir, 'behaviors.json', { stats: {}, actions: [], unmatchedFormulas: [] });
  const controls = readJson(cli.dir, 'control-intent-coverage.json', { stats: {}, rows: [] });
  const pcfPlan = readJson(cli.dir, 'pcf-plan.json', { stats: {}, controls: [] });
  const server = readJson(cli.dir, 'server-side-assets.json', { stats: {}, assets: [] });
  const flows = readJson(cli.dir, 'flows.json', { stats: {}, flows: [] });
  const checklistPath = path.join(cli.dir, 'migration-checklist.md');
  let checklist = '';
  if (fs.existsSync(checklistPath)) {
    const stat = fs.lstatSync(checklistPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Report input must be a regular file: ${checklistPath}`);
    if (stat.size > MAX_REPORT_INPUT_BYTES) throw new Error(`Report input exceeds ${MAX_REPORT_INPUT_BYTES} bytes: ${checklistPath}`);
    checklist = fs.readFileSync(checklistPath, 'utf8');
  }

  const validator = path.join(__dirname, 'validate-mobile-plugin-input.js');
  const validationRun = spawnSync(process.execPath, [validator, '--dir', cli.dir, '--json'], { encoding: 'utf8' });
  let validation;
  try { validation = JSON.parse(validationRun.stdout || '{}'); }
  catch { validation = { ok: false, errors: [validationRun.stderr || 'Package validation failed'], warnings: [] }; }

  const tables = input.dataModelPlan?.dataverseTables || [];
  const requirements = input.dataModelPlan?.connectionRequirements || [];
  const screens = input.screenPlan?.screens || [];
  const risks = input.riskReport || [];
  const unsupported = input.unsupported || [];
  const highRisk = (controls.rows || []).filter((row) => row.businessRisk === 'high');
  const unmatched = behaviors.unmatchedFormulas || [];
  const unresolved = input.dataModelPlan?.unresolvedDataSources || [];
  const missingFlows = (flows.flows || input.dataModelPlan?.flows || []).filter((flow) => !(flow.flowId || flow.id));
  const pcfRows = pcfPlan.controls || [];
  const pcfDiscoveryBlockers = pcfPlan.discovery?.complete === false
    ? (pcfPlan.discovery?.blockers || [{ message: 'PCF inventory is incomplete.' }])
    : [];
  const pcfPending = pcfRows.filter((row) => row.approval?.status === 'pending');
  const pcfHardBlocks = pcfRows.filter((row) =>
    row.approval?.status === 'blocked'
    || row.approval?.disposition === 'blocker');
  const blockers = [
    ...(validation.errors || []),
    ...unresolved.map((item) => `Unresolved data source: ${item.name || '(unnamed)'}`),
    ...pcfHardBlocks.map((row) => `PCF requires a resolved strategy: ${row.screen}/${row.control}`),
    ...pcfDiscoveryBlockers.map((finding) => finding.message || finding.code || 'PCF inventory is incomplete'),
  ];
  const reviewCount = unmatched.length + unsupported.length + highRisk.length + missingFlows.length + pcfPending.length + (validation.warnings || []).length;
  const status = blockers.length ? 'Blocked' : reviewCount ? 'Ready with review' : 'Ready for guided generation';
  const statusTone = blockers.length ? 'bad' : reviewCount ? 'warn' : 'good';

  const behaviorSource = Number(behaviors.stats?.sourceEventActionCount || behaviors.actions?.length || 0);
  const behaviorAccounted = Number(behaviors.stats?.accountedEventActionCount || behaviors.actions?.length || 0);
  const dropped = Number(behaviors.stats?.droppedEventActionCount || 0);
  const tableCounts = Object.fromEntries(['reuse', 'extend', 'new'].map((state) => [state, tables.filter((table) => table.status === state).length]));

  const report = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.app?.name || 'Canvas app')} — migration assessment</title>
<style>
:root{--ink:#102620;--paper:#f3f7f4;--surface:#fff;--line:#cbd9d2;--muted:#5d7068;--green:#0e7a52;--green2:#d8f3e6;--amber:#8a5a00;--amber2:#fff0c2;--red:#9c3028;--red2:#fde4df;--blue:#175b82;--blue2:#e0f0fa;--radius:10px}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(90deg,rgba(16,38,32,.035) 1px,transparent 1px),var(--paper);background-size:32px 32px;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}.wrap{max-width:1180px;margin:auto;padding:32px 24px 64px}.hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.7fr);gap:24px;background:var(--ink);color:#eef8f3;padding:32px;border-radius:14px}.eyebrow{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#8fdfb9}.hero h1{font:600 clamp(32px,5vw,58px) Georgia,serif;line-height:1.02;margin:14px 0}.hero p{color:#bed0c7;max-width:720px}.ledger{border-left:1px solid #446158;padding-left:24px}.ledger-row{display:flex;justify-content:space-between;gap:18px;padding:10px 0;border-bottom:1px solid #304b42}.ledger strong{font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700}.badge.good{background:var(--green2);color:var(--green);border-color:#9bd5ba}.badge.warn{background:var(--amber2);color:var(--amber);border-color:#e4c66e}.badge.bad{background:var(--red2);color:var(--red);border-color:#e2aaa4}.badge.info{background:var(--blue2);color:var(--blue);border-color:#a8cee4}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:18px 0}.metric,.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 8px 22px rgba(16,38,32,.06)}.metric{padding:16px}.metric strong{display:block;font:750 26px ui-monospace,SFMono-Regular,Menlo,monospace}.metric span{font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{padding:22px}.wide{grid-column:1/-1}.card h2{font:600 22px Georgia,serif;margin:0 0 14px}.card h3{font-size:14px;margin:18px 0 8px}.empty{color:var(--muted);font-style:italic}ul{padding-left:20px;margin:8px 0}li{margin:7px 0}code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px 8px;vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}pre{white-space:pre-wrap;max-height:420px;overflow:auto;background:#f7faf8;border:1px solid var(--line);padding:16px;border-radius:8px;color:#344b43}.footer{margin-top:20px;color:var(--muted);font-size:12px}@media(max-width:780px){.hero,.grid{grid-template-columns:1fr}.ledger{border-left:0;border-top:1px solid #446158;padding:18px 0 0}.metrics{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:no-preference){.card,.metric{transition:transform .18s ease,box-shadow .18s ease}.card:hover,.metric:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(16,38,32,.1)}}
</style></head><body><main class="wrap">
<section class="hero"><div><div class="eyebrow">Canvas → native / behavior ledger</div><h1>${esc(input.app?.name || 'Canvas app')}</h1><p>This report measures what can be carried into the current native mobile workflow before any target app is changed. It tracks business behavior and data contracts—not Canvas pixels.</p>${badge(status,statusTone)}</div><div class="ledger"><div class="ledger-row"><span>Source actions</span><strong>${behaviorSource}</strong></div><div class="ledger-row"><span>Accounted</span><strong>${behaviorAccounted}</strong></div><div class="ledger-row"><span>Dropped</span><strong>${dropped}</strong></div><div class="ledger-row"><span>Unmatched</span><strong>${unmatched.length}</strong></div></div></section>
<section class="metrics"><div class="metric"><strong>${screens.length}</strong><span>Screens</span></div><div class="metric"><strong>${controls.stats?.totalControls || controls.rows?.length || 0}</strong><span>Controls</span></div><div class="metric"><strong>${tables.length}</strong><span>Dataverse tables</span></div><div class="metric"><strong>${requirements.length}</strong><span>Connections / flows</span></div><div class="metric"><strong>${highRisk.length}</strong><span>High-risk controls</span></div></section>
<section class="grid">
<div class="card"><h2>Readiness</h2>${blockers.length ? list(blockers,(item)=>`<span class="mono">${esc(item)}</span>`) : '<p>No blocking contract errors detected.</p>'}<h3>Review queue</h3><p>${reviewCount} item(s): ${unmatched.length} unmatched formula(s), ${unsupported.length} unsupported item(s), ${highRisk.length} high-risk control(s), ${missingFlows.length} target flow ID(s), ${pcfPending.length} PCF approval(s), ${(validation.warnings||[]).length} validation warning(s).</p></div>
<div class="card"><h2>Data model</h2><p>${badge(`${tableCounts.reuse} reuse`,'good')} ${badge(`${tableCounts.extend} extend`,'warn')} ${badge(`${tableCounts.new} new`,'info')}</p><table><thead><tr><th>Table</th><th>Status</th><th>Tier</th><th>Columns</th></tr></thead><tbody>${tables.slice(0,40).map((t)=>`<tr><td><code>${esc(t.logicalName)}</code><br>${esc(t.displayName||'')}</td><td>${badge(t.status,t.status==='reuse'?'good':t.status==='extend'?'warn':'info')}</td><td>${esc(t.tier)}</td><td>${(t.columns||[]).length}</td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2>Connections and flows</h2>${list(requirements,(r)=>`${badge(r.status,r.status==='ready-to-add'?'good':r.status==='unsupported'?'bad':'warn')} <strong>${esc(r.connector||r.apiId)}</strong><br><span class="mono">${esc(r.apiId||r.classification||'')}</span>`)}</div>
<div class="card"><h2>High-risk control intent</h2>${list(highRisk.slice(0,24),(row)=>`<strong>${esc(row.screen)} / ${esc(row.control)}</strong><br>${esc(row.role)} — ${esc((row.mustPreserve||[]).join('; ')||row.nativeSuggestion||row.support)}`)}</div>
<div class="card wide"><h2>PCF disposition approval</h2>${pcfDiscoveryBlockers.length ? list(pcfDiscoveryBlockers,(item)=>`${badge('blocked','bad')} ${esc(item.message||item.code)}`) : pcfRows.length ? `<table><thead><tr><th>PCF</th><th>Screen</th><th>Essentiality</th><th>Proposal</th><th>Approval</th><th>Target / reason</th></tr></thead><tbody>${pcfRows.map((row)=>`<tr><td><strong>${esc(row.control)}</strong><br><code>${esc(row.pcfId)}</code></td><td>${esc(row.screen)}</td><td>${badge(row.essentiality?.level||'unknown',row.essentiality?.level==='essential'?'bad':'warn')}</td><td>${badge(row.proposal?.disposition||'missing',row.proposal?.disposition==='blocker'?'bad':'info')}</td><td>${badge(row.approval?.status||'missing',row.approval?.status==='approved'?'good':row.approval?.status==='blocked'?'bad':'warn')}</td><td>${esc(row.proposal?.targetStrategy?.primitive||row.proposal?.targetStrategy?.uiPrimitive||row.proposal?.reason||'')}</td></tr>`).join('')}</tbody></table>` : '<p>No PCF controls detected and source metadata contains no PCF signal.</p>'}</div>
<div class="card wide"><h2>Screens</h2><table><thead><tr><th>Screen</th><th>Purpose</th><th>Data</th><th>Native upgrades</th></tr></thead><tbody>${screens.map((s)=>`<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.purpose||s.userStory||'')}</td><td>${esc((s.dataverseTablesUsed||[]).join(', '))}</td><td>${esc((s.upgradeHints||[]).map((h)=>h.antiPattern||h.id).join(', '))}</td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2>Unmatched Power Fx</h2>${list(unmatched.slice(0,30),(item)=>`<strong>${esc(item.screen)} / ${esc(item.control||item.property)}</strong><br><code>${esc(item.sourceStatement||item.formula||item.raw)}</code>`)}</div>
<div class="card"><h2>Unsupported and risk notes</h2>${list([...unsupported,...risks].slice(0,30),(item)=>`${item.severity?badge(item.severity,item.severity==='high'?'bad':'warn'):''} ${esc(item.reason||item.message||item.code||JSON.stringify(item))}`)}</div>
${checklist?`<div class="card wide"><h2>Migration checklist</h2><pre>${esc(checklist)}</pre></div>`:''}
</section><p class="footer">Generated ${esc(new Date().toISOString())}. Local assessment only; no source or target environment was mutated.</p>
</main></body></html>`;

  fs.mkdirSync(path.dirname(cli.output), { recursive: true });
  if (fs.existsSync(cli.output)) {
    const stat = fs.lstatSync(cli.output);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Report output must be a regular file: ${cli.output}`);
  }
  fs.writeFileSync(cli.output, report, 'utf8');
  process.stdout.write(`${cli.output}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`Report generation failed: ${error.message}\n`); process.exit(1); }
