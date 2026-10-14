'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const { readEntityWithDescriptions, readRelationships, runDownload } = require('../download-model-app.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The OS temp directory, never a folder under scripts/: sdk-async-surface.test.js lists every .js file
// under scripts/ and reads each one later, so a scratch directory removed in between fails that scan.
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}`));
  tempDirs.push(dir);
  return dir;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function label(en, es) {
  const rows = [{ Label: en, LanguageCode: 1033 }];
  if (es) rows.push({ Label: es, LanguageCode: 3082 });
  return {
    LocalizedLabels: rows,
    UserLocalizedLabel: rows[0],
  };
}

function recursiveFiles(root, relative = '') {
  const here = path.join(root, relative);
  const entries = fs.readdirSync(here, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) out.push(...recursiveFiles(root, next));
    else out.push(next.replace(/\\/g, '/'));
  }
  return out.sort();
}

function snapshotDir(root) {
  const files = recursiveFiles(root);
  return Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file))]));
}

async function captureStderr(fn) {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = (chunk, ...rest) => {
    text += String(chunk);
    return true;
  };
  try {
    return { result: await fn(), stderr: text };
  } finally {
    process.stderr.write = original;
  }
}

function makeBarrier(expected) {
  if (!expected) return { wait: async () => {} };
  let seen = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    wait: async () => {
      seen += 1;
      if (seen === expected) release();
      await gate;
    },
  };
}

function makeStageStats() {
  return {
    current: 0,
    max: 0,
    counts: Object.create(null),
    completed: [],
  };
}

function enterStage(stats, route) {
  stats.current += 1;
  stats.max = Math.max(stats.max, stats.current);
  stats.counts[route] = (stats.counts[route] || 0) + 1;
  return () => {
    stats.current -= 1;
    stats.completed.push(route);
  };
}

function normalizedUrl(url) {
  return decodeURIComponent(String(url || ''));
}

function matchAuxRoute(url) {
  const text = normalizedUrl(url);
  if (/\?\$select=LogicalName,Description,DisplayName,DisplayCollectionName$/.test(text)) return 'entity-labels';
  if (/\/Attributes\?\$select=LogicalName,Description,DisplayName,IsLogical,AttributeOf,AttributeTypeName$/.test(text)) return 'attribute-labels';
  if (/MoneyAttributeMetadata\?\$select=LogicalName,IsBaseCurrency$/.test(text)) return 'money';
  if (/PicklistAttributeMetadata\?\$select=LogicalName&\$expand=OptionSet\(\$select=Name,IsGlobal,Options\)/.test(text)) return 'picklist';
  if (/MultiSelectPicklistAttributeMetadata\?\$select=LogicalName&\$expand=OptionSet\(\$select=Name,IsGlobal,Options\)/.test(text)) return 'multiselect';
  return null;
}

function entityBase(logical) {
  const prefix = logical.split('_')[0];
  return {
    logicalName: logical,
    schemaName: logical,
    displayName: logical.replace(/^contoso_/, '').replace(/^\w/, (c) => c.toUpperCase()),
    primaryNameAttribute: `${prefix}_name`,
    attributes: [
      { logicalName: `${prefix}_name`, displayName: 'Name', attributeType: 'String', isCustomAttribute: true },
      { logicalName: `${prefix}_amount`, displayName: 'Amount', attributeType: 'Money', isCustomAttribute: true },
      { logicalName: `${prefix}_amount_base`, displayName: 'Amount (Base)', attributeType: 'Money', isCustomAttribute: true },
      { logicalName: `${prefix}_localchoice`, displayName: 'Local Choice', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: `${prefix}_globalchoice`, displayName: 'Global Choice', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: `${prefix}_multi`, displayName: 'Multi', attributeType: 'MultiSelectPicklist', isCustomAttribute: true },
    ],
    relationships: [],
  };
}

function auxEntityResponse(logical, route) {
  const prefix = logical.split('_')[0];
  switch (route) {
    case 'entity-labels':
      return { status: 200, body: { LogicalName: logical, Description: label(`${logical} description`, `${logical} descripción`), DisplayName: label(`${logical} label`, `${logical} etiqueta`), DisplayCollectionName: label(`${logical} rows`, `${logical} filas`) } };
    case 'attribute-labels':
      return {
        status: 200,
        body: {
          value: [
            { LogicalName: `${prefix}_name`, DisplayName: label('Name', 'Nombre'), AttributeTypeName: { Value: 'StringType' } },
            { LogicalName: `${prefix}_amount`, DisplayName: label('Amount', 'Importe'), AttributeTypeName: { Value: 'MoneyType' } },
            { LogicalName: `${prefix}_amount_base`, DisplayName: label('Amount (Base)', 'Importe (base)'), AttributeTypeName: { Value: 'MoneyType' } },
            { LogicalName: `${prefix}_localchoice`, DisplayName: label('Local Choice', 'Elección local'), AttributeTypeName: { Value: 'PicklistType' } },
            { LogicalName: `${prefix}_globalchoice`, DisplayName: label('Global Choice', 'Elección global'), AttributeTypeName: { Value: 'PicklistType' } },
            { LogicalName: `${prefix}_multi`, DisplayName: label('Multi', 'Multi'), AttributeTypeName: { Value: 'MultiSelectPicklistType' } },
          ],
        },
      };
    case 'money':
      return { status: 200, body: { value: [{ LogicalName: `${prefix}_amount_base`, IsBaseCurrency: true }] } };
    case 'picklist':
      return {
        status: 200,
        body: {
          value: [
            {
              LogicalName: `${prefix}_localchoice`,
              OptionSet: {
                Name: `${logical}_localchoice`,
                IsGlobal: false,
                Options: [{ Value: 100000000, Label: label('One', 'Uno') }, { Value: 100000001, Label: label('Two', 'Dos') }],
              },
            },
            {
              LogicalName: `${prefix}_globalchoice`,
              OptionSet: {
                Name: 'shared_stage',
                IsGlobal: true,
                Options: [{ Value: 1, Label: label('Draft', 'Borrador') }, { Value: 2, Label: label('Final', 'Final') }],
              },
            },
          ],
        },
      };
    case 'multiselect':
      return {
        status: 200,
        body: {
          value: [{
            LogicalName: `${prefix}_multi`,
            OptionSet: {
              Name: `${logical}_multi`,
              IsGlobal: false,
              Options: [{ Value: 1, Label: label('North', 'Norte') }, { Value: 2, Label: label('South', 'Sur') }],
            },
          }],
        },
      };
    default:
      return { status: 404, body: null };
  }
}

async function runEntityReadWithStub(logical, { concurrency, barrier = false, fail = {}, delays = {} } = {}) {
  const stats = makeStageStats();
  const gate = makeBarrier(barrier ? 4 : 0);
  const sdk = {
    fetchEntityMetadata: async () => entityBase(logical),
    dataverse: {
      get: async (url) => {
        const route = matchAuxRoute(url);
        if (!route) throw new Error(`unexpected aux url: ${url}`);
        const leave = enterStage(stats, route);
        try {
          if (barrier && ['entity-labels', 'attribute-labels', 'money', 'picklist'].includes(route)) await gate.wait();
          if (delays[route]) await sleep(delays[route]);
          const response = fail[route];
          if (response && response.throw) throw new Error(response.throw);
          if (response && response.status) return { status: response.status, body: response.body || null };
          return auxEntityResponse(logical, route);
        } finally {
          leave();
        }
      },
    },
  };
  const meta = await readEntityWithDescriptions(sdk, logical, { concurrency });
  return { meta, stats };
}

function makeRealBundleHttpClient({ auxBarrier = false, delays = {} } = {}) {
  const stats = makeStageStats();
  const barrier = makeBarrier(auxBarrier ? 4 : 0);
  const responseFor = (url) => {
    const text = normalizedUrl(url);
    if (/EntityDefinitions\(LogicalName='contoso_alpha'\)\?/.test(text)) {
      return {
        status: 200,
        headers: {},
        body: {
          LogicalName: 'contoso_alpha',
          SchemaName: 'contoso_alpha',
          DisplayName: label('Alpha', 'Alfa'),
          Description: label('Alpha table', 'Tabla Alfa'),
          EntitySetName: 'contoso_alphas',
          IsCustomEntity: true,
          PrimaryNameAttribute: 'contoso_name',
          PrimaryIdAttribute: 'contoso_alphaid',
          Attributes: [
            { LogicalName: 'contoso_name', DisplayName: label('Name', 'Nombre'), AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsCustomAttribute: true },
            { LogicalName: 'contoso_amount', DisplayName: label('Amount', 'Importe'), AttributeType: 'Money', AttributeTypeName: { Value: 'MoneyType' }, IsCustomAttribute: true },
            { LogicalName: 'contoso_amount_base', DisplayName: label('Amount (Base)', 'Importe (base)'), AttributeType: 'Money', AttributeTypeName: { Value: 'MoneyType' }, IsCustomAttribute: true },
            { LogicalName: 'contoso_localchoice', DisplayName: label('Local Choice', 'Elección local'), AttributeType: 'Picklist', AttributeTypeName: { Value: 'PicklistType' }, IsCustomAttribute: true },
            { LogicalName: 'contoso_multi', DisplayName: label('Multi', 'Multi'), AttributeType: 'MultiSelectPicklist', AttributeTypeName: { Value: 'MultiSelectPicklistType' }, IsCustomAttribute: true },
          ],
        },
      };
    }
    if (/StringAttributeMetadata/.test(text)) return { status: 200, headers: {}, body: { value: [] } };
    if (/PicklistAttributeMetadata/.test(text) && /\$select=Options\)/.test(text)) {
      return {
        status: 200,
        headers: {},
        body: {
          value: [{
            LogicalName: 'contoso_localchoice',
            OptionSet: { Options: [{ Value: 100000000, Label: label('One', 'Uno') }, { Value: 100000001, Label: label('Two', 'Dos') }] },
          }],
        },
      };
    }
    if (/MultiSelectPicklistAttributeMetadata/.test(text) && /\$select=Options\)/.test(text)) {
      return {
        status: 200,
        headers: {},
        body: {
          value: [{
            LogicalName: 'contoso_multi',
            OptionSet: { Options: [{ Value: 1, Label: label('North', 'Norte') }, { Value: 2, Label: label('South', 'Sur') }] },
          }],
        },
      };
    }
    if (/LookupAttributeMetadata/.test(text)) return { status: 200, headers: {}, body: { value: [] } };
    if (/ManyToOneRelationships/.test(text) || /ManyToManyRelationships/.test(text) || /OneToManyRelationships/.test(text)) {
      return { status: 200, headers: {}, body: { value: [] } };
    }
    const route = matchAuxRoute(text);
    if (route) return { status: 200, headers: {}, body: auxEntityResponse('contoso_alpha', route).body };
    if (/StateAttributeMetadata/.test(text) || /StatusAttributeMetadata/.test(text)) return { status: 200, headers: {}, body: { value: [] } };
    throw new Error(`unexpected real-bundle url: ${url}`);
  };
  const get = async (url) => {
    const route = matchAuxRoute(url);
    const leave = route ? enterStage(stats, route) : () => {};
    try {
      if (route && auxBarrier && ['entity-labels', 'attribute-labels', 'money', 'picklist'].includes(route)) await barrier.wait();
      if (route && delays[route]) await sleep(delays[route]);
      return responseFor(url);
    } finally {
      leave();
    }
  };
  return {
    stats,
    httpClient: {
      get,
      post: async () => ({ status: 204, headers: {}, body: {} }),
      patch: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
      put: async () => ({ status: 204, headers: {}, body: {} }),
    },
  };
}

async function runRealBundleEntityRead(concurrency, { barrier = false } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const workspace = tempDir('download-parallel-real-bundle-');
  const { httpClient, stats } = makeRealBundleHttpClient({ auxBarrier: barrier, delays: { 'entity-labels': 8, 'attribute-labels': 6, money: 7, picklist: 9, multiselect: 5 } });
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(workspace),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient,
  });
  await sdk.initWorkspace();
  const meta = await readEntityWithDescriptions(sdk, 'contoso_alpha', { concurrency });
  return { meta, stats };
}

function relationshipScenario({ barrier = false, delays = {}, failures = {} } = {}) {
  const stats = makeStageStats();
  const gate = makeBarrier(barrier ? 3 : 0);
  const labelMap = {
    contoso_alpha_ownerid: { LogicalName: 'contoso_alpha_ownerid', SchemaName: 'contoso_AlphaOwnerId', DisplayName: label('Owner', 'Propietario'), Targets: ['systemuser'] },
    contoso_beta_alphaid: { LogicalName: 'contoso_beta_alphaid', SchemaName: 'contoso_BetaAlphaId', DisplayName: label('Alpha', 'Alfa'), Targets: ['contoso_alpha'] },
    contoso_beta_polyid: { LogicalName: 'contoso_beta_polyid', SchemaName: 'contoso_BetaPolyId', DisplayName: label('Poly', 'Poli'), Targets: ['account', 'contact'] },
    contoso_gamma_customid: { LogicalName: 'contoso_gamma_customid', SchemaName: 'contoso_GammaCustomId', DisplayName: label('Custom', 'Personalizado'), Targets: ['contoso_customparent'] },
    contoso_gamma_unknownid: { LogicalName: 'contoso_gamma_unknownid', SchemaName: 'contoso_GammaUnknownId', DisplayName: label('Unknown', 'Desconocido'), Targets: ['contoso_unknownparent'] },
  };
  const manyToOne = {
    contoso_alpha: [
      { IsCustomRelationship: true, SchemaName: 'contoso_systemuser_contoso_alpha', ReferencedEntity: 'systemuser', ReferencingEntity: 'contoso_alpha', ReferencingAttribute: 'contoso_alpha_ownerid' },
    ],
    contoso_beta: [
      { IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_beta', ReferencedEntity: 'contoso_alpha', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_alphaid' },
      { IsCustomRelationship: true, SchemaName: 'contoso_beta_account', ReferencedEntity: 'account', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_polyid' },
      { IsCustomRelationship: true, SchemaName: 'contoso_beta_contact', ReferencedEntity: 'contact', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_polyid' },
    ],
    contoso_gamma: [
      { IsCustomRelationship: true, SchemaName: 'contoso_customparent_contoso_gamma', ReferencedEntity: 'contoso_customparent', ReferencingEntity: 'contoso_gamma', ReferencingAttribute: 'contoso_gamma_customid' },
      { IsCustomRelationship: true, SchemaName: 'contoso_unknownparent_contoso_gamma', ReferencedEntity: 'contoso_unknownparent', ReferencingEntity: 'contoso_gamma', ReferencingAttribute: 'contoso_gamma_unknownid' },
    ],
  };
  const manyToMany = {
    contoso_alpha: [{ IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_gamma', Entity1LogicalName: 'contoso_alpha', Entity2LogicalName: 'contoso_gamma' }],
    contoso_gamma: [{ IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_gamma', Entity1LogicalName: 'contoso_alpha', Entity2LogicalName: 'contoso_gamma' }],
  };
  const customStates = {
    systemuser: false,
    contoso_customparent: true,
  };
  const ofEntity = (url) => (url.match(/LogicalName='([^']+)'/) || [])[1];
  const get = async (url) => {
    const logical = ofEntity(url);
    const route = /ManyToOneRelationships/.test(url) ? `${logical}:m2o`
      : /LookupAttributeMetadata/.test(url) ? `${logical}:lookup`
        : /ManyToManyRelationships/.test(url) ? `${logical}:m2m`
          : /\?\$select=IsCustomEntity/.test(url) ? `${logical}:parent`
            : null;
    if (!route) throw new Error(`unexpected relationship url: ${url}`);
    const leave = enterStage(stats, route);
    try {
      if (barrier && /:m2o$/.test(route)) await gate.wait();
      if (delays[route]) await sleep(delays[route]);
      const fail = failures[route];
      if (fail && fail.throw) throw new Error(fail.throw);
      if (fail && fail.status) return { status: fail.status, body: fail.body || null };
      if (/ManyToOneRelationships/.test(url)) return { status: 200, body: { value: manyToOne[logical] || [] } };
      if (/LookupAttributeMetadata/.test(url)) {
        const rows = (manyToOne[logical] || []).map((row) => labelMap[row.ReferencingAttribute]).filter(Boolean);
        return { status: 200, body: { value: rows } };
      }
      if (/ManyToManyRelationships/.test(url)) return { status: 200, body: { value: manyToMany[logical] || [] } };
      if (logical === 'contoso_unknownparent') return { status: 503, body: null };
      return { status: 200, body: { IsCustomEntity: customStates[logical] !== false } };
    } finally {
      leave();
    }
  };
  return { sdk: { dataverse: { get } }, stats };
}

async function runRelationshipRead({ concurrency, barrier = false, delays = {}, failures = {} } = {}) {
  const warnings = [];
  const { sdk, stats } = relationshipScenario({ barrier, delays, failures });
  const rel = await readRelationships(sdk, ['contoso_alpha', 'contoso_beta', 'contoso_gamma'], 'contoso', (message) => warnings.push(message), { concurrency });
  return { rel, warnings, stats };
}

function richDownloadFixture() {
  const appId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const layerId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const appUnique = 'contoso_downloadapp';
  const pageOverview = 'bbbbbbbb-0000-4000-8000-000000000001';
  const pageDetail = 'bbbbbbbb-0000-4000-8000-000000000002';
  const sitemapXml = `<SiteMap><Area><Group>`
    + `<SubArea Entity="contoso_alpha" Title="Alpha"/>`
    + `<SubArea Entity="contoso_beta" Title="Beta"/>`
    + `<SubArea Entity="contoso_gamma" Title="Gamma"/>`
    + `<SubArea GenPageId="${pageOverview}" Title="Overview"/>`
    + `<SubArea GenPageId="${pageDetail}" Title="Detail"/>`
    + `</Group></Area></SiteMap>`;
  const auxStats = makeStageStats();
  const relStats = makeStageStats();
  const componentRows = [];
  const app = {
    name: 'Download App',
    uniqueName: appUnique,
    description: '',
    siteMap: {
      areas: [{
        title: 'Main',
        groups: [{
          title: 'Data',
          subAreas: [
            { type: 'Entity', entity: 'contoso_alpha', title: 'Alpha' },
            { type: 'Entity', entity: 'contoso_beta', title: 'Beta' },
            { type: 'Entity', entity: 'contoso_gamma', title: 'Gamma' },
            { type: 'GenPage', genPageId: pageOverview, title: 'Overview' },
            { type: 'GenPage', genPageId: pageDetail, title: 'Detail' },
          ],
        }],
      }],
    },
  };
  const baseMeta = {
    contoso_alpha: {
      schemaName: 'contoso_alpha',
      displayName: 'Alpha',
      primaryNameAttribute: 'contoso_name',
      attributes: [
        { logicalName: 'contoso_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true },
        { logicalName: 'contoso_amount', displayName: 'Amount', attributeType: 'Money', isCustomAttribute: true },
        { logicalName: 'contoso_amount_base', displayName: 'Amount (Base)', attributeType: 'Money', isCustomAttribute: true },
        { logicalName: 'contoso_localchoice', displayName: 'Local Choice', attributeType: 'Picklist', isCustomAttribute: true },
      ],
      relationships: [],
    },
    contoso_beta: {
      schemaName: 'contoso_beta',
      displayName: 'Beta',
      primaryNameAttribute: 'contoso_name',
      attributes: [
        { logicalName: 'contoso_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true },
        { logicalName: 'contoso_globalchoice', displayName: 'Global Choice', attributeType: 'Picklist', isCustomAttribute: true },
        { logicalName: 'contoso_multi', displayName: 'Tags', attributeType: 'MultiSelectPicklist', isCustomAttribute: true },
      ],
      relationships: [],
    },
    contoso_gamma: {
      schemaName: 'contoso_gamma',
      displayName: 'Gamma',
      primaryNameAttribute: 'contoso_name',
      attributes: [
        { logicalName: 'contoso_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true },
        { logicalName: 'contoso_problem', displayName: 'Problem', attributeType: 'Picklist', isCustomAttribute: true },
      ],
      relationships: [],
    },
  };
  const metadataRows = {
    contoso_alpha: auxEntityResponse('contoso_alpha', 'attribute-labels').body.value,
    contoso_beta: auxEntityResponse('contoso_beta', 'attribute-labels').body.value,
    contoso_gamma: auxEntityResponse('contoso_gamma', 'attribute-labels').body.value,
  };
  const ofEntity = (url) => (url.match(/LogicalName='([^']+)'/) || [])[1];
  const lookupRows = {
    contoso_alpha: [{ LogicalName: 'contoso_alpha_ownerid', SchemaName: 'contoso_AlphaOwnerId', DisplayName: label('Owner', 'Propietario'), Targets: ['systemuser'] }],
    contoso_beta: [
      { LogicalName: 'contoso_beta_alphaid', SchemaName: 'contoso_BetaAlphaId', DisplayName: label('Alpha', 'Alfa'), Targets: ['contoso_alpha'] },
      { LogicalName: 'contoso_beta_polyid', SchemaName: 'contoso_BetaPolyId', DisplayName: label('Poly', 'Poli'), Targets: ['account', 'contact'] },
    ],
    contoso_gamma: [{ LogicalName: 'contoso_gamma_unknownid', SchemaName: 'contoso_GammaUnknownId', DisplayName: label('Unknown', 'Desconocido'), Targets: ['contoso_unknownparent'] }],
  };
  const manyToOne = {
    contoso_alpha: [{ IsCustomRelationship: true, SchemaName: 'contoso_systemuser_contoso_alpha', ReferencedEntity: 'systemuser', ReferencingEntity: 'contoso_alpha', ReferencingAttribute: 'contoso_alpha_ownerid' }],
    contoso_beta: [
      { IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_beta', ReferencedEntity: 'contoso_alpha', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_alphaid' },
      { IsCustomRelationship: true, SchemaName: 'contoso_beta_account', ReferencedEntity: 'account', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_polyid' },
      { IsCustomRelationship: true, SchemaName: 'contoso_beta_contact', ReferencedEntity: 'contact', ReferencingEntity: 'contoso_beta', ReferencingAttribute: 'contoso_beta_polyid' },
    ],
    contoso_gamma: [{ IsCustomRelationship: true, SchemaName: 'contoso_unknownparent_contoso_gamma', ReferencedEntity: 'contoso_unknownparent', ReferencingEntity: 'contoso_gamma', ReferencingAttribute: 'contoso_gamma_unknownid' }],
  };
  const manyToMany = {
    contoso_alpha: [{ IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_gamma', Entity1LogicalName: 'contoso_alpha', Entity2LogicalName: 'contoso_gamma' }],
    contoso_gamma: [{ IsCustomRelationship: true, SchemaName: 'contoso_alpha_contoso_gamma', Entity1LogicalName: 'contoso_alpha', Entity2LogicalName: 'contoso_gamma' }],
  };
  const delays = {
    'contoso_alpha:entity-labels': 25,
    'contoso_alpha:attribute-labels': 20,
    'contoso_alpha:money': 15,
    'contoso_alpha:picklist': 12,
    'contoso_alpha:multiselect': 10,
    'contoso_beta:entity-labels': 12,
    'contoso_beta:attribute-labels': 10,
    'contoso_beta:money': 6,
    'contoso_beta:picklist': 14,
    'contoso_beta:multiselect': 8,
    'contoso_gamma:entity-labels': 5,
    'contoso_gamma:attribute-labels': 7,
    'contoso_gamma:money': 4,
    'contoso_gamma:picklist': 6,
    'contoso_gamma:multiselect': 3,
    'contoso_alpha:m2o': 18,
    'contoso_beta:m2o': 7,
    'contoso_gamma:m2o': 4,
    'contoso_alpha:lookup': 6,
    'contoso_beta:lookup': 5,
    'contoso_gamma:lookup': 3,
    'contoso_alpha:m2m': 9,
    'contoso_beta:m2m': 8,
    'contoso_gamma:m2m': 6,
  };
  const sdk = currentReadSdk({
    fetchArtifact: async () => clone(app),
    fetchEntityMetadata: async (logical) => clone(baseMeta[logical]),
    retrieveSetting: async () => null,
    queryRecords: async (set, opts = {}) => {
      const filter = opts.filter || '';
      if (set === 'appmodule') return [{ appmoduleid: appId, appmoduleidunique: layerId, uniquename: appUnique }];
      if (set === 'appmodulecomponent') {
        if (filter.includes('componenttype eq 62')) return [{ objectid: 'cccccccc-0000-4000-8000-000000000001', componenttype: 62 }];
        return componentRows;
      }
      if (set === 'sitemap') return [{ sitemapxml: sitemapXml }];
      if (set === 'webresource') return [];
      if (set === 'systemform' || set === 'savedquery' || set === 'savedqueryvisualization' || set === 'solutioncomponent' || set === 'solution' || set === 'workflow') return [];
      return [];
    },
    dataverse: {
      get: async (url) => {
        const logical = ofEntity(url);
        const auxRoute = matchAuxRoute(url);
        if (auxRoute) {
          const leave = enterStage(auxStats, auxRoute);
          try {
            await sleep(delays[`${logical}:${auxRoute}`] || 1);
            if (logical === 'contoso_alpha' && auxRoute === 'entity-labels') return { status: 503, body: null };
            if (logical === 'contoso_gamma' && auxRoute === 'attribute-labels') throw new Error('gamma labels offline');
            if (logical === 'contoso_gamma' && (auxRoute === 'picklist' || auxRoute === 'multiselect')) return { status: 503, body: null };
            if (auxRoute === 'entity-labels') return { status: 200, body: auxEntityResponse(logical, auxRoute).body };
            if (auxRoute === 'attribute-labels') return { status: 200, body: { value: metadataRows[logical] || [] } };
            if (auxRoute === 'money') return { status: 200, body: auxEntityResponse(logical, auxRoute).body };
            if (auxRoute === 'picklist') {
              if (logical === 'contoso_beta') {
                return {
                  status: 200,
                  body: {
                    value: [{
                      LogicalName: 'contoso_globalchoice',
                      OptionSet: { Name: 'shared_stage', IsGlobal: true, Options: [{ Value: 1, Label: label('Draft', 'Borrador') }, { Value: 2, Label: label('Final', 'Final') }] },
                    }],
                  },
                };
              }
              return { status: 200, body: auxEntityResponse(logical, auxRoute).body };
            }
            if (auxRoute === 'multiselect') {
              if (logical === 'contoso_beta') {
                return {
                  status: 200,
                  body: {
                    value: [{
                      LogicalName: 'contoso_multi',
                      OptionSet: { Name: 'contoso_beta_multi', IsGlobal: false, Options: [{ Value: 1, Label: label('North', 'Norte') }, { Value: 2, Label: label('South', 'Sur') }] },
                    }],
                  },
                };
              }
              return { status: 200, body: { value: [] } };
            }
            throw new Error(`unhandled aux route ${auxRoute}`);
          } finally {
            leave();
          }
        }
        if (/ManyToOneRelationships/.test(url) || /LookupAttributeMetadata/.test(url) || /ManyToManyRelationships/.test(url) || /\?\$select=IsCustomEntity/.test(url)) {
          const route = /ManyToOneRelationships/.test(url) ? 'm2o'
            : /LookupAttributeMetadata/.test(url) ? 'lookup'
              : /ManyToManyRelationships/.test(url) ? 'm2m'
                : 'parent';
          const leave = enterStage(relStats, `${logical}:${route}`);
          try {
            await sleep(delays[`${logical}:${route}`] || 1);
            if (route === 'm2o') return { status: 200, body: { value: manyToOne[logical] || [] } };
            if (route === 'lookup') return { status: 200, body: { value: lookupRows[logical] || [] } };
            if (route === 'm2m') return { status: 200, body: { value: manyToMany[logical] || [] } };
            if (logical === 'contoso_unknownparent') return { status: 503, body: null };
            if (logical === 'systemuser' || logical === 'account' || logical === 'contact') return { status: 200, body: { IsCustomEntity: false } };
            return { status: 200, body: { IsCustomEntity: true } };
          } finally {
            leave();
          }
        }
        if (/EntityDefinitions\([0-9a-fA-F-]+\)\?\$select=LogicalName,IsCustomEntity/.test(url)) {
          return { status: 200, body: { LogicalName: 'contoso_alpha', IsCustomEntity: true } };
        }
        if (/\/systemforms\?\$select=formid,name,formactivationstate/.test(url)) {
          return { status: 200, body: { value: [] } };
        }
        if (/\/GlobalOptionSetDefinitions\?\$select=Name,Description,IsManaged,MetadataId/.test(url)) {
          return { status: 200, body: { value: [] } };
        }
        throw new Error(`unexpected fixture url: ${url}`);
      },
    },
  }, { appId, layerId, sitemapXml });
  const genpageCli = {
    enumerateEnv: async () => ({
      ok: true,
      ids: [pageOverview.toLowerCase(), pageDetail.toLowerCase()],
      pages: [{ pageId: pageOverview, name: 'Overview' }, { pageId: pageDetail, name: 'Detail' }],
    }),
    download: async ({ outputDir, pageIds }) => {
      for (const pageId of pageIds) {
        const pageDir = path.join(outputDir, pageId);
        fs.mkdirSync(pageDir, { recursive: true });
        fs.writeFileSync(path.join(pageDir, 'page.tsx'),
          pageId === pageOverview
            ? 'export default function Overview() { return "overview"; }\n'
            : 'export default function Detail() { return "detail"; }\n',
          'utf8');
        fs.writeFileSync(path.join(pageDir, 'config.json'),
          JSON.stringify({ dataSources: pageId === pageOverview ? ['contoso_alpha'] : ['contoso_beta'] }),
          'utf8');
      }
      return true;
    },
  };
  return { sdk, genpageCli, appId, appUnique, auxStats, relStats };
}

async function runDownloadSnapshot(concurrency) {
  const outDir = tempDir(`download-parallel-${concurrency}-`);
  const fixture = richDownloadFixture();
  const { result, stderr } = await captureStderr(() => runDownload({
    sdk: fixture.sdk,
    genpageCli: fixture.genpageCli,
    outDir,
    appId: fixture.appId,
    appUnique: fixture.appUnique,
    concurrency,
  }));
  assert.ok(result.ok, JSON.stringify(result));
  fs.writeFileSync(path.join(outDir, 'app-spec.json'), JSON.stringify(result.spec, null, 2), 'utf8');
  return { outDir, stderr, result, auxStats: fixture.auxStats, relStats: fixture.relStats };
}

test('real bundle overlaps one table\'s auxiliary metadata reads with the same bounded GET count', async () => {
  const sequential = await runRealBundleEntityRead(1);
  const parallel = await runRealBundleEntityRead(undefined);

  assert.deepStrictEqual(parallel.meta, sequential.meta, 'parallel aux reads must reconstruct the same metadata');
  assert.strictEqual(sequential.stats.max, 1, 'concurrency:1 keeps the aux stage sequential');
  assert.ok(parallel.stats.max > 1, `default concurrency must overlap aux reads (max ${parallel.stats.max})`);
  assert.ok(parallel.stats.max <= 4, `aux overlap stays bounded at 4 (max ${parallel.stats.max})`);
  for (const route of ['entity-labels', 'attribute-labels', 'money', 'picklist', 'multiselect']) {
    assert.strictEqual(parallel.stats.counts[route], sequential.stats.counts[route], `GET count stable for ${route}`);
  }
  for (const route of ['entity-labels', 'attribute-labels', 'money', 'picklist']) {
    assert.ok(parallel.stats.counts[route] >= 1, `${route} issued at least once`);
  }
});

test('runDownload keeps app-spec, pages, and warnings byte-identical while overlapping table and relationship reads', async () => {
  const sequential = await runDownloadSnapshot(1);
  const parallel = await runDownloadSnapshot(undefined);

  assert.strictEqual(sequential.auxStats.max, 1, 'concurrency:1 keeps table aux reads sequential');
  assert.ok(parallel.auxStats.max > 1, `default concurrency overlaps table aux reads (max ${parallel.auxStats.max})`);
  assert.ok(parallel.auxStats.max <= 4, `table aux reads stay bounded at 4 (max ${parallel.auxStats.max})`);
  assert.strictEqual(sequential.relStats.max, 1, 'concurrency:1 keeps per-table relationship chains sequential');
  assert.ok(parallel.relStats.max > 1, `default concurrency overlaps relationship table reads (max ${parallel.relStats.max})`);
  assert.ok(parallel.relStats.max <= 4, `relationship overlap stays bounded at 4 (max ${parallel.relStats.max})`);
  assert.deepStrictEqual(parallel.auxStats.counts, sequential.auxStats.counts, 'table aux GET count must stay unchanged');
  assert.deepStrictEqual(parallel.relStats.counts, sequential.relStats.counts, 'relationship GET count must stay unchanged');
  assert.strictEqual(parallel.stderr, sequential.stderr, 'warning transcript must stay byte-identical');
  assert.deepStrictEqual(snapshotDir(parallel.outDir), snapshotDir(sequential.outDir), 'downloaded files must stay byte-identical');
  assert.deepStrictEqual(parallel.result.spec, sequential.result.spec, 'spec object must stay identical too');
});

test('failure parity stays identical when later tables finish first in time', async () => {
  const attrFirst = await runEntityReadWithStub('contoso_alpha', {
    concurrency: undefined,
    delays: { 'entity-labels': 20, 'attribute-labels': 1, money: 8, picklist: 7, multiselect: 6 },
    fail: {
      'entity-labels': { status: 503 },
      'attribute-labels': { throw: 'attribute labels failed first' },
      money: { throw: 'money timed out' },
      picklist: { status: 503 },
    },
  });
  const attrSequential = await runEntityReadWithStub('contoso_alpha', {
    concurrency: 1,
    fail: {
      'entity-labels': { status: 503 },
      'attribute-labels': { throw: 'attribute labels failed first' },
      money: { throw: 'money timed out' },
      picklist: { status: 503 },
    },
  });
  assert.ok(attrFirst.stats.max > 1, `default concurrency must overlap aux failure reads too (max ${attrFirst.stats.max})`);
  assert.deepStrictEqual(attrFirst.meta, attrSequential.meta, 'aux read failures must preserve sequential metadata + precedence');
  assert.strictEqual(attrFirst.meta.labelReadFailed, 'HTTP 503', 'the first sequential label failure keeps precedence even if another fails earlier in time');
  assert.strictEqual(attrFirst.meta.optionSetReadFailed, 'HTTP 503');

  for (const [name, failures] of [
    ['many-to-one non-2xx', { 'contoso_beta:m2o': { status: 503 } }],
    ['lookup throw', { 'contoso_beta:lookup': { throw: 'lookup labels unavailable' } }],
    ['many-to-many throw', { 'contoso_gamma:m2m': { throw: 'm2m down' } }],
    ['parent unreadable', {}],
  ]) {
    const seq = await runRelationshipRead({ concurrency: 1, failures });
    const par = await runRelationshipRead({
      concurrency: undefined,
      delays: { 'contoso_alpha:m2o': 18, 'contoso_beta:m2o': 4, 'contoso_gamma:m2o': 2 },
      failures,
    });
    assert.ok(par.stats.max > 1, `${name}: default concurrency must overlap relationship table reads (max ${par.stats.max})`);
    assert.deepStrictEqual(par.rel, seq.rel, `${name}: relationship output must match sequential`);
    assert.deepStrictEqual(par.warnings, seq.warnings, `${name}: warning order + wording must match sequential`);
  }
});
