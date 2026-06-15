#!/usr/bin/env node

// Shared component-type tally helper — used by:
//   - commit-to-git Phase 5 auto-generated commit-message body (C-7)
//   - run-prevalidators.js' componentsByType section in the dry-run HTML report
//
// Single tally function, dual consumers: keeps "what would be committed" and
// "what was just committed" identical in phrasing.
//
// Usage as a library:
//   const { tallyByType, formatTallyMarkdown } = require('./component-type-tally');
//   const tally = tallyByType(items);
//   const md = formatTallyMarkdown(tally);
//
// Usage as a CLI:
//   node component-type-tally.js --items-file <path>
//       [--format json|markdown|text]    (default: json)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Static map of common componenttype integers → human label.
// Keep small and conservative: when an entry is missing we fall back to
// `Type N` rather than guessing. Source: Dataverse SDK + maker-portal labels.
const COMPONENT_TYPE_LABELS = Object.freeze({
  1:   'Entity',
  2:   'Attribute',
  9:   'OptionSet',
  10:  'EntityRelationship',
  20:  'Role',
  26:  'SystemForm',
  29:  'WorkflowDefinition',
  60:  'SystemForm',
  61:  'WebResource',
  62:  'SiteMap',
  68:  'AppModule',
  91:  'PluginAssembly',
  92:  'SdkMessageProcessingStep',
  151: 'EntityKey',
  201: 'Solution',
});

function labelForType(t) {
  if (t == null) return 'Unknown';
  return COMPONENT_TYPE_LABELS[t] || `Type ${t}`;
}

/**
 * Group items[] by componenttype, with a breakdown by changeType per group.
 * Input items mirror list-pending-changes.js output shape.
 *
 * @param {Array<{componenttype?: number, componentType?: number, changetype?: number, changeType?: number, action?: number}>} items
 * @returns {Array<{ componentType: number, label: string, total: number, byChangeType: {create:number, update:number, delete:number, other:number} }>}
 *   Sorted descending by total, then ascending by label for stability.
 */
function tallyByType(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('tallyByType: items must be an array');
  }
  const buckets = new Map();
  for (const it of items) {
    const t = it.componenttype ?? it.componentType ?? null;
    const ct = it.changetype ?? it.changeType ?? null;
    const key = t == null ? -1 : t;
    let b = buckets.get(key);
    if (!b) {
      b = { componentType: t, label: labelForType(t), total: 0,
            byChangeType: { create: 0, update: 0, delete: 0, other: 0 } };
      buckets.set(key, b);
    }
    b.total++;
    // changetype 1 = Create, 2 = Update, 3 = Delete in Dataverse Source Control schema.
    if (ct === 1) b.byChangeType.create++;
    else if (ct === 2) b.byChangeType.update++;
    else if (ct === 3) b.byChangeType.delete++;
    else b.byChangeType.other++;
  }
  return [...buckets.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Render a Markdown body for the commit message — short, scannable, line-broken.
 *   - 1 line per type
 *   - max 6 lines, then "+ N more"
 *   - each line: "- 4 Entity (3 create, 1 update)"
 *
 * @param {ReturnType<typeof tallyByType>} tally
 * @param {{ maxLines?: number }} [opts]
 * @returns {string} — multi-line markdown, no trailing newline
 */
function formatTallyMarkdown(tally, opts = {}) {
  const maxLines = opts.maxLines ?? 6;
  if (!Array.isArray(tally) || tally.length === 0) return '_(no components)_';
  const lines = [];
  for (let i = 0; i < Math.min(tally.length, maxLines); i++) {
    const t = tally[i];
    const parts = [];
    if (t.byChangeType.create) parts.push(`${t.byChangeType.create} create`);
    if (t.byChangeType.update) parts.push(`${t.byChangeType.update} update`);
    if (t.byChangeType.delete) parts.push(`${t.byChangeType.delete} delete`);
    if (t.byChangeType.other)  parts.push(`${t.byChangeType.other} other`);
    // O2: when every item is "other" (no create/update/delete distinction),
    // the "(N other)" suffix just repeats the total — "143 Site Component" reads
    // better than "143 Site Component (143 other)". Only show a breakdown when
    // there is a real mix of change types.
    const onlyOther = t.byChangeType.other === t.total &&
      !t.byChangeType.create && !t.byChangeType.update && !t.byChangeType.delete;
    const breakdown = (parts.length && !onlyOther) ? ` (${parts.join(', ')})` : '';
    lines.push(`- ${t.total} ${t.label}${breakdown}`);
  }
  if (tally.length > maxLines) {
    const remaining = tally.length - maxLines;
    const remainingTotal = tally.slice(maxLines).reduce((s, t) => s + t.total, 0);
    lines.push(`- + ${remaining} more component type(s) (${remainingTotal} components)`);
  }
  return lines.join('\n');
}

/**
 * Render a one-line text summary suitable for terminal output or HTML report
 * headlines. E.g. "16 components — 4 Entity, 3 WebResource, 2 SiteMap, +2 more".
 *
 * @param {ReturnType<typeof tallyByType>} tally
 * @param {{ maxInline?: number }} [opts]
 * @returns {string}
 */
function formatTallyText(tally, opts = {}) {
  const maxInline = opts.maxInline ?? 3;
  if (!Array.isArray(tally) || tally.length === 0) return '0 components';
  const total = tally.reduce((s, t) => s + t.total, 0);
  const inline = tally.slice(0, maxInline).map(t => `${t.total} ${t.label}`).join(', ');
  const moreCount = Math.max(0, tally.length - maxInline);
  const suffix = moreCount > 0 ? `, +${moreCount} more` : '';
  return `${total} components — ${inline}${suffix}`;
}

// --- CLI ---
function parseArgs(argv) {
  const out = { format: 'json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--items-file' && argv[i + 1]) out.itemsFile = argv[++i];
    else if (argv[i] === '--format' && argv[i + 1]) out.format = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.itemsFile) {
    process.stderr.write('component-type-tally: --items-file <path> is required\n');
    process.exit(1);
  }
  if (!['json', 'markdown', 'text'].includes(args.format)) {
    process.stderr.write(`component-type-tally: --format must be json|markdown|text (got: ${args.format})\n`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(path.resolve(args.itemsFile), 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    const tally = tallyByType(items);
    if (args.format === 'markdown') process.stdout.write(formatTallyMarkdown(tally) + '\n');
    else if (args.format === 'text') process.stdout.write(formatTallyText(tally) + '\n');
    else process.stdout.write(JSON.stringify(tally, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('component-type-tally: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  tallyByType,
  formatTallyMarkdown,
  formatTallyText,
  labelForType,
  COMPONENT_TYPE_LABELS,
};
