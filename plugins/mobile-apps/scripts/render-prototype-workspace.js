#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseNavigationModel, parseScreenMap } = require('./compile-screen-build-pack');

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function markdownSection(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n').trim();
}

function firstTable(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const table = [];
  for (const line of lines) {
    if (line.trim().startsWith('|')) table.push(line.trim());
    else if (table.length) break;
  }
  if (table.length < 2) return [];
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''));
  const headers = cells(table[0]);
  return table.slice(2)
    .filter((line) => !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line))
    .map(cells)
    .map((row) => Object.fromEntries(headers.map((header, index) => [header || `Column ${index + 1}`, row[index] || ''])));
}

function phase(id, label, complete, detail) {
  return { id, label, status: complete ? 'complete' : 'pending', detail };
}

function buildWorkspaceModel(projectRoot) {
  const root = path.resolve(projectRoot);
  const fromRoot = (...parts) => path.join(root, ...parts);
  const plan = readText(fromRoot('native-app-plan.md'));
  const brief = readText(fromRoot('brief.md'));
  const experience = readJson(fromRoot('.tmp', 'experience-contract.json'));
  const schema = readJson(fromRoot('.tmp', 'dataverse-schema-contract.json'));
  const pack = readJson(fromRoot('.tmp', 'screen-build-pack.json'));
  const approval = readJson(fromRoot('.tmp', 'mobile-plan-status.json'));
  const validation = readJson(fromRoot('.tmp', 'mobile-validation-manifest.json'));
  const metro = readJson(fromRoot('.mobile-app', 'metro-session.json'));
  const prototypeManifest = readJson(fromRoot('src', 'generated', '.prototype-manifest.json'));
  const title = plan.match(/^#\s+(.+?)(?:\s+[—-]\s+Native App Plan)?$/m)?.[1]
    || readJson(fromRoot('package.json'))?.name
    || 'Mobile prototype';
  const plannedScreens = pack?.screens || parseScreenMap(plan).map((screen) => ({
    ...screen,
    role: screen.route === '/(app)/home' ? 'primary' : screen.route === '/(app)/profile' ? 'profile' : 'supporting',
    nativeIntent: screen.nativeIntent || null,
  }));
  const screens = plannedScreens.map((screen) => ({
    id: screen.id,
    role: screen.role || 'supporting',
    route: screen.route,
    file: screen.file,
    purpose: screen.purpose || '',
    nativeIntent: screen.nativeIntent || null,
    status: fs.existsSync(fromRoot(screen.file)) ? 'built' : 'planned',
  }));
  const tables = Array.isArray(schema?.tables) ? schema.tables.map((table) => ({
    name: table.displayName || table.logicalName,
    logicalName: table.logicalName,
    fields: Array.isArray(table.columns) ? table.columns.length : 0,
    relationships: Array.isArray(table.relationships) ? table.relationships.length : 0,
  })) : [];
  const allScreensBuilt = screens.length > 0 && screens.every((screen) => screen.status === 'built');
  const canaryRoutes = pack?.execution?.canary?.routes || [];
  const canaryBuilt = canaryRoutes.length > 0 && canaryRoutes.every((route) => screens.find((screen) => screen.route === route)?.status === 'built');
  const finalValidation = validation?.phases?.final?.status === 'passed';
  const warnings = [];
  if (!approval || approval.status !== 'approved') warnings.push('Prototype plan approval is pending.');
  if (metro?.status === 'failed') warnings.push(metro.reason || 'Metro did not report readiness.');
  if (!finalValidation) warnings.push('Final changed-file validation has not passed yet.');
  if (!pack) warnings.push('The compact screen build pack has not been compiled yet.');
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    title,
    mode: 'local prototype',
    approval: approval?.status || 'pending',
    experience: {
      audience: experience?.audience || 'Pending',
      primaryJob: experience?.primaryJob || '',
      confidence: experience?.confidence || 'pending',
      entryMode: experience?.entryMode || 'pending',
      navigation: pack?.navigation?.model || parseNavigationModel(plan, experience?.navigationModel || 'pending').model,
      assumptions: experience?.assumptions || [],
      motifs: experience?.signatureMotifs || [],
    },
    editable: {
      brief,
      primaryJob: experience?.primaryJob || '',
      assumptions: (experience?.assumptions || []).join('\n'),
      dataModel: schema ? JSON.stringify({ tables: schema.tables || [] }, null, 2) : '',
    },
    phases: [
      phase('plan', 'Plan', Boolean(plan && experience), approval?.status || 'Draft'),
      phase('data', 'Local data', Boolean(schema && prototypeManifest), tables.length ? `${tables.length} entities` : 'Pending'),
      phase('design', 'Native design', fs.existsSync(fromRoot('brand', 'design-system.md')) && fs.existsSync(fromRoot('brand', 'tokens.ts')), experience?.visualCharacter || 'Pending'),
      phase('canary', 'Home + key flow', canaryBuilt, canaryRoutes.length ? `${canaryRoutes.length} routes` : 'Pending'),
      phase('screens', 'Supporting screens', allScreensBuilt, screens.length ? `${screens.filter((screen) => screen.status === 'built').length}/${screens.length} built` : 'Pending'),
      phase('validation', 'Validation', finalValidation, finalValidation ? 'Passed' : 'Pending'),
      phase('metro', 'Phone preview', metro?.status === 'ready', metro?.status || 'Pending'),
    ],
    screens,
    dataModel: tables,
    capabilities: firstTable(markdownSection(plan, 'Native Capabilities')),
    connectors: firstTable(markdownSection(plan, 'Connectors')),
    build: {
      packRevision: pack?.revision || null,
      canaryRoutes,
      supportingWaves: pack?.execution?.supportingWaves || [],
      fixtureEntities: pack?.fixtures?.entities || prototypeManifest?.tables || [],
    },
    validation: {
      final: finalValidation ? 'passed' : 'pending',
      fingerprint: validation?.phases?.final?.fingerprint || null,
      validatedAt: validation?.phases?.final?.validatedAt || null,
    },
    metro: {
      status: metro?.status || 'not-started',
      port: metro?.port || null,
      url: metro?.url || null,
      command: metro?.command || null,
      manualCommand: metro?.manualCommand || null,
      terminalId: metro?.terminalId || null,
    },
    warnings,
  };
}

function serializedForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function renderWorkspace(model) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${model.title.replace(/[<>&"]/g, '')} - prototype workspace</title>
  <style>
    :root { --ink:#17202a; --muted:#66717b; --paper:#f3f6f7; --surface:#ffffff; --line:#d7dee2; --green:#087f5b; --green-soft:#dff5ec; --blue:#1456c0; --blue-soft:#e6eefc; --coral:#c2413b; --coral-soft:#fae8e6; --gold:#a15c00; --gold-soft:#fff0cf; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:linear-gradient(90deg,#edf2f3 1px,transparent 1px),var(--paper); background-size:32px 32px; font-family:"Avenir Next","Segoe UI",sans-serif; letter-spacing:0; }
    button,input,textarea { font:inherit; letter-spacing:0; }
    button:focus-visible,input:focus-visible,textarea:focus-visible { outline:3px solid rgba(20,86,192,.28); outline-offset:2px; }
    .shell { min-height:100vh; display:grid; grid-template-columns:240px minmax(0,1fr); }
    aside { position:sticky; top:0; height:100vh; padding:28px 22px; color:#f8fafb; background:#17202a; }
    .brand { font-family:Charter,"Iowan Old Style",serif; font-size:24px; line-height:1.05; }
    .eyebrow { margin:0 0 8px; color:#9fb0bc; font:700 11px/1.2 "SFMono-Regular",Consolas,monospace; text-transform:uppercase; }
    .rail { margin:36px 0 0; padding:0; list-style:none; }
    .rail li { position:relative; min-height:54px; padding:0 0 20px 28px; color:#aebac2; font-size:13px; }
    .rail li::before { content:""; position:absolute; left:4px; top:3px; width:10px; height:10px; border:2px solid #667985; border-radius:50%; background:#17202a; }
    .rail li::after { content:""; position:absolute; left:9px; top:17px; width:1px; height:31px; background:#40505a; }
    .rail li:last-child::after { display:none; }
    .rail li.complete { color:#fff; }
    .rail li.complete::before { border-color:#46d3a0; background:#46d3a0; }
    .rail small { display:block; margin-top:3px; color:#82939e; }
    main { min-width:0; padding:32px clamp(20px,4vw,64px) 80px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding-bottom:26px; border-bottom:2px solid var(--ink); }
    h1 { max-width:760px; margin:0; font-family:Charter,"Iowan Old Style",serif; font-size:clamp(34px,5vw,66px); line-height:.98; font-weight:600; }
    h2 { margin:0 0 18px; font:700 12px/1.2 "SFMono-Regular",Consolas,monospace; text-transform:uppercase; }
    h3 { margin:0; font-size:17px; }
    p { line-height:1.55; }
    .meta { text-align:right; font:12px/1.6 "SFMono-Regular",Consolas,monospace; color:var(--muted); }
    .band { padding:28px 0; border-bottom:1px solid var(--line); }
    .summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }
    .metric { min-width:0; padding:18px; background:var(--surface); }
    .metric span { display:block; margin-bottom:7px; color:var(--muted); font-size:11px; text-transform:uppercase; }
    .metric strong { display:block; overflow-wrap:anywhere; font-size:16px; }
    .split { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr); gap:30px; }
    .split > * { min-width:0; }
    .fields { display:grid; gap:14px; }
    label { display:grid; gap:6px; font-size:12px; font-weight:700; }
    input,textarea { width:100%; border:1px solid #bec9cf; border-radius:4px; padding:11px 12px; color:var(--ink); background:#fff; }
    textarea { min-height:96px; resize:vertical; font-family:"Avenir Next","Segoe UI",sans-serif; }
    textarea.code { min-height:220px; font:12px/1.5 "SFMono-Regular",Consolas,monospace; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
    button { min-height:44px; border:1px solid var(--ink); border-radius:4px; padding:0 15px; cursor:pointer; background:var(--ink); color:#fff; font-weight:700; }
    button.secondary { color:var(--ink); background:#fff; }
    .note { padding:14px 16px; border-left:4px solid var(--gold); background:var(--gold-soft); }
    .note + .note { margin-top:8px; }
    .empty { color:var(--muted); font-style:italic; }
    .table-wrap { max-width:100%; overflow-x:auto; border-top:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; min-width:620px; }
    th,td { padding:13px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font:700 11px/1.2 "SFMono-Regular",Consolas,monospace; text-transform:uppercase; }
    td { font-size:13px; }
    .pill { display:inline-flex; align-items:center; min-height:24px; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:700; }
    .pill.complete,.pill.built,.pill.ready,.pill.passed,.pill.approved { color:var(--green); background:var(--green-soft); }
    .pill.pending,.pill.planned,.pill.not-started { color:var(--blue); background:var(--blue-soft); }
    .pill.failed { color:var(--coral); background:var(--coral-soft); }
    .mono { font:12px/1.5 "SFMono-Regular",Consolas,monospace; overflow-wrap:anywhere; }
    .runtime { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
    .runtime > div { padding:16px 0; border-top:3px solid var(--ink); }
    @media (max-width:900px) { .shell { grid-template-columns:1fr; } aside { position:relative; height:auto; } .rail { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:22px; } .rail li { padding:18px 10px 10px; border-top:1px solid #40505a; } .rail li::before { top:-7px; left:10px; } .rail li::after { display:none; } .summary { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:620px) { aside { padding:20px 16px; } main { padding:22px 16px 60px; } header { align-items:flex-start; flex-direction:column; } .meta { text-align:left; } .rail { grid-template-columns:repeat(4,minmax(0,1fr)); margin-top:16px; } .rail li { min-width:0; min-height:44px; padding:12px 6px 6px 22px; overflow-wrap:anywhere; } .rail li::before { left:6px; } .summary { grid-template-columns:repeat(2,minmax(0,1fr)); } .split,.runtime { grid-template-columns:1fr; } h1 { font-size:38px; } }
    @media (prefers-reduced-motion:no-preference) { main > * { animation:rise .35s both; } main > *:nth-child(2) { animation-delay:.05s; } main > *:nth-child(3) { animation-delay:.1s; } @keyframes rise { from { opacity:0; transform:translateY(7px); } } }
  </style>
</head>
<body>
  <div class="shell">
    <aside><p class="eyebrow">Local build control</p><div class="brand" id="rail-title"></div><ol class="rail" id="phases"></ol></aside>
    <main>
      <header><div><p class="eyebrow">Prototype workspace</p><h1 id="title"></h1></div><div class="meta"><div id="mode"></div><div id="approval"></div><div>Not native UX evidence</div></div></header>
      <section class="band"><div class="summary" id="summary"></div></section>
      <section class="band split"><div><h2>Editable review</h2><div class="fields"><label>Brief<textarea id="brief"></textarea></label><label>Primary job<input id="primary-job"></label><label>Assumptions<textarea id="assumptions"></textarea></label><label>Logical data model<textarea class="code" id="data-model"></textarea></label></div><div class="actions"><button id="export-review">Export review</button><button class="secondary" id="copy-path">Copy project path</button><span class="mono" id="export-status" role="status" aria-live="polite"></span></div><details id="review-payload" hidden><summary>Review payload</summary><textarea class="code" id="review-json" readonly></textarea></details></div><div><h2>Warnings</h2><div id="warnings"></div></div></section>
      <section class="band"><h2>Screen build</h2><div class="table-wrap"><table><thead><tr><th>Screen</th><th>Role</th><th>Route</th><th>Capability</th><th>Status</th></tr></thead><tbody id="screens"></tbody></table></div></section>
      <section class="band"><h2>Logical data</h2><div class="table-wrap"><table><thead><tr><th>Entity</th><th>Logical name</th><th>Fields</th><th>Relationships</th></tr></thead><tbody id="entities"></tbody></table></div></section>
      <section class="band split"><div><h2>Native capabilities</h2><div id="capabilities"></div></div><div><h2>Connector proposals</h2><div id="connectors"></div></div></section>
      <section class="band"><h2>Validation and Metro</h2><div class="runtime" id="runtime"></div></section>
    </main>
  </div>
  <script>
    const model = ${serializedForScript(model)};
    const byId = (id) => document.getElementById(id);
    const setText = (target, value) => { target.textContent = value == null || value === '' ? 'Pending' : String(value); };
    const pill = (value) => { const node=document.createElement('span'); node.className='pill '+String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-'); setText(node,value); return node; };
    setText(byId('title'), model.title); setText(byId('rail-title'), model.title); setText(byId('mode'), model.mode); byId('approval').append('Approval: ',pill(model.approval));
    for (const item of model.phases) { const row=document.createElement('li'); row.className=item.status; const label=document.createElement('strong'); setText(label,item.label); const detail=document.createElement('small'); setText(detail,item.detail); row.append(label,detail); byId('phases').append(row); }
    for (const [label,value] of [['Audience',model.experience.audience],['Primary job',model.experience.primaryJob],['Navigation',model.experience.navigation],['Confidence',model.experience.confidence]]) { const item=document.createElement('div'); item.className='metric'; const name=document.createElement('span'); setText(name,label); const data=document.createElement('strong'); setText(data,value); item.append(name,data); byId('summary').append(item); }
    byId('brief').value=model.editable.brief; byId('primary-job').value=model.editable.primaryJob; byId('assumptions').value=model.editable.assumptions; byId('data-model').value=model.editable.dataModel;
    const warnings=model.warnings.length?model.warnings:['No current warnings.']; for (const value of warnings) { const note=document.createElement('p'); note.className='note'; setText(note,value); byId('warnings').append(note); }
    const addRows=(target,rows,fields) => { if(!rows.length){const row=document.createElement('tr');const cell=document.createElement('td');cell.colSpan=fields.length;cell.className='empty';setText(cell,'No entries yet.');row.append(cell);target.append(row);return;} for(const value of rows){const row=document.createElement('tr');for(const field of fields){const cell=document.createElement('td');const data=typeof field==='function'?field(value):value[field];if(field==='status')cell.append(pill(data));else setText(cell,data);row.append(cell);}target.append(row);} };
    addRows(byId('screens'),model.screens,['id','role','route',(row)=>row.nativeIntent||'None','status']); addRows(byId('entities'),model.dataModel,['name','logicalName','fields','relationships']);
    const renderRecords=(target,records)=>{ if(!records.length){const text=document.createElement('p');text.className='empty';setText(text,'None proposed.');target.append(text);return;} const keys=Object.keys(records[0]);const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');const head=document.createElement('tr');for(const key of keys){const th=document.createElement('th');setText(th,key);head.append(th);}const body=document.createElement('tbody');addRows(body,records,keys);table.append(head,body);wrap.append(table);target.append(wrap);}; renderRecords(byId('capabilities'),model.capabilities);renderRecords(byId('connectors'),model.connectors);
    for(const [label,value,status] of [['Validation',model.validation.final,model.validation.final],['Metro',model.metro.status,model.metro.status],['Port',model.metro.port,'pending'],['Native URL',model.metro.url,'pending'],['Command',model.metro.command||model.metro.manualCommand,'pending'],['Project',model.projectRoot,'pending']]){const item=document.createElement('div');const title=document.createElement('h3');setText(title,label);const body=document.createElement('p');body.className='mono';if(label==='Validation'||label==='Metro')body.append(pill(status));else setText(body,value);item.append(title,body);byId('runtime').append(item);}
    byId('copy-path').addEventListener('click',()=>navigator.clipboard?.writeText(model.projectRoot));
    byId('export-review').addEventListener('click',()=>{const review={schemaVersion:1,projectRoot:model.projectRoot,generatedAt:new Date().toISOString(),edits:{brief:byId('brief').value,primaryJob:byId('primary-job').value,assumptions:byId('assumptions').value,dataModel:byId('data-model').value}};const payload=JSON.stringify(review,null,2)+'\\n';byId('review-json').value=payload;byId('review-payload').hidden=false;byId('review-payload').open=true;const link=document.createElement('a');const url=URL.createObjectURL(new Blob([payload],{type:'application/json'}));link.href=url;link.download='prototype-review.json';link.hidden=true;document.body.append(link);link.click();setTimeout(()=>{link.remove();URL.revokeObjectURL(url);},0);setText(byId('export-status'),'Review payload ready.');});
  </script>
</body>
</html>\n`;
}

function writeWorkspace(projectRoot, outputPath) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(root, outputPath || '_prototype_workspace.html');
  if (output !== root && !output.startsWith(`${root}${path.sep}`)) throw new Error('Workspace output must stay inside the project root.');
  const temporaryPath = `${output}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, renderWorkspace(buildWorkspaceModel(root)), { flag: 'wx' });
  fs.renameSync(temporaryPath, output);
  return output;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node render-prototype-workspace.js --project-root <dir> [--output <relative-path>]\n');
    return 2;
  }
  try {
    const output = writeWorkspace(args.projectRoot, args.output);
    process.stdout.write(`Prototype workspace written: ${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`render-prototype-workspace: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildWorkspaceModel, firstTable, markdownSection, renderWorkspace, writeWorkspace };