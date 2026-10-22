'use strict';

// eval 3's "Edit Phase 5: Existing functionality is preserved per the edit plan's Preservation Constraints",
// graded from what the run kept: the page it downloaded before the edit (a `before/*.tsx` artifact of a
// contract-2 fixture) and the page it uploaded (the fixture's top-level .tsx of the same name).
//
// agents/genpage-edit-planner.md asks for constraints that are "independently verifiable", and the plan
// quotes the code it means in backticks, e.g.
//   ## Preservation Constraints
//   - The window cache and in-flight de-dupe keys (`__ppContactsDirectory_contactCache` /
//     `__ppContactsDirectory_contactInflight`), the `[dataReady]` dependency and the single batched
//     `setData` stay exactly as they are.
// So the identifiers in those code spans that the DOWNLOADED page uses are the functionality the plan
// promised to keep, and each must still be used by the EDITED page. A span that names nothing the old
// page has (`--connectors`, a column it never selected) promises nothing about it and is not read.
// Comments are left out of both pages, so a comment cannot keep a deleted cache key "present".
//
// It does not judge behaviour — that a kept query still returns the same rows — which the Layer 3 rubric
// does; and constraints written only in prose, with no code span, are skipped for a person to judge.

const { commentRanges } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');
const { planSection } = require('./plan-evidence.js');
const { fileName } = require('./evidence-utils.js');
const { currentContract } = require('./workflow-evidence.js');

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function withoutComments(source) {
  const text = String(source || '').split('');
  for (const { start, end } of commentRanges(source)) for (let i = start; i < end; i += 1) if (text[i] !== '\n') text[i] = ' ';
  return text.join('');
}

const uses = (text, name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);

// The identifiers the constraints quote in code spans, three characters or longer (a one-letter loop
// variable or `id` says nothing about which feature is meant).
function quotedIdentifiers(section) {
  const names = new Set();
  for (const span of String(section).matchAll(/`([^`\n]+)`/g)) {
    for (const name of span[1].match(IDENTIFIER) || []) if (name.length >= 3) names.add(name);
  }
  return [...names];
}

// Returns { skip } when there is nothing the constraints can be graded against, else a list of problems.
function preservationProblems(fixture) {
  if (!fixture.genpageEditPlan) return ['no genpage-edit-plan.md'];
  const section = planSection(fixture.genpageEditPlan, 'Preservation Constraints');
  if (section === null || !section.trim()) return ['genpage-edit-plan.md has no ## Preservation Constraints'];
  const before = Object.entries(fixture.artifacts || {}).filter(([name]) => /^before\/[^/]+\.tsx$/.test(name));
  if (!before.length) {
    return currentContract(fixture) ? ['the downloaded page (a before/<page>.tsx artifact) was not captured'] : { skip: 'the downloaded page was not captured' };
  }
  const names = quotedIdentifiers(section);
  const problems = [];
  let graded = 0;
  for (const [name, source] of before) {
    const edited = (fixture.files || []).find((file) => file.name === fileName(name));
    if (!edited) { problems.push(`the edited ${fileName(name)} was not captured beside before/${fileName(name)}`); continue; }
    const old = withoutComments(source);
    const now = withoutComments(edited.content);
    for (const identifier of names.filter((id) => uses(old, id))) {
      graded += 1;
      if (!uses(now, identifier)) problems.push(`${edited.name} no longer uses \`${identifier}\`, which the Preservation Constraints keep`);
    }
  }
  if (!problems.length && graded === 0) return { skip: 'the Preservation Constraints quote no code the downloaded page uses, so a person judges them' };
  return problems;
}

module.exports = { preservationProblems, quotedIdentifiers };
