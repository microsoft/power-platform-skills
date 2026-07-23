'use strict';

const crypto = require('node:crypto');

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean))];
}

function normalizeGuid(value) {
  const normalized = String(value || '').replace(/[{}]/g, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized) ? normalized : null;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(fragment) {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(fragment))) attributes[match[1].toLowerCase()] = decodeXml(match[3] ?? match[4] ?? '');
  return attributes;
}

function assertSafeXml(xml, label) {
  const text = String(xml || '').trim();
  if (!text) throw new Error(`${label} is empty`);
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) throw new Error(`${label} contains unsupported XML declarations`);
  const stripped = text.replace(/<!--[^]*?-->/g, '').replace(/<\?xml[^]*?\?>/gi, '').replace(/<!\[CDATA\[[^]*?\]\]>/g, '');
  const tags = stripped.match(/<[^>]+>/g) || [];
  const stack = [];
  for (const token of tags) {
    if (/^<\//.test(token)) {
      const name = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)/i)?.[1]?.toLowerCase();
      if (!name || stack.pop() !== name) throw new Error(`${label} has unbalanced XML tags`);
    } else if (!/^<!|^<\?/.test(token) && !/\/\s*>$/.test(token)) {
      const name = token.match(/^<\s*([A-Za-z_][\w:.-]*)/i)?.[1]?.toLowerCase();
      if (!name) throw new Error(`${label} contains malformed XML`);
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`${label} has unbalanced XML tags`);
  return text;
}

function parseFetchXml(fetchXml) {
  const text = assertSafeXml(fetchXml, 'fetchxml');
  const entity = text.match(/<entity\b([^>]*)>/i);
  if (!entity) throw new Error('fetchxml does not contain an entity');
  const entityName = parseAttributes(entity[1]).name || null;
  if (!entityName) throw new Error('fetchxml entity is missing name');
  const columns = [];
  const orderBy = [];
  const entityBody = text.slice(entity.index + entity[0].length, text.search(/<\/entity\s*>/i));
  for (const match of entityBody.matchAll(/<attribute\b([^>]*)\/?\s*>/gi)) {
    const name = parseAttributes(match[1]).name;
    if (name) columns.push(name);
  }
  for (const match of entityBody.matchAll(/<order\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.attribute) orderBy.push(`${attributes.attribute} ${String(attributes.descending).toLowerCase() === 'true' ? 'desc' : 'asc'}`);
  }
  return {
    entityName,
    columns: unique(columns),
    orderBy: unique(orderBy),
    predicate: text,
  };
}

function parseLayoutXml(layoutXml) {
  if (!layoutXml) return [];
  const text = assertSafeXml(layoutXml, 'layoutxml');
  const columns = [];
  for (const match of text.matchAll(/<cell\b([^>]*)\/?\s*>/gi)) {
    const name = parseAttributes(match[1]).name;
    if (name) columns.push(name);
  }
  return unique(columns);
}

function normalizeRemoteView(record, kind) {
  const idField = kind === 'personal' ? 'userqueryid' : 'savedqueryid';
  const id = normalizeGuid(record && record[idField]);
  const name = String(record && record.name || '').trim();
  const fetchXml = String(record && record.fetchxml || '').trim();
  if (!id || !name || !fetchXml) throw new Error(`${kind} view response is missing ${idField}, name, or fetchxml`);
  const parsed = parseFetchXml(fetchXml);
  const layoutXml = String(record.layoutxml || '').trim() || null;
  const layoutColumns = parseLayoutXml(layoutXml);
  const returnedTypeCode = String(record.returnedtypecode || parsed.entityName || '').trim() || null;
  return {
    id,
    kind,
    name,
    fetchXml,
    layoutXml,
    predicate: parsed.predicate,
    columns: unique([...layoutColumns, ...parsed.columns]),
    orderBy: parsed.orderBy,
    queryType: Number.isInteger(record.querytype) ? record.querytype : null,
    returnedTypeCode,
    entityName: parsed.entityName,
    executionParameter: kind === 'personal' ? 'userQuery' : 'savedQuery',
    securityScope: kind === 'personal' ? 'owner-and-sharing' : 'organization',
  };
}

function remoteViewIdentity(record, kind) {
  const idField = kind === 'personal' ? 'userqueryid' : 'savedqueryid';
  return {
    id: normalizeGuid(record && record[idField]),
    kind,
    name: String(record && record.name || '').trim(),
    returnedTypeCode: String(record && record.returnedtypecode || '').trim() || null,
  };
}

function matchesTable(remote, table) {
  const expected = String(table.logicalName || table.displayName || '').toLowerCase();
  const entityName = String(remote.entityName || '').toLowerCase();
  const returnedTypeCode = String(remote.returnedTypeCode || '').toLowerCase();
  return !expected || entityName === expected || returnedTypeCode === expected;
}

function resolveOneView(table, view, remoteViews, malformedViews = []) {
  const sourceId = normalizeGuid(view.viewId);
  let candidates = [];
  let malformedCandidates = [];
  let matchedBy = 'source-guid';
  if (sourceId) {
    const guidMatches = remoteViews.filter((remote) => remote.id === sourceId);
    malformedCandidates = malformedViews.filter((remote) => remote.id === sourceId);
    if (malformedCandidates.length) {
      const reasons = malformedCandidates.map((candidate) => candidate.error).join('; ');
      throw new Error(`${table.logicalName || table.displayName || 'unknown table'} / ${view.displayName || view.name || sourceId}: source GUID matched malformed target metadata (${reasons})`);
    }
    if (guidMatches.length > 1) {
      throw new Error(`${table.logicalName || table.displayName || 'unknown table'} / ${view.displayName || view.name || sourceId}: source GUID matched multiple target views`);
    }
    if (guidMatches.length === 1) {
      if (!matchesTable(guidMatches[0], table)) {
        throw new Error(`${table.logicalName || table.displayName || 'unknown table'} / ${view.displayName || view.name || sourceId}: source GUID resolved to the wrong target table`);
      }
      candidates = guidMatches;
    }
  }
  if (!candidates.length) {
    const names = unique([view.name, view.displayName]).map((name) => String(name).trim().toLowerCase());
    candidates = remoteViews.filter((remote) => names.includes(remote.name.toLowerCase()) && matchesTable(remote, table));
    malformedCandidates = malformedViews.filter((remote) => names.includes(remote.name.toLowerCase()) && matchesTable(remote, table));
    matchedBy = 'exact-name-and-table';
  }
  if (malformedCandidates.length) {
    const reasons = malformedCandidates.map((candidate) => candidate.error).join('; ');
    throw new Error(`${table.logicalName || table.displayName || 'unknown table'} / ${view.displayName || view.name || sourceId || 'unknown view'}: matched target metadata is malformed (${reasons})`);
  }
  if (candidates.length !== 1) {
    const reason = candidates.length ? 'ambiguous target matches' : 'no target match';
    throw new Error(`${table.logicalName || table.displayName || 'unknown table'} / ${view.displayName || view.name || sourceId || 'unknown view'}: ${reason}`);
  }
  const match = candidates[0];
  return {
    ...view,
    fetchXml: match.fetchXml,
    layoutXml: match.layoutXml,
    predicate: match.predicate,
    orderBy: match.orderBy,
    columns: match.columns,
    queryType: match.queryType,
    targetViewId: match.id,
    targetViewKind: match.kind,
    executionParameter: match.executionParameter,
    returnedTypeCode: match.returnedTypeCode,
    securityScope: match.securityScope,
    resolutionStatus: 'resolved',
    resolutionMatch: matchedBy,
    targetSemanticsSha256: crypto.createHash('sha256').update(JSON.stringify({
      id: match.id,
      kind: match.kind,
      fetchXml: match.fetchXml,
      layoutXml: match.layoutXml,
      queryType: match.queryType,
      returnedTypeCode: match.returnedTypeCode,
    })).digest('hex'),
  };
}

function resolvePackageViews(input, remoteRecords) {
  const remoteViews = [];
  const malformedViews = [];
  for (const [kind, records] of [
    ['system', toArray(remoteRecords.savedqueries)],
    ['personal', toArray(remoteRecords.userqueries)],
  ]) {
    for (const record of records) {
      try {
        remoteViews.push(normalizeRemoteView(record, kind));
      } catch (error) {
        malformedViews.push({ ...remoteViewIdentity(record, kind), error: error.message });
      }
    }
  }
  const next = JSON.parse(JSON.stringify(input));
  const tables = toArray(next.dataModelPlan && next.dataModelPlan.dataverseTables);
  let resolved = 0;
  for (const table of tables) {
    table.views = toArray(table.views).map((view) => {
      resolved += 1;
      return resolveOneView(table, view, remoteViews, malformedViews);
    });
  }
  return { input: next, resolved, remote: remoteViews.length, ignoredMalformed: malformedViews.length };
}

module.exports = {
  assertSafeXml,
  normalizeRemoteView,
  remoteViewIdentity,
  parseFetchXml,
  parseLayoutXml,
  resolveOneView,
  resolvePackageViews,
};
