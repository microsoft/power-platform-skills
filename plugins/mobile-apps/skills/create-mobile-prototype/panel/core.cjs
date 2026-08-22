'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}

function read(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function cleanCell(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').replace(/\\\|/g, '|');
}

function section(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const level = heading.match(/^#+/)?.[0].length || 1;
  const body = markdown.slice(start + heading.length + 1);
  const next = body.search(new RegExp(`^#{1,${level}}\\s+`, 'm'));
  return next < 0 ? body : body.slice(0, next);
}

function table(markdown, heading) {
  const lines = section(markdown, heading).split('\n').filter((line) => /^\s*\|/.test(line));
  if (lines.length < 2) return [];
  const parse = (line) => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(cleanCell);
  const headers = parse(lines[0]);
  return lines.slice(1).filter((line) => !/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)).map(parse).filter((cells) => cells.some(Boolean)).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function events(projectDir) {
  const eventPath = path.join(projectDir, '.mobile-build', 'events.ndjson');
  return read(eventPath).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function eventState(list) {
  const state = { concerns: [], findings: [], screens: {} };
  for (const event of list) {
    if (event.kind === 'screen') state.screens[event.id] = { ...(state.screens[event.id] || {}), ...event };
    else if (event.kind === 'finding') state.findings.push(event);
    else if (event.kind === 'concern' && !state.concerns.includes(event.message)) state.concerns.push(event.message);
  }
  return state;
}

function sectionItems(markdown, heading) {
  const body = section(markdown, heading).trim();
  if (!body || /^None\b/im.test(body)) return [];
  return body.split('\n').filter((line) => /^[-|]/.test(line.trim()) && !/^\|\s*:?-/.test(line.trim())).map((line) => {
    const dropped = /drop|unsupported|not (?:available|present|shipped)|missing/i.test(line);
    return { text: line.replace(/^[-|]\s*/, '').trim(), state: dropped ? 'dropped' : 'ready', reason: dropped ? line.trim() : '' };
  }).sort((left, right) => Number(right.state === 'dropped') - Number(left.state === 'dropped'));
}

function loadState(projectDir) {
  const planPath = path.join(projectDir, 'native-app-plan.md');
  const contractPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
  const plan = read(planPath);
  const contract = fs.existsSync(contractPath) ? JSON.parse(read(contractPath)) : { tables: [] };
  const reduced = eventState(events(projectDir));
  const screens = table(plan, '### Screen Map').map((screen) => ({ ...screen, id: slug(screen.Screen) }));
  return {
    brief: read(path.join(projectDir, 'brief.md')),
    model: contract.tables || [],
    native: sectionItems(plan, '## Native Capabilities'),
    connectors: sectionItems(plan, '## Connectors'),
    screens,
    progress: Object.values(reduced.screens),
    issues: reduced.findings.map((finding) => ({ ...finding, state: finding.state || 'OPEN' })),
    concerns: reduced.concerns,
  };
}

function screenDependencies(plan, field) {
  const headings = [...plan.matchAll(/^#### Screen \d+ - (.+?) \(`[^`]+`\)$/gm)];
  const blocks = [];
  for (let index = 0; index < headings.length; index += 1) {
    const body = plan.slice(headings[index].index, index + 1 < headings.length ? headings[index + 1].index : plan.length);
    if (new RegExp(`\\b${field.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(body)) blocks.push({ screen: headings[index][1].trim(), reason: `references ${field} in its screen contract` });
  }
  return blocks;
}

function modelEdit(projectDir, edit) {
  const contractPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
  const planPath = path.join(projectDir, 'native-app-plan.md');
  const contract = JSON.parse(read(contractPath));
  let plan = read(planPath);
  const entity = (contract.tables || []).find((tableEntry) => tableEntry.logicalName === edit.entity);
  if (!entity) return { ok: false, error: `unknown entity ${edit.entity}` };
  const columns = entity.columns || (entity.columns = []);
  const column = columns.find((candidate) => candidate.logicalName === edit.field);
  if (edit.op !== 'add' && !column) return { ok: false, error: `unknown field ${edit.entity}.${edit.field}` };
  if (edit.op === 'drop') {
    const blocks = screenDependencies(plan, edit.field);
    if (blocks.length > 0) return { ok: false, blocks };
    entity.columns = columns.filter((candidate) => candidate !== column);
  } else if (edit.op === 'rename') {
    if (!/^[a-z][a-z0-9_]+$/i.test(edit.value)) return { ok: false, error: 'rename value must be a logical identifier' };
    const before = edit.field;
    column.logicalName = edit.value;
    if (column.schemaName === before) column.schemaName = edit.value;
    plan = plan.replace(new RegExp(`\\b${before.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'g'), edit.value);
  } else if (edit.op === 'retype') {
    if (!['string', 'memo', 'integer', 'decimal', 'money', 'boolean', 'choice', 'datetime', 'lookup', 'image', 'file'].includes(edit.value)) return { ok: false, error: 'unsupported simple field type' };
    column.type = edit.value;
  } else if (edit.op === 'add') {
    const value = edit.value || {};
    if (!/^[a-z][a-z0-9_]+$/i.test(value.logicalName || '') || !String(value.displayName || '').trim()) return { ok: false, error: 'add requires logicalName and displayName' };
    if (columns.some((candidate) => candidate.logicalName === value.logicalName)) return { ok: false, error: 'field already exists' };
    if (!['string', 'memo', 'integer', 'decimal', 'money', 'boolean', 'datetime'].includes(value.type)) return { ok: false, error: 'add supports simple fields only' };
    columns.push({ logicalName: value.logicalName, schemaName: value.logicalName, displayName: value.displayName, type: value.type, requiredLevel: 'None', plannedDecision: 'create' });
  } else return { ok: false, error: `unsupported model op ${edit.op}` };
  atomicWrite(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  atomicWrite(planPath, plan);
  return { ok: true, state: loadState(projectDir) };
}

function screenEdit(projectDir, edit) {
  if (edit.op !== 'remove') return { ok: false, error: 'screens support remove only' };
  const planPath = path.join(projectDir, 'native-app-plan.md');
  let plan = read(planPath);
  const row = table(plan, '### Screen Map').find((screen) => slug(screen.Screen) === edit.id);
  if (!row) return { ok: false, error: `unknown screen ${edit.id}` };
  plan = plan.split('\n').filter((line) => !(line.startsWith('|') && (line.includes(`| ${row.Screen} |`) || line.includes(`| \`${row.Route}\` |`)))).join('\n');
  const headings = [...plan.matchAll(/^#### Screen \d+ - (.+?) \(`[^`]+`\)$/gm)];
  const heading = headings.find((match) => match[1].trim() === row.Screen);
  if (heading) {
    const index = headings.indexOf(heading);
    const end = index + 1 < headings.length ? headings[index + 1].index : plan.indexOf('\n## ', heading.index + 1) >= 0 ? plan.indexOf('\n## ', heading.index + 1) : plan.length;
    plan = `${plan.slice(0, heading.index)}${plan.slice(end)}`;
  }
  atomicWrite(planPath, `${plan.trimEnd()}\n`);
  return { ok: true, state: loadState(projectDir) };
}

module.exports = { atomicWrite, eventState, loadState, modelEdit, screenDependencies, screenEdit, section, table };