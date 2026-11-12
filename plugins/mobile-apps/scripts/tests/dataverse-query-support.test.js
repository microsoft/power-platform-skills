'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { checkQuerySupport, supportsRelease } = require('../check-dataverse-query-support');
const { findCursorViolations } = require('../../hooks/validate-dataverse-heavy-lists');

const pluginRoot = path.resolve(__dirname, '../..');

function fixture(t, { sdk = '1.6.0', cli = '1.4.1', generated = true, async = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-query-support-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  write('package.json', JSON.stringify({ dependencies: { '@microsoft/power-apps': '^1.6.0' } }));
  for (const [name, version] of [['power-apps', sdk], ['power-apps-cli', cli]]) {
    if (!version) continue;
    write(`node_modules/@microsoft/${name}/package.json`, JSON.stringify({
      name: `@microsoft/${name}`, version,
      ...(name === 'power-apps' ? { exports: { './data': './data.js' } } : {}),
    }));
    write(`node_modules/@microsoft/${name}/data.js`, 'module.exports = {};\n');
  }
  write('power.config.json', JSON.stringify({
    databaseReferences: {
      'default.cds': { dataSources: { retained_contacts: { logicalName: 'contact', entitySetName: 'contacts' } } },
    },
  }));
  write('src/generated/models/CommonModels.ts', `
export interface IGetOptions { select?: string[]; ${generated ? 'expand?: string[];' : ''} }
export interface IGetAllOptions { maxPageSize?: number; ${generated ? 'expand?: string[]; apply?: string;' : ''} }
`);
  const modifier = async ? 'async ' : '';
  write('src/generated/services/ContactsService.ts', `
import type { IGetOptions, IGetAllOptions } from '../models/CommonModels';
export class ContactsService {
  public static ${modifier}get${generated ? '<TResult>' : ''}(id: string, options?: IGetOptions) {}
  public static ${modifier}getAll${generated ? '<TResult>' : ''}(options?: IGetAllOptions) {}
  ${generated ? 'public static async getSavedQuery<TResult>() { return client.retrieveSavedQueryAsync<TResult>(); }' : ''}
}
`);
  return { root, write };
}

test('only verified stable release lines enable SDK queries', () => {
  for (const version of ['1.6.0', '1.6.1', '1.7.0', '1.6.0+build']) {
    assert.equal(supportsRelease(version, '1.6.0'), true, version);
  }
  for (const version of [null, '', '^1.6.0', '1.5.0', '1.6.0-beta.1', '2.0.0', 'not-a-version']) {
    assert.equal(supportsRelease(version, '1.6.0'), false, String(version));
  }
});

for (const async of [false, true]) {
  test(`reads generated generic signatures (async=${async}) and retained binding names`, (t) => {
    const { root } = fixture(t, { async });
    const report = checkQuerySupport(root);
    assert.equal(report.sdkVersion, '1.6.0');
    assert.equal(report.generatorSupported, true);
    assert.equal(report.services[0].bindingName, 'retained_contacts');
    assert.deepEqual(report.services[0].supported, { expand: true, apply: true, 'saved-query': true });
  });
}

test('installed SDK, not a newer declared range, determines support', (t) => {
  for (const sdk of ['1.5.0', null]) {
    const { root } = fixture(t, { sdk });
    const report = checkQuerySupport(root);
    assert.equal(report.sdkSupported, false);
    assert.equal(report.services[0].generated.expand, true);
    assert.equal(report.services[0].supported.expand, false);
  }
});

test('SDK upgrade does not hide stale services or mutate customer files', (t) => {
  const { root } = fixture(t, { generated: false });
  const before = fs.readFileSync(path.join(root, 'src/generated/services/ContactsService.ts'));
  const report = checkQuerySupport(root);
  assert.equal(report.sdkSupported, true);
  assert.deepEqual(report.services[0].supported, { expand: false, apply: false, 'saved-query': false });
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/generated/services/ContactsService.ts')), before);
  const result = spawnSync(process.execPath, [
    path.join(pluginRoot, 'scripts/check-dataverse-query-support.js'),
    '--project-root', root, '--table', 'contact', '--require', 'expand',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refresh the retained data sources/);
});

test('missing/malformed generated options are explicit failures', (t) => {
  const { root, write } = fixture(t);
  fs.unlinkSync(path.join(root, 'src/generated/models/CommonModels.ts'));
  assert.throws(() => checkQuerySupport(root), /ENOENT/);
  write('src/generated/models/CommonModels.ts', 'export interface IGetOptions {}');
  assert.equal(checkQuerySupport(root).services[0].supported.expand, false);
});

test('connector-only and pre-generation apps do not gain Dataverse query services', (t) => {
  const { root, write } = fixture(t);
  write('power.config.json', JSON.stringify({ connectionReferences: {} }));
  assert.deepEqual(checkQuerySupport(root).services, []);
  fs.unlinkSync(path.join(root, 'power.config.json'));
  assert.deepEqual(checkQuerySupport(root).services, []);
});

test('legacy array registrations never become numeric refresh binding names', (t) => {
  const { root, write } = fixture(t);
  write('power.config.json', JSON.stringify({
    databaseReferences: {
      'default.cds': { dataSources: [{ logicalName: 'contact', entitySetName: 'contacts' }] },
    },
  }));
  const service = checkQuerySupport(root).services[0];
  assert.equal(service.supported.expand, true);
  assert.equal(service.bindingName, null);
});

test('saved-view cursor validation accepts generic typed calls without invented OData options', () => {
  const source = `
    const list = useCursorListData<ViewRow>({
      cursorMode: 'nextLink',
      fetchPage: ({ pageSize, nextLink }) => ContactsService.getSavedQuery<ViewRow>(viewId, {
        maxPageSize: pageSize, nextLink,
      }),
    });
    <FlatList onEndReached={list.loadMore} />
  `;
  assert.deepEqual(findCursorViolations(source), []);
  assert.match(findCursorViolations(source.replace("cursorMode: 'nextLink',", '')).join('\n'), /cursorMode/);
});

test('generic OData reads still require ordinary cursor selection and ordering', () => {
  const source = `
    useCursorListData<ExpandedRow>({
      fetchPage: ({ pageSize, skipToken }) => ContactsService.getAll<ExpandedRow>({
        maxPageSize: pageSize, skipToken, expand: ['parentcustomerid_account($select=name)'],
      }),
    });
  `;
  const issues = findCursorViolations(source).join('\n');
  assert.match(issues, /include `select`/);
  assert.match(issues, /deterministic `orderBy`/);
});

test('a separate aggregate cannot exempt an ordinary list from selection/order checks', () => {
  const source = `
    const total = AccountsService.getAll<{ total: number }>({ apply: 'aggregate($count as total)' });
    useCursorListData<ContactRow>({
      fetchPage: ({ pageSize, skipToken }) => ContactsService.getAll<ContactRow>({
        maxPageSize: pageSize, skipToken,
      }),
    });
  `;
  const issues = findCursorViolations(source).join('\n');
  assert.match(issues, /include `select`/);
  assert.match(issues, /deterministic `orderBy`/);
});

test('importing the shared Dataverse parser does not register a second stdin hook', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const before = process.stdin.listenerCount('end');
    require(${JSON.stringify(path.join(pluginRoot, 'hooks/validate-dataverse-payload.js'))});
    if (process.stdin.listenerCount('end') !== before) process.exit(1);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('query-specific updates guide refresh without introducing an app migration', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills/check-updates/SKILL.md'), 'utf8');
  assert.match(skill, /scope\s+updates to `@microsoft\/power-apps` and `@microsoft\/power-apps-cli`/);
  assert.match(skill, /Do not execute these refresh commands/);
  assert.match(skill, /already current or updates were skipped/);
  assert.match(skill, /query adoption not\s+performed/);
  assert.match(skill, /There is no app migration/);
});

test('all query-producing surfaces reference the shared contract or capability checker', () => {
  for (const file of [
    'agents/native-app-planner.md', 'agents/data-model-architect.md',
    'agents/screen-planner.md', 'agents/screen-builder.md',
    'skills/create-mobile-app/SKILL.md', 'skills/add-dataverse/SKILL.md',
    'skills/setup-datamodel/SKILL.md', 'skills/edit-app/SKILL.md',
    'skills/deploy/SKILL.md', 'skills/check-updates/SKILL.md',
  ]) {
    const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    assert.match(source, /data-performance\.md|check-dataverse-query-support\.js/, file);
    assert.doesNotMatch(source, /SDK has no `?\$expand|SDK cannot `?\$expand|cannot propose the calc column/, file);
  }
});

test('screen pagination and skeleton rules distinguish saved views from ordinary OData', () => {
  for (const file of [
    'agents/screen-planner.md', 'agents/screen-builder.md',
    'shared/references/mobile-ui-patterns.md', 'skills/create-mobile-app/SKILL.md',
  ]) {
    const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    assert.match(source, /getSavedQuery/, file);
    assert.match(source, /cursorMode:[^\n]*nextLink/, file);
    assert.match(source, /[Oo]rdinary OData/, file);
  }
});

test('related-field resolutions represent aggregate and saved-view projections end to end', () => {
  const planner = fs.readFileSync(path.join(pluginRoot, 'agents/screen-planner.md'), 'utf8');
  const architect = fs.readFileSync(path.join(pluginRoot, 'agents/data-model-architect.md'), 'utf8');
  const builder = fs.readFileSync(path.join(pluginRoot, 'agents/screen-builder.md'), 'utf8');
  for (const feature of ['expand', 'apply', 'saved-query']) {
    assert.match(planner, new RegExp(`recommends: [^\\n]*\\b${feature}\\b`));
    assert.ok(architect.includes(`recommends: ${feature}`));
    assert.ok(builder.includes(`| \`${feature}\` |`));
  }
});
