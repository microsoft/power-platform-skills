'use strict';

const { extractNavTargets, resolvePageRefs, navTargetParity } = require('../../../../plugins/model-apps/scripts/lib/pageref-resolver.js');
const { workflowCalls, isUpload, resultObject } = require('./workflow-evidence.js');
const { artifactText, commandInfo, fileName, isGuid, pathKey } = require('./evidence-utils.js');

function historicalPageMap(log) {
  const map = {};
  // A resolved capture records `PAGEREF_ map: candidate-list -> <guid>, ...`.
  // Read that deployment evidence, not GUIDs in the TSX being judged.
  const line = /^\s*-\s*PAGEREF_ map:\s*(.+)$/m.exec(log || '');
  if (line) {
    for (const match of line[1].matchAll(/([A-Za-z0-9_-]+)\s*(?:\u2192|->)\s*([0-9a-f-]{36})/gi)) map[match[1]] = match[2];
  }
  return map;
}

// This one capture predates `pageType:"generative"` and double-quoted PAGEREFs. The compatibility
// view admits those historical spellings ONLY; it still checks every actual target against sibling
// files. It is never used to claim current-contract compliance.
function navTargets(content, { legacy = false } = {}) {
  const code = legacy ? content.replace(/\bpageType\s*:\s*(["'])custom\1/g, 'pageType: "generative"') : content;
  return extractNavTargets(code);
}

function sourceProblems(files, { phase = 'authored', pageMap = {}, legacy = false } = {}) {
  const keys = new Set(files.map((file) => file.name.replace(/\.tsx$/i, '')));
  const ids = new Set(Object.values(pageMap).filter(isGuid).map((id) => id.toLowerCase()));
  const problems = [];
  for (const file of files) {
    for (const target of navTargets(file.content, { legacy })) {
      if (target.kind === 'dynamic') problems.push(`${file.name}: effective navigation target is dynamic or overridden`);
      else if (target.kind === 'pageref' || (legacy && target.kind === 'pageref-malformed')) {
        if (phase === 'resolved') problems.push(`${file.name}: PAGEREF_${target.key} remains after resolution`);
        if (!keys.has(target.key)) problems.push(`${file.name}: unknown sibling target PAGEREF_${target.key}`);
      } else if (target.kind === 'pageref-malformed') {
        problems.push(`${file.name}: navigation placeholder is not a canonical double-quoted PAGEREF`);
      } else if (target.kind === 'literal') {
        if (phase !== 'resolved') problems.push(`${file.name}: literal page id appears before resolution`);
        if (!isGuid(target.pageId) || !ids.has(target.pageId.toLowerCase())) {
          problems.push(`${file.name}: resolved target is not a deployed GUID from the page map`);
        }
      }
    }
  }
  return problems;
}

function navigationProblems(fixture) {
  const contract = fixture.manifest?.navigation;
  if (!contract) {
    const phase = fixture.manifest?.navigationPhase || 'authored';
    const pageMap = fixture.manifest?.pageMap || historicalPageMap(fixture.workflowLog);
    return sourceProblems(fixture.files || [], { phase, pageMap, legacy: phase === 'legacy-authored' });
  }
  const problems = [];
  const pageMap = contract.pageMap || {};
  const rows = contract.sources || [];
  const keys = rows.map((row) => row.key);
  const files = fixture.files || [];
  if (!rows.length || new Set(keys).size !== keys.length) problems.push('navigation sources are missing or have duplicate keys');
  if (Object.keys(pageMap).sort().join('|') !== [...keys].sort().join('|')) problems.push('navigation page map does not contain exactly the generated pages');
  for (const [key, id] of Object.entries(pageMap)) if (!isGuid(id)) problems.push(`${key}: deployed page id is not a GUID`);
  if (files.length !== rows.length || rows.some((row) => !files.some((file) => file.name === row.file))) {
    problems.push('navigation evidence must cover every actual before/after TSX file');
  }
  const before = rows.map((row) => ({ name: row.file, content: artifactText(fixture, row.before) }));
  problems.push(...sourceProblems(before, { pageMap, phase: 'authored' }));
  for (const row of rows) {
    const declared = contract.expectedTargets?.[row.key];
    if (!Array.isArray(declared)) { problems.push(`${row.key}: missing declared target set`); continue; }
    const targets = extractNavTargets(artifactText(fixture, row.before)).filter((target) => target.kind === 'pageref').map((target) => target.key);
    const parity = navTargetParity(declared, targets);
    if (parity.declaredNotReferenced.length || parity.referencedNotDeclared.length) problems.push(`${row.key}: effective target set differs from the declared navigation`);
  }
  const sources = new Map(rows.map((row) => [row.key, { code: artifactText(fixture, row.before) }]));
  const resolved = resolvePageRefs(sources, new Map(Object.entries(pageMap)));
  if (resolved.unresolved.length) problems.push(`unresolved navigation targets: ${resolved.unresolved.join(', ')}`);
  const changed = [];
  for (const row of rows) {
    const expected = resolved.deployment.get(row.key);
    if (artifactText(fixture, row.file) !== expected) problems.push(`${row.file}: after TSX is not the exact structural substitution (non-navigation bytes changed or a target was missed)`);
    if (sources.get(row.key).code !== expected) changed.push(row.key);
  }
  problems.push(...sourceProblems(files, { pageMap, phase: 'resolved' }));
  const updates = [];
  const creates = [];
  for (const call of workflowCalls(fixture).filter((entry) => isUpload(entry.command))) {
    const { flags, problems: flagProblems } = commandInfo(call);
    problems.push(...flagProblems);
    const row = rows.find((entry) => entry.file === fileName(flags['code-file']));
    if (!row) { problems.push('navigation upload names a page outside the source map'); continue; }
    const result = resultObject(call);
    if (result?.ok !== true || result.pageId?.toLowerCase() !== pageMap[row.key]?.toLowerCase()) problems.push(`${row.key}: upload result does not match its deployed page-map id`);
    if (flags['page-id']) {
      updates.push(row.key);
      if (new Set(creates).size !== keys.length) problems.push('navigation fix-up ran before all sibling page ids were returned');
      if (pathKey(flags['code-file']) !== pathKey(row.file)) problems.push(`${row.key}: re-upload must use the actual resolved TSX snapshot`);
      if (flags['page-id'] !== pageMap[row.key] || flags['add-to-sitemap']) problems.push(`${row.key}: fix-up must update its own id without sitemap placement`);
      const prompt = flags['prompt-file'] ? artifactText(fixture, flags['prompt-file']) : '';
      if (!/^Resolve cross-page navigation placeholders to real page GUIDs\b/.test(prompt)) problems.push(`${row.key}: navigation re-upload prompt is not the fix-up delta`);
    } else {
      creates.push(row.key);
      if (pathKey(flags['code-file']) !== pathKey(row.before)) problems.push(`${row.key}: first upload must use the actual authored before-resolution TSX snapshot`);
      if (!flags['add-to-sitemap']) problems.push(`${row.key}: first upload does not place the page`);
    }
  }
  if (creates.sort().join('|') !== [...keys].sort().join('|')) problems.push('navigation map is not backed by exactly one successful create per page');
  if (updates.sort().join('|') !== changed.sort().join('|')) problems.push('only affected navigation pages must reupload, exactly once');
  return problems;
}

module.exports = { navigationProblems, sourceProblems, navTargets };
