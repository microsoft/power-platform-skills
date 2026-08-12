#!/usr/bin/env node

/**
 * Generate prototype-mode mock generated services for a mobile app project.
 *
 * The files intentionally live under src/generated so screen imports match the
 * real Power Apps generated-service paths. /prototype-to-real-app later replaces
 * these with real Dataverse/connector services and cleanup-prototype-artifacts.js
 * proves that no mock runtime remains.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const planPath = path.join(projectRoot, 'native-app-plan.md');

if (!fs.existsSync(planPath)) {
  fail(`native-app-plan.md not found: ${planPath}`);
}

const planText = fs.readFileSync(planPath, 'utf8');
const tables = parseTables(planText);
const connectors = parseConnectors(planText);

if (tables.length === 0) {
  fail('No tables found in native-app-plan.md. Expected a ## Data Model section with table rows or entity blocks.');
}

const servicesDir = path.join(projectRoot, 'src', 'generated', 'services');
const modelsDir = path.join(projectRoot, 'src', 'generated', 'models');
const schemasDir = path.join(projectRoot, 'src', 'generated', 'schemas');
fs.mkdirSync(servicesDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(schemasDir, { recursive: true });

const rowsByTable = seedRows(tables);

for (const table of tables) {
  fs.writeFileSync(path.join(servicesDir, `${table.serviceName}Service.ts`), renderService(table));
  fs.writeFileSync(path.join(servicesDir, `${table.serviceName}.seed.json`), `${JSON.stringify(rowsByTable.get(table.logicalName), null, 2)}\n`);
  fs.writeFileSync(path.join(modelsDir, `${table.serviceName}Model.ts`), renderModel(table));
  fs.writeFileSync(path.join(schemasDir, `${table.serviceName}.Schema.ts`), renderSchema(table));
}

for (const connector of connectors) {
  fs.writeFileSync(path.join(servicesDir, `${connector.serviceName}Service.ts`), renderConnectorStub(connector));
}

fs.writeFileSync(path.join(servicesDir, 'dataSourcesInfo.ts'), renderDataSourcesInfo(tables, connectors));

console.log(`prototype mocks: generated ${tables.length} table service(s), ${connectors.length} connector stub(s)`);
console.log(`prototype mocks: ${servicesDir}`);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function section(markdown, heading) {
  const start = markdown.search(new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im'));
  if (start < 0) return '';
  const rest = markdown.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function parseTables(markdown) {
  const dataModel = section(markdown, 'Data Model') || markdown;
  const tables = new Map();

  // Current mobile-app plans commonly use a markdown table with Logical name.
  for (const line of dataModel.split(/\r?\n/)) {
    if (!line.includes('|') || !line.includes('`')) continue;
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    const logicalCell = cells.find((cell) => /`[a-zA-Z][a-zA-Z0-9_]*`/.test(cell));
    if (!logicalCell) continue;
    const logicalName = logicalCell.match(/`([^`]+)`/)?.[1];
    if (!logicalName || /logical name/i.test(logicalName)) continue;
    const displayName = cells.find((cell) => cell && !cell.includes('`') && !/^[-✅🟡0-9]+$/.test(cell)) || titleCase(logicalName.replace(/^cr_/, '').replace(/_/g, ' '));
    addTable(tables, logicalName, displayName, inferFieldsFromNearby(dataModel, logicalName));
  }

  // Older prototype planner blocks: **Entity** (`cr_entity`) then field bullets.
  const blockRe = /\*\*([^*`]+?)\*\*\s*\(`([^`]+)`\)[^\n]*\n((?:\s*-\s*`[^`]+`[^\n]*\n?)+)/g;
  let match;
  while ((match = blockRe.exec(dataModel)) !== null) {
    const fields = [];
    for (const line of match[3].split(/\r?\n/)) {
      const fieldMatch = line.match(/-\s*`([^`]+)`\s*\(([^)]+)\)/);
      if (!fieldMatch) continue;
      fields.push(field(fieldMatch[1], fieldMatch[2]));
    }
    addTable(tables, match[2], match[1], fields);
  }

  return [...tables.values()].map((table) => {
    const primaryId = `${table.logicalName}id`;
    if (!table.fields.some((candidate) => candidate.name === primaryId)) {
      table.fields.unshift(field(primaryId, 'uniqueidentifier'));
    }
    if (!table.fields.some((candidate) => /name$|title$|subject$/i.test(candidate.name))) {
      table.fields.push(field(`${table.logicalName}_name`, 'text'));
    }
    return table;
  });
}

function addTable(tables, logicalName, displayName, fields) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(logicalName)) return;
  if (tables.has(logicalName)) {
    const existing = tables.get(logicalName);
    for (const item of fields) {
      if (!existing.fields.some((candidate) => candidate.name === item.name)) existing.fields.push(item);
    }
    return;
  }
  tables.set(logicalName, {
    logicalName,
    entitySetName: pluralize(logicalName),
    displayName: displayName || titleCase(logicalName.replace(/^cr_/, '').replace(/_/g, ' ')),
    serviceName: generatedDataverseName(logicalName),
    fields: fields.length ? fields : defaultFields(logicalName),
  });
}

function inferFieldsFromNearby(text, logicalName) {
  const fields = [];
  const index = text.indexOf(`\`${logicalName}\``);
  if (index < 0) return fields;
  const nearby = text.slice(index, index + 1800);
  for (const fieldMatch of nearby.matchAll(/`([a-zA-Z][a-zA-Z0-9_]+)`\s*\(([^)]+)\)/g)) {
    const name = fieldMatch[1];
    if (name === logicalName) continue;
    fields.push(field(name, fieldMatch[2]));
  }
  return fields;
}

function defaultFields(logicalName) {
  return [
    field(`${logicalNameidSafe(logicalName)}_name`, 'text'),
    field('status', 'choice'),
    field('createdon', 'datetime'),
    field('notes', 'multiline text'),
  ];
}

function logicalNameidSafe(logicalName) {
  return logicalName.replace(/id$/i, '');
}

function field(name, typeSpec) {
  const lower = String(typeSpec || '').toLowerCase();
  let tsType = 'string';
  let kind = 'text';
  if (/bool|yes\/no|twooptions/.test(lower)) { tsType = 'boolean'; kind = 'boolean'; }
  else if (/int|whole|decimal|double|number|currency/.test(lower)) { tsType = 'number'; kind = 'number'; }
  else if (/date|time/.test(lower)) { tsType = 'string'; kind = 'datetime'; }
  else if (/choice|picklist|status|state/.test(lower)) { tsType = 'number'; kind = 'choice'; }
  else if (/lookup|customer|owner/.test(lower) || /^_.*_value$/.test(name)) { tsType = 'string'; kind = 'lookup'; }
  else if (/image|photo/.test(lower + name.toLowerCase())) { tsType = 'string'; kind = 'image'; }
  else if (/file|document|attachment/.test(lower + name.toLowerCase())) { tsType = 'string'; kind = 'file'; }
  return { name, tsType, kind, rawType: typeSpec || 'text' };
}

function parseConnectors(markdown) {
  const connectorsSection = section(markdown, 'Connectors');
  if (!connectorsSection || /_None/i.test(connectorsSection)) return [];
  const connectors = [];
  for (const line of connectorsSection.split(/\r?\n/)) {
    if (!line.includes('|') || !line.includes('`')) continue;
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.some((cell) => /api name/i.test(cell))) continue;
    const apiName = cells.find((cell) => /`[^`]+`/.test(cell))?.match(/`([^`]+)`/)?.[1];
    if (!apiName) continue;
    const label = cells[0] && !cells[0].includes('`') ? cells[0] : apiName;
    connectors.push({ label, apiName, serviceName: serviceNameForConnector(apiName) });
  }
  return dedupe(connectors, (item) => item.apiName);
}

function serviceNameForConnector(apiName) {
  const known = {
    sharepointonline: 'SharePointOnline',
    office365users: 'Office365Users',
    office365: 'Office365',
    outlook: 'Office365Outlook',
    teams: 'Teams',
    excelonlinebusiness: 'ExcelOnlineBusiness',
    onedriveforbusiness: 'OneDriveForBusiness',
    azuredevops: 'AzureDevOps',
    azureblob: 'AzureBlob',
    sql: 'Sql',
  };
  return known[apiName.toLowerCase()] || pascal(apiName.replace(/^shared_/, '').replace(/[^a-zA-Z0-9]+/g, '_'));
}

function seedRows(tables) {
  const result = new Map();
  for (const table of tables) {
    const rows = [];
    for (let index = 0; index < 8; index += 1) {
      const row = {};
      for (const item of table.fields) row[item.name] = sampleValue(table, item, index);
      rows.push(row);
    }
    result.set(table.logicalName, rows);
  }
  return result;
}

function sampleValue(table, item, index) {
  if (item.name === `${table.logicalName}id`) return pseudoGuid(`${table.logicalName}-${index}`);
  const lower = item.name.toLowerCase();
  if (item.kind === 'number') return /priority|severity|status/.test(lower) ? (index % 3) + 1 : (index + 1) * 10;
  if (item.kind === 'choice') return (index % 4) + 1;
  if (item.kind === 'boolean') return index % 2 === 0;
  if (item.kind === 'datetime') return new Date(Date.now() + (index - 2) * 86400000).toISOString();
  if (item.kind === 'image') return `https://picsum.photos/seed/${encodeURIComponent(table.logicalName + index)}/640/420`;
  if (item.kind === 'file') return `sample-${index + 1}.pdf`;
  if (item.kind === 'lookup' || /^_.*_value$/.test(lower) || /id$/.test(lower)) return pseudoGuid(`${item.name}-${index}`);
  if (/status|state/.test(lower)) return ['Open', 'In progress', 'Blocked', 'Complete'][index % 4];
  if (/name|title|subject/.test(lower)) return `${table.displayName} ${index + 1}`;
  if (/note|description|comment/.test(lower)) return `Prototype ${table.displayName.toLowerCase()} note ${index + 1}`;
  return `${titleCase(item.name.replace(/_/g, ' '))} ${index + 1}`;
}

function renderModel(table) {
  return `// Auto-generated by gen-mock-services.js — prototype model.\nexport interface ${table.serviceName} {\n${table.fields.map((item) => `  ${item.name}: ${item.tsType};`).join('\n')}\n}\n`;
}

function renderSchema(table) {
  return `// Auto-generated by gen-mock-services.js — prototype schema compatibility export.\nexport type { ${table.serviceName} } from '../models/${table.serviceName}Model';\n`;
}

function renderService(table) {
  const typeName = table.serviceName;
  const pk = `${table.logicalName}id`;
  return `// Auto-generated by gen-mock-services.js — PROTOTYPE MOCK SERVICE.\n// In-memory store resets on JS reload. /prototype-to-real-app replaces this file.\nimport seedRows from './${table.serviceName}.seed.json';\nimport type { ${typeName} } from '../models/${table.serviceName}Model';\n\ntype OperationError = { message: string };\ntype OperationResult<T> = { success: boolean; data?: T; error?: OperationError; nextLink?: string | null; skipToken?: string | null };\ntype GetAllOptions = { top?: number; maxPageSize?: number; orderBy?: string[] | string; select?: string[]; filter?: string; skipToken?: string };\n\nlet rows: ${typeName}[] | null = null;\n\nfunction load(): ${typeName}[] {\n  if (!rows) rows = JSON.parse(JSON.stringify(seedRows)) as ${typeName}[];\n  return rows;\n}\n\nfunction ok<T>(data: T): OperationResult<T> { return { success: true, data }; }\nfunction fail(message: string): OperationResult<never> { return { success: false, error: { message } }; }\nfunction newId(): string { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8; return v.toString(16); }); }\n\nfunction applyOptions(items: ${typeName}[], options?: GetAllOptions): ${typeName}[] {\n  let output = [...items];\n  const order = Array.isArray(options?.orderBy) ? options?.orderBy?.[0] : options?.orderBy;\n  if (order) {\n    const [field, dir = 'asc'] = String(order).split(/\\s+/);\n    output.sort((a, b) => {\n      const av = (a as any)[field];\n      const bv = (b as any)[field];\n      if (av === bv) return 0;\n      return (av > bv ? 1 : -1) * (dir.toLowerCase() === 'desc' ? -1 : 1);\n    });\n  }\n  const limit = options?.maxPageSize ?? options?.top;\n  if (limit) output = output.slice(0, limit);\n  return output;\n}\n\nexport const ${table.serviceName}Service = {\n  async getAll(options?: GetAllOptions): Promise<OperationResult<${typeName}[]>> {\n    return ok(applyOptions(load(), options));\n  },\n  async get(id: string): Promise<OperationResult<${typeName}>> {\n    const item = load().find(row => (row as any).${pk} === id);\n    return item ? ok(item) : fail('${table.displayName} not found');\n  },\n  async getById(id: string): Promise<OperationResult<${typeName}>> {\n    return this.get(id);\n  },\n  async create(input: Partial<${typeName}>): Promise<OperationResult<${typeName}>> {\n    const created = { ...(input as any), ${pk}: (input as any).${pk} || newId() } as ${typeName};\n    rows = [...load(), created];\n    return ok(created);\n  },\n  async update(id: string, patch: Partial<${typeName}>): Promise<OperationResult<${typeName}>> {\n    const items = load();\n    const index = items.findIndex(row => (row as any).${pk} === id);\n    if (index < 0) return fail('${table.displayName} not found');\n    items[index] = { ...items[index], ...(patch as any) };\n    return ok(items[index]);\n  },\n  async delete(id: string): Promise<OperationResult<void>> {\n    rows = load().filter(row => (row as any).${pk} !== id);\n    return ok(undefined);\n  },\n  async clear(): Promise<OperationResult<void>> {\n    rows = null;\n    return ok(undefined);\n  },\n};\n\nexport default ${table.serviceName}Service;\n`;
}

function renderConnectorStub(connector) {
  return `// Auto-generated by gen-mock-services.js — PROTOTYPE CONNECTOR STUB.\n// /prototype-to-real-app replaces this file with a real generated connector service.\ntype OperationError = { message: string };\ntype OperationResult<T> = { success: boolean; data?: T; error?: OperationError };\n\nfunction planned(method: string): Promise<OperationResult<never>> {\n  return Promise.resolve({\n    success: false,\n    error: { message: 'Connector "${connector.apiName}" method "' + method + '" is planned but not mockable in prototype mode. Run /prototype-to-real-app to provision the real connector.' },\n  });\n}\n\nexport const ${connector.serviceName}Service = new Proxy({}, {\n  get(_target, prop) {\n    if (prop === 'then') return undefined;\n    return (..._args: unknown[]) => planned(String(prop));\n  },\n}) as Record<string, (...args: unknown[]) => Promise<OperationResult<unknown>>>;\n\nexport default ${connector.serviceName}Service;\n`;
}

function renderDataSourcesInfo(tables, connectors) {
  return `// Auto-generated by gen-mock-services.js — prototype registry.\n${tables.map((table) => `export { ${table.serviceName}Service } from './${table.serviceName}Service';`).join('\n')}\n${connectors.map((connector) => `export { ${connector.serviceName}Service } from './${connector.serviceName}Service';`).join('\n')}\n\nexport const REGISTERED_DATA_SOURCES = [\n${tables.map((table) => `  '${table.logicalName}'`).join(',\n')}\n] as const;\n\nexport const REGISTERED_CONNECTORS = [\n${connectors.map((connector) => `  '${connector.apiName}'`).join(',\n')}\n] as const;\n`;
}

function pascal(value) {
  return String(value).split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function generatedDataverseName(logicalName) {
  // The current Power Apps generator preserves underscores in Dataverse service
  // filenames, e.g. `cr3e9_projects` -> `Cr3e9_projectsService.ts`.
  return logicalName.charAt(0).toUpperCase() + logicalName.slice(1);
}

function titleCase(value) {
  return String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pluralize(value) {
  if (value.endsWith('s')) return value;
  if (value.endsWith('y')) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

function pseudoGuid(seed) {
  let hash = 0;
  for (const char of seed) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-0000-4000-8000-${hex}${hex}`.slice(0, 36);
}

function dedupe(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}