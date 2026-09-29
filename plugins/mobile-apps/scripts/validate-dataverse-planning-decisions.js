#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { derivedExpected, isComputedColumn, validateContract } = require('./build-dataverse-operation-manifest');
const { compareDerivedColumn } = require('./lib/derived-metadata');
const { validateSnapshot } = require('./create-dataverse-snapshot');

const FULL_DETAIL_DECISIONS = new Set(['reuse', 'extend', 'adapt']);
const CONTEXT_GATE_ERRORS = new Set([
  'reuse, extend, and adapt decisions require full Dataverse detail evidence',
  'create and adapt decisions require proposed-name collision evidence',
]);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function getBlockingErrors(result) {
  return result.errors.filter(
    (error) => error.startsWith('contract: ') || error.startsWith('snapshot: '),
  );
}

function getRevisionErrors(result) {
  return result.errors.filter(
    (error) => (
      !CONTEXT_GATE_ERRORS.has(error)
      && !error.startsWith('contract: ')
      && !error.startsWith('snapshot: ')
    ),
  );
}

function validatePlanningDecisions(contract, snapshot) {
  const errors = [];
  const contextNames = new Set();
  const fullDetailContextNames = new Set();
  const proposedContextNames = new Set();
  const contractValidation = validateContract(contract);
  if (!contractValidation.valid) {
    errors.push(...contractValidation.errors.map((error) => `contract: ${error}`));
  }
  const snapshotValidation = validateSnapshot(snapshot);
  if (!snapshotValidation.valid) {
    errors.push(...snapshotValidation.errors.map((error) => `snapshot: ${error}`));
  }
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      contextNames: [],
      proposedContextNames: [],
    };
  }

  const detailed = new Map(snapshot.tables.map((table) => [normalize(table.logicalName), table]));
  const unavailableDetails = new Set(
    (snapshot.detailLoadFailures || []).map((failure) => normalize(failure.logicalName)),
  );
  const deferRequiredNames = new Set();
  const proposedChecks = new Map(
    (snapshot.proposedNameChecks?.checked || []).map(
      (check) => [normalize(check.logicalName), normalize(check.status)],
    ),
  );
  for (const table of contract.tables || []) {
    const decision = normalize(table.plannedDecision);
    // Unverified remains valid for legacy discovery contracts, but a trusted
    // snapshot requires a grounded decision or explicit deferral before approval.
    for (const [kind, components] of [
      ['table', [table]],
      ['column', table.columns || []],
      ['relationship', table.relationships || []],
      ['alternate key', table.alternateKeys || []],
    ]) {
      for (const component of components) {
        if (normalize(component.plannedDecision) !== 'unverified') continue;
        const name = component.logicalName || component.schemaName;
        errors.push(`${kind} ${name} is unverified; revise the decision from snapshot evidence or defer it`);
      }
    }
    if (unavailableDetails.has(normalize(table.logicalName)) && decision !== 'defer') {
      contextNames.add(table.logicalName);
      deferRequiredNames.add(table.logicalName);
    }
    if (FULL_DETAIL_DECISIONS.has(decision)) {
      const evidence = detailed.get(normalize(table.logicalName));
      if (!evidence || evidence.detailLevel !== 'full') {
        contextNames.add(table.logicalName);
        fullDetailContextNames.add(table.logicalName);
      } else {
        for (const column of table.columns || []) {
          if (!isComputedColumn(column) || normalize(column.plannedDecision) === 'defer') continue;
          const liveColumn = evidence.columns.find(
            (item) => normalize(item.logicalName) === normalize(column.logicalName),
          );
          const computed = liveColumn?.computed;
          const label = `required computed column ${table.logicalName}.${column.logicalName}`;
          if (computed?.metadataStatus !== 'available'
            || !Number.isInteger(computed.sourceType) || ![1, 2, 3].includes(computed.sourceType)
            || !Number.isInteger(computed.sourceTypeMask) || computed.sourceTypeMask < 0
            || typeof computed.formulaDefinition !== 'string' || !computed.formulaDefinition.trim()) {
            errors.push(`${label} has unavailable metadata; defer the column or revise the requirement`);
            continue;
          }
          const comparison = compareDerivedColumn(derivedExpected(table.logicalName, column), {
            ...computed,
            type: liveColumn.type,
          });
          if (!comparison.compatible) {
            errors.push(`${label} does not match its metadata: ${comparison.reasons.join('; ')}`);
          }
        }
      }
    }
    if (decision === 'create' || decision === 'adapt') {
      const effectiveName = decision === 'adapt' ? table.adaptedLogicalName : table.logicalName;
      const status = proposedChecks.get(normalize(effectiveName));
      if (!status) {
        proposedContextNames.add(effectiveName);
      } else if (status !== 'missing') {
        errors.push(`proposed table name ${effectiveName} is not available (${status})`);
      }
    }
    for (const relationship of table.relationships || []) {
      const relationshipDecision = normalize(relationship.plannedDecision);
      if (relationship.kind !== 'many-to-many'
        || !['create', 'adapt'].includes(relationshipDecision)) continue;
      const effectiveIntersect = relationshipDecision === 'adapt'
        ? relationship.adaptedIntersectTable
        : relationship.intersectTable;
      const status = proposedChecks.get(normalize(effectiveIntersect));
      if (!status) {
        proposedContextNames.add(effectiveIntersect);
      } else if (status !== 'missing') {
        errors.push(
          `proposed intersect table name ${effectiveIntersect} is not available (${status})`,
        );
      }
    }
  }
  return {
    valid: contextNames.size === 0 && proposedContextNames.size === 0 && errors.length === 0,
    errors: [
      ...(fullDetailContextNames.size === 0
        ? []
        : ['reuse, extend, and adapt decisions require full Dataverse detail evidence']),
      ...(deferRequiredNames.size === 0
        ? []
        : ['tables with attempted unavailable detail metadata must be deferred']),
      ...(proposedContextNames.size === 0
        ? []
        : ['create and adapt decisions require proposed-name collision evidence']),
      ...errors,
    ],
    contextNames: [...contextNames].sort((left, right) => left.localeCompare(right)),
    proposedContextNames: [...proposedContextNames]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--snapshot') args.snapshot = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (!args.contract || !args.snapshot) {
    process.stderr.write(
      'Usage: node validate-dataverse-planning-decisions.js '
      + '--contract <json> --snapshot <json> [--json]\n',
    );
    return 2;
  }
  try {
    const contract = JSON.parse(fs.readFileSync(path.resolve(args.contract), 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(args.snapshot), 'utf8'));
    const result = validatePlanningDecisions(contract, snapshot);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const blockingErrors = getBlockingErrors(result);
    if (blockingErrors.length > 0) {
      blockingErrors.forEach((error) => process.stderr.write(`${error}\n`));
      return 2;
    }
    const revisionErrors = getRevisionErrors(result);
    if (revisionErrors.length > 0) {
      process.stderr.write('NEEDS_REVISION: dataverse-plan-validation\n');
      revisionErrors.forEach((error) => process.stderr.write(`${error}\n`));
      return 4;
    }
    if (result.contextNames.length > 0) {
      process.stderr.write(
        `NEEDS_CONTEXT: detailed-dataverse-metadata:${result.contextNames.join(',')}\n`,
      );
      return 3;
    }
    if (result.proposedContextNames.length > 0) {
      process.stderr.write(
        `NEEDS_CONTEXT: proposed-dataverse-names:${result.proposedContextNames.join(',')}\n`,
      );
      return 3;
    }
    if (!result.valid) {
      result.errors.forEach((error) => process.stderr.write(`${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write('Dataverse planning decisions have full evidence.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`validate-dataverse-planning-decisions: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  CONTEXT_GATE_ERRORS,
  FULL_DETAIL_DECISIONS,
  getBlockingErrors,
  getRevisionErrors,
  main,
  validatePlanningDecisions,
};