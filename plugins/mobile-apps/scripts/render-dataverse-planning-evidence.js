#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile, parseArgs, relationshipCount, validateSnapshot } = require('./create-dataverse-snapshot');

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatBoolean(value) {
  return value ? 'yes' : 'no';
}

function formatDuration(value) {
  return `${Number(value || 0).toFixed(0)} ms`;
}

function rankedCandidateText(ranking, limit = 5) {
  if (!ranking.candidates?.length) return 'No matching candidates';
  const rendered = ranking.candidates.slice(0, limit).map((candidate) => {
    const flags = [
      candidate.detailStatus === 'unavailable'
        ? 'detail unavailable'
        : candidate.detailed
          ? 'detailed'
          : 'inventory only',
      candidate.versioned ? 'versioned' : 'unversioned',
      candidate.reasons?.slice(0, 2).join(', '),
    ].filter(Boolean).join('; ');
    return `${candidate.rank}. \`${candidate.logicalName}\` (${candidate.score}; ${flags})`;
  });
  if (ranking.candidates.length > limit) {
    rendered.push(`+${ranking.candidates.length - limit} lower-ranked`);
  }
  return rendered.join('<br>');
}

function renderPlanningEvidence(snapshot) {
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse snapshot: ${validation.errors.join('; ')}`);
  }

  const lines = [
    '# Dataverse Planning Evidence',
    '',
    `- **Environment:** \`${snapshot.environmentUrl}\``,
    `- **Tenant:** \`${snapshot.tenantId}\``,
    `- **Generated:** ${snapshot.generatedAt}`,
    `- **Snapshot version:** ${snapshot.version}`,
    '',
    '## Required exact-name resolution',
    '',
    `- **Requested:** ${(snapshot.exactNameResolution?.requestedTables || []).map((name) => `\`${escapeCell(name)}\``).join(', ') || 'none'}`,
    `- **Loaded:** ${(snapshot.exactNameResolution?.loadedTables || []).map((name) => `\`${escapeCell(name)}\``).join(', ') || 'none'}`,
    `- **Unavailable:** ${(snapshot.exactNameResolution?.unavailableTables || []).map((name) => `\`${escapeCell(name)}\``).join(', ') || 'none'}`,
    '- Proposed logical names are reported separately as collision checks; they are not required existing tables.',
    '',
    '## Concept candidate ranking',
    '',
    '| Concept | Preferred publisher family | Ranked candidates |',
    '|---|---|---|',
  ];

  if (snapshot.candidateRanking.length === 0) {
    lines.push('| — | — | No concepts supplied |');
  } else {
    for (const ranking of snapshot.candidateRanking) {
      lines.push(
        `| ${escapeCell(ranking.concept)} | \`${escapeCell(ranking.preferredPublisherFamily || 'standard')}\` | ${rankedCandidateText(ranking)} |`,
      );
    }
  }

  lines.push(
    '',
    '## Unavailable detail metadata',
    '',
    '| Logical name | Required | Selection reasons | Status | Error |',
    '|---|---:|---|---:|---|',
  );
  const detailLoadFailures = snapshot.detailLoadFailures || [];
  if (detailLoadFailures.length === 0) {
    lines.push('| — | — | — | — | None |');
  } else {
    for (const failure of detailLoadFailures) {
      lines.push(
        `| \`${escapeCell(failure.logicalName)}\` | `
        + `${failure.required ? 'yes' : 'no'} | `
        + `${escapeCell(failure.selectionReasons.join(', '))} | `
        + `${failure.status ?? 'n/a'} | ${escapeCell(failure.error)} |`,
      );
    }
  }

  lines.push(
    '',
    '## Detailed candidate facts',
    '',
    '| Logical name | Custom | Managed | Customizable | Columns | Relationships | Keys |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  if (snapshot.tables.length === 0) {
    lines.push('| — | — | — | — | 0 | 0 | 0 |');
  } else {
    for (const table of [...snapshot.tables].sort(
      (left, right) => left.logicalName.localeCompare(right.logicalName),
    )) {
      lines.push(
        `| \`${escapeCell(table.logicalName)}\` | ${formatBoolean(table.customEntity)} | `
        + `${formatBoolean(table.managed)} | ${formatBoolean(table.customizable)} | `
        + `${table.facts?.columnCount ?? table.columns?.length ?? 0} | `
        + `${table.facts?.relationshipCount ?? relationshipCount(table)} | `
        + `${table.facts?.keyCount ?? table.alternateKeys?.length ?? 0} |`,
      );
    }
  }

  lines.push(
    '',
    '## Proposed logical-name checks',
    '',
    '| Proposed logical name | Result | Existing table facts |',
    '|---|---|---|',
  );
  const nameChecks = snapshot.proposedNameChecks?.checked || [];
  if (nameChecks.length === 0) {
    lines.push('| — | Not supplied | — |');
  } else {
    for (const item of nameChecks) {
      const facts = item.existing
        ? `custom=${formatBoolean(item.existing.customEntity)}, managed=${formatBoolean(item.existing.managed)}, customizable=${formatBoolean(item.existing.customizable)}`
        : 'No table returned by the bounded inventory/collision-check metadata reads';
      lines.push(`| \`${escapeCell(item.logicalName)}\` | **${item.status}** | ${facts} |`);
    }
  }

  lines.push(
    '',
    '## Snapshot timings',
    '',
    '| Phase | Duration |',
    '|---|---:|',
    `| Inventory retrieval | ${formatDuration(snapshot.timings.inventoryRetrievalMs)} |`,
    `| Candidate selection | ${formatDuration(snapshot.timings.candidateSelectionMs)} |`,
    `| Detail loading | ${formatDuration(snapshot.timings.detailLoadingMs)} |`,
    `| **Total** | **${formatDuration(snapshot.timings.totalDurationMs)}** |`,
    '',
    '> This appendix is deterministic metadata evidence. The data-model architect should reference it rather than restating raw inventory or column payloads.',
    '',
  );
  return lines.join('\n');
}

function readSnapshot(file, fileSystem = fs) {
  return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.snapshot || !args.output) {
    process.stderr.write(
      'Usage: node render-dataverse-planning-evidence.js --snapshot <json> --output <markdown>\n',
    );
    process.exit(1);
  }
  const snapshotPath = path.resolve(args.snapshot);
  const outputPath = path.resolve(args.output);
  const snapshot = readSnapshot(snapshotPath);
  const markdown = renderPlanningEvidence(snapshot);
  atomicWriteFile(outputPath, markdown);
  console.log(JSON.stringify({
    status: 'DONE',
    output: outputPath,
    concepts: snapshot.candidateRanking.length,
    detailedTables: snapshot.tables.length,
    detailedCandidates: {
      attempted: snapshot.detailLoadSummary?.attemptedCandidates || 0,
      loaded: snapshot.detailLoadSummary?.loadedCandidates || 0,
      failed: snapshot.detailLoadSummary?.failedCandidates || 0,
    },
    proposedCollisions: snapshot.proposedNameChecks?.collisions?.length || 0,
    proposedMissing: snapshot.proposedNameChecks?.missing?.length || 0,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  escapeCell,
  formatDuration,
  rankedCandidateText,
  readSnapshot,
  renderPlanningEvidence,
};
