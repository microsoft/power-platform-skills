#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function contextEnrichmentRevision(contract) {
  return crypto.createHash('sha256').update(stableStringify(contract)).digest('hex');
}

function evidence(brief, pattern, signal) {
  const match = pattern.exec(brief);
  const text = match?.[0] || brief.slice(0, Math.min(brief.length, 120));
  const start = match?.index || 0;
  return { signal, text, start, end: start + text.length };
}

function item(id, label, sampleValue, valueType, placementIntent, itemEvidence, assumption) {
  return { id, label, sampleValue, valueType, source: 'inferred-prototype-fixture', placementIntent, evidence: itemEvidence, assumption };
}

function resolveContextEnrichment(briefText, experienceContract) {
  const brief = String(briefText || '').trim();
  if (!brief) throw new Error('confirmed brief must be non-empty');
  const base = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experienceContract),
    contextMode: 'none',
    displayContext: [],
    ephemeralModel: null,
    assumptions: [],
    forbiddenInferences: ['Do not invent functionality, integrations, permissions, or persistent entities from illustrative context.'],
  };
  const shared = (mode, key, fields, entries, assumptions, forbidden) => ({
    ...base,
    contextMode: mode,
    displayContext: entries,
    ephemeralModel: { key, persistence: 'prototype-session', fields },
    assumptions,
    forbiddenInferences: [...base.forbiddenInferences, ...forbidden],
  });
  if (experienceContract.primarySurface === 'product-led-discovery' && /\b(?:flight|in[-\s]?flight|onboard|passenger)\b/i.test(brief)) {
    const proof = evidence(brief, /\b(?:flight|in[-\s]?flight|onboard|passenger)\b/i, 'active-journey');
    const assumption = 'Journey values are illustrative session context and are not connected airline data.';
    return shared('active-journey', 'JourneyContext', ['flightNumber', 'seatNumber', 'connectivity', 'fulfilmentMode'], [
      item('flight-number', 'Flight', 'AI 184', 'text', 'primary-screen-context-rail', proof, assumption),
      item('seat-number', 'Seat', '12A', 'text', 'primary-screen-context-rail', proof, assumption),
      item('connectivity', 'Connectivity', 'Catalog available offline', 'status', 'primary-screen-context-rail', proof, assumption),
      item('fulfilment-mode', 'Fulfilment', 'Delivery to your seat', 'status', 'primary-screen-context-rail', proof, assumption),
    ], [assumption], [
      'Do not claim live airline integration or real-time flight tracking.',
      'Do not add booking, check-in, seat-management, or payment functionality.',
      'Do not make JourneyContext a permanent Dataverse table without later evidence and approval.',
    ]);
  }
  const configurations = {
    'learning-journey': ['learning-progress', 'LearningContext', ['course', 'currentLesson', 'progress', 'nextMilestone'], [
      ['course', 'Course', 'Mobile Foundations', 'text'], ['current-lesson', 'Current lesson', 'Lesson 4: Navigation', 'text'], ['progress', 'Progress', '60% complete', 'progress'], ['next-milestone', 'Next milestone', 'Complete the navigation exercise', 'status'],
    ], /\b(?:learn|lesson|course|study)\b/i, 'learning-progress'],
    'availability-led-discovery': ['availability-context', 'BookingContext', ['location', 'service', 'dateTime', 'availability'], [
      ['location', 'Location', 'Downtown clinic', 'text'], ['service', 'Service', 'Follow-up consultation', 'text'], ['date-time', 'Date and time', 'Tuesday, 10:30 AM', 'date-time'], ['availability', 'Availability', '3 times available', 'status'],
    ], /\b(?:book|appointment|schedule|reserve)\b/i, 'booking-context'],
    'task-led-workflow': ['active-assignment', 'AssignmentContext', ['shift', 'assignment', 'site', 'offlineReadiness'], [
      ['shift', 'Shift', 'Morning shift', 'text'], ['assignment', 'Assignment', 'Inspection route 04', 'text'], ['site', 'Site', 'North facility', 'text'], ['offline-readiness', 'Offline', 'Ready for field work', 'status'],
    ], /\b(?:task|assignment|inspection|work order|shift)\b/i, 'assignment-context'],
    'decision-led-overview': ['financial-period', 'FinancialContext', ['period', 'account', 'lastRefresh', 'privacyState'], [
      ['period', 'Period', 'Current month', 'text'], ['account', 'Account', 'Primary account', 'text'], ['last-refresh', 'Last refresh', '8 minutes ago', 'status'], ['privacy-state', 'Privacy', 'Values hidden in app switcher', 'status'],
    ], /\b(?:finance|balance|budget|spending|account)\b/i, 'financial-context'],
    'conversation-led-inbox': ['workspace-presence', 'WorkspaceContext', ['workspace', 'unreadState', 'presence', 'activeConversation'], [
      ['workspace', 'Workspace', 'Customer support', 'text'], ['unread-state', 'Unread', '4 conversations', 'status'], ['presence', 'Presence', 'Available', 'status'], ['active-conversation', 'Active', 'Delivery question', 'text'],
    ], /\b(?:message|conversation|inbox|workspace)\b/i, 'workspace-context'],
    'capture-led-utility': ['capture-session', 'CaptureContext', ['site', 'assignment', 'captureStatus', 'syncState'], [
      ['site', 'Site', 'North facility', 'text'], ['assignment', 'Assignment', 'Safety inspection', 'text'], ['capture-status', 'Capture', '2 of 5 items complete', 'progress'], ['sync-state', 'Sync', 'Saved on device', 'status'],
    ], /\b(?:capture|inspection|scan|photo|site)\b/i, 'capture-context'],
  };
  const configuration = configurations[experienceContract.primarySurface];
  if (!configuration) return base;
  const [mode, key, fields, values, pattern, signal] = configuration;
  const proof = evidence(brief, pattern, signal);
  const assumption = `${key} values are illustrative prototype-session context derived from the confirmed user situation.`;
  return shared(mode, key, fields, values.map(([id, label, sampleValue, valueType]) => item(id, label, sampleValue, valueType, id === values[0][0] ? 'primary-screen-context-rail' : 'supporting-section', proof, assumption)), [assumption], [`Do not persist ${key} or claim a live external source without later evidence and approval.`]);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node resolve-context-enrichment.js --project-root <dir> [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--output .tmp/context-enrichment-contract.json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const briefPath = path.resolve(root, args.brief || 'brief.md');
    const experiencePath = path.resolve(root, args.experienceContract || '.tmp/experience-contract.json');
    const outputPath = path.resolve(root, args.output || '.tmp/context-enrichment-contract.json');
    const contract = resolveContextEnrichment(fs.readFileSync(briefPath, 'utf8'), JSON.parse(fs.readFileSync(experiencePath, 'utf8')));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
    process.stdout.write(`Context enrichment written: ${outputPath} (${contract.contextMode})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-context-enrichment: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { contextEnrichmentRevision, resolveContextEnrichment, stableStringify };