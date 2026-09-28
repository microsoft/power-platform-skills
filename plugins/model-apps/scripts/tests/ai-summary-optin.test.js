'use strict';
// `ai.summaries.default: "off"` silently discarded an explicit per-table `enabled: true`.
//
// `selectSummaryTables` (lib/ai-candidates.js) already implements the documented semantics — its own
// comment reads "When default is 'off', only explicit opt-ins (handled above) are included", and the
// `override.enabled === true` branch runs BEFORE the `defaultOff` bail. But both call sites in
// sdk-build.js short-circuited ahead of it:
//
//     const tables = (spec.ai.summaries && spec.ai.summaries.default === 'off') ? [] : selectSummaryTables(spec);
//
// so the opt-in branch was unreachable from a real build. The schema documents `default` as "the
// app-level default for all tables" and `tables` as "per-table OVERRIDES" — an override that cannot
// override is the same silent-intent-loss class this plugin exists to prevent.
//
// Found by live-running the ai-features phase: the build reported success with `summaries: {}` while
// the spec explicitly asked for one.
const test = require('node:test');
const assert = require('node:assert');

const { selectSummaryTables } = require('../lib/ai-candidates.js');
const { planFor } = require('../lib/sdk-build.js');

const specWith = (summaries) => ({
  solution: { uniqueName: 'ZZAi', publisherPrefix: 'zza' },
  app: { name: 'ZZ AI' },
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'R', subAreas: [{ entity: 'zza_ticket', title: 'Tickets' }] }] }] },
  entities: [
    {
      schemaName: 'zza_ticket',
      displayName: 'Ticket',
      pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'zza_name', displayName: 'Name' },
      columns: [{ schemaName: 'zza_details', displayName: 'Details', type: 'Memo' }],
    },
    {
      schemaName: 'zza_lookupish',
      displayName: 'Lookupish',
      pluralName: 'Lookupishes',
      primaryAttribute: { schemaName: 'zza_code', displayName: 'Code' },
      // No columns at all — `hasDescriptive` is computed over `columns` only, and DESCRIPTIVE_TYPES
      // covers Integer/Money/DateTime too, so a numeric column would still qualify.
      columns: [],
    },
  ],
  ai: { summaries },
});

const OPT_IN = { default: 'off', tables: { zza_ticket: { enabled: true, instruction: 'Summarise it.' } } };

test('selectSummaryTables honours an explicit opt-in even when default is off (helper contract)', () => {
  assert.deepStrictEqual(selectSummaryTables(specWith(OPT_IN)), ['zza_ticket']);
});

test('default:off with NO opt-in still selects nothing', () => {
  assert.deepStrictEqual(selectSummaryTables(specWith({ default: 'off' })), []);
});

test('the BUILD PLAN includes the row summary for an explicit opt-in under default:off', () => {
  const labels = planFor(specWith(OPT_IN), {}).map((i) => i.label);
  assert.ok(
    labels.some((l) => /row summary for zza_ticket/.test(l)),
    `plan must include the opted-in table; got: ${JSON.stringify(labels)}`,
  );
});

test('the BUILD PLAN still includes NO row summary under default:off with no opt-in', () => {
  const labels = planFor(specWith({ default: 'off' }), {}).map((i) => i.label);
  assert.ok(!labels.some((l) => /row summary/.test(l)), `got: ${JSON.stringify(labels)}`);
});

test('an explicit enabled:false still opts a table OUT under default:auto', () => {
  const spec = specWith({ default: 'auto', tables: { zza_ticket: { enabled: false } } });
  assert.ok(!selectSummaryTables(spec).includes('zza_ticket'));
});

test('default:auto still auto-selects a descriptive table and skips a non-descriptive one', () => {
  const picked = selectSummaryTables(specWith({ default: 'auto' }));
  assert.ok(picked.includes('zza_ticket'), 'Memo column makes it a candidate');
  assert.ok(!picked.includes('zza_lookupish'), 'no descriptive column — not a candidate');
});
