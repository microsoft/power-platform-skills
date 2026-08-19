#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDataverseRequestExecutor } = require('./dataverse-request');

const ENTITY_SELECT = [
  'LogicalName',
  'SchemaName',
  'DisplayName',
  'DisplayCollectionName',
  'Description',
  'EntitySetName',
  'PrimaryIdAttribute',
  'PrimaryNameAttribute',
  'OwnershipType',
  'HasActivities',
  'HasNotes',
  'IsAvailableOffline',
  'ChangeTrackingEnabled',
  'IsCustomEntity',
  'IsManaged',
  'IsCustomizable',
  'CanCreateAttributes',
  'CanBePrimaryEntityInRelationship',
  'CanBeRelatedEntityInRelationship',
  'CanBeInManyToMany',
].join(',');

const ATTRIBUTE_SELECT = [
  'MetadataId',
  'LogicalName',
  'SchemaName',
  'AttributeType',
  'AttributeTypeName',
  'RequiredLevel',
  'IsCustomAttribute',
  'IsManaged',
  'IsCustomizable',
  'IsPrimaryId',
  'IsPrimaryName',
  'IsValidForCreate',
  'IsValidForRead',
  'IsValidForUpdate',
  'SourceType',
  'AttributeOf',
  'IsLogical',
].join(',');

const CHOICE_TYPE_BY_ATTRIBUTE = {
  Boolean: 'BooleanAttributeMetadata',
  Picklist: 'PicklistAttributeMetadata',
  State: 'StateAttributeMetadata',
  Status: 'StatusAttributeMetadata',
};

const FORMULA_TYPE_BY_ATTRIBUTE = {
  BigInt: 'BigIntAttributeMetadata',
  Boolean: 'BooleanAttributeMetadata',
  DateTime: 'DateTimeAttributeMetadata',
  Decimal: 'DecimalAttributeMetadata',
  Double: 'DoubleAttributeMetadata',
  Integer: 'IntegerAttributeMetadata',
  Money: 'MoneyAttributeMetadata',
  Picklist: 'PicklistAttributeMetadata',
  String: 'StringAttributeMetadata',
};

const ORDINARY_METADATA_FIELDS_BY_TYPE = {
  BigIntAttributeMetadata: ['MinValue', 'MaxValue'],
  BooleanAttributeMetadata: ['DefaultValue'],
  DateTimeAttributeMetadata: ['Format', 'DateTimeBehavior'],
  DecimalAttributeMetadata: ['MinValue', 'MaxValue', 'Precision'],
  DoubleAttributeMetadata: ['MinValue', 'MaxValue', 'Precision'],
  FileAttributeMetadata: ['MaxSizeInKB'],
  ImageAttributeMetadata: ['MaxHeight', 'MaxWidth', 'MaxSizeInKB'],
  IntegerAttributeMetadata: ['MinValue', 'MaxValue', 'Format'],
  MemoAttributeMetadata: ['MaxLength', 'Format'],
  MoneyAttributeMetadata: ['MinValue', 'MaxValue', 'Precision', 'PrecisionSource'],
  StringAttributeMetadata: ['MaxLength', 'Format', 'FormatName'],
};

const CONCEPT_ALIASES = {
  associate: ['systemuser'],
  associates: ['systemuser'],
  customer: ['contact', 'account'],
  customers: ['contact', 'account'],
  manager: ['systemuser'],
  managers: ['systemuser'],
  organization: ['account'],
  organizations: ['account'],
  people: ['contact'],
  person: ['contact'],
  store: ['stocklocation'],
  stores: ['stocklocation'],
  user: ['systemuser'],
  users: ['systemuser'],
};

const GENERIC_CONCEPT_TOKENS = new Set([
  'and',
  'data',
  'record',
  'records',
  'report',
  'reports',
  'table',
  'tables',
  'workflow',
  'workflows',
]);

const MAX_TABLES_PER_CONCEPT = 3;
const MAX_ADVISORY_DETAIL_TABLES = 40;
const MAX_EXACT_NAME_TABLES = 50;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (index + 1 < argv.length && !String(value).startsWith('--')) {
      args[key.slice(2)] = value;
      index += 1;
    } else {
      args[key.slice(2)] = true;
    }
  }
  return args;
}

function parseList(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function atomicWriteFile(file, content, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, content, 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function atomicWriteJson(file, value, fileSystem = fs) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, fileSystem);
}

function normalizeUrl(value) {
  return String(value || '').replace(/\/+$/, '').toLowerCase();
}

function odataString(value) {
  return String(value).replace(/'/g, "''");
}

function normalizeNextLink(nextLink) {
  const marker = '/api/data/v9.2/';
  const markerIndex = nextLink ? nextLink.indexOf(marker) : -1;
  return nextLink && markerIndex >= 0 ? nextLink.slice(markerIndex + marker.length) : nextLink;
}

async function requestCollection(request, apiPath, label, { optional = false } = {}) {
  const values = [];
  let next = apiPath;
  while (next) {
    const response = await request('GET', normalizeNextLink(next));
    if (response.status < 200 || response.status >= 300) {
      if (optional && [400, 404].includes(response.status)) return [];
      const detail = response.error || JSON.stringify(response.data || {}) || 'unknown error';
      const error = new Error(`${label} failed (${response.status}): ${detail}`);
      error.status = response.status;
      error.metadataError = detail;
      throw error;
    }
    values.push(...(response.data?.value || []));
    next = response.data?.['@odata.nextLink'] || null;
  }
  return values;
}

function logicalNameOf(entity) {
  return String(entity?.LogicalName || entity?.logicalName || '');
}

function uniqueLogicalNames(values) {
  const names = new Map();
  for (const value of values || []) {
    const logicalName = String(value || '').trim();
    if (!logicalName) continue;
    const key = logicalName.toLowerCase();
    if (!names.has(key)) names.set(key, logicalName);
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right));
}

function mergeEntitiesByLogicalName(entities, additions) {
  const merged = new Map();
  for (const entity of [...(entities || []), ...(additions || [])]) {
    const logicalName = logicalNameOf(entity);
    if (!logicalName) continue;
    merged.set(logicalName.toLowerCase(), entity);
  }
  return [...merged.values()].sort(
    (left, right) => logicalNameOf(left).localeCompare(logicalNameOf(right)),
  );
}

async function resolveExactNameEntities(request, entities, requestedNames) {
  const requestedTables = uniqueLogicalNames(requestedNames);
  const existingNames = new Set(
    (entities || []).map((entity) => logicalNameOf(entity).toLowerCase()).filter(Boolean),
  );
  const queriedTables = requestedTables.filter(
    (logicalName) => !existingNames.has(logicalName.toLowerCase()),
  );
  if (queriedTables.length > MAX_EXACT_NAME_TABLES) {
    throw new Error(
      `Exact-name metadata query exceeds ${MAX_EXACT_NAME_TABLES} tables: `
      + queriedTables.join(', '),
    );
  }

  let discovered = [];
  if (queriedTables.length > 0) {
    const filter = queriedTables
      .map((logicalName) => `LogicalName eq '${odataString(logicalName)}'`)
      .join(' or ');
    const apiPath = `EntityDefinitions?$select=${ENTITY_SELECT}&$filter=${filter}&LabelLanguages=1033`;
    if (apiPath.length > 8000) {
      throw new Error('Exact-name metadata query exceeds the bounded URL budget');
    }
    const response = await request('GET', apiPath);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Exact-name table metadata failed (${response.status}): `
        + `${response.error || JSON.stringify(response.data || {})}`,
      );
    }
    if (response.data?.['@odata.nextLink']) {
      throw new Error('Exact-name table metadata exceeded one bounded response page');
    }
    const requestedKeys = new Set(queriedTables.map((name) => name.toLowerCase()));
    discovered = (response.data?.value || []).filter(
      (entity) => requestedKeys.has(logicalNameOf(entity).toLowerCase()),
    );
  }

  const mergedEntities = mergeEntitiesByLogicalName(entities, discovered);
  const availableNames = new Map(
    mergedEntities.map((entity) => [logicalNameOf(entity).toLowerCase(), logicalNameOf(entity)]),
  );
  return {
    entities: mergedEntities,
    requestedTables,
    queriedTables,
    discoveredTables: uniqueLogicalNames(discovered.map(logicalNameOf)),
    availableTables: requestedTables
      .filter((logicalName) => availableNames.has(logicalName.toLowerCase()))
      .map((logicalName) => availableNames.get(logicalName.toLowerCase())),
    unavailableTables: requestedTables.filter(
      (logicalName) => !availableNames.has(logicalName.toLowerCase()),
    ),
  };
}

function labelText(label) {
  return label?.UserLocalizedLabel?.Label
    || label?.LocalizedLabels?.find((item) => item.LanguageCode === 1033)?.Label
    || label?.LocalizedLabels?.[0]?.Label
    || '';
}

function singularizeToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token === 'statuses') return 'status';
  if (token.length > 5 && /(ches|shes|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function normalizedTokens(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularizeToken);
}

function compact(value) {
  return normalizedTokens(value).join('');
}

function entitySearchParts(entity) {
  return [
    entity.LogicalName,
    entity.SchemaName,
    entity.EntitySetName,
    labelText(entity.DisplayName),
    labelText(entity.DisplayCollectionName),
    labelText(entity.Description),
  ].filter(Boolean);
}

function publisherPrefix(logicalName) {
  const match = String(logicalName || '').toLowerCase().match(/^([a-z][a-z0-9]*)_/);
  return match?.[1] || '';
}

function isVersionedName(logicalName) {
  const value = String(logicalName || '')
    .toLowerCase()
    .replace(/^[a-z][a-z0-9]*_/, '');
  return /(?:^|_)(?:v\d+[a-z0-9]*|m\d+[a-z0-9]*|old|legacy|test|backup|copy)(?:_|$)/.test(value)
    || /v\d+[a-z0-9]*$/.test(value);
}

function conceptDescriptor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = CONCEPT_ALIASES[raw] || [];
  const tokens = normalizedTokens(raw);
  const aliasTokens = aliases.flatMap(normalizedTokens);
  return {
    raw,
    compactValues: [...new Set([compact(raw), ...aliases.map(compact)].filter((item) => item.length >= 3))],
    matchTokens: [...new Set([...tokens, ...aliasTokens])]
      .filter((token) => token.length >= 3 && !GENERIC_CONCEPT_TOKENS.has(token)),
  };
}

function scoreEntityForConcept(entity, descriptor) {
  const parts = entitySearchParts(entity);
  const compactParts = parts.map(compact);
  const tokenSet = new Set(parts.flatMap(normalizedTokens));
  let score = 0;
  const reasons = [];

  for (const value of descriptor.compactValues) {
    if (compactParts.some((part) => part === value)) {
      score = Math.max(score, 1000);
      reasons.push(`exact:${value}`);
    } else if (compactParts.some((part) => part.endsWith(value))) {
      score = Math.max(score, 900);
      reasons.push(`suffix:${value}`);
    } else if (compactParts.some((part) => part.includes(value))) {
      score = Math.max(score, 750);
      reasons.push(`contains:${value}`);
    }
  }

  for (const token of descriptor.matchTokens) {
    if (tokenSet.has(token)) {
      score = Math.max(score, 500);
      reasons.push(`token:${token}`);
    } else if (compactParts.some((part) => part.includes(token))) {
      score = Math.max(score, 400);
      reasons.push(`partial-token:${token}`);
    }
  }

  if (score === 0) return { score: 0, reasons: [] };
  if (isVersionedName(entity.LogicalName)) {
    score -= 300;
    reasons.push('version-penalty');
  }
  score -= Math.min(String(entity.LogicalName || '').length, 100) / 100;
  return { score, reasons: [...new Set(reasons)] };
}

function compareCandidates(left, right, preferredFamily = null) {
  if (preferredFamily !== null) {
    const leftPreferred = left.publisherFamily === preferredFamily ? 1 : 0;
    const rightPreferred = right.publisherFamily === preferredFamily ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
  }
  if (left.score !== right.score) return right.score - left.score;
  if (left.versioned !== right.versioned) return Number(left.versioned) - Number(right.versioned);
  const lengthDifference = left.logicalName.length - right.logicalName.length;
  if (lengthDifference !== 0) return lengthDifference;
  return left.logicalName.localeCompare(right.logicalName);
}

function rankCandidatesByConcept(entities, concepts) {
  const preliminary = concepts.map((concept) => {
    const descriptor = conceptDescriptor(concept);
    const candidates = entities
      .map((entity) => {
        const scored = scoreEntityForConcept(entity, descriptor);
        return {
          entity,
          logicalName: entity.LogicalName,
          publisherFamily: publisherPrefix(entity.LogicalName),
          versioned: isVersionedName(entity.LogicalName),
          score: scored.score,
          reasons: scored.reasons,
        };
      })
      .filter((candidate) => candidate.score > 0);
    return { concept, descriptor, candidates };
  });

  const familyCoverage = new Map();
  for (const entry of preliminary) {
    for (const family of new Set(entry.candidates.map((candidate) => candidate.publisherFamily))) {
      familyCoverage.set(family, (familyCoverage.get(family) || 0) + 1);
    }
  }

  return preliminary.map((entry) => {
    const familyFacts = new Map();
    for (const candidate of entry.candidates) {
      const facts = familyFacts.get(candidate.publisherFamily) || {
        family: candidate.publisherFamily,
        maxScore: Number.NEGATIVE_INFINITY,
        unversionedCount: 0,
      };
      facts.maxScore = Math.max(facts.maxScore, candidate.score);
      if (!candidate.versioned) facts.unversionedCount += 1;
      familyFacts.set(candidate.publisherFamily, facts);
    }
    const preferredFamily = [...familyFacts.values()]
      .sort((left, right) => {
        const scoreDifference = right.maxScore - left.maxScore;
        if (Math.abs(scoreDifference) > 10) return scoreDifference;
        return (familyCoverage.get(right.family) || 0) - (familyCoverage.get(left.family) || 0)
          || right.unversionedCount - left.unversionedCount
          || scoreDifference
          || left.family.length - right.family.length
          || left.family.localeCompare(right.family);
      })[0]?.family ?? '';
    const candidates = entry.candidates
      .sort((left, right) => compareCandidates(left, right, preferredFamily))
      .map((candidate, index) => ({
        rank: index + 1,
        logicalName: candidate.logicalName,
        displayName: labelText(candidate.entity.DisplayName),
        publisherFamily: candidate.publisherFamily,
        versioned: candidate.versioned,
        score: Number(candidate.score.toFixed(2)),
        reasons: candidate.reasons,
      }));
    return {
      concept: entry.concept,
      normalizedTokens: entry.descriptor.matchTokens,
      preferredPublisherFamily: preferredFamily,
      candidates,
    };
  });
}

function selectDetailedCandidates(entities, tableNames, concepts) {
  const explicitNames = new Set(tableNames.map((value) => value.toLowerCase()));
  const rankings = rankCandidatesByConcept(entities, concepts);
  const selectedReasons = new Map();
  const unresolvedConcepts = [];
  let exactCoveredConcepts = 0;

  for (const entity of entities) {
    if (!explicitNames.has(String(entity.LogicalName).toLowerCase())) continue;
    selectedReasons.set(entity.LogicalName, new Set(['explicit-table']));
  }

  for (const ranking of rankings) {
    if (ranking.candidates.length === 0) continue;
    const exactCoverage = ranking.candidates.find((candidate) => (
      explicitNames.has(candidate.logicalName.toLowerCase())
      && (
        candidate.rank === 1
        || candidate.reasons.some((reason) => (
          reason.startsWith('exact:')
          || reason.startsWith('suffix:')
        ))
      )
    ));
    if (exactCoverage) {
      selectedReasons.get(exactCoverage.logicalName)
        .add(`concept:${ranking.concept}:exact-covered`);
      exactCoveredConcepts += 1;
      continue;
    }

    const bestScore = ranking.candidates[0].score;
    const familyToken = ranking.normalizedTokens[0];
    let preferred = ranking.candidates.filter((candidate) => (
      candidate.publisherFamily === ranking.preferredPublisherFamily
      && !candidate.versioned
      && (
        candidate.score >= bestScore - 300
        || (familyToken && candidate.reasons.some((reason) => reason === `token:${familyToken}`))
      )
    ));
    if (preferred.length === 0) {
      preferred = ranking.candidates.filter((candidate) => !candidate.versioned);
    }
    if (preferred.length === 0) preferred = ranking.candidates;
    unresolvedConcepts.push({
      concept: ranking.concept,
      candidates: preferred
        .filter((candidate) => !explicitNames.has(candidate.logicalName.toLowerCase()))
        .slice(0, MAX_TABLES_PER_CONCEPT),
    });
  }

  const advisoryCandidates = new Map();
  function selectAdvisory(candidate, concept) {
    const current = advisoryCandidates.get(candidate.logicalName) || {
      ...candidate,
      concepts: new Set(),
    };
    current.concepts.add(concept);
    advisoryCandidates.set(candidate.logicalName, current);
  }

  // Quality floor: every unresolved concept gets its best available candidate,
  // even when there are more than 40 distinct concepts.
  for (const entry of unresolvedConcepts) {
    if (entry.candidates[0]) selectAdvisory(entry.candidates[0], entry.concept);
  }
  const advisoryLimit = Math.max(
    MAX_ADVISORY_DETAIL_TABLES,
    advisoryCandidates.size,
  );
  const remainingCandidates = unresolvedConcepts
    .flatMap((entry) => entry.candidates.slice(1).map((candidate) => ({
      ...candidate,
      concept: entry.concept,
    })))
    .sort((left, right) => (
      right.score - left.score
      || left.rank - right.rank
      || left.concept.localeCompare(right.concept)
      || left.logicalName.localeCompare(right.logicalName)
    ));
  for (const candidate of remainingCandidates) {
    if (advisoryCandidates.has(candidate.logicalName)) {
      selectAdvisory(candidate, candidate.concept);
      continue;
    }
    if (advisoryCandidates.size >= advisoryLimit) break;
    selectAdvisory(candidate, candidate.concept);
  }
  for (const candidate of advisoryCandidates.values()) {
    const reasons = new Set([...candidate.concepts].map((concept) => `concept:${concept}`));
    selectedReasons.set(candidate.logicalName, reasons);
  }

  const entityByName = new Map(entities.map((entity) => [entity.LogicalName, entity]));
  const selectedEntities = [...selectedReasons.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((logicalName) => entityByName.get(logicalName))
    .filter(Boolean);
  const selectedNames = new Set(selectedEntities.map((entity) => entity.LogicalName));
  const candidateRanking = rankings.map((ranking) => ({
    ...ranking,
    candidates: ranking.candidates.map((candidate) => ({
      ...candidate,
      detailed: false,
      detailStatus: selectedNames.has(candidate.logicalName) ? 'pending' : 'inventory-only',
      detailFailure: null,
      selectionEvidence: [...(selectedReasons.get(candidate.logicalName) || [])],
    })),
  }));

  return {
    candidateRanking,
    selectedEntities,
    selectedEvidence: selectedEntities.map((entity) => ({
      logicalName: entity.LogicalName,
      reasons: [...selectedReasons.get(entity.LogicalName)].sort(),
    })),
    detailSelectionSummary: {
      requiredCandidates: selectedEntities.filter((entity) => (
        selectedReasons.get(entity.LogicalName).has('explicit-table')
      )).length,
      advisoryCandidates: advisoryCandidates.size,
      exactCoveredConcepts,
      unresolvedConcepts: unresolvedConcepts.length,
      advisoryLimit,
    },
  };
}

function normalizeDetailLoadFailure(entity, reasons, error) {
  const status = Number(error?.status);
  return {
    logicalName: entity.LogicalName,
    selectionReasons: [...reasons].sort(),
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    error: String(error?.metadataError || error?.message || error || 'unknown error'),
    required: false,
  };
}

function applyDetailLoadOutcomes(candidateRanking, selectedEvidence, tables, failures) {
  const loadedNames = new Set(tables.map((table) => table.logicalName.toLowerCase()));
  const failureByName = new Map(
    failures.map((failure) => [failure.logicalName.toLowerCase(), failure]),
  );
  return {
    candidateRanking: candidateRanking.map((ranking) => ({
      ...ranking,
      candidates: ranking.candidates.map((candidate) => {
        const key = candidate.logicalName.toLowerCase();
        const failure = failureByName.get(key) || null;
        const detailed = loadedNames.has(key);
        return {
          ...candidate,
          detailed,
          detailStatus: detailed
            ? 'loaded'
            : failure
              ? 'unavailable'
              : candidate.selectionEvidence?.length
                ? 'pending'
                : 'inventory-only',
          detailFailure: failure,
        };
      }),
    })),
    selectedCandidateEvidence: selectedEvidence.map((item) => {
      const key = item.logicalName.toLowerCase();
      const failure = failureByName.get(key) || null;
      return {
        ...item,
        required: item.reasons.includes('explicit-table')
          || item.reasons.includes('explicit-expansion'),
        detailStatus: loadedNames.has(key) ? 'loaded' : failure ? 'unavailable' : 'pending',
        detailFailure: failure,
      };
    }),
  };
}

function selectDetailedEntities(entities, tableNames, concepts) {
  return selectDetailedCandidates(entities, tableNames, concepts).selectedEntities;
}

function normalizeChoiceOptions(metadata) {
  const optionSet = metadata.OptionSet || metadata.GlobalOptionSet;
  const options = optionSet?.Options || [
    optionSet?.FalseOption,
    optionSet?.TrueOption,
  ].filter(Boolean);
  return (options || []).map((option) => ({
    value: option.Value,
    label: labelText(option.Label),
  }));
}

function choiceMetadataType(attribute) {
  if (attribute.AttributeType === 'Virtual'
    && attribute.AttributeTypeName?.Value === 'MultiSelectPicklistType') {
    return 'MultiSelectPicklistAttributeMetadata';
  }
  return CHOICE_TYPE_BY_ATTRIBUTE[attribute.AttributeType] || null;
}

function ordinaryMetadataType(attribute) {
  const typeName = attribute.AttributeTypeName?.Value;
  if (typeName === 'FileType') return 'FileAttributeMetadata';
  if (typeName === 'ImageType') return 'ImageAttributeMetadata';
  const candidate = `${attribute.AttributeType || ''}AttributeMetadata`;
  return hasOwn(ORDINARY_METADATA_FIELDS_BY_TYPE, candidate) ? candidate : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function lowerCamel(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function normalizeTypedConstraint(value) {
  return value && typeof value === 'object' && hasOwn(value, 'Value')
    ? value.Value
    : value;
}

function managedValue(value) {
  return typeof value === 'object' && value !== null && 'Value' in value
    ? Boolean(value.Value)
    : Boolean(value);
}

function normalizeIntegerMetadata(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function relationshipCount(table) {
  return (table.manyToOneRelationships?.length || 0)
    + (table.oneToManyRelationships?.length || 0)
    + (table.manyToManyRelationships?.length || 0);
}

async function loadDetailedEntity(request, entity) {
  const logicalName = entity.LogicalName;
  const root = `EntityDefinitions(LogicalName='${odataString(logicalName)}')`;
  const attributes = await requestCollection(
    request,
    `${root}/Attributes?$select=${ATTRIBUTE_SELECT}`,
    `${logicalName} attributes`,
  );
  const manyToOneRelationships = await requestCollection(
    request,
    `${root}/ManyToOneRelationships?$select=SchemaName,ReferencingAttribute,ReferencedEntity,ReferencedAttribute,IsManaged,CascadeConfiguration`,
    `${logicalName} many-to-one relationships`,
  );
  const oneToManyRelationships = await requestCollection(
    request,
    `${root}/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedAttribute,IsManaged,CascadeConfiguration`,
    `${logicalName} one-to-many relationships`,
  );
  const manyToManyRelationships = await requestCollection(
    request,
    `${root}/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity1IntersectAttribute,Entity2LogicalName,Entity2IntersectAttribute,IntersectEntityName,IsManaged`,
    `${logicalName} many-to-many relationships`,
  );
  const keys = await requestCollection(
    request,
    `${root}/Keys?$select=LogicalName,SchemaName,KeyAttributes,EntityKeyIndexStatus,IsManaged`,
    `${logicalName} alternate keys`,
  );

  const choices = new Map();
  const choiceTypes = [...new Set(attributes
    .map(choiceMetadataType)
    .filter(Boolean))];
  for (const type of choiceTypes) {
    const metadata = await requestCollection(
      request,
      `${root}/Attributes/Microsoft.Dynamics.CRM.${type}?$select=LogicalName&$expand=OptionSet,GlobalOptionSet`,
      `${logicalName} ${type}`,
    );
    for (const item of metadata) {
      choices.set(item.LogicalName, {
        options: normalizeChoiceOptions(item),
      });
    }
  }

  const lookups = new Map();
  if (attributes.some((attribute) => attribute.AttributeType === 'Lookup')) {
    const lookupMetadata = await requestCollection(
      request,
      `${root}/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`,
      `${logicalName} lookup metadata`,
    );
    for (const item of lookupMetadata) lookups.set(item.LogicalName, item.Targets || []);
  }

  const ordinaryConstraints = new Map();
  const ordinaryTypes = [...new Set(attributes.map(ordinaryMetadataType).filter(Boolean))];
  for (const type of ordinaryTypes) {
    const fields = ORDINARY_METADATA_FIELDS_BY_TYPE[type];
    const metadata = await requestCollection(
      request,
      `${root}/Attributes/Microsoft.Dynamics.CRM.${type}?$select=LogicalName,${fields.join(',')}`,
      `${logicalName} ${type} ordinary metadata`,
    );
    for (const item of metadata) {
      const constraints = {};
      for (const field of fields) {
        if (hasOwn(item, field)) {
          constraints[lowerCamel(field)] = normalizeTypedConstraint(item[field]);
        }
      }
      ordinaryConstraints.set(item.LogicalName, constraints);
    }
  }

  const computedMetadata = new Map();
  for (const attribute of attributes.filter(
    (item) => [1, 2, 3].includes(normalizeIntegerMetadata(item.SourceType)),
  )) {
    if (!attribute.MetadataId) {
      computedMetadata.set(attribute.LogicalName, {
        sourceType: normalizeIntegerMetadata(attribute.SourceType),
        sourceTypeMask: normalizeIntegerMetadata(attribute.SourceTypeMask),
        formulaDefinition: null,
        metadataStatus: 'unavailable',
        unavailableReason: 'MetadataId unavailable for typed computed metadata lookup',
      });
      continue;
    }
    const type = FORMULA_TYPE_BY_ATTRIBUTE[attribute.AttributeType];
    if (!type) {
      computedMetadata.set(attribute.LogicalName, {
        sourceType: normalizeIntegerMetadata(attribute.SourceType),
        sourceTypeMask: normalizeIntegerMetadata(attribute.SourceTypeMask),
        formulaDefinition: null,
        metadataStatus: 'unavailable',
        unavailableReason: `unsupported attribute type ${attribute.AttributeType || '<missing>'}`,
      });
      continue;
    }
    const response = await request(
      'GET',
      `${root}/Attributes(${attribute.MetadataId})/Microsoft.Dynamics.CRM.${type}?$select=LogicalName,SourceType,SourceTypeMask,FormulaDefinition`,
    );
    if (response.status >= 200 && response.status < 300) {
      const hasFormulaDefinition = Object.prototype.hasOwnProperty.call(
        response.data || {},
        'FormulaDefinition',
      );
      const sourceType = normalizeIntegerMetadata(
        response.data?.SourceType ?? attribute.SourceType,
      );
      const sourceTypeMask = normalizeIntegerMetadata(
        response.data?.SourceTypeMask ?? attribute.SourceTypeMask,
      );
      const baseSourceType = normalizeIntegerMetadata(attribute.SourceType);
      const compatible = sourceType !== null
        && sourceType === baseSourceType
        && sourceTypeMask !== null
        && hasFormulaDefinition
        && typeof response.data.FormulaDefinition === 'string'
        && response.data.FormulaDefinition.trim().length > 0
        && (sourceTypeMask & 32) === 0;
      computedMetadata.set(attribute.LogicalName, {
        sourceType,
        sourceTypeMask,
        formulaDefinition: hasFormulaDefinition ? response.data.FormulaDefinition : null,
        metadataStatus: compatible ? 'available' : 'unavailable',
        unavailableReason: compatible
          ? null
          : [
            sourceType === null ? 'SourceType unavailable or malformed' : null,
            sourceType !== null && sourceType !== baseSourceType
              ? `SourceType mismatch: base ${baseSourceType}, typed ${sourceType}`
              : null,
            sourceTypeMask === null ? 'SourceTypeMask unavailable or malformed' : null,
            sourceTypeMask !== null && (sourceTypeMask & 32) !== 0
              ? 'SourceTypeMask contains the Invalid bit'
              : null,
            !hasFormulaDefinition || typeof response.data.FormulaDefinition !== 'string'
              || response.data.FormulaDefinition.trim().length === 0
              ? 'FormulaDefinition unavailable'
              : null,
          ].filter(Boolean).join('; '),
      });
    } else if (response.status === 404) {
      computedMetadata.set(attribute.LogicalName, {
        sourceType: normalizeIntegerMetadata(attribute.SourceType),
        sourceTypeMask: normalizeIntegerMetadata(attribute.SourceTypeMask),
        formulaDefinition: null,
        metadataStatus: 'unavailable',
        unavailableReason: 'typed computed metadata endpoint returned 404',
      });
    } else {
      const detail = response.error || JSON.stringify(response.data || {}) || 'unknown error';
      const error = new Error(
        `${logicalName} ${attribute.LogicalName} computed metadata failed (${response.status}): `
        + detail,
      );
      error.status = response.status;
      error.metadataError = detail;
      throw error;
    }
  }

  const table = {
    logicalName,
    schemaName: entity.SchemaName,
    displayName: labelText(entity.DisplayName),
    displayCollectionName: labelText(entity.DisplayCollectionName),
    description: labelText(entity.Description),
    entitySetName: entity.EntitySetName,
    primaryIdAttribute: entity.PrimaryIdAttribute,
    primaryNameAttribute: entity.PrimaryNameAttribute,
    ownershipType: entity.OwnershipType ?? null,
    hasActivities: hasOwn(entity, 'HasActivities') ? Boolean(entity.HasActivities) : null,
    hasNotes: hasOwn(entity, 'HasNotes') ? Boolean(entity.HasNotes) : null,
    isAvailableOffline: hasOwn(entity, 'IsAvailableOffline')
      ? Boolean(entity.IsAvailableOffline)
      : null,
    changeTrackingEnabled: hasOwn(entity, 'ChangeTrackingEnabled')
      ? Boolean(entity.ChangeTrackingEnabled)
      : null,
    customEntity: Boolean(entity.IsCustomEntity),
    managed: Boolean(entity.IsManaged),
    customizable: managedValue(entity.IsCustomizable),
    canCreateAttributes: managedValue(entity.CanCreateAttributes),
    canBePrimaryEntityInRelationship: managedValue(
      entity.CanBePrimaryEntityInRelationship,
    ),
    canBeRelatedEntityInRelationship: managedValue(
      entity.CanBeRelatedEntityInRelationship,
    ),
    canBeInManyToMany: managedValue(entity.CanBeInManyToMany),
    columns: attributes.map((attribute) => {
      const computed = computedMetadata.get(attribute.LogicalName) || null;
      return {
        logicalName: attribute.LogicalName,
        schemaName: attribute.SchemaName,
        type: attribute.AttributeType,
        typeName: attribute.AttributeTypeName?.Value || null,
        ...(ordinaryConstraints.get(attribute.LogicalName) || {}),
        requiredLevel: attribute.RequiredLevel?.Value || attribute.RequiredLevel || null,
        customAttribute: Boolean(attribute.IsCustomAttribute),
        managed: Boolean(attribute.IsManaged),
        customizable: managedValue(attribute.IsCustomizable),
        primaryId: Boolean(attribute.IsPrimaryId),
        primaryName: Boolean(attribute.IsPrimaryName),
        validForCreate: Boolean(attribute.IsValidForCreate),
        validForRead: Boolean(attribute.IsValidForRead),
        validForUpdate: Boolean(attribute.IsValidForUpdate),
        sourceType: normalizeIntegerMetadata(attribute.SourceType),
        sourceTypeMask: normalizeIntegerMetadata(attribute.SourceTypeMask),
        attributeOf: attribute.AttributeOf || null,
        logical: Boolean(attribute.IsLogical),
        lookupTargets: lookups.get(attribute.LogicalName) || [],
        choices: choices.get(attribute.LogicalName)?.options || [],
        formula: computed?.formulaDefinition || null,
        formulaDefinition: computed?.formulaDefinition || null,
        computed: computed
          ? {
            ...computed,
            formula: computed.formulaDefinition,
            attributeOf: attribute.AttributeOf || null,
          }
          : null,
      };
    }),
    manyToOneRelationships: manyToOneRelationships.map((relationship) => ({
      schemaName: relationship.SchemaName,
      lookupColumn: relationship.ReferencingAttribute,
      targetTable: relationship.ReferencedEntity,
      targetColumn: relationship.ReferencedAttribute,
      managed: Boolean(relationship.IsManaged),
      cascadeConfiguration: relationship.CascadeConfiguration
        ? { ...relationship.CascadeConfiguration }
        : null,
    })),
    oneToManyRelationships: oneToManyRelationships.map((relationship) => ({
      schemaName: relationship.SchemaName,
      childTable: relationship.ReferencingEntity,
      childLookupColumn: relationship.ReferencingAttribute,
      parentColumn: relationship.ReferencedAttribute,
      managed: Boolean(relationship.IsManaged),
      cascadeConfiguration: relationship.CascadeConfiguration
        ? { ...relationship.CascadeConfiguration }
        : null,
    })),
    manyToManyRelationships: manyToManyRelationships.map((relationship) => ({
      schemaName: relationship.SchemaName,
      entity1: relationship.Entity1LogicalName,
      entity1IntersectAttribute: relationship.Entity1IntersectAttribute,
      entity2: relationship.Entity2LogicalName,
      entity2IntersectAttribute: relationship.Entity2IntersectAttribute,
      intersectTable: relationship.IntersectEntityName,
      managed: Boolean(relationship.IsManaged),
    })),
    alternateKeys: keys.map((key) => ({
      logicalName: key.LogicalName,
      schemaName: key.SchemaName,
      columns: key.KeyAttributes || [],
      status: key.EntityKeyIndexStatus || null,
      managed: Boolean(key.IsManaged),
    })),
  };
  table.facts = {
    columnCount: table.columns.length,
    relationshipCount: relationshipCount(table),
    keyCount: table.alternateKeys.length,
  };
  return table;
}

function normalizeInventoryEntity(entity) {
  if (entity.logicalName) return { ...entity };
  return {
    logicalName: entity.LogicalName,
    schemaName: entity.SchemaName,
    displayName: labelText(entity.DisplayName),
    displayCollectionName: labelText(entity.DisplayCollectionName),
    description: labelText(entity.Description),
    entitySetName: entity.EntitySetName,
    primaryIdAttribute: entity.PrimaryIdAttribute,
    primaryNameAttribute: entity.PrimaryNameAttribute,
    ownershipType: entity.OwnershipType ?? null,
    hasActivities: hasOwn(entity, 'HasActivities') ? Boolean(entity.HasActivities) : null,
    hasNotes: hasOwn(entity, 'HasNotes') ? Boolean(entity.HasNotes) : null,
    isAvailableOffline: hasOwn(entity, 'IsAvailableOffline')
      ? Boolean(entity.IsAvailableOffline)
      : null,
    changeTrackingEnabled: hasOwn(entity, 'ChangeTrackingEnabled')
      ? Boolean(entity.ChangeTrackingEnabled)
      : null,
    customEntity: Boolean(entity.IsCustomEntity),
    managed: Boolean(entity.IsManaged),
    customizable: managedValue(entity.IsCustomizable),
    canCreateAttributes: managedValue(entity.CanCreateAttributes),
    canBePrimaryEntityInRelationship: managedValue(
      entity.CanBePrimaryEntityInRelationship,
    ),
    canBeRelatedEntityInRelationship: managedValue(
      entity.CanBeRelatedEntityInRelationship,
    ),
    canBeInManyToMany: managedValue(entity.CanBeInManyToMany),
  };
}

function analyzeProposedNames(entities, proposedTableNames) {
  const byLogicalName = new Map(
    entities.map((entity) => [
      String(entity.LogicalName || entity.logicalName).toLowerCase(),
      normalizeInventoryEntity(entity),
    ]),
  );
  const checked = [...new Set(proposedTableNames)]
    .sort((left, right) => left.localeCompare(right))
    .map((logicalName) => {
      const existing = byLogicalName.get(logicalName.toLowerCase()) || null;
      return {
        logicalName,
        status: existing ? 'collision' : 'missing',
        existing,
      };
    });
  return {
    checked,
    collisions: checked.filter((item) => item.status === 'collision'),
    missing: checked.filter((item) => item.status === 'missing').map((item) => item.logicalName),
  };
}

function validateSnapshot(snapshot, expected = {}) {
  const errors = [];
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const requireStringArray = (value, label) => {
    if (!Array.isArray(value)
      || value.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push(`${label} must be a string array`);
      return false;
    }
    return true;
  };
  if (!snapshot || typeof snapshot !== 'object') errors.push('snapshot must be an object');
  if ((snapshot?.version || 0) < 3) errors.push('snapshot version must be 3 or newer');
  if (!snapshot?.environmentUrl) errors.push('environmentUrl is required');
  if (!snapshot?.tenantId) errors.push('tenantId is required');
  if (typeof snapshot?.generatedAt !== 'string'
    || !snapshot.generatedAt.trim()
    || Number.isNaN(Date.parse(snapshot.generatedAt))) {
    errors.push('generatedAt must be an ISO timestamp');
  }
  if (!Array.isArray(snapshot?.inventory)) errors.push('inventory must be an array');
  if (!Array.isArray(snapshot?.tables)) errors.push('tables must be an array');
  if (!Array.isArray(snapshot?.candidateRanking)) errors.push('candidateRanking must be an array');
  if (!isObject(snapshot?.inventoryFacts)) {
    errors.push('inventoryFacts must be an object');
  } else {
    for (const key of [
      'customizableTables',
      'exactNameTables',
      'requiredExactNameTables',
      'proposedCollisionTables',
      'totalTables',
    ]) {
      if (!Number.isInteger(snapshot.inventoryFacts[key])
        || snapshot.inventoryFacts[key] < 0) {
        errors.push(`inventoryFacts.${key} must be a non-negative integer`);
      }
    }
    if (Number.isInteger(snapshot.inventoryFacts.totalTables)
      && Array.isArray(snapshot.inventory)
      && snapshot.inventoryFacts.totalTables !== snapshot.inventory.length) {
      errors.push('inventoryFacts.totalTables must equal inventory length');
    }
  }
  if (!isObject(snapshot?.proposedNameChecks)) {
    errors.push('proposedNameChecks must be an object');
  } else {
    const checkedValid = Array.isArray(snapshot.proposedNameChecks.checked);
    const collisionsValid = Array.isArray(snapshot.proposedNameChecks.collisions);
    const missingValid = requireStringArray(
      snapshot.proposedNameChecks.missing,
      'proposedNameChecks.missing',
    );
    if (!checkedValid) errors.push('proposedNameChecks.checked must be an array');
    if (!collisionsValid) errors.push('proposedNameChecks.collisions must be an array');
    if (checkedValid) {
      const checkedNames = new Set();
      const collisionNames = new Set();
      const missingNames = new Set(
        missingValid
          ? snapshot.proposedNameChecks.missing.map((name) => name.toLowerCase())
          : [],
      );
      for (const [index, item] of snapshot.proposedNameChecks.checked.entries()) {
        if (!isObject(item)
          || typeof item.logicalName !== 'string'
          || !item.logicalName.trim()
          || !['collision', 'missing'].includes(item.status)) {
          errors.push(`proposedNameChecks.checked[${index}] is malformed`);
          continue;
        }
        const key = item.logicalName.toLowerCase();
        if (checkedNames.has(key)) {
          errors.push(`proposedNameChecks.checked[${index}].logicalName must be unique`);
        }
        checkedNames.add(key);
        if (item.status === 'collision') collisionNames.add(key);
      }
      if (collisionsValid) {
        const listedCollisionNames = new Set();
        for (const [index, item] of snapshot.proposedNameChecks.collisions.entries()) {
          if (!isObject(item)
            || typeof item.logicalName !== 'string'
            || !item.logicalName.trim()
            || item.status !== 'collision') {
            errors.push(`proposedNameChecks.collisions[${index}] is malformed`);
            continue;
          }
          listedCollisionNames.add(item.logicalName.toLowerCase());
        }
        if (listedCollisionNames.size !== collisionNames.size
          || [...collisionNames].some((name) => !listedCollisionNames.has(name))) {
          errors.push('proposedNameChecks.collisions must match checked collision entries');
        }
      }
      if (missingValid
        && (missingNames.size !== snapshot.proposedNameChecks.checked.filter(
          (item) => item?.status === 'missing',
        ).length
          || snapshot.proposedNameChecks.checked.some(
            (item) => item?.status === 'missing'
              && !missingNames.has(item.logicalName.toLowerCase()),
          ))) {
        errors.push('proposedNameChecks.missing must match checked missing entries');
      }
    }
  }
  if (!isObject(snapshot?.exactNameResolution)) {
    errors.push('exactNameResolution must be an object');
  } else {
    const requestedValid = requireStringArray(
      snapshot.exactNameResolution.requestedTables,
      'exactNameResolution.requestedTables',
    );
    const loadedValid = requireStringArray(
      snapshot.exactNameResolution.loadedTables,
      'exactNameResolution.loadedTables',
    );
    const unavailableValid = requireStringArray(
      snapshot.exactNameResolution.unavailableTables,
      'exactNameResolution.unavailableTables',
    );
    if (requestedValid && loadedValid && unavailableValid) {
      const requested = new Set(
        snapshot.exactNameResolution.requestedTables.map((name) => name.toLowerCase()),
      );
      const resolved = [
        ...snapshot.exactNameResolution.loadedTables,
        ...snapshot.exactNameResolution.unavailableTables,
      ].map((name) => name.toLowerCase());
      if (new Set(resolved).size !== resolved.length
        || resolved.length !== requested.size
        || resolved.some((name) => !requested.has(name))) {
        errors.push('exactNameResolution loaded and unavailable tables must partition requestedTables');
      }
    }
  }
  if (!Array.isArray(snapshot?.detailLoadFailures)) {
    errors.push('detailLoadFailures must be an array');
  } else {
      const failureNames = new Set();
      for (const [index, failure] of snapshot.detailLoadFailures.entries()) {
        const prefix = `detailLoadFailures[${index}]`;
        if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
          errors.push(`${prefix} must be an object`);
          continue;
        }
        if (typeof failure.logicalName !== 'string' || !failure.logicalName.trim()) {
          errors.push(`${prefix}.logicalName must be a non-empty string`);
        } else {
          const key = failure.logicalName.toLowerCase();
          if (failureNames.has(key)) errors.push(`${prefix}.logicalName must be unique`);
          failureNames.add(key);
        }
        if (!Array.isArray(failure.selectionReasons)
          || failure.selectionReasons.length === 0
          || failure.selectionReasons.some(
            (reason) => typeof reason !== 'string' || !reason.trim(),
          )) {
          errors.push(`${prefix}.selectionReasons must be a non-empty string array`);
        }
        if (failure.status !== null
          && (!Number.isInteger(failure.status)
            || failure.status < 100
            || failure.status > 599)) {
          errors.push(`${prefix}.status must be null or an HTTP status integer`);
        }
        if (typeof failure.error !== 'string' || !failure.error.trim()) {
          errors.push(`${prefix}.error must be a non-empty string`);
        }
        if (failure.required !== false) {
          errors.push(`${prefix}.required must be false`);
        }
        if (failure.selectionReasons?.some(
          (reason) => reason === 'explicit-table' || reason === 'explicit-expansion',
        )) {
          errors.push(`${prefix}.selectionReasons must be advisory`);
      }
    }
  }
  if (snapshot?.detailLoadSummary === undefined) {
    errors.push('detailLoadSummary must be an object');
  } else {
    const summary = snapshot.detailLoadSummary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      errors.push('detailLoadSummary must be an object');
    } else {
      for (const key of ['attemptedCandidates', 'loadedCandidates', 'failedCandidates']) {
        if (!Number.isInteger(summary[key]) || summary[key] < 0) {
          errors.push(`detailLoadSummary.${key} must be a non-negative integer`);
        }
      }
      if (Number.isInteger(summary.attemptedCandidates)
        && Number.isInteger(summary.loadedCandidates)
        && Number.isInteger(summary.failedCandidates)
        && summary.attemptedCandidates
          !== summary.loadedCandidates + summary.failedCandidates) {
        errors.push('detailLoadSummary attempted count must equal loaded plus failed');
      }
      if (Number.isInteger(summary.loadedCandidates)
        && Array.isArray(snapshot?.tables)
        && summary.loadedCandidates !== snapshot.tables.length) {
        errors.push('detailLoadSummary.loadedCandidates must equal tables length');
      }
      if (Number.isInteger(summary.failedCandidates)
        && Array.isArray(snapshot?.detailLoadFailures)
        && summary.failedCandidates !== snapshot.detailLoadFailures.length) {
        errors.push('detailLoadSummary.failedCandidates must equal detailLoadFailures length');
      }
    }
  }
  for (const key of [
    'inventoryRetrievalMs',
    'candidateSelectionMs',
    'detailLoadingMs',
    'totalDurationMs',
  ]) {
    if (!Number.isFinite(snapshot?.timings?.[key]) || snapshot.timings[key] < 0) {
      errors.push(`timings.${key} must be a non-negative number`);
    }
  }
  if (expected.environmentUrl
    && normalizeUrl(snapshot?.environmentUrl) !== normalizeUrl(expected.environmentUrl)) {
    errors.push('environmentUrl does not match');
  }
  if (expected.tenantId
    && String(snapshot?.tenantId).toLowerCase() !== String(expected.tenantId).toLowerCase()) {
    errors.push('tenantId does not match');
  }
  return { valid: errors.length === 0, errors };
}

async function createSnapshot({
  environmentUrl,
  tenantId,
  tableNames = [],
  proposedTableNames = [],
  concepts = [],
  request,
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  onProgress = () => {},
}) {
  if (!environmentUrl) throw new Error('environmentUrl is required');
  if (typeof request !== 'function') throw new Error('request is required');

  const totalStartedAt = nowMs();
  const customizableEntities = await requestCollection(
    request,
    [
      'EntityDefinitions?',
      `$select=${ENTITY_SELECT}`,
      '&$filter=IsCustomizable/Value eq true',
      '&LabelLanguages=1033',
    ].join(''),
    'Customizable-table inventory',
  );
  const requiredNames = uniqueLogicalNames(tableNames);
  const proposedNames = uniqueLogicalNames(proposedTableNames);
  // Required exact-name discovery and proposed-name collision checks share one
  // bounded query, but only required names participate in detail loading.
  const allExactCheckNames = uniqueLogicalNames([...requiredNames, ...proposedNames]);
  const exactResolution = await resolveExactNameEntities(
    request,
    customizableEntities,
    allExactCheckNames,
  );
  const entities = exactResolution.entities;
  const availableEntityNames = new Set(
    entities.map((entity) => logicalNameOf(entity).toLowerCase()),
  );
  const requiredNameKeys = new Set(requiredNames.map((name) => name.toLowerCase()));
  const proposedNameKeys = new Set(proposedNames.map((name) => name.toLowerCase()));
  const requiredDiscoveredTables = exactResolution.discoveredTables.filter(
    (name) => requiredNameKeys.has(name.toLowerCase()),
  );
  const proposedCollisionTables = exactResolution.discoveredTables.filter(
    (name) => proposedNameKeys.has(name.toLowerCase())
      && !requiredNameKeys.has(name.toLowerCase()),
  );
  const requiredUnavailableTables = requiredNames.filter(
    (name) => !availableEntityNames.has(name.toLowerCase()),
  );
  const proposedNameChecks = analyzeProposedNames(entities, proposedNames);
  const inventoryCompletedAt = nowMs();
  onProgress({
    milestoneId: 'inventory-loaded',
    inventoryTables: entities.length,
    customizableInventoryTables: customizableEntities.length,
    exactNameTables: exactResolution.discoveredTables.length,
    requiredExactNameTables: requiredDiscoveredTables.length,
    requiredExactNameUnavailable: requiredUnavailableTables.length,
    exactNameUnavailable: requiredUnavailableTables.length,
    proposedNameCollisions: proposedNameChecks.collisions.length,
    proposedNameMissing: proposedNameChecks.missing.length,
    elapsedMs: inventoryCompletedAt - totalStartedAt,
  });

  const selection = selectDetailedCandidates(entities, requiredNames, concepts);
  const selectionCompletedAt = nowMs();
  onProgress({
    milestoneId: 'candidates-selected',
    concepts: concepts.length,
    attemptedDetailedCandidates: selection.selectedEntities.length,
    detailedCandidates: selection.selectedEntities.length,
    requiredDetailedCandidates: selection.detailSelectionSummary.requiredCandidates,
    advisoryDetailedCandidates: selection.detailSelectionSummary.advisoryCandidates,
    exactCoveredConcepts: selection.detailSelectionSummary.exactCoveredConcepts,
    unresolvedConcepts: selection.detailSelectionSummary.unresolvedConcepts,
    advisoryLimit: selection.detailSelectionSummary.advisoryLimit,
    proposedCollisions: proposedNameChecks.collisions.length,
    proposedMissing: proposedNameChecks.missing.length,
    elapsedMs: selectionCompletedAt - totalStartedAt,
  });

  const tables = [];
  const detailLoadFailures = [];
  const selectedEvidenceByName = new Map(
    selection.selectedEvidence.map((item) => [item.logicalName.toLowerCase(), item]),
  );
  const requiredNameSet = new Set(requiredNames.map((name) => name.toLowerCase()));
  for (const entity of selection.selectedEntities) {
    try {
      tables.push(await loadDetailedEntity(request, entity));
    } catch (error) {
      if (requiredNameSet.has(entity.LogicalName.toLowerCase())) throw error;
      const evidence = selectedEvidenceByName.get(entity.LogicalName.toLowerCase());
      detailLoadFailures.push(normalizeDetailLoadFailure(
        entity,
        evidence?.reasons || [],
        error,
      ));
    }
  }
  const detailCompletedAt = nowMs();
  onProgress({
    milestoneId: 'details-loaded',
    attemptedDetailedCandidates: selection.selectedEntities.length,
    loadedDetailedCandidates: tables.length,
    failedDetailedCandidates: detailLoadFailures.length,
    detailedTables: tables.length,
    columns: tables.reduce((total, table) => total + table.facts.columnCount, 0),
    relationships: tables.reduce((total, table) => total + table.facts.relationshipCount, 0),
    elapsedMs: detailCompletedAt - totalStartedAt,
  });
  const totalCompletedAt = nowMs();
  const detailedNames = new Map(
    tables.map((table) => [table.logicalName.toLowerCase(), table.logicalName]),
  );
  const detailOutcomes = applyDetailLoadOutcomes(
    selection.candidateRanking,
    selection.selectedEvidence,
    tables,
    detailLoadFailures,
  );

  return {
    version: 3,
    purpose: 'foreground-planning',
    environmentUrl: environmentUrl.replace(/\/+$/, ''),
    tenantId: tenantId || null,
    generatedAt: nowIso(),
    inputs: {
      concepts: [...concepts],
      explicitTableNames: [...tableNames],
      proposedTableNames: [...proposedTableNames],
    },
    inventory: entities
      .map(normalizeInventoryEntity)
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
    inventoryFacts: {
      customizableTables: customizableEntities.length,
      exactNameTables: exactResolution.discoveredTables.length,
      requiredExactNameTables: requiredDiscoveredTables.length,
      proposedCollisionTables: proposedCollisionTables.length,
      totalTables: entities.length,
    },
    candidateRanking: detailOutcomes.candidateRanking,
    selectedCandidateEvidence: detailOutcomes.selectedCandidateEvidence,
    tables,
    detailLoadFailures,
    detailLoadSummary: {
      attemptedCandidates: selection.selectedEntities.length,
      loadedCandidates: tables.length,
      failedCandidates: detailLoadFailures.length,
      ...selection.detailSelectionSummary,
    },
    proposedNameChecks,
    missingProposedTables: proposedNameChecks.missing,
    exactNameResolution: {
      requestedTables: requiredNames,
      loadedTables: requiredNames
        .filter((logicalName) => detailedNames.has(logicalName.toLowerCase()))
        .map((logicalName) => detailedNames.get(logicalName.toLowerCase())),
      unavailableTables: requiredUnavailableTables,
    },
    timings: {
      inventoryRetrievalMs: inventoryCompletedAt - totalStartedAt,
      candidateSelectionMs: selectionCompletedAt - inventoryCompletedAt,
      detailLoadingMs: detailCompletedAt - selectionCompletedAt,
      totalDurationMs: totalCompletedAt - totalStartedAt,
    },
  };
}

async function createReconciliationSnapshot({
  environmentUrl,
  tenantId,
  tableNames = [],
  proposedTableNames = [],
  request,
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  onProgress = () => {},
}) {
  if (!environmentUrl) throw new Error('environmentUrl is required');
  if (typeof request !== 'function') throw new Error('request is required');
  const requiredNames = uniqueLogicalNames(tableNames);
  const proposedNames = uniqueLogicalNames(proposedTableNames);
  if (requiredNames.length === 0) {
    throw new Error('fresh reconciliation requires at least one exact approved table');
  }

  const totalStartedAt = nowMs();
  const exactResolution = await resolveExactNameEntities(
    request,
    [],
    uniqueLogicalNames([...requiredNames, ...proposedNames]),
  );
  const inventoryCompletedAt = nowMs();
  const inventoryByName = new Map(exactResolution.entities.map(
    (entity) => [logicalNameOf(entity).toLowerCase(), entity],
  ));
  const unavailableTables = requiredNames.filter(
    (logicalName) => !inventoryByName.has(logicalName.toLowerCase()),
  );
  const entitiesToLoad = requiredNames
    .map((logicalName) => inventoryByName.get(logicalName.toLowerCase()))
    .filter(Boolean);
  const proposedNameChecks = analyzeProposedNames(
    exactResolution.entities,
    proposedNames,
  );
  onProgress({
    milestoneId: 'reconciliation-exact-names-loaded',
    requestedTables: requiredNames.length,
    existingTables: entitiesToLoad.length,
    unavailableTables: unavailableTables.length,
    proposedCollisions: proposedNameChecks.collisions.length,
    proposedMissing: proposedNameChecks.missing.length,
    elapsedMs: inventoryCompletedAt - totalStartedAt,
  });

  const tables = [];
  for (const entity of entitiesToLoad) {
    tables.push(await loadDetailedEntity(request, entity));
  }
  const detailCompletedAt = nowMs();
  onProgress({
    milestoneId: 'reconciliation-details-loaded',
    loadedTables: tables.length,
    columns: tables.reduce((total, table) => total + table.facts.columnCount, 0),
    relationships: tables.reduce((total, table) => total + table.facts.relationshipCount, 0),
    keys: tables.reduce((total, table) => total + table.facts.keyCount, 0),
    elapsedMs: detailCompletedAt - totalStartedAt,
  });
  const detailedByName = new Map(
    tables.map((table) => [table.logicalName.toLowerCase(), table.logicalName]),
  );
  const selectedCandidateEvidence = tables.map((table) => ({
    logicalName: table.logicalName,
    reasons: ['fresh-exact-reconciliation'],
    required: true,
    detailStatus: 'loaded',
    detailFailure: null,
  }));

  return {
    version: 3,
    purpose: 'execution-reconciliation',
    environmentUrl: environmentUrl.replace(/\/+$/, ''),
    tenantId: tenantId || null,
    generatedAt: nowIso(),
    inputs: {
      concepts: [],
      explicitTableNames: requiredNames,
      proposedTableNames: proposedNames,
    },
    inventory: exactResolution.entities
      .map(normalizeInventoryEntity)
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
    inventoryFacts: {
      customizableTables: exactResolution.entities.filter(
        (entity) => managedValue(entity.IsCustomizable),
      ).length,
      exactNameTables: exactResolution.discoveredTables.length,
      requiredExactNameTables: entitiesToLoad.length,
      proposedCollisionTables: proposedNameChecks.collisions.length,
      totalTables: exactResolution.entities.length,
    },
    candidateRanking: [],
    selectedCandidateEvidence,
    tables,
    detailLoadFailures: [],
    detailLoadSummary: {
      attemptedCandidates: entitiesToLoad.length,
      loadedCandidates: tables.length,
      failedCandidates: 0,
      requiredCandidates: requiredNames.length,
      advisoryCandidates: 0,
      exactCoveredConcepts: 0,
      unresolvedConcepts: 0,
      advisoryLimit: 0,
    },
    proposedNameChecks,
    missingProposedTables: proposedNameChecks.missing,
    exactNameResolution: {
      requestedTables: requiredNames,
      loadedTables: requiredNames
        .filter((logicalName) => detailedByName.has(logicalName.toLowerCase()))
        .map((logicalName) => detailedByName.get(logicalName.toLowerCase())),
      unavailableTables,
    },
    timings: {
      inventoryRetrievalMs: inventoryCompletedAt - totalStartedAt,
      candidateSelectionMs: 0,
      detailLoadingMs: detailCompletedAt - inventoryCompletedAt,
      totalDurationMs: detailCompletedAt - totalStartedAt,
    },
    reconciliation: {
      boundedExactNames: true,
      fullInventoryRead: false,
      tables: requiredNames,
      proposedNames,
    },
  };
}

function inventoryEntityToRaw(entity) {
  return {
    LogicalName: entity.logicalName,
    SchemaName: entity.schemaName,
    DisplayName: { UserLocalizedLabel: { Label: entity.displayName || '' } },
    DisplayCollectionName: {
      UserLocalizedLabel: { Label: entity.displayCollectionName || '' },
    },
    Description: { UserLocalizedLabel: { Label: entity.description || '' } },
    EntitySetName: entity.entitySetName,
    PrimaryIdAttribute: entity.primaryIdAttribute,
    PrimaryNameAttribute: entity.primaryNameAttribute,
    OwnershipType: entity.ownershipType,
    HasActivities: entity.hasActivities,
    HasNotes: entity.hasNotes,
    IsAvailableOffline: entity.isAvailableOffline,
    ChangeTrackingEnabled: entity.changeTrackingEnabled,
    IsCustomEntity: entity.customEntity,
    IsManaged: entity.managed,
    IsCustomizable: { Value: entity.customizable },
    CanCreateAttributes: { Value: entity.canCreateAttributes },
    CanBePrimaryEntityInRelationship: {
      Value: entity.canBePrimaryEntityInRelationship,
    },
    CanBeRelatedEntityInRelationship: {
      Value: entity.canBeRelatedEntityInRelationship,
    },
    CanBeInManyToMany: { Value: entity.canBeInManyToMany },
  };
}

async function expandSnapshot({
  snapshot,
  tableNames = [],
  proposedTableNames = [],
  request,
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  onProgress = () => {},
}) {
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`Cannot expand invalid snapshot: ${validation.errors.join('; ')}`);
  }
  if (typeof request !== 'function') throw new Error('request is required');

  const totalStartedAt = nowMs();
  const requestedNames = uniqueLogicalNames(tableNames);
  const proposedNames = uniqueLogicalNames(proposedTableNames);
  const exactCheckNames = uniqueLogicalNames([...requestedNames, ...proposedNames]);
  const baseRawInventory = snapshot.inventory.map(inventoryEntityToRaw);
  const exactResolution = await resolveExactNameEntities(
    request,
    baseRawInventory,
    exactCheckNames,
  );
  const inventoryCompletedAt = nowMs();
  const rawInventory = exactResolution.entities;
  const inventoryByName = new Map(
    rawInventory.map((entity) => [logicalNameOf(entity).toLowerCase(), entity]),
  );
  const existingDetailed = new Map(
    snapshot.tables.map((table) => [table.logicalName.toLowerCase(), table]),
  );
  const entitiesToLoad = requestedNames
    .filter((logicalName) => !existingDetailed.has(logicalName.toLowerCase()))
    .map((logicalName) => inventoryByName.get(logicalName.toLowerCase()))
    .filter(Boolean)
    .map((entity) => (entity.logicalName ? inventoryEntityToRaw(entity) : entity));
  const unavailableRequestedTables = requestedNames
    .filter((logicalName) => !inventoryByName.has(logicalName.toLowerCase()));
  const allProposedNames = [...new Set([
    ...(snapshot.inputs?.proposedTableNames || []),
    ...proposedNames,
  ])];
  const proposedNameChecks = analyzeProposedNames(rawInventory, allProposedNames);
  const requestedNameKeys = new Set(requestedNames.map((name) => name.toLowerCase()));
  const proposedNameKeys = new Set(proposedNames.map((name) => name.toLowerCase()));
  const requiredDiscoveredTables = exactResolution.discoveredTables.filter(
    (name) => requestedNameKeys.has(name.toLowerCase()),
  );
  const proposedCollisionTables = exactResolution.discoveredTables.filter(
    (name) => proposedNameKeys.has(name.toLowerCase())
      && !requestedNameKeys.has(name.toLowerCase()),
  );
  const selectionCompletedAt = nowMs();
  onProgress({
    milestoneId: 'expansion-selected',
    requestedTables: requestedNames.length,
    exactNameQueries: exactResolution.queriedTables.length > 0 ? 1 : 0,
    requiredExactNameDiscovered: requiredDiscoveredTables.length,
    requiredExactNameUnavailable: unavailableRequestedTables.length,
    exactNameDiscovered: requiredDiscoveredTables.length,
    exactNameUnavailable: unavailableRequestedTables.length,
    proposedNameCollisions: proposedNameChecks.collisions.length,
    proposedNameMissing: proposedNameChecks.missing.length,
    attemptedDetailedCandidates: entitiesToLoad.length,
    tablesToLoad: entitiesToLoad.length,
    inventoryTables: rawInventory.length,
    elapsedMs: selectionCompletedAt - totalStartedAt,
  });

  const loadedTables = [];
  for (const entity of entitiesToLoad) loadedTables.push(await loadDetailedEntity(request, entity));
  const detailCompletedAt = nowMs();
  onProgress({
    milestoneId: 'expansion-loaded',
    attemptedDetailedCandidates: entitiesToLoad.length,
    loadedDetailedCandidates: loadedTables.length,
    failedDetailedCandidates: 0,
    newlyLoadedTables: loadedTables.length,
    elapsedMs: detailCompletedAt - totalStartedAt,
  });
  const totalCompletedAt = nowMs();

  const detailedNames = new Set([
    ...snapshot.tables.map((table) => table.logicalName),
    ...loadedTables.map((table) => table.logicalName),
  ].map((logicalName) => logicalName.toLowerCase()));
  const expandedEvidence = new Map((snapshot.selectedCandidateEvidence || []).map((item) => [
    item.logicalName.toLowerCase(),
    { logicalName: item.logicalName, reasons: new Set(item.reasons) },
  ]));
  for (const logicalName of requestedNames) {
    if (!detailedNames.has(logicalName.toLowerCase())) continue;
    const key = logicalName.toLowerCase();
    const evidence = expandedEvidence.get(key) || {
      logicalName,
      reasons: new Set(),
    };
    evidence.reasons.add('explicit-expansion');
    expandedEvidence.set(key, evidence);
  }
  const loadedRequestedTables = requestedNames
    .filter((logicalName) => detailedNames.has(logicalName.toLowerCase()));
  const previousExactNames = snapshot.inputs?.explicitTableNames
    || snapshot.exactNameResolution?.requestedTables
    || [];
  const allExactNames = uniqueLogicalNames([...previousExactNames, ...requestedNames]);
  const allExactAvailable = new Map(
    rawInventory.map((entity) => [logicalNameOf(entity).toLowerCase(), logicalNameOf(entity)]),
  );
  const allDetailedNames = new Map(
    [...snapshot.tables, ...loadedTables]
      .map((table) => [table.logicalName.toLowerCase(), table.logicalName]),
  );
  const remainingDetailLoadFailures = (snapshot.detailLoadFailures || []).filter(
    (failure) => !allDetailedNames.has(failure.logicalName.toLowerCase()),
  );
  const expandedSelectedEvidence = [...expandedEvidence.values()]
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName))
    .map((item) => ({
      logicalName: item.logicalName,
      reasons: [...item.reasons].sort(),
    }));
  const detailOutcomes = applyDetailLoadOutcomes(
    snapshot.candidateRanking,
    expandedSelectedEvidence,
    [...snapshot.tables, ...loadedTables],
    remainingDetailLoadFailures,
  );

  return {
    ...snapshot,
    generatedAt: nowIso(),
    inputs: {
      concepts: [...(snapshot.inputs?.concepts || [])],
      explicitTableNames: [...new Set([
        ...(snapshot.inputs?.explicitTableNames || []),
        ...requestedNames,
      ])],
      proposedTableNames: allProposedNames,
    },
    inventory: rawInventory
      .map(normalizeInventoryEntity)
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
    inventoryFacts: {
      customizableTables: snapshot.inventoryFacts?.customizableTables
        ?? snapshot.inventory.filter((entity) => entity.customizable).length,
      exactNameTables: rawInventory.filter(
        (entity) => !baseRawInventory.some(
          (base) => logicalNameOf(base).toLowerCase() === logicalNameOf(entity).toLowerCase(),
        ),
      ).length + (snapshot.inventoryFacts?.exactNameTables || 0),
      requiredExactNameTables: requiredDiscoveredTables.length
        + (snapshot.inventoryFacts?.requiredExactNameTables || 0),
      proposedCollisionTables: proposedCollisionTables.length
        + (snapshot.inventoryFacts?.proposedCollisionTables || 0),
      totalTables: rawInventory.length,
    },
    candidateRanking: detailOutcomes.candidateRanking.map((ranking) => ({
      ...ranking,
      candidates: ranking.candidates.map((candidate) => {
        const evidence = expandedEvidence.get(candidate.logicalName.toLowerCase());
        return {
          ...candidate,
          selectionEvidence: evidence
            ? [...evidence.reasons].sort()
            : candidate.selectionEvidence || [],
        };
      }),
    })),
    selectedCandidateEvidence: detailOutcomes.selectedCandidateEvidence,
    tables: [...snapshot.tables, ...loadedTables]
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
    detailLoadFailures: remainingDetailLoadFailures,
    detailLoadSummary: {
      attemptedCandidates: snapshot.tables.length
        + loadedTables.length
        + remainingDetailLoadFailures.length,
      loadedCandidates: snapshot.tables.length + loadedTables.length,
      failedCandidates: remainingDetailLoadFailures.length,
      requiredCandidates: allExactNames.length,
      advisoryCandidates: snapshot.detailLoadSummary?.advisoryCandidates || 0,
      exactCoveredConcepts: snapshot.detailLoadSummary?.exactCoveredConcepts || 0,
      unresolvedConcepts: snapshot.detailLoadSummary?.unresolvedConcepts || 0,
      advisoryLimit: snapshot.detailLoadSummary?.advisoryLimit
        || MAX_ADVISORY_DETAIL_TABLES,
    },
    proposedNameChecks,
    missingProposedTables: proposedNameChecks.missing,
    exactNameResolution: {
      requestedTables: allExactNames,
      loadedTables: allExactNames
        .filter((logicalName) => allDetailedNames.has(logicalName.toLowerCase()))
        .map((logicalName) => allDetailedNames.get(logicalName.toLowerCase())),
      unavailableTables: allExactNames.filter(
        (logicalName) => !allExactAvailable.has(logicalName.toLowerCase()),
      ),
    },
    timings: {
      inventoryRetrievalMs: inventoryCompletedAt - totalStartedAt,
      candidateSelectionMs: selectionCompletedAt - inventoryCompletedAt,
      detailLoadingMs: detailCompletedAt - selectionCompletedAt,
      totalDurationMs: totalCompletedAt - totalStartedAt,
    },
    expansion: {
      baseGeneratedAt: snapshot.generatedAt,
      inventoryReused: true,
      requestedTables: requestedNames,
      loadedTables: loadedRequestedTables,
      newlyLoadedTables: loadedTables.map((table) => table.logicalName),
      unavailableTables: unavailableRequestedTables,
      attemptedDetailedCandidates: entitiesToLoad.length,
      loadedDetailedCandidates: loadedTables.length,
      failedDetailedCandidates: 0,
    },
  };
}

function createCliRequest(args, createExecutor = createDataverseRequestExecutor) {
  return createExecutor({
    environmentUrl: args['env-url'],
    tenantId: args['tenant-id'],
    solution: args.solution || null,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['env-url'] || !args['tenant-id'] || !args.output) {
    process.stderr.write(
      'Usage: node create-dataverse-snapshot.js --env-url <url> --tenant-id <id> --output <json> '
      + '[--tables <logical-name,...>] [--proposed-tables <logical-name,...>] '
      + '[--concepts <domain-term,...>] [--solution <unique-name>] '
      + '[--base-snapshot <existing-json>] [--reconcile-exact]\n',
    );
    process.exit(1);
  }
  const progress = (event) => {
    process.stderr.write(`DATAVERSE_SNAPSHOT_PROGRESS ${JSON.stringify(event)}\n`);
  };
  const request = createCliRequest(args);
  const baseSnapshot = args['base-snapshot']
    ? JSON.parse(fs.readFileSync(path.resolve(args['base-snapshot']), 'utf8'))
    : null;
  if (baseSnapshot && args['reconcile-exact']) {
    throw new Error('--base-snapshot and --reconcile-exact are mutually exclusive');
  }
  if (baseSnapshot) {
    const validation = validateSnapshot(baseSnapshot, {
      environmentUrl: args['env-url'],
      tenantId: args['tenant-id'],
    });
    if (!validation.valid) {
      throw new Error(`Base snapshot mismatch: ${validation.errors.join('; ')}`);
    }
  }
  const snapshot = args['reconcile-exact']
    ? await createReconciliationSnapshot({
      environmentUrl: args['env-url'],
      tenantId: args['tenant-id'],
      tableNames: parseList(args.tables),
      proposedTableNames: parseList(args['proposed-tables']),
      request,
      onProgress: progress,
    })
    : baseSnapshot
    ? await expandSnapshot({
      snapshot: baseSnapshot,
      tableNames: parseList(args.tables),
      proposedTableNames: parseList(args['proposed-tables']),
      request,
      onProgress: progress,
    })
    : await createSnapshot({
      environmentUrl: args['env-url'],
      tenantId: args['tenant-id'],
      tableNames: parseList(args.tables),
      proposedTableNames: parseList(args['proposed-tables']),
      concepts: parseList(args.concepts),
      request,
      onProgress: progress,
    });
  const output = path.resolve(args.output);
  atomicWriteJson(output, snapshot);
  console.log(JSON.stringify({
    status: 'DONE',
    output,
    inventoryTables: snapshot.inventory.length,
    rankedConcepts: snapshot.candidateRanking.length,
    detailedTables: snapshot.tables.length,
    detailedCandidates: {
      attempted: snapshot.detailLoadSummary?.attemptedCandidates || 0,
      loaded: snapshot.detailLoadSummary?.loadedCandidates || 0,
      failed: snapshot.detailLoadSummary?.failedCandidates || 0,
      required: snapshot.detailLoadSummary?.requiredCandidates || 0,
      advisory: snapshot.detailLoadSummary?.advisoryCandidates || 0,
      exactCoveredConcepts: snapshot.detailLoadSummary?.exactCoveredConcepts || 0,
      advisoryLimit: snapshot.detailLoadSummary?.advisoryLimit
        || MAX_ADVISORY_DETAIL_TABLES,
    },
    proposedCollisions: snapshot.proposedNameChecks.collisions.length,
    proposedMissing: snapshot.proposedNameChecks.missing.length,
    exactNameResolution: snapshot.exactNameResolution,
    expansion: snapshot.expansion || null,
    timings: snapshot.timings,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  analyzeProposedNames,
  atomicWriteFile,
  atomicWriteJson,
  compact,
  choiceMetadataType,
  conceptDescriptor,
  createCliRequest,
  createReconciliationSnapshot,
  createSnapshot,
  expandSnapshot,
  inventoryEntityToRaw,
  isVersionedName,
  labelText,
  loadDetailedEntity,
  normalizeNextLink,
  normalizeIntegerMetadata,
  normalizedTokens,
  odataString,
  parseArgs,
  parseList,
  publisherPrefix,
  rankCandidatesByConcept,
  relationshipCount,
  resolveExactNameEntities,
  requestCollection,
  selectDetailedCandidates,
  selectDetailedEntities,
  singularizeToken,
  validateSnapshot,
};
