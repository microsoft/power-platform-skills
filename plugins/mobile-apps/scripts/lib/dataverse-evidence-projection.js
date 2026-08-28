'use strict';

const crypto = require('node:crypto');

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function conceptTokens(snapshot) {
  const phrases = [
    ...(snapshot.inputs?.concepts || []).map((concept) => (
      typeof concept === 'string' ? concept : concept?.phrase
    )),
    ...(snapshot.candidateRanking || []).map((ranking) => ranking.concept),
  ];
  return new Set(phrases
    .flatMap((phrase) => String(phrase || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 3));
}

function matchesConcept(value, tokens) {
  const words = String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => tokens.has(word));
}

function relationshipOtherTables(tableName, relationship, kind) {
  if (kind === 'manyToOne') return [relationship.targetTable];
  if (kind === 'oneToMany') return [relationship.childTable];
  if (kind === 'manyToMany') {
    return [relationship.entity1, relationship.entity2]
      .filter((name) => normalizeName(name) !== normalizeName(tableName));
  }
  return [];
}

function compactColumn(column) {
  return {
    logicalName: column.logicalName,
    schemaName: column.schemaName || column.logicalName,
    type: column.type,
    typeName: column.typeName || null,
    primaryId: Boolean(column.primaryId),
    primaryName: Boolean(column.primaryName),
    lookupTargets: clone(column.lookupTargets || []),
  };
}

function compactRelationship(relationship, kind) {
  if (kind === 'manyToOne') {
    return {
      kind: 'many-to-one',
      schemaName: relationship.schemaName,
      lookupColumn: relationship.lookupColumn || null,
      targetTable: relationship.targetTable || null,
      targetColumn: relationship.targetColumn || null,
      managed: Boolean(relationship.managed),
    };
  }
  if (kind === 'oneToMany') {
    return {
      kind: 'one-to-many',
      schemaName: relationship.schemaName,
      childTable: relationship.childTable || null,
      childLookupColumn: relationship.childLookupColumn || null,
      parentColumn: relationship.parentColumn || null,
      managed: Boolean(relationship.managed),
    };
  }
  return {
    kind: 'many-to-many',
    schemaName: relationship.schemaName,
    entity1: relationship.entity1 || null,
    entity2: relationship.entity2 || null,
    intersectTable: relationship.intersectTable || null,
    managed: Boolean(relationship.managed),
  };
}

function projectTable(table, selectedNames, tokens, sourceSnapshotSha256) {
  const keyColumns = new Set((table.alternateKeys || [])
    .flatMap((key) => key.columns || [])
    .map(normalizeName));
  const retainedColumnNames = new Set();
  for (const column of table.columns || []) {
    const name = normalizeName(column.logicalName);
    const lookupSelected = (column.lookupTargets || []).some(
      (target) => selectedNames.has(normalizeName(target)),
    );
    if (column.primaryId
      || column.primaryName
      || name === normalizeName(table.primaryIdAttribute)
      || name === normalizeName(table.primaryNameAttribute)
      || keyColumns.has(name)
      || (table.customEntity !== false && column.customAttribute !== false)
      || lookupSelected
      || matchesConcept(column.logicalName, tokens)
      || matchesConcept(column.schemaName, tokens)) {
      retainedColumnNames.add(name);
    }
  }

  const relationshipGroups = [
    ['manyToOneRelationships', 'manyToOne'],
    ['oneToManyRelationships', 'oneToMany'],
    ['manyToManyRelationships', 'manyToMany'],
  ];
  const retainedRelationships = new Map();
  const omittedRelationshipIndex = [];
  for (const [property, kind] of relationshipGroups) {
    const retained = [];
    for (const relationship of table[property] || []) {
      const otherSelected = relationshipOtherTables(table.logicalName, relationship, kind)
        .some((name) => selectedNames.has(normalizeName(name)));
      const lookupName = kind === 'manyToOne'
        ? relationship.lookupColumn
        : kind === 'oneToMany'
          && normalizeName(relationship.childTable) === normalizeName(table.logicalName)
          ? relationship.childLookupColumn
          : null;
      const lookupRetained = lookupName && retainedColumnNames.has(normalizeName(lookupName));
      const conceptRelevant = relationship.managed === false
        && [relationship.schemaName, ...relationshipOtherTables(
          table.logicalName,
          relationship,
          kind,
        )].some((value) => matchesConcept(value, tokens));
      if (otherSelected || lookupRetained || conceptRelevant) {
        retained.push(clone(relationship));
        if (lookupName) retainedColumnNames.add(normalizeName(lookupName));
      } else {
        omittedRelationshipIndex.push(compactRelationship(relationship, kind));
      }
    }
    retainedRelationships.set(property, retained);
  }

  const columns = [];
  const omittedColumnIndex = [];
  for (const column of table.columns || []) {
    if (retainedColumnNames.has(normalizeName(column.logicalName))) columns.push(clone(column));
    else omittedColumnIndex.push(compactColumn(column));
  }
  const projected = clone(table);
  projected.columns = columns;
  for (const [property] of relationshipGroups) {
    projected[property] = retainedRelationships.get(property);
  }
  projected.alternateKeys = clone(table.alternateKeys || []);
  projected.projectionSummary = {
    includedColumns: columns.length,
    omittedColumns: omittedColumnIndex.length,
    includedRelationships: [...retainedRelationships.values()]
      .reduce((total, relationships) => total + relationships.length, 0),
    omittedRelationships: omittedRelationshipIndex.length,
    includedKeys: projected.alternateKeys.length,
    omittedKeys: 0,
  };

  if (omittedColumnIndex.length === 0 && omittedRelationshipIndex.length === 0) {
    return { projected, shard: null };
  }
  const shard = {
    schemaVersion: 1,
    sourceSnapshotSha256,
    tableLogicalName: table.logicalName,
    columnIndex: omittedColumnIndex,
    relationshipIndex: omittedRelationshipIndex,
    keyIndex: [],
  };
  shard.integritySha256 = sha256(stableJson(shard));
  return { projected, shard };
}

function projectSelectedTables(snapshot, sourceSnapshotSha256) {
  const selectedNames = new Set([
    ...(snapshot.tables || []).map((table) => normalizeName(table.logicalName)),
    ...(snapshot.inputs?.explicitTableNames || []).map(normalizeName),
  ]);
  const tokens = conceptTokens(snapshot);
  const selectedTables = [];
  const shards = [];
  for (const table of snapshot.tables || []) {
    const result = projectTable(table, selectedNames, tokens, sourceSnapshotSha256);
    selectedTables.push(result.projected);
    if (result.shard) shards.push(result.shard);
  }
  return { selectedTables, shards };
}

module.exports = {
  compactColumn,
  compactRelationship,
  projectSelectedTables,
  stableJson,
};