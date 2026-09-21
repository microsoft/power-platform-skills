'use strict';

// Turns the joined sharing view into the report model that
// render-sharepoint-artifact.js validates and renders. Presentation decisions
// live here; the rules that decide what is true live in sharepoint-sharing-map.js.

const path = require('node:path');
const { REACH_LABELS } = require('./sharepoint-sharing-map');
const {
  SHAREPOINT_UNSUPPORTED_COLUMN_TYPES,
  VIRTUAL_TABLE_QUERY_ROW_LIMIT,
} = require('./sharepoint-virtual-tables');

const SEVERITY_ORDER = ['danger', 'warning', 'info'];
const SEVERITY_LABELS = { danger: 'Must fix', warning: 'Review', info: 'For information' };

const DEFAULT_LINKS = [
  { artifact: 'requirements', label: 'Requirements', href: 'sharepoint-requirements.html' },
  { artifact: 'discovery', label: 'Discovery', href: 'sharepoint-discovery.html' },
  { artifact: 'plan', label: 'Plan', href: 'sharepoint-migration-plan.html' },
  { artifact: 'sharing', label: 'Sharing map', href: 'sharepoint-sharing-map.html' },
  { artifact: 'progress', label: 'Progress', href: 'sharepoint-migration-progress.html' },
];

function text(value) {
  return { kind: 'text', text: String(value) };
}

function code(value) {
  return { kind: 'code', text: String(value) };
}

function badge(value, tone) {
  return { kind: 'badge', text: String(value), tone };
}

function listName(row) {
  return row.source.listName || row.table.displayName || row.table.logicalName;
}

function reachCell(row) {
  const reach = REACH_LABELS[row.reach] || REACH_LABELS['not-reachable'];
  return [badge(reach.text, reach.tone)];
}

function roleNames(row) {
  const names = [...new Set(row.permissions
    .flatMap((permission) => permission.roles)
    .map((role) => role.name || `unresolved ${role.id}`))];
  return names.length ? names.join(', ') : 'None';
}

function operationsCell(row) {
  return row.operations.length ? row.operations.join(', ') : 'None granted';
}

function sharedContentSection(rows) {
  return {
    id: 'shared-content',
    title: 'What SharePoint content the portal can reach',
    blocks: [
      {
        type: 'paragraph',
        content: [text('Each row is one SharePoint list that this site shares through a Dataverse virtual table. The list stays in SharePoint; the table is a live view of it, so what the portal can read is whatever the connection identity can read.')],
      },
      {
        type: 'table',
        columns: ['SharePoint list', 'Site', 'Dataverse table', 'Reachable by', 'Operations'],
        emptyMessage: 'No SharePoint list has been provisioned for this site yet.',
        rows: rows.map((row) => [
          [text(listName(row))],
          [text(row.source.site || 'Not recorded')],
          [code(row.table.logicalName)],
          reachCell(row),
          [text(operationsCell(row))],
        ]),
      },
    ],
  };
}

function accessControlSection(rows) {
  const blocks = [{
    type: 'paragraph',
    content: [
      text('Access is enforced by Power Pages table permissions and web roles on the server. A filter in the site code is presentation, not a boundary - the rows below are what the platform actually allows.'),
    ],
  }];

  if (rows.length === 0) {
    blocks.push({
      type: 'paragraph',
      content: [text('Nothing is provisioned yet, so there is no access control to describe.')],
    });
    return { id: 'access-control', title: 'Who can reach it, and how that is enforced', blocks };
  }

  for (const row of rows) {
    blocks.push({ type: 'heading', text: `${listName(row)} → ${row.table.logicalName}`, level: 3 });
    blocks.push({
      type: 'facts',
      items: [
        { label: 'Web API', value: row.webApi.enabled ? [badge('Enabled', 'success'), text(' '), code(`Webapi/${row.table.logicalName}/enabled`)] : [badge('Not enabled', 'warning')] },
        { label: 'Web roles', value: roleNames(row) },
        { label: 'Entity set', value: row.table.entitySetName ? [code(`/_api/${row.table.entitySetName}`)] : 'Not recorded' },
        { label: 'Source list', value: row.source.listUrl ? [{ kind: 'link', text: row.source.listUrl, href: row.source.listUrl }] : (row.source.listName || 'Not recorded') },
      ],
    });
    blocks.push({
      type: 'table',
      columns: ['Permission', 'Scope', 'Operations', 'Web roles'],
      emptyMessage: 'No table permission grants this table, so the portal cannot read it.',
      rows: row.permissions.map((permission) => [
        [text(permission.name)],
        [text(permission.scope)],
        [text(permission.operations.length ? permission.operations.join(', ') : 'None')],
        [text(permission.roles.map((role) => role.name || `unresolved ${role.id}`).join(', ') || 'None')],
      ]),
    });
  }

  return { id: 'access-control', title: 'Who can reach it, and how that is enforced', blocks };
}

function columnsSection(rows) {
  return {
    id: 'columns',
    title: 'Which columns leave SharePoint',
    blocks: [
      {
        type: 'paragraph',
        content: [
          text('The Web API field allowlist decides which columns a portal request may read. A column recorded on the table but absent from the allowlist stays inside Dataverse and is never returned to the browser.'),
        ],
      },
      {
        type: 'table',
        columns: ['Dataverse table', 'Shared columns', 'Withheld columns'],
        emptyMessage: 'No columns have been recorded yet.',
        rows: rows.map((row) => [
          [code(row.table.logicalName)],
          [text(row.columns.shared.length ? row.columns.shared.map((column) => column.logicalName).join(', ') : 'None')],
          [text(row.columns.withheld.length ? row.columns.withheld.map((column) => column.logicalName).join(', ') : 'None')],
        ]),
      },
    ],
  };
}

function findingsSection(rows) {
  const all = rows.flatMap((row) => row.findings.map((item) => ({ ...item, row })));
  const blocks = [];
  if (all.length === 0) {
    blocks.push({
      type: 'paragraph',
      content: [text('No mismatch was found between the provisioned tables and the access control this site ships.')],
    });
  }
  for (const severity of SEVERITY_ORDER) {
    const matching = all.filter((item) => item.severity === severity);
    if (matching.length === 0) continue;
    blocks.push({ type: 'heading', text: SEVERITY_LABELS[severity], level: 3 });
    blocks.push({
      type: 'callout',
      tone: severity === 'info' ? 'info' : severity,
      blocks: [{
        type: 'list',
        items: matching.map((item) => [
          { kind: 'strong', text: listName(item.row) },
          text(' - '),
          text(item.message),
        ]),
      }],
    });
  }
  return { id: 'security-findings', title: 'Security findings', blocks };
}

function limitsSection() {
  return {
    id: 'platform-limits',
    title: 'Platform behaviour that affects this sharing',
    blocks: [{
      type: 'facts',
      items: [
        {
          label: 'Row visibility',
          value: 'Virtual tables are organization-owned and have no field-level security. SharePoint item-level permissions do not travel with the data, so every access decision has to be made by the table permissions above.',
        },
        {
          label: 'Reading identity',
          value: 'The virtual connector reads SharePoint as the identity that owns the connection, not as the signed-in portal visitor.',
        },
        {
          label: 'Query size',
          value: `A virtual-table query is limited to ${VIRTUAL_TABLE_QUERY_ROW_LIMIT} records, and a query that crosses a relationship past that limit fails with an error. Filter server-side and page rather than relying on the client to trim the result.`,
        },
        {
          label: 'Columns that cannot cross',
          value: `The provider cannot project these SharePoint column types: ${SHAREPOINT_UNSUPPORTED_COLUMN_TYPES.join(', ')}. Content held only in those columns is absent from the table, not hidden by permissions.`,
        },
        {
          label: 'Writes',
          value: 'A create, write or delete permission changes the SharePoint list itself. There is no separate copy to roll back.',
        },
      ],
    }],
  };
}

function evidenceSection(rows, otherWebApiTables, relativeTo) {
  // Config paths are absolute on disk. Showing them relative to the project keeps
  // the reader's own home directory out of a document they may hand to someone else.
  const display = (file) => (relativeTo ? path.relative(relativeTo, file) || file : file);
  const blocks = [{
    type: 'table',
    columns: ['Dataverse table', 'Data source', 'Provisioned', 'Verified'],
    emptyMessage: 'No provisioning has been recorded.',
    rows: rows.map((row) => [
      [code(row.table.logicalName)],
      [text(row.provisioning.dataSourceId || 'Not recorded')],
      [text(row.provisioning.createdAt || 'Not recorded')],
      [text(row.provisioning.verified === true ? 'Columns read back from Dataverse' : 'Not verified')],
    ]),
  }];

  const files = rows.flatMap((row) => [
    row.webApi.enabledSettingFile,
    row.webApi.fieldsSettingFile,
    ...row.permissions.map((permission) => permission.file),
  ]).filter(Boolean);
  if (files.length > 0) {
    blocks.push({ type: 'heading', text: 'Configuration files read', level: 4 });
    blocks.push({ type: 'list', items: [...new Set(files)].map((file) => [code(display(file))]) });
  }

  if (otherWebApiTables.length > 0) {
    blocks.push({ type: 'heading', text: 'Other Web API tables on this site', level: 4 });
    blocks.push({
      type: 'paragraph',
      content: [text(`These tables also have Web API site settings but were not provisioned by the SharePoint workflow, so this page says nothing about them: ${otherWebApiTables.join(', ')}.`)],
    });
  }

  return { id: 'evidence', title: 'Provisioning evidence', detail: true, blocks };
}

function joinClauses(clauses) {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}

function singleReach({ anonymous, reachable }) {
  if (anonymous > 0) return 'reachable without signing in';
  if (reachable > 0) return 'reachable by signed-in visitors holding the listed web roles';
  return 'not reachable from the portal yet';
}

function summaryFor(rows) {
  if (rows.length === 0) {
    return 'No SharePoint list is shared through this portal yet. Provision a virtual table and its table permissions, then regenerate this page.';
  }
  const anonymous = rows.filter((row) => row.reach === 'anonymous').length;
  const reachable = rows.filter((row) => row.reach === 'authenticated').length;
  const pending = rows.filter((row) => row.reach === 'not-reachable').length;
  const mustFix = rows.reduce((total, row) => total + row.findings.filter((item) => item.severity === 'danger').length, 0);

  const clauses = [];
  if (reachable > 0) clauses.push(`${reachable} reachable by signed-in visitors holding the listed web roles`);
  if (pending > 0) clauses.push(`${pending} not reachable from the portal yet`);
  if (anonymous > 0) clauses.push(`${anonymous} reachable without signing in`);

  const opening = rows.length === 1
    ? '1 SharePoint list is shared through a Dataverse virtual table.'
    : `${rows.length} SharePoint lists are shared through Dataverse virtual tables.`;
  const breakdown = rows.length === 1
    ? ` It is ${singleReach({ anonymous, reachable })}.`
    : ` Of those, ${joinClauses(clauses)}.`;
  const verdict = mustFix > 0
    ? ` ${mustFix} finding${mustFix === 1 ? '' : 's'} need${mustFix === 1 ? 's' : ''} attention before release - see Security findings.`
    : ' No must-fix finding was raised.';
  return opening + breakdown + verdict;
}

/**
 * @param {{rows: object[], otherWebApiTables: string[]}} sharing
 * @param {{title?: string, phase?: string, updatedAt?: string, links?: object[], relativeTo?: string, footer?: any}} [options]
 */
function buildSharingReport(sharing, options = {}) {
  const rows = sharing.rows;
  return {
    version: 1,
    artifact: 'sharing',
    title: options.title || 'SharePoint sharing map',
    updatedAt: options.updatedAt || new Date().toISOString(),
    phase: options.phase || 'Backend integration',
    summary: summaryFor(rows),
    links: options.links || DEFAULT_LINKS,
    sections: [
      sharedContentSection(rows),
      accessControlSection(rows),
      columnsSection(rows),
      findingsSection(rows),
      limitsSection(),
      evidenceSection(rows, sharing.otherWebApiTables || [], options.relativeTo),
    ],
    ...(options.footer !== undefined ? { footer: options.footer } : {}),
  };
}

module.exports = { DEFAULT_LINKS, buildSharingReport, summaryFor };
