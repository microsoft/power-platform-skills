#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { stableJson } = require('./build-dataverse-operation-manifest');
const { validateProposal } = require('./compile-dataverse-model-proposal');

const DEFAULT_INPUT = '.tmp/dataverse-model-architect-response.txt';
const DEFAULT_OUTPUT = '.tmp/dataverse-model-proposal.json';
const SUCCESS_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS']);

function marker(kind, runId, edge) {
  return `<<<MOBILE_DATAVERSE_PROPOSAL${kind ? `_${kind}` : ''}:${runId}:${edge}>>>`;
}

function parseJsonLine(line, prefix, label) {
  if (!line.startsWith(prefix)) throw new Error(`${label} line is missing`);
  try {
    return JSON.parse(line.slice(prefix.length).trim());
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function proposalRequiresConcerns(proposal) {
  return (proposal.tables || []).some((table) => [
    table.decision,
    ...(table.columns || []).map((column) => column.decision),
    ...(table.relationships || []).map((relationship) => relationship.decision),
    ...(table.alternateKeys || []).map((key) => key.decision),
  ].some((decision) => decision === 'adapt' || decision === 'defer'));
}

function parseEnvelope(source, expectedRunId) {
  const runId = String(expectedRunId || '').trim();
  if (!runId || /[\r\n:<>]/.test(runId)) throw new Error('run ID is invalid');
  const normalized = String(source).replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new Error('architect response contains unsupported line endings');
  const text = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const lines = text.split('\n');
  const outerBegin = marker('', runId, 'BEGIN');
  const outerEnd = marker('', runId, 'END');
  if (lines[0] !== outerBegin || lines.at(-1) !== outerEnd) {
    throw new Error('architect response has text outside the expected run envelope or a mismatched run ID');
  }
  const nestedOuterMarkers = lines.slice(1, -1).filter((line) => (
    line.startsWith('<<<MOBILE_DATAVERSE_PROPOSAL:')
  ));
  if (nestedOuterMarkers.length > 0) throw new Error('architect response contains multiple envelopes');
  const body = lines.slice(1, -1);
  if (!body[0]?.startsWith('STATUS: ')) throw new Error('STATUS line is missing');
  const status = body[0].slice('STATUS: '.length).trim();
  if (![...SUCCESS_STATUSES, 'NEEDS_CONTEXT', 'BLOCKED'].includes(status)) {
    throw new Error(`unsupported architect status: ${status || '<empty>'}`);
  }

  if (SUCCESS_STATUSES.has(status)) {
    if (body.length < 5) throw new Error('successful architect response is incomplete');
    const concerns = parseJsonLine(body[1], 'CONCERNS:', 'CONCERNS');
    if (!Array.isArray(concerns) || concerns.some((item) => typeof item !== 'string')) {
      throw new Error('CONCERNS must be a JSON string array');
    }
    if (status === 'DONE' && concerns.length !== 0) {
      throw new Error('DONE requires an empty CONCERNS array');
    }
    if (status === 'DONE_WITH_CONCERNS' && concerns.length === 0) {
      throw new Error('DONE_WITH_CONCERNS requires at least one concern');
    }
    const contentBegin = marker('CONTENT', runId, 'BEGIN');
    const contentEnd = marker('CONTENT', runId, 'END');
    const begins = body.reduce((indexes, line, index) => (
      line === contentBegin ? [...indexes, index] : indexes
    ), []);
    const ends = body.reduce((indexes, line, index) => (
      line === contentEnd ? [...indexes, index] : indexes
    ), []);
    if (begins.length !== 1 || ends.length !== 1 || begins[0] !== 2 || ends[0] !== body.length - 1) {
      throw new Error('architect response must contain exactly one run-scoped content block');
    }
    const jsonText = body.slice(begins[0] + 1, ends[0]).join('\n');
    let proposal;
    try {
      proposal = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`proposal content is not valid JSON: ${error.message}`);
    }
    const validation = validateProposal(proposal);
    if (!validation.valid) {
      throw new Error(`proposal content is invalid: ${validation.errors.join('; ')}`);
    }
    const requiresConcerns = proposalRequiresConcerns(proposal);
    if (status === 'DONE' && requiresConcerns) {
      throw new Error('a proposal containing adapt or defer requires DONE_WITH_CONCERNS');
    }
    if (status === 'DONE_WITH_CONCERNS' && !requiresConcerns) {
      throw new Error('DONE_WITH_CONCERNS is only valid when the proposal contains adapt or defer');
    }
    return { status, concerns, proposal };
  }

  if (body.some((line) => line.startsWith('<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:'))) {
    throw new Error(`${status} response must not contain a proposal content block`);
  }
  const fields = {};
  for (const line of body.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`${status} response contains a malformed field`);
    const key = line.slice(0, separator);
    if (fields[key] !== undefined) throw new Error(`${status} response repeats ${key}`);
    fields[key] = line.slice(separator + 1).trim();
  }
  const concerns = parseJsonLine(`CONCERNS: ${fields.CONCERNS || ''}`, 'CONCERNS:', 'CONCERNS');
  if (!Array.isArray(concerns) || concerns.some((item) => typeof item !== 'string')) {
    throw new Error('CONCERNS must be a JSON string array');
  }
  if (!fields.DETAIL) throw new Error(`${status} response requires DETAIL`);
  if (status === 'NEEDS_CONTEXT'
    && !/^(detailed-dataverse-metadata|proposed-dataverse-names):[a-z0-9_,]+$/.test(fields.DETAIL)) {
    throw new Error('NEEDS_CONTEXT DETAIL is invalid');
  }
  return { status, concerns, detail: fields.DETAIL };
}

function resolveInside(root, requested) {
  const file = path.resolve(root, requested);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside project root: ${requested}`);
  }
  return file;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--run-id') args.runId = argv[++index];
    else if (token === '--input') args.input = argv[++index];
    else if (token === '--output') args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  if (!args.runId) throw new Error('--run-id is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const root = path.resolve(args.projectRoot);
    const input = resolveInside(root, args.input || DEFAULT_INPUT);
    const output = resolveInside(root, args.output || DEFAULT_OUTPUT);
    const parsed = parseEnvelope(fs.readFileSync(input, 'utf8'), args.runId);
    if (SUCCESS_STATUSES.has(parsed.status)) atomicWrite(output, parsed.proposal);
    const result = {
      ok: SUCCESS_STATUSES.has(parsed.status),
      status: parsed.status,
      concerns: parsed.concerns,
      ...(parsed.detail ? { detail: parsed.detail } : {}),
      ...(SUCCESS_STATUSES.has(parsed.status) ? {
        output: path.relative(root, output),
        proposalSha256: require('node:crypto').createHash('sha256')
          .update(stableJson(parsed.proposal)).digest('hex'),
      } : {}),
    };
    const stream = parsed.status === 'BLOCKED' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(result)}\n`);
    if (parsed.status === 'NEEDS_CONTEXT') return 3;
    if (parsed.status === 'BLOCKED') return 4;
    return 0;
  } catch (error) {
    process.stderr.write(`parse-dataverse-model-proposal-envelope: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, marker, parseEnvelope };