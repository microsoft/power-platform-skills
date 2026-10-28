'use strict';
// The canonical lookup normalizer of references/rules.md "Lookup references" (Critical Rule 23), read once, and the check that a
// page's copy of it is that one: declared once at the top level, line for line (comments, indentation and blank lines aside), with
// its two patterns. tests/polymorphic-lookup-contract.test.js checks copies against it and runs the published block itself on
// fixture 26's synthetic customer values (lookup-rows.json).
//
// What a page then DOES with a lookup — reads, filters, retrieves, navigation and writes through the normalized pair — is not
// graded. The closed grammar that graded it was withdrawn: its proofs that a reference's table was checked (a guard before the
// use) and that the normalized pair stayed unchanged could each be satisfied by a page that opens a contact as an account, and a
// check that can certify such a page is worse than none. evals/model-apps/genpage/EVAL_GUIDE.md says so.

const fs = require('node:fs');
const path = require('node:path');
const { blankNonCodePreservingTemplateExpressions } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');
const { canonicalLines, topLevelFunction } = require('./page-error-canonical.js');

const RULES_PATH = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'references', 'rules.md');
const HEADING = '### Lookup references (Customer, Owner, Regarding and every other lookup)';
const NORMALIZER = 'normalizeLookupReference';
const PATTERNS = ['LOOKUP_GUID', 'LOOKUP_QUALIFIED'];

let canonical = null;
// The canonical normalizer from rules.md: { fn, patterns: Map(name → statement) }, each as its canonical lines.
function canonicalNormalizer() {
  if (canonical) return canonical;
  const rules = fs.readFileSync(RULES_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = rules.indexOf(`\n${HEADING}\n`);
  if (start < 0) throw new Error('references/rules.md has no "Lookup references" section');
  const rest = rules.slice(start + HEADING.length + 2);
  const next = rest.search(/\n#{2,3} /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const block = [...section.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((text) => text.includes(`function ${NORMALIZER}(`));
  if (!block) throw new Error('references/rules.md does not publish the canonical lookup normalizer');
  const mask = blankNonCodePreservingTemplateExpressions(block);
  const range = topLevelFunction(block, mask, NORMALIZER);
  const patterns = new Map();
  for (const name of PATTERNS) {
    const declared = new RegExp(`^const ${name} = .*;$`, 'm').exec(block);
    if (!declared) throw new Error(`references/rules.md's normalizer block has no ${name}`);
    patterns.set(name, declared[0].trim());
  }
  canonical = { fn: canonicalLines(block.slice(range.start, range.end)).join('\n'), patterns };
  return canonical;
}

// How many brackets are open at `at` (0 at the module's top level).
function depthAt(mask, at) {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if ('({['.includes(mask[i])) depth += 1;
    else if (')}]'.includes(mask[i])) depth -= 1;
  }
  return depth;
}

// The page's normalizer is the canonical one, declared once at the top level with its two patterns.
function normalizerProblems(code) {
  const { fn, patterns } = canonicalNormalizer();
  const mask = blankNonCodePreservingTemplateExpressions(code);
  const problems = [];
  const declarations = [...mask.matchAll(new RegExp(`\\bfunction\\s+${NORMALIZER}\\s*\\(`, 'g'))];
  const other = new RegExp(`\\b(?:const|let|var)\\s+${NORMALIZER}\\b`).test(mask);
  if (declarations.length !== 1 || other) return [`the page must declare ${NORMALIZER} once, as the top-level function references/rules.md publishes`];
  const range = topLevelFunction(code, mask, NORMALIZER);
  if (!range) return [`${NORMALIZER} must be a top-level function`];
  if (canonicalLines(code.slice(range.start, range.end)).join('\n') !== fn) problems.push(`${NORMALIZER} is not the canonical normalizer — copy it unchanged from references/rules.md "Lookup references"`);
  for (const [name, statement] of patterns) {
    const found = [...mask.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g'))];
    const line = found.length === 1 && depthAt(mask, found[0].index) === 0
      ? code.slice(found[0].index, code.indexOf('\n', found[0].index) < 0 ? code.length : code.indexOf('\n', found[0].index)).trim() : null;
    if (line !== statement) problems.push(`${name} is not the canonical pattern — copy it unchanged from references/rules.md "Lookup references"`);
  }
  return problems;
}

module.exports = { normalizerProblems, canonicalNormalizer };
