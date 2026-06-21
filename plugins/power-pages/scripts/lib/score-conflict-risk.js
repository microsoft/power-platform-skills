#!/usr/bin/env node

// Conflict risk scoring & smart gates (Wave 4 #4).
//
// NOT an AI/auto-merge — this is SECURITY gating. It scores how dangerous it would
// be to mis-resolve a given conflict, and recommends a gate:
//
//   recommendedGate:
//     'binary-only' — never inline-merge (auth/secret/credential components); the
//                     maker must pick keep-current / accept-incoming wholesale.
//     'elevated'    — allow selective merge but behind a harder, explicit gate
//                     (server logic, plug-ins, web roles, table permissions).
//     'standard'    — normal selective-merge gate (ordinary web template/snippet/page).
//
// Inputs come from the conflict row + (optionally) the component name/path/field.
// Pure + deterministic + unit-tested. Callers use `recommendedGate` to decide
// whether to even offer selective merge, and to choose the consent copy.

'use strict';

const { CREDENTIAL_REGEX, AUTH_PREFIX_REGEX } = require('./classify-site-settings');

// Path/name signals for higher-risk component classes (beyond the credential regex).
const ELEVATED_PATH_REGEX = /(web-roles|table-permissions|website-access|entity-permissions|column-permissions|site-settings|plugin|workflow|sdkmessage|web-files)/i;
const SERVER_LOGIC_REGEX = /(server-?logic|plugin|workflow|sdkmessageprocessingstep|custom-?api)/i;

const LEVELS = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

/**
 * Score one conflict's risk.
 * @param {object} conflict { componentType, componentName, componentPath, field, value? }
 * @returns {{ level:'low'|'medium'|'high'|'critical', score:number, recommendedGate:'standard'|'elevated'|'binary-only', reasons:string[] }}
 */
function scoreConflictRisk(conflict = {}) {
  const name = String(conflict.componentName || '');
  const path = String(conflict.componentPath || '');
  const field = String(conflict.field || '');
  const value = typeof conflict.value === 'string' ? conflict.value : '';
  const hay = `${name} ${path} ${field} ${value}`;
  const reasons = [];
  let level = 'low';

  const bump = (to, reason) => { if (LEVELS[to] > LEVELS[level]) level = to; reasons.push(reason); };

  // CRITICAL — credentials / auth secrets. Never inline-merge.
  if (CREDENTIAL_REGEX.test(hay) || AUTH_PREFIX_REGEX.test(name) || AUTH_PREFIX_REGEX.test(path)) {
    bump('critical', 'Auth/credential/secret component — must be resolved binary (keep or accept), never inline-merged.');
  }
  // HIGH — server logic / plug-ins / permission models. Selective merge allowed but hard-gated.
  if (SERVER_LOGIC_REGEX.test(hay)) bump('high', 'Server logic / plug-in / workflow — a bad merge can change behavior or security.');
  if (/web-roles|table-permissions|entity-permissions|column-permissions|website-access/i.test(path)) {
    bump('high', 'Access-control component (roles/permissions) — a bad merge can widen access.');
  }
  // MEDIUM — settings or other elevated paths that aren't outright critical.
  if (level === 'low' && ELEVATED_PATH_REGEX.test(path)) bump('medium', 'Configuration/settings component — review carefully.');

  const recommendedGate = level === 'critical' ? 'binary-only' : (level === 'high' ? 'elevated' : 'standard');
  return { level, score: LEVELS[level], recommendedGate, reasons };
}

/**
 * Score a list of conflicts and summarize.
 * @returns {{ items: object[], highestLevel, counts, anyBinaryOnly, anyElevated }}
 */
function scoreConflicts(conflicts = []) {
  const items = (conflicts || []).map((c) => ({ ...c, risk: scoreConflictRisk(c) }));
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  let highest = 'low';
  for (const it of items) {
    counts[it.risk.level]++;
    if (LEVELS[it.risk.level] > LEVELS[highest]) highest = it.risk.level;
  }
  return {
    items,
    highestLevel: highest,
    counts,
    anyBinaryOnly: items.some((i) => i.risk.recommendedGate === 'binary-only'),
    anyElevated: items.some((i) => i.risk.recommendedGate === 'elevated'),
  };
}

if (require.main === module) {
  const fs = require('fs');
  const idx = process.argv.indexOf('--conflictsFile');
  const conflicts = idx >= 0 ? JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8')) : [];
  process.stdout.write(JSON.stringify(scoreConflicts(conflicts), null, 2) + '\n');
}

module.exports = { scoreConflictRisk, scoreConflicts, LEVELS };
