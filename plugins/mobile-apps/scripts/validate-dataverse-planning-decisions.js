#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateContract } = require('./build-dataverse-operation-manifest');
const { validateSnapshot } = require('./create-dataverse-snapshot');

const FULL_DETAIL_DECISIONS = new Set(['reuse', 'extend', 'adapt']);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePlanningDecisions(contract, snapshot) {
  const errors = [];
  const contextNames = new Set();
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
  const proposedChecks = new Map(
    (snapshot.proposedNameChecks?.checked || []).map(
      (check) => [normalize(check.logicalName), normalize(check.status)],
    ),
  );
  for (const table of contract.tables || []) {
    const decision = normalize(table.plannedDecision);
    if (FULL_DETAIL_DECISIONS.has(decision)) {
      const evidence = detailed.get(normalize(table.logicalName));
      if (!evidence || (evidence.detailLevel || 'full') !== 'full') {
        contextNames.add(table.logicalName);
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
      ...(contextNames.size === 0
        ? []
        : ['reuse, extend, and adapt decisions require full Dataverse detail evidence']),
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
  FULL_DETAIL_DECISIONS,
  main,
  validatePlanningDecisions,
};