#!/usr/bin/env node

// Append-only JSONL metrics journal for inner-loop skill runs.
//
// Why JSONL: every skill run produces ONE line on disk. Concurrent writers
// never clobber each other because we use a single fs.appendFileSync call
// (atomic on most filesystems for buffers < PIPE_BUF, which is always true
// for our ~300-byte metric lines). No locking required.
//
// What gets recorded: caller-supplied object + ts (auto) + skill (required).
// We do not impose a schema beyond {ts, skill} so each caller can record
// whatever is meaningful for that skill's trend dashboard. Typical fields:
//   commit-to-git:   { commitId, durationMs, pollAttempts, componentsCommitted,
//                      payloadBytes, branch, status }
//   sync-from-git:   { durationMs, updatesPulled, conflictsResolved, status }
//   validate-...:    { durationMs, blockerCount, warningCount, validatorsRun }
//
// Location: docs/inner-loop/skill-metrics.jsonl  (single file across skills)
//
// CLI usage:
//   node append-skill-metric.js
//       --project-root <path>             # required: resolves docs/inner-loop/skill-metrics.jsonl
//       --skill <name>                    # required: 'CommitToGit' | 'SyncFromGit' | ...
//       --json <inline JSON>              # OR
//       --json-file <path>                # JSON object to merge (excluding ts/skill)
//
// Library usage:
//   const { appendSkillMetric } = require('./append-skill-metric');
//   appendSkillMetric({
//     projectRoot: '/foo',
//     skill: 'CommitToGit',
//     payload: { commitId: 'abc', durationMs: 5000, status: 'succeeded' },
//   });
//
// Both modes return the path written + the literal line appended.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  innerLoopPath,
  ensureInnerLoopDir,
} = require('./inner-loop-paths');

/**
 * Compose a single JSONL line and append it to docs/inner-loop/skill-metrics.jsonl.
 *
 * @param {object} options
 * @param {string} options.projectRoot - absolute path used to resolve the journal
 * @param {string} options.skill - the skill name (e.g. 'CommitToGit')
 * @param {object} [options.payload] - additional fields merged into the line
 * @param {Date|string} [options.ts] - override the timestamp (default new Date().toISOString())
 * @returns {{path: string, line: string}}
 */
function appendSkillMetric({ projectRoot, skill, payload = {}, ts = null } = {}) {
  if (!projectRoot) throw new Error('appendSkillMetric: projectRoot is required');
  if (!skill || typeof skill !== 'string') {
    throw new Error('appendSkillMetric: skill is required and must be a string');
  }
  if (payload && typeof payload !== 'object') {
    throw new Error('appendSkillMetric: payload must be an object');
  }
  // Forbid callers from sneaking in their own ts/skill via payload — auto fields win.
  const sanitized = { ...payload };
  delete sanitized.ts;
  delete sanitized.skill;

  const isoTs = ts ? (ts instanceof Date ? ts.toISOString() : String(ts)) : new Date().toISOString();
  const record = { ts: isoTs, skill, ...sanitized };

  ensureInnerLoopDir(projectRoot);
  const filePath = innerLoopPath(projectRoot, 'skillMetricsJsonl');
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
  return { path: filePath, line };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { projectRoot: null, skill: null, json: null, jsonFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--skill' && args[i + 1]) out.skill = args[++i];
    else if (args[i] === '--json' && args[i + 1]) out.json = args[++i];
    else if (args[i] === '--json-file' && args[i + 1]) out.jsonFile = args[++i];
  }
  return out;
}

if (require.main === module) {
  try {
    const a = parseArgs(process.argv);
    if (!a.projectRoot) throw new Error('--project-root is required');
    if (!a.skill) throw new Error('--skill is required');
    let payload = {};
    if (a.json && a.jsonFile) {
      throw new Error('--json and --json-file are mutually exclusive');
    }
    if (a.json) {
      payload = JSON.parse(a.json);
    } else if (a.jsonFile) {
      payload = JSON.parse(fs.readFileSync(a.jsonFile, 'utf8'));
    }
    const r = appendSkillMetric({ projectRoot: a.projectRoot, skill: a.skill, payload });
    process.stdout.write(JSON.stringify({ ok: true, path: r.path }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('append-skill-metric: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { appendSkillMetric };
