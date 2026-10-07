// Maps each natural-language workflow assertion in evals.json to a check
// function. Each check receives { fixture, eval } and returns { status, reason }.
//
//   fixture: { id, dir, files, workflowLog, genpagePlan, genpageEditPlan,
//              entityCreationLog }
//   eval:    the eval entry from evals.json
//
// status: "pass" | "fail" | "skip"
//
// The runner applies every entry in `common_workflow_assertions` first, then
// each per-eval `expectations` entry whose text starts with "Phase " or
// "Edit Phase " or "Prefix discipline ".

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pageFileProblems } = require('../../../../plugins/model-apps/scripts/lib/page-file-targets.js');
const { currentContract, workflowCalls, isAuth, isDiscovery, authGateProblems, discoveryProblems, refusalProblems, resultObject, isGeneration, isUpload } = require('./workflow-evidence.js');
const { gradeEvidence, isGuid, fileName, artifactText, commandInfo } = require('./evidence-utils.js');
const { navigationProblems, navTargets } = require('./navigation-contract.js');
const { workerProblems } = require('./worker-contract.js');
const { uploadProblems, uploadPreservationProblems } = require('./upload-contract.js');
const { planSection, findMarkdownTable, parseMarkdownRows } = require('./plan-evidence.js');
const { customApiProblems, customApiGateProblems } = require('./custom-api-contract.js');
const { packagingProblems, isPackaging } = require('./packaging-contract.js');
const evidence = require('./expectation-evidence.js');
const { blankLiterals } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');
const { planTargets } = require('../../../../plugins/model-apps/scripts/genpage-plan-provenance.js');

function fail(reason) { return { status: 'fail', reason }; }
function pass() { return { status: 'pass', reason: '' }; }

// The two upload transports, recognised in ONE place.
//
// New runs deploy through `scripts/genpage-upload.js`, which hands the prompt to pac BY FILE so a
// shell cannot reinterpret quotes/newlines (#589). The fixtures checked in here are captured
// transcripts from before that change and show the raw `pac model genpage upload` form; rewriting a
// captured transcript to match today's skill would be falsifying the evidence it exists to be.
//
// Defined once because the two DID drift: the common assertion was updated and the per-eval Phase
// expectations were not, so a correct new-transport run failed the evals while a raw
// `pac … --prompt "…"` run passed — the evals were grading the quoting-unsafe transport as correct.
const UPLOAD_CMD = /pac\s+model\s+genpage\s+upload|genpage-upload\.js/;
const uploadLinesOf = (log) => String(log || '').split('\n').filter((l) => UPLOAD_CMD.test(l));

// What the log records about an upload's PROMPT, whichever transport carried it: the inline quoted
// value, or — for the file transport, where there is no inline value to read — the `Prompt scope:`
// line the skill requires alongside the command.
function promptEvidence(log, uploadLine) {
  const inline = /--prompt\s+"([^"]*)"/.exec(uploadLine || '');
  if (inline) return inline[1];
  const scope = /^\s*[-*]?\s*Prompt scope:\s*(.+)$/im.exec(String(log || ''));
  return scope ? scope[1].trim() : null;
}
function skip(reason) { return { status: 'skip', reason }; }

// An EDIT-flow fixture produces `genpage-edit-plan.md` and never `genpage-plan.md`: the create
// flow's planning phases (solution question, EnterPlanMode approval, plan-schema conformance,
// entity prefix discipline) do not run at all on that path.
//
// Those assertions must SKIP rather than fail for such a fixture. Until eval 19 the suite had no
// edit fixture — eval 3 is edit-flow but ships none — so the create-flow assumption baked into the
// COMMON assertions was never exercised, and the first edit fixture added reported six false
// failures that say nothing about the page under test.
function isEditFlowFixture(fixture) {
  return Boolean(fixture && fixture.genpageEditPlan && !fixture.genpagePlan);
}

function beforePlanningRefusal(fixture) {
  return fixture.manifest?.expectedOutcome === 'refused' && fixture.manifest.refusal?.stage === 'discovery';
}

function checkProblems(problems) {
  return problems.length ? fail(problems[0]) : pass();
}

function logHas(log, pattern) {
  return Boolean(log) && new RegExp(pattern, 'mi').test(log);
}

function isUnattendedLog(log) {
  return Boolean(log) && (
    /Unattended default:/i.test(log) ||
    // The mode probe, in prose (`interactive: false`) or as the raw resolve-interaction-mode.js
    // line (`{"ok":true,"interactive":false,...}`) — hence the optional quotes.
    // The lookbehind is load-bearing: without it `non-interactive: false`, which describes an
    // ATTENDED run, matches on the tail of the word and flips the log to the unattended branch.
    /(?<![\w-])"?interactive"?\s*[:=]\s*"?false"?/i.test(log) ||
    // The two `reason` strings resolveInteractionMode() emits, and only ever for interactive:false.
    // Anchored to the `reason` field rather than matched as bare phrases: an ATTENDED log
    // legitimately *negates* them ("attended (no --non-interactive flag, TTY present)",
    // "POWER_PLATFORM_SKILLS_NONINTERACTIVE is set -> no"), and an unanchored match would
    // grade that correct attended run down the unattended branch and fail it for lacking an
    // `Unattended default:` marker. Shape emitted by scripts/resolve-interaction-mode.js:
    //   {"ok":true,"interactive":false,"reason":"--non-interactive flag"}
    /"?reason"?\s*[:=]\s*"?(?:--non-interactive flag|POWER_PLATFORM_SKILLS_NONINTERACTIVE\s+is set)/i.test(log)
    // Deliberately NO free-prose alternative here (e.g. matching "Interaction mode: unattended").
    // Prose is unbounded and every attempt to pattern-match it closed one negation position while
    // opening another: a bare `\bunattended\b` matches inside "not unattended"; anchoring on
    // `mode: unattended` fixes that but then admits "Mode: unattended = false",
    // "Interaction mode: unattended? no", and "the Unattended column" — all ATTENDED logs, each
    // graded unattended and failed for lacking a marker, which is the exact false failure this
    // function was fixed to stop causing.
    // Instead the contract is pinned in the doc: genpage SKILL.md's unattended table requires the
    // mode to be recorded as `Unattended default: interaction mode → unattended (<reason>)`, which
    // the first alternative already matches. Matching the documented marker is decidable; matching
    // English is not. Re-adding a prose alternative re-opens the negation problem.
  );
}

function entitiesNeedCreating(plan) {
  const section = planSection(plan, 'Entity Creation Required');
  if (!section) return false;
  return !/No entity creation required/i.test(section);
}

function newAppNeeded(plan) {
  if (!plan) return false;
  // Accept canonical phrasing and the shorter "App: create new:" form the
  // planner spec uses in the ## Environment section.
  return /create new app|new app will be created|create-app|^[\s-]*App:\s*create new/im.test(plan);
}

// True if the workflow log records that the planner actually asked the solution
// selection question (not skipped). Distinguishes "solution selection question
// SKIPPED" (false) from "solution selection question asked" / AskUserQuestion
// referencing solution (true).
function solutionQuestionAsked(log) {
  if (!log) return false;
  if (/solution\s+selection[^\n]*SKIPPED|skipped\s+(the\s+)?solution\s+selection|solution\s+question\s+SKIPPED/i.test(log)) {
    return false;
  }
  return /AskUserQuestion[^\n]*solution/i.test(log) ||
         /solution\s+selection\s+question\s+asked|asked[^\n]*solution\s+selection/i.test(log);
}

// Iterate all regex matches without using RegExp.prototype.exec by name
function allMatches(pattern, text) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))];
}

const REQUIRED_PLAN_SECTIONS = [
  'User Requirements',
  'Working Directory',
  'Plugin Root',
  'Environment',
  'Pages',
  'Entity Creation Required',
  'Existing Entities',
  'Connector Bindings',
  'Custom API Bindings',
  'Design Preferences',
  'Relevant Samples',
  'Per-Page Specifications',
];

const OPTIONAL_PLAN_SECTIONS = new Set(['Solution Packaging']);

const REQUIRED_PER_PAGE_FIELDS = [
  'File',
  'Purpose',
  'Entities',
  'Needs caching',
  'Key Features',
  'Components',
  'Layout',
  'Data Binding',
  'Interactions',
];

function schemaError(code, message, details = {}) {
  return { code, message, ...details };
}

function parseHeadingLine(line) {
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function parsePlanSections(plan) {
  const lines = plan.split(/\r?\n/);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = parseHeadingLine(lines[i]);
    if (heading && heading.level === 2) {
      const start = i;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const nextHeading = parseHeadingLine(lines[j]);
        if (nextHeading && nextHeading.level === 2) {
          end = j;
          break;
        }
      }
      sections.push({
        title: heading.title,
        startLine: start + 1,
        content: lines.slice(start + 1, end).join('\n').trim(),
      });
    }
  }
  return sections;
}

function workingDirectoryOf(plan) {
  const section = planSection(plan, 'Working Directory');
  return section ? section.split(/\r?\n/)[0].trim() : '';
}

function validatePageFileTargets(pageRows, workingDir, errors) {
  // The rule is the plugin's own (page-file-targets.js), so this validator, /app-builder's plan
  // projection and /genpage's pre-dispatch gate cannot disagree about a page filename.
  const files = pageRows.map((row) => String(row.file || '').trim());
  const byFile = new Map(pageRows.map((row) => [String(row.file || '').trim(), row]));
  const problems = pageFileProblems(files, { workingDir: workingDir ? path.resolve(workingDir) : process.cwd() });
  for (const problem of problems) {
    const row = byFile.get(problem.file) || {};
    if (problem.code === 'collision') {
      errors.push(schemaError('duplicate-page-file', `page files ${problem.message}`, { section: 'Pages', page: row.page, file: problem.file }));
    } else {
      errors.push(schemaError('invalid-page-file', `page "${row.page}": ${problem.message}`, { section: 'Pages', page: row.page, file: problem.file }));
    }
  }
}

function parsePerPageBlocks(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const blocks = new Map();
  let current = null;
  for (const line of lines) {
    const heading = parseHeadingLine(line);
    if (heading && heading.level === 3) {
      current = { title: heading.title, lines: [] };
      blocks.set(heading.title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

function bulletFieldValues(lines, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Some fixture plans use the required field as a parent bullet whose details
  // are nested on following lines. The schema contract requires the field to be
  // present; it does not require single-line prose after the colon.
  const pattern = new RegExp(`^\\s*[-*]\\s+\\*\\*${escaped}:\\*\\*\\s*(.*?)\\s*$`, 'i');
  return lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [match[1]] : [];
  });
}

function hasBulletField(lines, field) {
  return bulletFieldValues(lines, field).length > 0;
}

function validateEnvironment(sectionText, errors) {
  for (const field of ['URL', 'App', 'Languages', 'Solution', 'Publisher Prefix']) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^\\s*[-*]?\\s*${escaped}:\\s*\\S`, 'mi').test(sectionText)) {
      errors.push(schemaError('missing-environment-field', `## Environment missing required field "${field}"`, { section: 'Environment', field }));
    }
  }
}

function validateEntityCreationSection(sectionText, errors) {
  if (/^No entity creation required — all entities already exist\.\s*$/i.test(sectionText.trim())) return;

  const entityBlocks = [...sectionText.matchAll(/^###\s+(.+?)\s*$/gmi)];
  if (entityBlocks.length === 0) {
    errors.push(schemaError('missing-entity-block', '## Entity Creation Required must contain entity subsections or the exact no-entity sentinel', { section: 'Entity Creation Required' }));
    return;
  }

  for (let index = 0; index < entityBlocks.length; index++) {
    const name = entityBlocks[index][1].trim();
    const start = entityBlocks[index].index + entityBlocks[index][0].length;
    const end = index + 1 < entityBlocks.length ? entityBlocks[index + 1].index : sectionText.length;
    const block = sectionText.slice(start, end);
    for (const field of ['Display Name', 'Display Plural', 'Primary Name Suffix']) {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`^\\s*[-*]\\s+${escaped}:\\s*\\S`, 'mi').test(block)) {
        errors.push(schemaError('missing-entity-field', `entity "${name}" missing required field "${field}"`, { section: 'Entity Creation Required', entity: name, field }));
      }
    }
    for (const [label, columns] of [
      ['Columns', ['Suffix', 'Type', 'Required', 'Notes']],
      ['Choice Columns', ['Column Suffix', 'Options']],
      ['Relationships', ['Type', 'Related Table', 'Lookup Suffix', 'Cascade']],
    ]) {
      if (!new RegExp(`^\\s*[-*]\\s+${label}:`, 'mi').test(block) || !findMarkdownTable(block, columns)) {
        errors.push(schemaError('missing-entity-table', `entity "${name}" missing required "${label}" table`, { section: 'Entity Creation Required', entity: name, table: label }));
      }
    }
  }
}

function validateGenpagePlanSchema(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'string') {
    return [schemaError('missing-plan', 'genpage-plan.md is empty or missing')];
  }

  if (!/^#\s+Genpage Plan\s*$/m.test(plan)) {
    errors.push(schemaError('missing-title', 'plan missing exact "# Genpage Plan" title'));
  }

  const sections = parsePlanSections(plan);
  const byTitle = new Map(sections.map((section) => [section.title, section]));
  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!byTitle.has(section)) {
      errors.push(schemaError('missing-section', `plan missing required section "## ${section}"`, { section }));
    }
  }

  // Section order is part of the machine contract. Validate using only known
  // headings so optional prose headings cannot create false positives.
  const observed = sections
    .map((section) => section.title)
    .filter((title) => REQUIRED_PLAN_SECTIONS.includes(title) || OPTIONAL_PLAN_SECTIONS.has(title));
  // Solution Packaging is optional and sits between Custom API Bindings and Design Preferences, as in
  // references/plan-schema.md. Split at that point by NAME: an index goes stale the moment a required
  // section is added before it — which is exactly how Custom API Bindings ended up expected after it.
  const packagingAt = REQUIRED_PLAN_SECTIONS.indexOf('Design Preferences');
  const expected = [
    ...REQUIRED_PLAN_SECTIONS.slice(0, packagingAt),
    ...(observed.includes('Solution Packaging') ? ['Solution Packaging'] : []),
    ...REQUIRED_PLAN_SECTIONS.slice(packagingAt),
  ];
  const comparable = observed.filter((title) => expected.includes(title));
  if (comparable.join('\n') !== expected.filter((title) => comparable.includes(title)).join('\n')) {
    errors.push(schemaError('section-order', 'required plan sections are not in references/plan-schema.md order'));
  }

  const envSection = byTitle.get('Environment');
  if (envSection) validateEnvironment(envSection.content, errors);

  const pagesSection = byTitle.get('Pages');
  const pageRows = pagesSection ? parseMarkdownRows(pagesSection.content, ['Page', 'File', 'Purpose', 'Entities']) : [];
  if (pagesSection && pageRows.length === 0) {
    errors.push(schemaError('missing-pages-table', '## Pages must contain a table with Page, File, Purpose, and Entities columns', { section: 'Pages' }));
  }
  if (pageRows.length) validatePageFileTargets(pageRows, workingDirectoryOf(plan), errors);

  const entitySection = byTitle.get('Entity Creation Required');
  if (entitySection) validateEntityCreationSection(entitySection.content, errors);

  const connectorSection = byTitle.get('Connector Bindings');
  if (connectorSection) {
    const body = connectorSection.content.trim();
    if (body !== 'No connector bindings.' && !findMarkdownTable(body, ['Logical Name', 'Connector Id', 'Dataset', 'Tables (GUIDs)', 'Table Display Names', 'Operations', 'Fields', 'Parameters', 'Response'])) {
      errors.push(schemaError('missing-connector-table', '## Connector Bindings must be the exact no-bindings sentinel or the full connector binding table', { section: 'Connector Bindings' }));
    }
  }

  const customApiSection = byTitle.get('Custom API Bindings');
  if (customApiSection) {
    const body = customApiSection.content.trim();
    const rows = parseMarkdownRows(body, ['Name', 'Kind', 'Bound Entity', 'Display Name', 'Parameters (name: kind)']);
    if (body !== 'No custom API bindings.' && rows.length === 0) {
      errors.push(schemaError('missing-customapi-table', '## Custom API Bindings must be the exact no-bindings sentinel or the Custom API binding table', { section: 'Custom API Bindings' }));
    } else {
      for (const row of rows) {
        const kind = row.kind || '';
        if (!row.name || !/^(Action|Function)$/i.test(kind) || !row['bound entity'] || !row['display name']) {
          errors.push(schemaError('missing-customapi-table', '## Custom API Bindings rows must include Name, Kind (Action or Function), Bound Entity, Display Name, and Parameters (name: kind)', { section: 'Custom API Bindings' }));
          break;
        }
      }
    }
  }

  const samplesSection = byTitle.get('Relevant Samples');
  if (samplesSection && !findMarkdownTable(samplesSection.content, ['Page', 'Sample', 'Reason'])) {
    errors.push(schemaError('missing-samples-table', '## Relevant Samples must contain a table with Page, Sample, and Reason columns', { section: 'Relevant Samples' }));
  }

  const perPageSection = byTitle.get('Per-Page Specifications');
  if (perPageSection) {
    const blocks = parsePerPageBlocks(perPageSection.content);
    for (const row of pageRows) {
      const pageName = row.page;
      const block = blocks.get(pageName);
      if (!block) {
        errors.push(schemaError('missing-page-spec', `## Per-Page Specifications missing page subsection "### ${pageName}"`, { section: 'Per-Page Specifications', page: pageName }));
        continue;
      }
      for (const field of REQUIRED_PER_PAGE_FIELDS) {
        if (!hasBulletField(block.lines, field)) {
          errors.push(schemaError('missing-per-page-field', `page "${pageName}" missing required per-page field "${field}"`, { section: 'Per-Page Specifications', page: pageName, field }));
        }
      }
      // Dispatch reads the Pages table, while the builder reads its per-page File. A disagreement
      // can overwrite a sibling or leave the declared target unwritten even though both names are safe.
      const files = bulletFieldValues(block.lines, 'File');
      if (files.length && (files.length !== 1 || files[0] !== row.file)) {
        errors.push(schemaError('page-file-mismatch', `page "${pageName}" must have exactly one File matching ## Pages: expected "${row.file}", got ${JSON.stringify(files)}`, {
          section: 'Per-Page Specifications', page: pageName, expectedFile: row.file, files,
        }));
      }
    }

    for (const pageName of blocks.keys()) {
      if (!pageRows.some((row) => row.page === pageName)) {
        errors.push(schemaError('extra-page-spec', `per-page subsection "### ${pageName}" has no matching ## Pages row`, { section: 'Per-Page Specifications', page: pageName }));
      }
    }
  }

  return errors;
}

const WORKFLOW_ASSERTIONS = new Map();

WORKFLOW_ASSERTIONS.set(
  'A workflow-log.md file is saved to the working directory documenting all phases attempted',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('workflow-log.md not present in fixture');
    if (fixture.workflowLog.trim().length < 50) {
      return fail(`workflow-log.md too short (${fixture.workflowLog.trim().length} chars)`);
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 0: A working directory is created with a kebab-case name derived from the user\'s description',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/Phase\s*0\b/i.test(log)) return fail('workflow-log lacks a "Phase 0" entry');
    if (!/working[\s-]?dir(ectory)?/i.test(log)) return fail('no mention of working directory in Phase 0');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/node\s+--version/.test(log)) return fail('workflow-log does not record `node --version`');
    if (!/\bpac\s+help\b/.test(log)) return fail('workflow-log does not record `pac help`');
    if (/node\s+--version\s*&&\s*pac\s+help/.test(log)) {
      return fail('node --version and pac help are chained with && (forbidden)');
    }
    // Parse the recorded PAC CLI version and enforce the contract (> 2.10.0), rather than merely
    // matching version-shaped text — an older pac (e.g. 2.7.x) must fail. Anchor on the "PAC CLI" /
    // "PowerPlatform CLI" phrase so the earlier `node --version → v20.x` line can't be mistaken for the
    // pac version. Accepts the forms pac emits, e.g. "PAC CLI Version 2.11.0", "PAC CLI: 2.11.0",
    // "Microsoft PowerPlatform CLI Version: 2.11.0+g06bb2eb (.NET 10.0.8)".
    const m = /(?:PAC|PowerPlatform)\s+CLI(?:\s+Version)?[:\s]+v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(log);
    if (!m) return fail('no PAC CLI version recorded (expected e.g. "PAC CLI Version 2.11.0")');
    const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
    const gtMin = major > 2 || (major === 2 && (minor > 10 || (minor === 10 && patch > 0)));
    if (!gtMin) {
      return fail(`recorded PAC CLI version ${major}.${minor}.${patch} does not satisfy > 2.10.0`);
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): pac auth list is run and the active environment is identified and reported to the user',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+auth\s+list/.test(log)) return fail('workflow-log does not record `pac auth list`');
    // Accept several legitimate signals that the active env was reported:
    //  - "active environment" / "active env" / "active profile" (synthetic style)
    //  - "currently active" (real `pac auth list` output)
    //  - "active":  flag in JSON-like output
    //  - Any Dataverse env URL near the pac auth list output (real captures
    //    contain the table-rendered URL but not the literal word "environment")
    const reportsEnv =
      /active\s+(environment|env|profile)/i.test(log) ||
      /currently\s+active/i.test(log) ||
      /environment[:\s]+https?:\/\//i.test(log) ||
      /https?:\/\/[a-z0-9-]+\.(crm|dynamics)/i.test(log);
    if (!reportsEnv) return fail('workflow-log does not report active environment');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): Question 1 (new or edit) is asked via AskUserQuestion',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    const unattended = isUnattendedLog(log);
    if (!unattended && !/AskUserQuestion/.test(log)) return fail('workflow-log does not record any AskUserQuestion call');
    if (unattended && !/Unattended default:/i.test(log)) return fail('unattended workflow-log does not record its default decision');
    // The planner spec allows the "new vs edit" question to be inferred
    // from $ARGUMENTS when the prompt clearly states a new page. Accept any of:
    //  - explicit question recorded
    //  - "Create new page" / "new page(s)" decision recorded
    //  - "edit existing" decision recorded
    //  - "inferred: new" / "implied: new"
    //  - presence of a Pages section in the plan (implies new-page flow)
    if (
      /new\s+or\s+edit/i.test(log) ||
      /create new page/i.test(log) ||
      /\bnew page\(s\)/i.test(log) ||
      /edit existing/i.test(log) ||
      /(inferred|implied)[:\s]+new/i.test(log) ||
      /^##\s+Pages\b/im.test(fixture.genpagePlan || '')
    ) return pass();
    return fail('workflow-log does not record the new-or-edit determination');
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): genpage-plan.md ALWAYS contains \'Solution:\' and \'Publisher Prefix:\' lines in ## Environment; default fallback is \'Solution: Default\' + \'Publisher Prefix: new\' for code-only flows',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before a create plan was authored');
    if (isEditFlowFixture(fixture)) return skip('edit flow — no genpage-plan.md is produced');
    if (!plan) return fail('genpage-plan.md not present in fixture');
    const env = planSection(plan, 'Environment');
    if (!env) return fail('plan has no "## Environment" section');
    // Allow optional list markers (`- Solution:`, `* Solution:`) and leading whitespace
    if (!/^\s*[-*]?\s*Solution:\s*\S/m.test(env)) return fail('## Environment missing "Solution:" line');
    if (!/^\s*[-*]?\s*Publisher Prefix:\s*\S/m.test(env)) return fail('## Environment missing "Publisher Prefix:" line');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const plan = fixture.genpagePlan;
    if (!log) return fail('no workflow-log.md');
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before solution selection');
    if (isEditFlowFixture(fixture)) return skip('edit flow — the solution question belongs to the create flow');
    if (!plan) return fail('no genpage-plan.md');
    const needsMetadata = entitiesNeedCreating(plan) || newAppNeeded(plan);
    const asked = solutionQuestionAsked(log);
    if (isUnattendedLog(log)) {
      if (asked) return fail('unattended flow recorded an interactive solution question');
      if (needsMetadata && !/Unattended default:[^\n]*solution/i.test(log)) {
        return fail('metadata work required in unattended mode but no solution default/decision was recorded');
      }
      return pass();
    }
    if (needsMetadata && !asked) return fail('metadata work required but solution question not asked');
    if (!needsMetadata && asked) return fail('code-only flow asked solution question (should be skipped)');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): When the solution question runs, the planner queries /solutions via dataverse-request.js and presents options (existing custom solutions, \'Create new genpage-<app> solution\', \'Use Default Solution\')',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!solutionQuestionAsked(log)) return skip('solution question not asked');
    // Accept either canonical (dataverse-request.js on the solutions entity set, or GET /solutions)
    // or the PAC CLI equivalent (`pac solution list`) — both enumerate solutions. The planner's
    // documented command passes a RELATIVE path with no leading slash, and is written across a
    // shell line continuation (agents/genpage-planner.md):
    //   node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "$ENV_URL" GET \
    //     "solutions?\$select=uniquename,friendlyname&..."
    // so the entity set may follow a quote, a space or a slash, possibly on the next line after a
    // bash `\` or PowerShell backtick continuation — but never across an unrelated line break.
    if (
      !/dataverse-request\.js(?:[^\n]|[\\`]\r?\n)*?[\s'"/]solutions\b|GET\s+\/solutions/i.test(log) &&
      !/pac\s+solution\s+list/i.test(log)
    ) {
      return fail('solution question asked but solutions endpoint not queried (expected dataverse-request.js /solutions OR pac solution list)');
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before plan approval');
    if (isEditFlowFixture(fixture)) return skip('edit flow — approval is presented from genpage-edit-plan.md');
    if (isUnattendedLog(log)) {
      if (/EnterPlanMode called|ExitPlanMode called|AskUserQuestion:/i.test(log)) {
        return fail('unattended workflow-log contains an attended interaction marker');
      }
      // Alternative B (`Unattended default:[^\n]*approved`) strictly subsumed this, making the
      // plan/approval context dead code: any `Unattended default:` line containing "approved" —
      // e.g. a solution-selection default — satisfied an assertion that claims to check PLAN
      // approval. The documented marker is `Unattended default: plan approval → approved (...)`.
      if (!/Unattended default:[^\n]*(plan|approval)[^\n]*approved/i.test(log)) {
        return fail('unattended workflow-log does not record plan approval');
      }
      return pass();
    }
    if (!/EnterPlanMode/.test(log)) return fail('workflow-log does not record EnterPlanMode');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md',
  ({ fixture }) => {
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before a create plan was authored');
    if (isEditFlowFixture(fixture)) return skip('edit flow — no genpage-plan.md is produced');
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const errors = validateGenpagePlanSchema(fixture.genpagePlan);
    if (errors.length > 0) {
      // Keep the runner output readable while still exposing the first concrete
      // schema violation; the full structured list is available to unit tests via
      // validateGenpagePlanSchema().
      return fail(errors[0].message);
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const plan = fixture.genpagePlan;
    if (!log) return fail('no workflow-log.md');
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before entity planning');
    if (isEditFlowFixture(fixture)) return skip('edit flow — entity creation belongs to the create flow');
    if (!plan) return fail('no genpage-plan.md');
    if (!entitiesNeedCreating(plan)) return skip('no entity creation required');
    return checkProblems(authGateProblems(fixture, { required: true }));
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 6 / 6.5 / 7.5 / Edit Phase 6 (--prompt scoping): The FIRST pac model genpage upload for each new page passes --prompt with the FULL page description (from plan\'s ## User Requirements). EVERY SUBSEQUENT upload of an existing page (--page-id, no --add-to-sitemap) passes --prompt scoped to ONLY the delta of changes in that upload — never the full original description',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (fixture.manifest?.expectedOutcome === 'refused') {
      return checkProblems(refusalProblems(fixture));
    }
    if (currentContract(fixture)) return gradeEvidence(uploadProblems, fixture);
    if (!UPLOAD_CMD.test(log)) return fail('no upload invocation recorded');
    // `--prompt` also matches `--prompt-file`, which is the intent: what is asserted is that a
    // prompt was recorded and scoped, not which flag carried it.
    if (!/--prompt/.test(log)) return fail('upload lacks a --prompt/--prompt-file flag');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Prefix discipline — plan format: Every name in `## Entity Creation Required` (table headings, column Suffix values, choice column suffixes, relationship Lookup Suffix values) is a bare suffix matching `^[a-z][a-z0-9]+$`. No value contains an underscore or a prefix. The prefix lives only in `## Environment` → `Publisher Prefix:`.',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
    if (beforePlanningRefusal(fixture)) return skip('discovery refused before entity planning');
    if (isEditFlowFixture(fixture)) return skip('edit flow — no ## Entity Creation Required section exists');
    if (!plan) return fail('no genpage-plan.md');
    const section = planSection(plan, 'Entity Creation Required');
    if (!section || /No entity creation required/i.test(section)) return skip('no entity creation');
    const lines = section.split('\n').filter((l) => /^\|/.test(l));
    const offenders = [];
    for (const line of lines) {
      if (/^\|\s*-/.test(line) || /Suffix|Column|Type|Cardinality|Heading/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      for (const c of cells) {
        if (/^[a-z][a-z0-9_]+$/.test(c) && c.includes('_')) offenders.push(c);
      }
    }
    if (offenders.length > 0) {
      return fail(`prefix drift in ## Entity Creation Required: ${offenders.slice(0,3).join(', ')}${offenders.length>3?'...':''}`);
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Prefix discipline — resolved names: For every operation in `genpage-entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
    const log = fixture.entityCreationLog;
    if (!plan) return skip('no genpage-plan.md');
    if (!log) return skip('no genpage-entity-creation-log.md (or its legacy entity-creation-log.md alias)');
    const env = planSection(plan, 'Environment');
    if (!env) return fail('plan has no ## Environment section');
    // Allow optional list markers (`- Publisher Prefix: new` or `* Publisher Prefix: new`).
    const prefixMatch = env.match(/^\s*[-*]?\s*Publisher Prefix:\s*(\S+)/m);
    if (!prefixMatch) return fail('plan ## Environment missing Publisher Prefix');
    const prefix = prefixMatch[1].trim().toLowerCase();
    const matches = allMatches(/(?:Resolved Full Name|Logical Name|Schema Name):\s*([a-z][a-z0-9_]+)/gi, log);
    const offenders = [];
    for (const m of matches) {
      const name = m[1].toLowerCase();
      if (!name.includes('_')) continue;
      if (!name.startsWith(prefix + '_')) offenders.push(name);
    }
    if (offenders.length > 0) {
      return fail(`names not prefixed with "${prefix}_": ${offenders.slice(0,3).join(', ')}${offenders.length>3?'...':''}`);
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Prefix discipline — solution alignment: If the env has a dominant non-system custom prefix (>=50% of custom tables AND >=3 such tables), the planner surfaces this in the solution question and ordered the option whose publisher prefix matches the dominant prefix FIRST as the recommended choice. If the user picks a different-prefix solution, the planner logged a one-line warning before proceeding.',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!solutionQuestionAsked(log)) return skip('solution question not asked');
    if (!/dominant\s+prefix|prefix\s+alignment|env(ironment)?\s+publishers/i.test(log)) {
      return fail('solution question recorded but no dominant-prefix detection mentioned');
    }
    return pass();
  }
);

const PHASE_EXPECTATIONS = new Map();

const PACKAGING_ASSERTION = 'Phase 6.7: Packaging uses every deployed page id, the approved solution and discovered component types; invalid identities refuse before writes and results agree with read-back';
PHASE_EXPECTATIONS.set(PACKAGING_ASSERTION, ({ fixture }) => gradeEvidence(packagingProblems, fixture));
WORKFLOW_ASSERTIONS.set(PACKAGING_ASSERTION, ({ fixture }) => {
  const section = planSection(fixture.genpagePlan, 'Solution Packaging');
  if (!fixture.manifest?.packaging && !/Package into solution:\s*true\b/i.test(section || '') && !workflowCalls(fixture).some((call) => isPackaging(call.command))) {
    return skip('solution packaging was not requested or attempted');
  }
  return gradeEvidence(packagingProblems, fixture);
});

WORKFLOW_ASSERTIONS.set(
  'Phase 4.6: A populated Custom API plan never discovers, generates or uploads after a disabled or unreadable feature gate',
  ({ fixture }) => {
    const body = planSection(fixture.genpagePlan, 'Custom API Bindings');
    if (!fixture.manifest?.customApi && (!body || body === 'No custom API bindings.')) return skip('no Custom API lifecycle in this workflow');
    return gradeEvidence(customApiGateProblems, fixture);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5: Custom API discovery, gate, bare bindings, runtime calls and update preservation or explicit clear agree',
  ({ fixture }) => gradeEvidence(customApiProblems, fixture)
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Create uploads use name-file and preserve the exact approved name prompt and agent-message text',
  ({ fixture }) => gradeEvidence((f) => uploadPreservationProblems(f, 'create'), fixture)
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 6: Updates preserve omitted name model data sources and untouched connector and action bindings',
  ({ fixture }) => gradeEvidence((f) => uploadPreservationProblems(f, 'update'), fixture)
);

PHASE_EXPECTATIONS.set(
  'Phase 6.5: Every effective navigation target resolves against the deployed page map; exact substitutions preserve non-navigation bytes and only affected pages reupload',
  ({ fixture }) => gradeEvidence(navigationProblems, fixture)
);

PHASE_EXPECTATIONS.set(
  'Phase 5: A rejected worker artifact prevents upload until a stamped, complete regeneration passes the production gate',
  ({ fixture }) => gradeEvidence(workerProblems, fixture)
);

PHASE_EXPECTATIONS.set(
  'Phase 2a: Auth timeout retries once then halts before provisioning or upload',
  ({ fixture }) => checkProblems(refusalProblems(fixture))
);

PHASE_EXPECTATIONS.set(
  'Phase 1: Discovery refusal preserves the error and halts before connection setup or generation',
  ({ fixture }) => checkProblems(refusalProblems(fixture))
);

WORKFLOW_ASSERTIONS.set(
  'Phase 2a: Every applicable auth result is associated with its command; only the latest successful gate authorizes mutations, and final failures halt with bounded retry and advice',
  ({ fixture }) => workflowCalls(fixture).some((call) => isAuth(call.command))
    ? checkProblems(authGateProblems(fixture))
    : skip('no applicable check-auth call')
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1: Failed connector discovery returns needs_input and never creates a connection or reference',
  ({ fixture }) => workflowCalls(fixture).some((call) => isDiscovery(call.command))
    ? checkProblems(discoveryProblems(fixture))
    : skip('no connector discovery in this workflow')
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): pac model list-tables --search \'account\' is run and results are filtered by exact logical-name match',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+model\s+list-tables/.test(log)) return fail('pac model list-tables not invoked');
    if (!/--search/.test(log)) return fail('list-tables invoked without --search');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Account entity is detected as existing; plan records no entity creation required',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
    if (!plan) return fail('no genpage-plan.md');
    const section = planSection(plan, 'Entity Creation Required');
    if (!section) return fail('plan missing ## Entity Creation Required');
    if (!/No entity creation required/i.test(section)) {
      return fail('plan does not record "No entity creation required"');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2: Entity-builder is SKIPPED (no entities to create)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (/genpage-entity-builder\s+invoked|entity-builder\s+invoked|Task.*entity-builder/i.test(log)) {
      return fail('entity-builder was invoked (should be skipped)');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2: Entity-builder is SKIPPED (mock data)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (/genpage-entity-builder\s+invoked|entity-builder\s+invoked|Task.*entity-builder/i.test(log)) {
      return fail('entity-builder was invoked on a mock-data eval');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 4: RuntimeTypes generation is SKIPPED (mock data)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    // Match an actual invocation (generate-types followed by a --flag), not
    // descriptive prose like "generate-types not run".
    if (/generate-types\s+--/.test(log)) return fail('generate-types invoked on mock-data eval');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 4: pac model genpage generate-types --data-sources \'account\' --output-file <working-dir>/RuntimeTypes.ts is run',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/generate-types\s+--/.test(log)) return fail('generate-types not invoked');
    if (!/--data-sources\s+['"]?account['"]?/.test(log)) {
      return fail('generate-types missing --data-sources account');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5 (Page Builder): genpage-page-builder is invoked with Data mode: mock',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/genpage-page-builder/.test(log) && !/Phase\s*5b?/.test(log)) {
      return fail('no page-builder invocation recorded');
    }
    if (!/Data mode[:\s]+mock|mock\s+data/i.test(log)) return fail('Data mode: mock not recorded');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5b (single-page fast path): Plan has 1 page so orchestrator inlines the build — NO Task subagent dispatched for the page-builder',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (/Task[^\n]*genpage-page-builder/i.test(log)) {
      return fail('Task subagent dispatched (fast path should inline)');
    }
    if (!/Phase\s*5b|single[-\s]page\s+fast\s+path|inlined|inline\s+build/i.test(log)) {
      return fail('fast path not recorded');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5c (multi-page): Three genpage-page-builder agents are invoked via Task tool in a SINGLE message (parallel execution, not sequential). The single-page fast path (5b) is NOT taken because N>1.',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    // Accept singular "page-builder" and plural "page-builders".
    if (!/(3|three)\s+(page-builders?|builders|genpage-page-builders?|Task)/i.test(log)) {
      return fail('multi-page parallel dispatch not recorded');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: pac model genpage upload includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    const required = ['--app-id', '--code-file', '--data-sources', '--prompt', '--model', '--name', '--agent-message', '--add-to-sitemap'];
    const missing = required.filter((flag) => !log.includes(flag));
    if (missing.length > 0) return fail(`upload missing flags: ${missing.join(', ')}`);
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Deployment omits --data-sources flag (mock data page)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!UPLOAD_CMD.test(log)) return fail('upload command not recorded');
    const uploadLines = uploadLinesOf(log);
    if (uploadLines.some((l) => /--data-sources/.test(l))) {
      return fail('upload includes --data-sources on mock-data page');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Upload omits --data-sources flag',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!UPLOAD_CMD.test(log)) return fail('upload command not recorded');
    const uploadLines = uploadLinesOf(log);
    if (uploadLines.some((l) => /--data-sources/.test(l))) {
      return fail('upload includes --data-sources on mock-data page');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: --prompt value is the FULL page description (from plan\'s ## User Requirements) — this is the create-step prompt, NOT a delta',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/--prompt/.test(log)) return fail('upload missing --prompt');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5b: Orchestrator reads ${PLUGIN_ROOT}/references/verified-icons.txt before writing the .tsx',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/verified-icons\.txt/.test(log)) return fail('verified-icons.txt not read');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5b: A relevant sample file is read (e.g., 7-responsive-cards.tsx for card layout)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/samples?\/[\w-]+\.tsx/i.test(log)) return fail('no sample file read recorded');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5b: Generated .tsx uses only column names verified from RuntimeTypes.ts — no guessed names',
  () => skip('column-name verification needs schema cross-check')
);

PHASE_EXPECTATIONS.set(
  'Phase 5b: After writing, orchestrator greps the .tsx for `from "@fluentui/react-icons"` imports and verifies each named import against verified-icons.txt — rewrites if any are missing',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/grep[^\n]*react-icons|verify[^\n]*icons|verified[\s-]*icons[^\n]*check/i.test(log)) {
      return fail('icon verification step not recorded');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): User indicates \'edit existing\'; planner returns { action: \'edit\' }, skipping Phases 2-8 of the create flow',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/action[:\s]+['"]?edit['"]?|edit\s+flow|Edit\s+Phase/i.test(log)) {
      return fail('edit flow not recorded');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 1a: pac model list is run to discover available apps — orchestrator does NOT guess or invent app names',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+model\s+list\b/.test(log)) return fail('pac model list not invoked');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 2: pac model genpage download produces <working-dir>/<page-id>/ with page.tsx, page.js, config.json, prompt.txt',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+model\s+genpage\s+download/.test(log)) return fail('pac model genpage download not invoked');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 4: genpage-edit-planner agent is invoked via Task tool',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/genpage-edit-planner/.test(log)) return fail('edit-planner not invoked');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 5: Orchestrator applies edits inline using Edit tool on <working-dir>/<page-id>/page.tsx',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/Edit\s+tool|Edit\s+applied|inline\s+edit/i.test(log)) return fail('inline Edit application not recorded');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 6: pac model genpage upload uses --page-id flag; omits --add-to-sitemap',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    const uploadLines = uploadLinesOf(log);
    if (uploadLines.length === 0) return fail('upload not recorded');
    const editUpload = uploadLines.find((l) => /--page-id/.test(l));
    if (!editUpload) return fail('edit upload missing --page-id');
    if (/--add-to-sitemap/.test(editUpload)) return fail('edit upload includes --add-to-sitemap');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 6: --prompt value is the user\'s edit request (the DELTA of changes — \'Add a search bar and column sorting by company name\'), NOT a re-statement of the original page description',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/--prompt/.test(log)) return fail('edit upload missing --prompt');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2a: Orchestrator runs scripts/check-auth.js; ok:true gate before invoking entity-builder',
  ({ fixture }) => {
    return checkProblems(authGateProblems(fixture, { required: true }));
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration',
  ({ fixture }) => {
    const log = fixture.entityCreationLog || fixture.workflowLog;
    if (!log) return fail('no genpage-entity-creation-log.md (or legacy alias) or workflow-log.md');

    // Check legacy flow: old-script calls must have --solution
    const legacyMatches = allMatches(/(create-table\.js|add-column\.js|create-relationship\.js)([^\n]*)/g, log);
    const offenders = [];
    for (const m of legacyMatches) {
      if (!/--solution\b/.test(m[2])) offenders.push(m[1]);
    }
    if (offenders.length > 0) return fail(`${offenders.length} call(s) missing --solution: ${offenders.slice(0,3).join(', ')}`);

    // Check new flow: provision-entities.js must have Solution: declared in plan or log
    // Check for provision-entities.js in both workflowLog and entityCreationLog
    const usesNewFlow = /\bprovision-entities\.js\b/.test(fixture.workflowLog || '') || /\bprovision-entities\.js\b/.test(fixture.entityCreationLog || '');
    if (usesNewFlow) {
      // Solution must be declared in ## Environment section (plan or entity-creation-log)
      const planEnv = planSection(fixture.genpagePlan, 'Environment');
      const logEnv = planSection(fixture.entityCreationLog, 'Environment');
      const solutionPattern = /^\s*[-*]?\s*Solution:\s*(\S+)/m;
      const hasSolution = (planEnv && solutionPattern.test(planEnv)) || (logEnv && solutionPattern.test(logEnv));
      if (!hasSolution) return fail('provision-entities.js used but no Solution: declaration in ## Environment');
    }

    // Skip if no entity provisioning detected
    if (legacyMatches.length === 0 && !usesNewFlow) return skip('no entity provisioning detected');

    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 3: pac model create --name \'Account Metrics\' --solution \'<Solution from plan>\' is run; --solution is ALWAYS passed (pac model create errors out without it)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+model\s+create/.test(log)) return fail('pac model create not invoked');
    if (!/pac\s+model\s+create[^\n]*--solution/.test(log)) return fail('pac model create missing --solution');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2a: If the script returns blocker:\'az_not_logged_in\', orchestrator surfaces the message (\'Run `az login`...\') to the user and halts (entity-builder is NOT invoked)',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/blocker[:\s]+['"]?az_not_logged_in['"]?/i.test(log)) {
      return skip('az_not_logged_in blocker not in scenario');
    }
    if (/genpage-entity-builder\s+invoked/i.test(log)) {
      return fail('entity-builder invoked despite az_not_logged_in blocker');
    }
    if (!/halt|halted|stopped|abort/i.test(log)) return fail('orchestrator did not halt after blocker');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b: genpage-entity-builder is only invoked AFTER check-auth returns ok:true',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    const idxCheck = log.search(/check-auth\.js/);
    const idxBuilder = log.search(/genpage-entity-builder\s+invoked|entity-builder\s+invoked/i);
    if (idxBuilder === -1) return skip('entity-builder not invoked');
    if (idxCheck === -1 || idxBuilder < idxCheck) return fail('entity-builder invoked before check-auth.js');
    return checkProblems(authGateProblems(fixture, { required: true }));
  }
);

// Eval 17: mock-data page — regression guard confirming the planner does NOT run
// connector discovery for a page with no connector data source, leaving
// ## Connector Bindings as the exact sentinel. (Connector authoring has no feature
// flag and is always available, so the thing worth pinning is that it stays OFF THE PATH when
// the maker asked for mock data — otherwise every mock page pays for a `pac
// connection list` round trip and risks inventing a binding nobody asked for.)
PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): For a mock-data page, connector discovery (list-connections.js) is NOT run, and the plan's ## Connector Bindings is exactly 'No connector bindings.'",
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const plan = fixture.genpagePlan;
    if (!log) return fail('no workflow-log.md');
    if (!plan) return fail('no genpage-plan.md');
    // (a) list-connections.js must NOT be invoked — a `node ... list-connections.js`
    //     command must be absent. A narrative mention like "list-connections.js NOT
    //     run" in a comment is acceptable and does not count as an invocation.
    if (/\bnode\b[^\n]*list-connections\.js/.test(log)) {
      return fail(
        'list-connections.js was invoked for a mock-data page — connector discovery should be skipped'
      );
    }

    // (b) Plan's ## Connector Bindings body must be exactly the no-binding sentinel.
    const cbSection = planSection(plan, 'Connector Bindings');
    if (!cbSection) {
      return fail('genpage-plan.md is missing ## Connector Bindings section');
    }
    if (cbSection.trim() !== 'No connector bindings.') {
      return fail(
        `## Connector Bindings body is not exactly 'No connector bindings.' (got: ${cbSection.trim().slice(0, 60)})`
      );
    }

    return pass();
  }
);

// Eval 18: connector-backed page — regression guard confirming that the planner
// runs list-connections.js for discovery and records at least one real binding.
PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): For a connector-backed page, list-connections.js is run for connector discovery, and the plan's ## Connector Bindings records at least one binding (not 'No connector bindings.')",
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const plan = fixture.genpagePlan;
    if (!log) return fail('no workflow-log.md');
    if (!plan) return fail('no genpage-plan.md');
    const discovery = discoveryProblems(fixture, { required: true, needsBinding: true });
    if (discovery.length) return checkProblems(discovery);

    // (a) A `node ... list-connections.js` invocation must appear in the log —
    //     discovery must run for a connector-backed data source.
    if (!/\bnode\b[^\n]*list-connections\.js/.test(log)) {
      return fail(
        'list-connections.js not invoked — expected for a connector-backed page'
      );
    }

    // (b) Plan's ## Connector Bindings must contain at least one real binding,
    //     detected by a table pipe (|) or a shared_ connector id.
    const cbSection = planSection(plan, 'Connector Bindings');
    if (!cbSection || cbSection.trim() === '') {
      return fail('genpage-plan.md is missing ## Connector Bindings section');
    }
    if (cbSection.trim() === 'No connector bindings.') {
      return fail(
        '## Connector Bindings says "No connector bindings." but the page is connector-backed and a binding was expected'
      );
    }
    if (!/\|/.test(cbSection) && !/shared_/.test(cbSection)) {
      return fail(
        '## Connector Bindings does not contain a binding table row (expected | pipe or shared_ connector id)'
      );
    }

    return pass();
  }
);

// Eval 18: connector deploy — connectors.json is written as a bare array (not
// the config.json { connectorBindings: [...] } wrapper) and the upload passes
// --connectors. Locks in the connectors.json shape and the deploy wiring.
PHASE_EXPECTATIONS.set(
  "Phase 4.5 / Phase 6: connectors.json is written as a bare array (not the config.json object wrapper) and the upload includes --connectors",
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/connectors\.json/.test(log)) return fail('workflow-log does not record connectors.json');
    if (!/--connectors\b/.test(log)) return fail('upload does not include --connectors');
    // Guard against the object-wrapper regression: connectors.json must be a bare
    // array, not `{ "connectorBindings": [...] }` (that is the deployed config.json).
    if (/connectors\.json[^\n]*\{\s*"connectorBindings"/.test(log)) {
      return fail('connectors.json shown as the config.json object wrapper, not a bare array');
    }
    return pass();
  }
);

// --- Eval 19: adding a connector to an EXISTING page (edit flow) -------------
//
// Connector work on the create path (eval 18) and on the edit path are different code paths:
// the edit path dispatches genpage-connector-builder in `edit` mode with the page's EXISTING
// bindings, and must merge rather than replace. Nothing covered the edit path until this eval.

PHASE_EXPECTATIONS.set(
  'Edit Phase 3.5 (connector edit): genpage-connector-builder is dispatched with Mode: edit and the existing bindings, runs list-connections.js, and writes connectors.json as a bare JSON array',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');

    // (a) The builder must be dispatched in EDIT mode. A create-mode dispatch would discard the
    //     page's existing bindings instead of merging the new one into them.
    if (!/genpage-connector-builder/.test(log)) return fail('genpage-connector-builder was not dispatched');
    if (!/Mode:\s*`?edit`?/i.test(log)) return fail('connector-builder was not dispatched with Mode: edit');
    if (!/existing bindings/i.test(log)) return fail('the existing bindings were not passed to the builder');

    // (b) Discovery still runs on the edit path.
    if (!/\bnode\b[^\n]*list-connections\.js/.test(log)) {
      return fail('list-connections.js not invoked on the edit path');
    }
    const discovery = discoveryProblems(fixture, { required: true, needsBinding: true });
    if (discovery.length) return checkProblems(discovery);

    // (c) Same bare-array shape as the create path — `pac` wraps it into config.json itself.
    //     Asserted POSITIVELY (the recorded content opens with `[{`) rather than by banning the
    //     string `{ "connectorBindings"`: a log line legitimately names the wrapper in order to
    //     contrast with it, and a negative match cannot tell the two apart.
    if (!/connectors\.json/.test(log)) return fail('workflow-log does not record connectors.json');
    const jsonLine = log.split('\n').find((l) => /connectors\.json/.test(l) && /\[\s*\{/.test(l));
    if (!jsonLine) return fail('workflow-log does not show connectors.json content as a bare JSON array');
    if (/:\s*\{\s*"connectorBindings"/.test(jsonLine)) {
      return fail('connectors.json written as the config.json object wrapper, not a bare array');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 5 (REST connector): the page calls executeConnectorOperation for an operation-based connector — never queryConnectorTable — presence-checks the method, and checks response.ok before reading response.body',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const tsx = (fixture.files || []).map((f) => f.content).join('\n');
    if (!log) return fail('no workflow-log.md');
    if (!tsx) return fail('no .tsx file in fixture');

    // A REST/action connector (MSN Weather) is called with executeConnectorOperation. Using the
    // table API for it is the mistake this pins: queryConnectorTable takes dataset+table, which an
    // operation-based connector does not have, so the call fails at runtime.
    //
    // Both checks match an actual CALL (`.name(`), not a mention: generated pages legitimately
    // carry a comment explaining which API they chose and why, and banning the bare identifier
    // would fail the very code that documents itself correctly.
    if (!/\.executeConnectorOperation\s*\(/.test(tsx)) {
      return fail('.tsx does not call executeConnectorOperation for the REST connector');
    }
    if (/\.queryConnectorTable\s*\(/.test(tsx)) {
      return fail('.tsx calls queryConnectorTable for an operation-based connector');
    }
    // Presence-check before calling — the runtime may not expose the method yet.
    if (!/typeof[^\n]*executeConnectorOperation[^\n]*!==\s*'function'/.test(tsx)) {
      return fail('.tsx does not presence-check executeConnectorOperation before calling it');
    }
    // `ok` is checked before `body` is read; an operation that failed still RESOLVES.
    const okIdx = tsx.search(/response\.ok/);
    const bodyIdx = tsx.search(/response\.body/);
    if (okIdx === -1) return fail('.tsx does not check response.ok');
    if (bodyIdx !== -1 && okIdx > bodyIdx) return fail('.tsx reads response.body before checking response.ok');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Edit Phase 5 (preservation): content the connector cannot supply is preserved per the edit plan's Preservation Constraints rather than dropped",
  ({ fixture }) => {
    const plan = fixture.genpageEditPlan;
    const tsx = (fixture.files || []).map((f) => f.content).join('\n');
    if (!plan) return fail('no genpage-edit-plan.md');
    if (!tsx) return fail('no .tsx file in fixture');

    if (!/##\s*Preservation Constraints/i.test(plan)) {
      return fail('genpage-edit-plan.md has no ## Preservation Constraints section');
    }
    // The concrete case: the CurrentWeather operation returns current conditions only, so the
    // five-day forecast must survive the edit as inline data. Silently dropping it would remove a
    // feature the maker never asked to lose — the most common edit-flow regression.
    if (!/weeklyForecast|forecast/i.test(tsx)) {
      return fail('.tsx no longer contains the preserved forecast data');
    }
    if (!/\{\s*date:\s*'/.test(tsx)) {
      return fail('.tsx no longer carries the preserved inline forecast rows');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 6 (connector edit): the upload passes --page-id and --connectors, omits --add-to-sitemap, and --prompt carries only the edit delta',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    const upload = uploadLinesOf(log)[0] || '';
    if (!upload) return fail('no genpage upload command in the workflow log');

    if (!/--page-id\b/.test(upload)) return fail('edit upload must pass --page-id');
    if (!/--connectors\b/.test(upload)) return fail('edit upload must pass --connectors');
    // An existing page is already in the sitemap; re-adding it creates a duplicate subarea.
    if (/--add-to-sitemap\b/.test(upload)) return fail('edit upload must omit --add-to-sitemap');

    // The prompt must be the DELTA. The page's original description ("dashboard showing the current
    // weather ... temperature, conditions, and humidity") must not be restated, or each edit
    // re-sends the whole history and the stored prompt drifts from what the page now is.
    //
    // Read through `promptEvidence` rather than demanding an inline quoted value: the file
    // transport has no inline value to read, and requiring one made a correct run fail while a raw
    // `--prompt "…"` run passed — grading the quoting-unsafe transport as the correct one.
    const value = promptEvidence(log, upload);
    if (value === null) return fail('edit upload records no prompt value or `Prompt scope:` line');
    if (/temperature, conditions, and humidity/i.test(value)) {
      return fail('the prompt restates the original page description instead of this edit\'s delta');
    }
    return pass();
  }
);

// ---------------------------------------------------------------------------------------------
// Per-eval expectations graded from structured evidence
// ---------------------------------------------------------------------------------------------
//
// Each check below reads the artifact a real run leaves for its requirement — a command and the
// result recorded with it, a plan table, an entity-creation transaction or the generated
// RuntimeTypes.ts — through lib/expectation-evidence.js. It SKIPs only where that artifact is not
// part of the fixture's shape, and names the exact value that disagrees when it fails.

const {
  csvList, sameSet, containsAll, suffixOf, commandCalls, listTablesSearches, generateTypesCalls, uploadCalls,
  provisionCalls, legacyProvisionCalls, planPrefix, planSolution, planEntityBlocks, existingEntities, entityLog,
  createdTableNames, runtimeEnums, choiceEnum, NOT_FOUND, LIST_LANGUAGES, GENPAGE_LIST, GUID_RE, listingRows, conversationSteps,
} = evidence;

const resultOf = (problems) => (problems.length ? fail(problems[0]) : pass());
const listText = (items) => (items.length ? items.join(',') : 'none');
const normalized = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// The body under a heading matched by `heading` (any level), up to the next heading of the same or
// a higher level. Logs title their phases freely (`## Phase 8 — Summary`, `## Phase 8: Summary`),
// so the title is a pattern rather than planSection's exact text.
function headingSection(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const next = /^(#+)\s/.exec(line);
    if (next && next[1].length <= level) break;
    out.push(line);
  }
  return out.join('\n');
}

function pageRowsOf(plan) {
  return parseMarkdownRows(planSection(plan, 'Pages') || '', ['Page', 'File', 'Purpose', 'Entities']);
}

// Recorded by the orchestrator (`Task genpage-entity-builder`, `Dispatched genpage-entity-builder`) or
// implied by the provisioning scripts only the entity-builder runs.
const BUILDER_CALL = /\b(?:Task|Dispatched)\s+genpage-entity-builder\b|\bgenpage-entity-builder\s+invoked\b|\bprovision-entities\.js\b|\b(?:create-table|add-column|create-relationship|create-record)\.js\b/i;

function entityBuilderInvoked(fixture) {
  return /genpage-entity-builder\s+invoked|entity-builder\s+invoked|Task.*entity-builder/i.test(fixture.workflowLog || '')
    || workflowCalls(fixture).some((call) => BUILDER_CALL.test(call.command));
}

// An existing table is confirmed by BOTH halves of discovery: a `list-tables --search` that covered
// it without reporting it absent, and the plan's verdict (listed under Existing Entities, not
// scheduled for creation). The list-tables wording varies by capture, so the plan is the
// structured verdict and the search result is only checked for a contradiction.
function existingEntityProblems(fixture, names) {
  if (!fixture.genpagePlan) return ['no genpage-plan.md'];
  const searches = listTablesSearches(fixture);
  if (!searches.length) return ['pac model list-tables --search was not run'];
  const existing = existingEntities(fixture.genpagePlan);
  const planned = planEntityBlocks(fixture.genpagePlan).map((block) => block.suffix);
  const problems = [];
  for (const name of names) {
    const search = searches.find((s) => s.terms.includes(name));
    if (!search) problems.push(`no pac model list-tables --search covered ${name} (searched: ${searches.map((s) => listText(s.terms)).join('; ')})`);
    else if (NOT_FOUND.test(search.text)) problems.push(`list-tables recorded ${name} as not found`);
    if (!existing.includes(name)) problems.push(`plan ## Existing Entities does not confirm ${name}`);
    if (planned.includes(suffixOf(name))) problems.push(`plan schedules ${name} for creation although it exists`);
  }
  return problems;
}

// The mirror image for a table the run must create. `exact` additionally requires the verdict to
// rest on an exact logical-name match: a search for `cr_candidate` can return `cr_candidatenote`,
// and a fuzzy reading of that hit would skip creating a table that does not exist. A search that
// returned no rows at all cannot have been misread, so it satisfies `exact` on its own.
function missingEntityProblems(fixture, names, { exact = false } = {}) {
  if (!fixture.genpagePlan) return ['no genpage-plan.md'];
  const searches = listTablesSearches(fixture);
  if (!searches.length) return ['pac model list-tables --search was not run'];
  const existing = existingEntities(fixture.genpagePlan);
  const planned = planEntityBlocks(fixture.genpagePlan).map((block) => block.suffix);
  const problems = [];
  for (const name of names) {
    const search = searches.find((s) => s.terms.includes(name) || s.terms.includes(suffixOf(name)));
    if (!search) problems.push(`no pac model list-tables --search covered ${name} (searched: ${searches.map((s) => listText(s.terms)).join('; ')})`);
    else if (!NOT_FOUND.test(search.text)) problems.push(`list-tables result does not record ${name} as absent`);
    else if (exact && !/\bexact\b/i.test(search.text) && !/\bNo\s+tables?\s+found\b/i.test(search.text)) {
      problems.push(`list-tables verdict for ${name} does not rest on an exact logical-name match`);
    }
    if (!planned.includes(suffixOf(name))) problems.push(`plan ## Entity Creation Required has no "### ${suffixOf(name)}" block for ${name}`);
    if (existing.includes(name)) problems.push(`plan ## Existing Entities lists ${name} although it must be created`);
  }
  return problems;
}

function generateTypesProblems(fixture, names, { exact = false } = {}) {
  const calls = generateTypesCalls(fixture);
  if (!calls.length) return ['pac model genpage generate-types was not run'];
  if (!names.length) return ['no entity names to generate types for'];
  const covers = (c) => (exact ? sameSet(c.sources, names) : containsAll(c.sources, names));
  if (!calls.some(covers)) return [`no generate-types run has --data-sources ${listText(names)} (saw ${calls.map((c) => listText(c.sources)).join('; ')})`];
  return [];
}

// Every upload of the page must bind the tables: the raw `pac` transport persists exactly the
// `--data-sources` it is given, so an update that drops one silently unbinds the page.
function uploadSourcesProblems(fixture, names, { exact = false } = {}) {
  const uploads = uploadCalls(fixture);
  if (!uploads.length) return ['no genpage upload command recorded'];
  if (!names.length) return ['no entity names to bind'];
  return uploads.filter((u) => (exact ? !sameSet(u.sources, names) : !containsAll(u.sources, names)))
    .map((u) => `${u.file || 'upload'}: --data-sources is ${listText(u.sources)}, expected ${listText(names)}`);
}

// The answer to a question, recorded as `AskUserQuestion: <question> → <answer>` or as a list line
// under a heading that names AskUserQuestion, e.g.
//   ### Discovery questions (AskUserQuestion)
//   - Question 4 (sample data): user answered "Yes, add sample data"
// Unattended runs record `Unattended default: <decision> -> <value>` instead.
function recordedAnswer(log, topic) {
  let heading = '';
  for (const line of String(log || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) { heading = line; continue; }
    if (!topic.test(line)) continue;
    const unattended = /Unattended default:/i.test(line);
    if (!unattended && !/AskUserQuestion/.test(line) && !/AskUserQuestion/.test(heading)) continue;
    const answer = /(?:\u2192|->|\banswered\b|\bselected\b)\s*:?\s*"?([^"\n]+)"?/i.exec(line);
    if (answer) return { unattended, answer: answer[1].trim() };
  }
  return null;
}

// The sample-data QUESTION, not any line that mentions sample data. "sample data" must come before
// the question mark or the `(topic):` label, so a requirements answer that merely asks for sample
// data is not read as the builder's yes/no question:
//   - Question 4 (sample data): user answered "Yes, add sample data"                 the question
//   AskUserQuestion: … Would you like me to add sample data for testing? → Yes, add …  the question
//   AskUserQuestion: Any specific requirements? → Project tracker; include sample data  NOT it
const SAMPLE_DATA_QUESTION = /\bsample\s+data\b[^\n]*?(?:\?|\):)/i;

// The solution the maker picked, e.g.
//   AskUserQuestion: Which solution should cr_ticket go in? → Crdec34 (existing custom solution)
//   ### Solution selection / - User selected: "Use Default Solution"
function solutionAnswer(log) {
  let heading = '';
  for (const line of String(log || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) { heading = line; continue; }
    const asked = /AskUserQuestion[^\n]*solution/i.test(line) && /(?:\u2192|->)\s*(.+)$/.exec(line);
    if (asked) return asked[1];
    const selected = /solution/i.test(heading) && /\b(?:user\s+)?(?:selected|chose|picked|answered)\b:?\s*(.+)$/i.exec(line);
    if (selected) return selected[1];
  }
  return null;
}

function solutionChoiceProblems(fixture) {
  const { workflowLog: log, genpagePlan: plan } = fixture;
  if (!log) return ['no workflow-log.md'];
  if (!plan) return ['no genpage-plan.md'];
  if (!entitiesNeedCreating(plan) && !newAppNeeded(plan)) return ['plan records no entity or app creation, so no solution question was due'];
  const solution = planSolution(plan);
  const prefix = planPrefix(plan);
  const problems = [];
  if (!solution) problems.push('## Environment has no "Solution: <uniqueName>" line');
  if (!prefix) problems.push('## Environment has no "Publisher Prefix: <prefix>" line');
  if (isUnattendedLog(log)) {
    if (!/Unattended default:[^\n]*solution/i.test(log)) problems.push('unattended run recorded no solution default');
    return problems;
  }
  if (!solutionQuestionAsked(log)) return [...problems, 'metadata work is planned but the solution question was not asked'];
  const answer = solutionAnswer(log);
  if (answer === null) problems.push('the answer to the solution question is not recorded');
  // Compare on letters and digits only: "Use Default Solution" picked `Default`, and a "Create new
  // genpage-recruitment solution" answer records the unique name `genpage_recruitment`.
  else if (solution && !normalized(answer).includes(normalized(solution))) {
    problems.push(`## Environment records Solution: ${solution}, but the maker answered "${answer.trim()}"`);
  }
  return problems;
}

// The lookups between tables this run creates: [{ child, parent }] by suffix. Only these impose an
// order — a lookup to an existing table (`account`) has its target already in place.
function newTableLookups(plan) {
  const blocks = planEntityBlocks(plan);
  return blocks.flatMap((block) => block.relationships
    .filter((rel) => !/N\s*:\s*N/i.test(rel.type) && blocks.some((other) => other.suffix === rel.related))
    .map((rel) => ({ child: block.suffix, parent: rel.related })));
}

// Every create in the plan has its transaction in genpage-entity-creation-log.md: a Created Tables
// entry carrying the Resolved Full Name Dataverse returned, a Created Columns row per column and
// choice column, and a Created Relationships row per lookup (From = referenced, To = referencing).
function entityLogCoverageProblems(fixture) {
  const log = entityLog(fixture.entityCreationLog);
  if (!log) return { problems: ['no genpage-entity-creation-log.md (or its legacy entity-creation-log.md alias)'], log };
  const blocks = planEntityBlocks(fixture.genpagePlan);
  if (!blocks.length) return { problems: ['plan schedules no entity creation'], log };
  const problems = [];
  for (const block of blocks) {
    const table = log.tables.find((t) => t.resolved && suffixOf(t.resolved) === block.suffix);
    if (!table) { problems.push(`table ${block.suffix} has no Created Tables entry with its Resolved Full Name`); continue; }
    for (const column of [...block.columns, ...block.choices]) {
      if (!log.columns.some((row) => row.table === table.resolved && suffixOf(row.resolved) === column.suffix)) {
        problems.push(`column ${column.suffix} of ${table.resolved} has no Created Columns row`);
      }
    }
    for (const rel of block.relationships.filter((r) => !/N\s*:\s*N/i.test(r.type))) {
      if (!log.relationships.some((row) => suffixOf(row.from) === rel.related && suffixOf(row.to) === block.suffix)) {
        problems.push(`lookup ${table.resolved} → ${rel.related} has no Created Relationships row`);
      }
    }
  }
  return { problems, log };
}

// Tables a generated page binds: the literal first argument of each dataApi row call. Calls are
// found in LITERAL-BLANKED source so a commented-out or quoted example never counts, and the name is
// read back from the original at the same offset (blankLiterals keeps offsets 1:1). A table passed
// through a variable is dynamic and not counted.
const DATA_API_ROW_CALL = /\bdataApi\s*\??\.\s*(?:queryTable|retrieveRow|retrieveMultipleRecords|createRow|updateRow|deleteRow)\s*\(\s*/g;
function boundTables(content) {
  const tables = new Set();
  for (const m of blankLiterals(content).matchAll(DATA_API_ROW_CALL)) {
    const literal = /^(['"`])([A-Za-z_]\w*)\1/.exec(content.slice(m.index + m[0].length));
    if (literal) tables.add(literal[2].toLowerCase());
  }
  return [...tables];
}

// Phase 6.5 operates on the files whose navigation still names a sibling: PAGEREF_ tokens in an
// authored snapshot, or — in a capture taken after the fix-up — the deployed GUIDs they became.
function navigationPhaseOf(fixture) {
  return fixture.manifest?.navigationPhase || 'authored';
}

function pagerefFiles(fixture) {
  const phase = navigationPhaseOf(fixture);
  const legacy = phase === 'legacy-authored';
  return (fixture.files || []).filter((file) => navTargets(file.content, { legacy })
    .some((t) => (phase === 'resolved' ? t.kind === 'literal' : t.kind === 'pageref' || t.kind === 'pageref-malformed')))
    .map((file) => file.name);
}

// The prompt an upload carried, by transport: the inline `--prompt "…"` value, the prompt file the
// file transport passes, or the `Prompt scope:` line the skill logs next to that command.
function uploadPrompt(fixture, upload) {
  if (typeof upload.flags.prompt === 'string') return upload.flags.prompt;
  if (typeof upload.flags['prompt-file'] === 'string') {
    try { return artifactText(fixture, upload.flags['prompt-file']); } catch { /* fall through to the logged scope */ }
  }
  return promptEvidence(fixture.workflowLog, upload.call.command);
}

// --- Eval 2 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): Data source question is skipped or answered 'mock data' — no entity detection needed",
  ({ fixture }) => {
    const { workflowLog: log, genpagePlan: plan } = fixture;
    if (!log) return fail('no workflow-log.md');
    if (!plan) return fail('no genpage-plan.md');
    // The data source must have resolved to mock data. A recorded answer says so directly, e.g.
    //   - Question 2 (data source): user answered "Mock data"
    //   AskUserQuestion: Dataverse entities or mock data? → mock data (pre-supplied)
    // and an unrecorded question was skipped — then the `Data mode: mock` the orchestrator hands the
    // page builder is the record of what it resolved to. Upload lines (`--data-sources`) are flags,
    // not answers.
    const answers = log.split(/\r?\n/).filter((line) => /\bdata[\s-]?source\b(?!s)|entities or mock data/i.test(line) && !/--data-sources/.test(line));
    const other = answers.find((line) => !/mock[\s-]?data|\bskipped\b/i.test(line));
    if (other) return fail(`the data-source question was not answered with mock data: ${other.trim()}`);
    if (!answers.length && !/Data mode:\s*`?mock\b/i.test(log)) return fail('workflow-log records no data-source answer and no mock data mode');
    if (entitiesNeedCreating(plan)) return fail('plan schedules entity creation for a mock-data page');
    const existing = existingEntities(plan);
    if (existing.length) return fail(`plan lists existing entities (${listText(existing)}) for a mock-data page`);
    const searches = listTablesSearches(fixture);
    if (searches.length) return fail(`entity detection ran for a mock-data page (list-tables --search ${listText(searches[0].terms)})`);
    return pass();
  }
);

// --- Eval 4 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): pac model list-tables --search 'incident,contact' is run; both entities confirmed as existing",
  ({ fixture }) => resultOf(existingEntityProblems(fixture, ['incident', 'contact']))
);

PHASE_EXPECTATIONS.set(
  'Phase 2: Entity-builder is SKIPPED',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    if (entitiesNeedCreating(fixture.genpagePlan)) return fail('plan schedules entity creation, so skipping the builder would leave its tables missing');
    if (entityBuilderInvoked(fixture)) return fail('entity-builder was invoked or entities were provisioned');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 4: pac model genpage generate-types --data-sources 'incident,contact' is run",
  ({ fixture }) => resultOf(generateTypesProblems(fixture, ['incident', 'contact'], { exact: true }))
);

PHASE_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Wizard sample (2-wizard-multi-step.tsx) is read',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    // `- Read sample: plugins/model-apps/samples/2-wizard-multi-step.tsx` — the READ, not merely
    // the plan's ## Relevant Samples row naming it.
    const read = fixture.workflowLog.split(/\r?\n/).some((line) => /\bread\b/i.test(line) && /samples[\\/]2-wizard-multi-step\.tsx\b/.test(line));
    return read ? pass() : fail('workflow-log does not record reading samples/2-wizard-multi-step.tsx');
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 6: Upload includes --data-sources 'incident,contact'",
  ({ fixture }) => resultOf(uploadSourcesProblems(fixture, ['incident', 'contact'], { exact: true }))
);

// --- Eval 5 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): task entity confirmed as existing; plan describes kanban with 3 columns mapped to task statecode/statuscode values',
  ({ fixture }) => {
    const problems = existingEntityProblems(fixture, ['task']);
    if (problems.length) return fail(problems[0]);
    const spec = planSection(fixture.genpagePlan, 'Per-Page Specifications') || '';
    const missing = ['To Do', 'In Progress', 'Done'].filter((label) => !new RegExp(`\\b${label}\\b`, 'i').test(spec));
    if (missing.length) return fail(`## Per-Page Specifications does not describe the ${missing.join(', ')} column(s)`);
    // e.g. `- Three columns mapped to task statuscode values: Open (1) = To Do, …`
    if (!spec.split(/\r?\n/).some((line) => /\bcolumns?\b/i.test(line) && /\b(?:statuscode|statecode)\b/.test(line))) {
      return fail('## Per-Page Specifications does not map the columns to task statuscode/statecode values');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 4: RuntimeTypes.ts is read — status field enum values are identified for column mapping',
  ({ fixture }) => {
    const calls = generateTypesCalls(fixture);
    if (!calls.length) return fail('pac model genpage generate-types was not run');
    // What the log records AFTER the command line, e.g.
    //   - Critical finding: planner's statuscode mapping was incorrect. RuntimeTypes shows:
    //     - `"Not Started" = 2` → To Do column
    // The identified `"Label" = value` pairs ARE the evidence of the read: they are checked against
    // the captured RuntimeTypes.ts below, so a guessed mapping cannot pass as a read one.
    const after = calls.map((c) => c.text.split(/\r?\n/).slice(1).join('\n')).join('\n');
    const pairs = [...after.matchAll(/"([^"\n]+)"\s*=\s*(-?\d+)/g)].map((m) => ({ label: m[1], value: Number(m[2]) }));
    if (!pairs.length) return fail('workflow-log does not record the status enum values read from RuntimeTypes.ts for the column mapping');
    if (fixture.runtimeTypes) {
      // Cross-check against the generated schema: an identified value that is not a member of the
      // table's statuscode/statecode enum was guessed, not read.
      const { registrations, enums } = runtimeEnums(fixture.runtimeTypes);
      const members = [...registrations].filter(([key]) => /-(?:statuscode|statecode)$/.test(key)).flatMap(([, name]) => enums.get(name) || []);
      if (!members.length) return fail('RuntimeTypes.ts registers no statuscode/statecode enum');
      const wrong = pairs.filter((p) => !members.some((m) => m.label === p.label && m.value === p.value));
      if (wrong.length) return fail(`recorded status values are not in RuntimeTypes.ts: ${wrong.map((p) => `"${p.label}" = ${p.value}`).join(', ')}`);
    }
    return pass();
  }
);

// --- Eval 7 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): pac model list-tables --search confirms cr_candidate and cr_jobrequisition do NOT exist (exact logical-name match, not fuzzy)',
  ({ fixture }) => resultOf(missingEntityProblems(fixture, ['cr_candidate', 'cr_jobrequisition'], { exact: true }))
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes entity definitions with columns, types, and a lookup relationship (cr_candidate → cr_jobrequisition)',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const blocks = planEntityBlocks(fixture.genpagePlan);
    const problems = [];
    for (const suffix of ['candidate', 'jobrequisition']) {
      const block = blocks.find((b) => b.suffix === suffix);
      if (!block) { problems.push(`## Entity Creation Required has no "### ${suffix}" definition`); continue; }
      if (!block.columns.length) problems.push(`${suffix} defines no columns`);
      const untyped = block.columns.filter((c) => !c.type || /^none$/i.test(c.type));
      if (untyped.length) problems.push(`${suffix} column(s) without a type: ${untyped.map((c) => c.suffix).join(', ')}`);
    }
    const candidate = blocks.find((b) => b.suffix === 'candidate');
    if (candidate && !candidate.relationships.some((r) => r.related === 'jobrequisition' && r.lookup && !/N\s*:\s*N/i.test(r.type))) {
      problems.push('candidate has no lookup relationship to jobrequisition');
    }
    return resultOf(problems);
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): Because entities will be created, the planner asks the solution selection question via AskUserQuestion and records the choice in ## Environment as 'Solution: <uniqueName>' and 'Publisher Prefix: <prefix>'",
  ({ fixture }) => resultOf(solutionChoiceProblems(fixture))
);

PHASE_EXPECTATIONS.set(
  "Phase 2b (Entity Builder): Reads Solution + Publisher Prefix from the plan's ## Environment",
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    // The builder copies what it read into its transaction log's own ## Environment (entity-builder
    // Step 3), so that block — not prose — is the record of what it read.
    const log = entityLog(fixture.entityCreationLog);
    if (!log) return fail('no genpage-entity-creation-log.md (or its legacy alias) recording the Environment the builder read');
    const solution = planSolution(fixture.genpagePlan);
    const prefix = planPrefix(fixture.genpagePlan);
    if (!solution || !prefix) return fail('plan ## Environment lacks Solution or Publisher Prefix');
    if (log.solution !== solution) return fail(`builder recorded Solution: ${log.solution || 'none'}, plan declares ${solution}`);
    if (log.prefix !== prefix) return fail(`builder recorded Publisher Prefix: ${log.prefix || 'none'}, plan declares ${prefix}`);
    // When the log restates it too (`Reads Solution=Default, Publisher Prefix=cr`), it must agree.
    const said = /Solution\s*=\s*([^,\s]+),?\s+Publisher Prefix\s*=\s*(\S+)/i.exec(fixture.workflowLog || '');
    if (said && (said[1] !== solution || said[2].toLowerCase() !== prefix)) {
      return fail(`workflow-log says the builder read Solution=${said[1]}, Publisher Prefix=${said[2]}`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): cr_jobrequisition (independent) is provisioned before cr_candidate (has lookup) to satisfy dependency ordering',
  ({ fixture }) => {
    const lookups = newTableLookups(fixture.genpagePlan);
    if (!lookups.some((l) => l.child === 'candidate' && l.parent === 'jobrequisition')) {
      return fail('plan declares no candidate → jobrequisition lookup to order by');
    }
    const log = entityLog(fixture.entityCreationLog);
    if (!log) return fail('no genpage-entity-creation-log.md (or its legacy alias)');
    // Created Tables is appended as each create succeeds, so its order is the provisioning order.
    const order = log.tables.map((t) => suffixOf(t.resolved || ''));
    const problems = [];
    for (const { child, parent } of lookups) {
      const p = order.indexOf(parent);
      const c = order.indexOf(child);
      if (p === -1 || c === -1) problems.push(`Created Tables does not record both ${parent} and ${child}`);
      else if (p > c) problems.push(`${child} (has the lookup) was provisioned before ${parent}`);
    }
    return resultOf(problems);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): provision-entities.js handles entity creation and column definitions atomically with internal propagation management',
  ({ fixture }) => {
    const calls = provisionCalls(fixture);
    if (!calls.length) return fail('provision-entities.js was not run');
    const legacy = legacyProvisionCalls(fixture);
    if (legacy.length) return fail(`per-object scripts were run alongside provision-entities.js: ${legacy[0].call.command.split(/\s/).find((t) => /\.js$/.test(t)) || 'legacy script'}`);
    if (!calls.some((c) => typeof c.flags.input === 'string' && c.flags.apply === true)) {
      return fail('provision-entities.js was not run with one --input <json> --apply');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Lookup relationship (cr_candidate → cr_jobrequisition) is provisioned via input JSON; provision-entities.js handles propagation internally',
  ({ fixture }) => {
    if (!provisionCalls(fixture).some((c) => typeof c.flags.input === 'string')) return fail('provision-entities.js was not run with --input <json>');
    if (legacyProvisionCalls(fixture).some((c) => /create-relationship\.js/.test(c.call.command))) {
      return fail('create-relationship.js was run instead of declaring the lookup in the input JSON');
    }
    const log = entityLog(fixture.entityCreationLog);
    if (!log) return fail('no genpage-entity-creation-log.md (or its legacy alias)');
    if (!log.relationships.some((r) => suffixOf(r.from) === 'jobrequisition' && suffixOf(r.to) === 'candidate')) {
      return fail('Created Relationships has no jobrequisition → candidate (1:N) row');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): User is asked about sample data via AskUserQuestion',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    const decision = recordedAnswer(fixture.workflowLog, SAMPLE_DATA_QUESTION);
    if (!decision) return fail('workflow-log records no answered sample-data question');
    if (decision.unattended && !isUnattendedLog(fixture.workflowLog)) return fail('sample data was defaulted in an attended run instead of asked');
    // The answer must be the one acted on: `--sample-data` appears exactly when the maker said yes.
    const accepted = /^\s*yes\b|\badd\b/i.test(decision.answer) && !/^\s*no\b|\bskip/i.test(decision.answer);
    const seeded = provisionCalls(fixture).some((c) => c.flags['sample-data'] === true);
    if (accepted !== seeded) return fail(`maker answered "${decision.answer}" but provisioning ${seeded ? 'seeded' : 'did not seed'} sample data`);
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Sample data is provisioned via provision-entities.js input JSON; parent references use $parent/match convention for dependency resolution',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    const decision = recordedAnswer(fixture.workflowLog, SAMPLE_DATA_QUESTION);
    if (decision && /^\s*no\b|\bskip/i.test(decision.answer)) return skip('maker declined sample data');
    const seeded = provisionCalls(fixture).filter((c) => c.flags['sample-data'] === true);
    if (!seeded.length) return fail('no provision-entities.js --sample-data run');
    if (!seeded.some((c) => typeof c.flags.input === 'string')) return fail('sample data was not passed through an --input <json>');
    if (legacyProvisionCalls(fixture).some((c) => /create-record\.js/.test(c.call.command))) return fail('rows were created with create-record.js instead of the input JSON');
    // provision-input.json itself is not captured; the builder's description of it is the record.
    // `$parent: { entity, match }` is how a child row names its parent row (entity-builder Step 7).
    if (newTableLookups(fixture.genpagePlan).length && !/\$parent\b[^\n]*\bmatch\b/i.test(fixture.workflowLog)) {
      return fail('child sample rows do not record the $parent/match parent reference');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Actual logical names are reported back (may be normalized by Dataverse); a transaction log at <working-dir>/genpage-entity-creation-log.md captures each successful operation',
  ({ fixture }) => {
    const { problems, log } = entityLogCoverageProblems(fixture);
    if (problems.length) return fail(problems[0]);
    const unreported = log.tables.map((t) => t.resolved).filter((name) => !new RegExp(`\\b${name}\\b`, 'i').test(fixture.workflowLog || ''));
    if (unreported.length) return fail(`resolved table name(s) not reported back in workflow-log: ${unreported.join(', ')}`);
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 4: pac model genpage generate-types is run with the created entity names',
  ({ fixture }) => resultOf(generateTypesProblems(fixture, createdTableNames(fixture)))
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Upload includes --data-sources with both created entity names',
  ({ fixture }) => {
    const created = createdTableNames(fixture);
    if (created.length !== 2) return fail(`expected two created tables, the run records ${listText(created)}`);
    return resultOf(uploadSourcesProblems(fixture, created));
  }
);

// --- Eval 10 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan records cr_widget under Entity Creation Required',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    // Matched on the suffix: the section stores suffixes only, and the prefix is the selected
    // publisher's (`### widget` + `Publisher Prefix: cnt` is the same request as cr_widget).
    if (!planEntityBlocks(fixture.genpagePlan).some((b) => b.suffix === 'widget')) {
      return fail('## Entity Creation Required has no "### widget" block');
    }
    if (existingEntities(fixture.genpagePlan).some((name) => suffixOf(name) === 'widget')) {
      return fail('## Existing Entities lists the widget table the plan is creating');
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2a: Orchestrator runs scripts/check-auth.js BEFORE invoking entity-builder; parses the returned JSON',
  // authGateProblems rejects an auth call whose result is missing or not a parsed { ok } object,
  // and any builder dispatch or provisioning call not preceded by a successful gate.
  ({ fixture }) => checkProblems(authGateProblems(fixture, { required: true }))
);

// --- Eval 11 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes 3 pages in the Pages table with distinct file names and purposes',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length !== 3) return fail(`## Pages has ${rows.length} row(s), expected 3`);
    const distinct = (values) => new Set(values.map((v) => v.trim().toLowerCase())).size === values.length;
    if (!distinct(rows.map((r) => r.file))) return fail(`## Pages file names are not distinct: ${rows.map((r) => r.file).join(', ')}`);
    if (rows.some((r) => !r.purpose.trim()) || !distinct(rows.map((r) => r.purpose))) return fail('## Pages purposes are missing or repeated');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Per-Page Specifications section has an entry for each of the 3 pages',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length !== 3) return fail(`## Pages has ${rows.length} row(s), expected 3`);
    const blocks = parsePerPageBlocks(planSection(fixture.genpagePlan, 'Per-Page Specifications') || '');
    const missing = rows.filter((r) => !blocks.has(r.page)).map((r) => r.page);
    return missing.length ? fail(`## Per-Page Specifications has no "### ${missing[0]}" entry`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5a: Orchestrator validates the plan — at least one page, unique filenames, each page has a matching Per-Page Specifications subsection',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    // The gate's observable outcome is what is graded: a plan that fails any Phase 5a rule must not
    // reach the builders. The rules are the plan-schema validator's (Pages table, page-file targets,
    // one matching Per-Page Specifications subsection per row) plus the at-least-one-page rule.
    const codes = new Set(['missing-pages-table', 'duplicate-page-file', 'invalid-page-file', 'missing-page-spec', 'extra-page-spec', 'page-file-mismatch']);
    const problems = validateGenpagePlanSchema(fixture.genpagePlan).filter((e) => codes.has(e.code)).map((e) => e.message);
    if (!pageRowsOf(fixture.genpagePlan).length) problems.unshift('plan has no pages');
    if (!problems.length) return pass();
    const built = (fixture.files || []).length > 0 || workflowCalls(fixture).some((c) => /genpage-page-builder/.test(c.command));
    return built ? fail(`pages were built from a plan that fails Phase 5a: ${problems[0]}`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 4: pac model genpage generate-types is run ONCE with --data-sources 'contact,appointment'; a single RuntimeTypes.ts is generated",
  ({ fixture }) => {
    const calls = generateTypesCalls(fixture);
    if (calls.length !== 1) return fail(`generate-types ran ${calls.length} time(s), expected once`);
    const problems = generateTypesProblems(fixture, ['contact', 'appointment'], { exact: true });
    if (problems.length) return fail(problems[0]);
    const output = fileName(calls[0].flags['output-file']);
    return output === 'RuntimeTypes.ts' ? pass() : fail(`generate-types wrote ${output || 'no --output-file'}, not RuntimeTypes.ts`);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5c: Each builder receives a distinct target filename — no two builders target the same file',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length < 2) return skip('single-page plan — no parallel builders');
    const targets = rows.map((r) => r.file.trim().toLowerCase());
    const dup = targets.find((file, i) => targets.indexOf(file) !== i);
    if (dup) return fail(`two pages target ${dup}`);
    // A shared target leaves one page's file missing and the other overwritten.
    const missing = rows.filter((r) => !(fixture.files || []).some((f) => f.name === r.file)).map((r) => r.file);
    if (missing.length) return fail(`no builder wrote ${missing.join(', ')}`);
    // When the dispatch is logged (`- Builder A target: candidate-list.tsx`), those targets too.
    const logged = [...String(fixture.workflowLog || '').matchAll(/\btarget:\s*`?([\w.-]+\.tsx)\b/gi)].map((m) => m[1].toLowerCase());
    const loggedDup = logged.find((file, i) => logged.indexOf(file) !== i);
    return loggedDup ? fail(`two builders were dispatched with target ${loggedDup}`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5c: Each builder reads the same genpage-plan.md but extracts only its own page specification',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length < 2) return skip('single-page plan — no parallel builders');
    // The dispatch prompts are not captured, so this grades the consequence: each page binds only
    // the tables ITS OWN specification declares, never a sibling's. `usersettings` is exempt —
    // references/localization.md mandates it on every localized page and it is never a page entity.
    const blocks = parsePerPageBlocks(planSection(fixture.genpagePlan, 'Per-Page Specifications') || '');
    for (const row of rows) {
      const block = blocks.get(row.page);
      if (!block) return fail(`## Per-Page Specifications has no "### ${row.page}" entry`);
      const file = (fixture.files || []).find((f) => f.name === row.file);
      if (!file) return fail(`${row.file} was not generated`);
      const declared = csvList((bulletFieldValues(block.lines, 'Entities')[0] || '').replace(/\([^)]*\)/g, ''));
      const foreign = boundTables(file.content).filter((t) => t !== 'usersettings' && !declared.includes(t));
      if (foreign.length) return fail(`${row.file} binds ${foreign.join(', ')}, which its own specification (Entities: ${listText(declared)}) does not declare`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5c: Each builder reads the same RuntimeTypes.ts for column verification',
  ({ fixture }) => {
    const calls = generateTypesCalls(fixture);
    if (!calls.length) return fail('pac model genpage generate-types was not run');
    const outputs = new Set(calls.map((c) => String(c.flags['output-file'] || '').replace(/\\/g, '/').toLowerCase()));
    if (outputs.size !== 1) return fail(`builders could read different schemas: generate-types wrote ${[...outputs].join(', ')}`);
    // Every Dataverse page resolves its types from the one sibling module the run generated.
    const rows = pageRowsOf(fixture.genpagePlan);
    const dataverse = rows.filter((r) => !/mock/i.test(r.entities));
    const unshared = dataverse.map((r) => (fixture.files || []).find((f) => f.name === r.file))
      .filter((f) => !f || !/from\s+['"]\.\/RuntimeTypes['"]/.test(f.content));
    if (unshared.length) return fail(`${unshared[0]?.name || 'a Dataverse page'} does not import the shared ./RuntimeTypes`);
    return pass();
  }
);

// Every planned page has exactly ONE create upload (no --page-id) whose --code-file is that page's
// file, and no create targets an unplanned file. Phase 6.5 updates are graded separately. When a
// create's result was recorded it must have succeeded with a page id no sibling shares — two pages
// collapsing into one id is what a shared file name would have caused.
function createUploadProblems(fixture, rows) {
  const creates = uploadCalls(fixture).filter((u) => !u.update);
  for (const row of rows) {
    const n = creates.filter((u) => u.file === row.file).length;
    if (n !== 1) return [`${row.file} has ${n} create upload(s) with --code-file pointing at it, expected 1`];
  }
  const stray = creates.filter((u) => !rows.some((r) => r.file === u.file));
  if (stray.length) return [`create upload with --code-file ${stray[0].file || 'missing'} matches no planned page`];
  // Historical captures summarize results in prose (Phase 6 "results" sections), so only a
  // contract-2 event's associated result is read here.
  const results = creates.filter((u) => !u.call.historical).map((u) => resultObject(u.call)).filter(Boolean);
  if (results.some((r) => r.ok === false)) return ['a create upload failed'];
  const ids = results.map((r) => String(r.pageId || '').toLowerCase()).filter(Boolean);
  if (new Set(ids).size !== ids.length) return [`two create uploads returned the same page id ${ids.find((id, i) => ids.indexOf(id) !== i)}`];
  return [];
}

PHASE_EXPECTATIONS.set(
  'Phase 6: All 3 pages are deployed via separate pac model genpage upload commands, each with the correct --code-file',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length !== 3) return fail(`## Pages has ${rows.length} row(s), expected 3`);
    return resultOf(createUploadProblems(fixture, rows));
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 5c: Cross-page navigation (e.g., candidate list → candidate detail) uses quoted `"PAGEREF_<filename>"` placeholders, never invented GUIDs',
  ({ fixture }) => {
    const files = fixture.files || [];
    if (files.length <= 1) return skip('single-page fixture');
    const legacy = navigationPhaseOf(fixture) === 'legacy-authored';
    if (!files.some((f) => navTargets(f.content, { legacy }).length)) return skip('no cross-page navigation in this build');
    // The same oracle as the common navigation assertion: before resolution every target is a
    // sibling PAGEREF; after it, every literal is an id from the deployed page map.
    return gradeEvidence(navigationProblems, fixture);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6.5: If any .tsx contains PAGEREF_ tokens, orchestrator builds a filename→page-id map sorted by length desc, replaces quoted `"PAGEREF_<name>"` tokens with the matching GUID (word-boundary safe), and re-uploads only affected files with the full update flag set',
  ({ fixture }) => {
    if (fixture.manifest?.navigation) return gradeEvidence(navigationProblems, fixture);
    const affected = pagerefFiles(fixture);
    if (!affected.length) return skip('no .tsx carries a PAGEREF_ navigation target');
    // The sort order is internal to the substitution; its observable result — every resolved target
    // is the deployed id of the sibling it named — is what navigationProblems checks.
    const nav = navigationProblems(fixture);
    if (nav.length) return fail(nav[0]);
    const uploads = uploadCalls(fixture);
    const updates = uploads.filter((u) => u.update);
    const reuploaded = updates.map((u) => u.file);
    const twice = reuploaded.find((file, i) => reuploaded.indexOf(file) !== i);
    if (twice) return fail(`${twice} was re-uploaded more than once`);
    if (!sameSet(reuploaded, affected)) return fail(`Phase 6.5 re-uploaded ${listText(reuploaded)}, but the affected files are ${listText(affected)}`);
    const returned = new Set([...String(fixture.workflowLog || '').matchAll(/page-id\s*[=:]\s*`?([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase()));
    for (const u of updates) {
      const missing = ['app-id', 'page-id', 'code-file'].filter((flag) => !u.flags[flag]);
      if (!u.flags.prompt && !u.flags['prompt-file']) missing.push('prompt');
      if (!u.flags['agent-message'] && !u.flags['agent-message-file']) missing.push('agent-message');
      if (missing.length) return fail(`${u.file}: re-upload lacks --${missing.join(', --')}`);
      if (u.flags['add-to-sitemap']) return fail(`${u.file}: re-upload passes --add-to-sitemap`);
      // Raw pac persists exactly the data sources it is given, so an update that drops them unbinds.
      const create = uploads.find((c) => !c.update && c.file === u.file);
      if (create && !sameSet(u.sources, create.sources)) return fail(`${u.file}: re-upload --data-sources ${listText(u.sources)} differs from its create (${listText(create.sources)})`);
      if (isGuid(u.flags['page-id']) && !returned.has(u.flags['page-id'].toLowerCase())) return fail(`${u.file}: --page-id ${u.flags['page-id']} was never returned by an upload`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 6.5: Re-upload uses a DELTA --prompt (e.g. 'Resolve cross-page navigation placeholders to real page GUIDs') — NOT a copy of the original page description from Phase 6",
  ({ fixture }) => {
    const uploads = uploadCalls(fixture);
    const updates = uploads.filter((u) => u.update);
    if (!updates.length) return skip('no Phase 6.5 re-upload recorded');
    const requirements = normalized(planSection(fixture.genpagePlan, 'User Requirements'));
    for (const u of updates) {
      const prompt = uploadPrompt(fixture, u);
      if (!prompt) return fail(`${u.file}: re-upload records no prompt`);
      if (requirements && normalized(prompt).includes(requirements)) return fail(`${u.file}: re-upload prompt restates ## User Requirements`);
      const create = uploads.find((c) => !c.update && c.file === u.file);
      const original = create && uploadPrompt(fixture, create);
      if (original && normalized(original) === normalized(prompt)) return fail(`${u.file}: re-upload prompt repeats the create prompt`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6.5: Unresolved PAGEREF tokens (typos, missing siblings) cause an explicit error to the user — never silently shipped',
  ({ fixture }) => {
    if (fixture.manifest?.navigation) return gradeEvidence(navigationProblems, fixture);
    const phase = navigationPhaseOf(fixture);
    const legacy = phase === 'legacy-authored';
    const siblings = new Set((fixture.files || []).map((f) => f.name.replace(/\.tsx$/i, '')));
    const shipped = [];
    const unresolved = [];
    let seen = false;
    for (const file of fixture.files || []) {
      for (const t of navTargets(file.content, { legacy })) {
        const token = t.kind === 'pageref' || (legacy && t.kind === 'pageref-malformed');
        if (token || t.kind === 'literal') seen = true;
        // The resolver substitutes only the canonical double-quoted token, so a malformed one would
        // reach the deployed page verbatim.
        if (!token && t.kind === 'pageref-malformed') shipped.push(`${file.name}: PAGEREF_${t.key} is not a resolvable double-quoted token`);
        else if (token && phase === 'resolved') shipped.push(`${file.name}: PAGEREF_${t.key} remains after resolution`);
        else if (token && !siblings.has(t.key)) unresolved.push({ file: file.name, key: t.key });
      }
    }
    if (!seen) return skip('no cross-page navigation in this build');
    if (shipped.length) return fail(`${shipped[0]} — an unresolved token was shipped`);
    for (const { file, key } of unresolved) {
      if (!new RegExp(`PAGEREF_${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(?:unresolved|no matching|missing)|(?:unresolved|no matching|missing)[^\\n]*PAGEREF_${key}`, 'i').test(fixture.workflowLog || '')) {
        return fail(`${file}: PAGEREF_${key} names no sibling page and no error was reported`);
      }
      if (uploadCalls(fixture).some((u) => u.update && u.file === file)) return fail(`${file}: re-uploaded despite unresolved PAGEREF_${key}`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 8: Summary table lists all 3 pages with their files, entities, and deployment status',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length !== 3) return fail(`## Pages has ${rows.length} row(s), expected 3`);
    const section = headingSection(fixture.workflowLog, /^#{2,3}\s+Phase\s*8\b/i);
    if (section === null) return fail('workflow-log has no Phase 8 summary');
    const summary = parseMarkdownRows(section, ['Page', 'File', 'Entities', 'Status']);
    if (!summary.length) return fail('Phase 8 has no | Page | File | Entities | Status | table');
    const uploads = uploadCalls(fixture);
    for (const row of rows) {
      const line = summary.find((s) => fileName(s.file.replace(/`/g, '')) === row.file);
      if (!line) return fail(`Phase 8 summary does not list ${row.file}`);
      if (!line.status.trim()) return fail(`Phase 8 summary gives ${row.file} no deployment status`);
      // The entities the page was actually deployed with, else (no upload recorded) the plan's.
      const create = uploads.find((u) => !u.update && u.file === row.file);
      const expected = create ? create.sources : csvList(row.entities);
      if (!sameSet(csvList(line.entities), expected)) return fail(`Phase 8 lists ${row.file} with entities ${line.entities}, deployed with ${listText(expected)}`);
    }
    return pass();
  }
);

// --- Eval 13 -----------------------------------------------------------------------------------

// LCIDs in the recorded `pac model list-languages` output. Two shapes are captured:
//   1033 English (United States) en-US No          (the PAC table)
//   English (United States) (1033, en-US), Arabic (Saudi Arabia) (1025, ar-SA)   (a summary)
// An LCID counts only next to a language tag, so a version or row count never does.
function detectedLanguages(fixture) {
  const calls = commandCalls(fixture, LIST_LANGUAGES);
  if (!calls.length) return null;
  const text = calls.map((c) => c.text).join('\n');
  return [...new Set([...text.matchAll(/\b(\d{4,5})\b[^\n]{0,60}?\b[a-z]{2,3}-[A-Z]{2,4}\b/g)].map((m) => Number(m[1])))];
}

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): pac model list-languages output includes Arabic (1025) and French (1036) in addition to English',
  ({ fixture }) => {
    const lcids = detectedLanguages(fixture);
    if (lcids === null) return fail('pac model list-languages was not run');
    const missing = [1033, 1025, 1036].filter((id) => !lcids.includes(id));
    return missing.length ? fail(`recorded list-languages output lacks LCID ${missing.join(', ')} (saw ${listText(lcids)})`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes a Localization section listing detected languages',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const lcids = detectedLanguages(fixture);
    if (lcids === null) return fail('pac model list-languages was not run, so no languages were detected');
    const section = headingSection(fixture.genpagePlan, /^#{2,3}\s+Localization\s*$/i);
    if (section === null) return fail('plan has no Localization section');
    const missing = lcids.filter((id) => !new RegExp(`\\b${id}\\b`).test(section));
    return missing.length ? fail(`Localization section does not list detected LCID ${missing.join(', ')}`) : pass();
  }
);

// --- Eval 15 -----------------------------------------------------------------------------------

// A choice column as Dataverse holds it after provisioning, read from the RuntimeTypes.ts that
// generate-types wrote from the live schema — the plan and the input JSON only say what was asked.
function picklistResult(fixture, tableSuffix, columnSuffix, { labels = null, count }) {
  if (!fixture.runtimeTypes) return skip('RuntimeTypes.ts was not captured');
  const found = choiceEnum(fixture.runtimeTypes, tableSuffix, columnSuffix);
  if (!found) return fail(`RuntimeTypes.ts registers no ${tableSuffix}-${columnSuffix} choice`);
  if (!found.members) return fail(`RuntimeTypes.ts has no body for enum ${found.name}`);
  const values = found.members.map((m) => m.value);
  if (found.members.length !== count) return fail(`${found.key} has ${found.members.length} option(s), expected ${count}`);
  if (values.some((value, i) => value !== 100000000 + i)) return fail(`${found.key} values are ${values.join(', ')}, expected ${count} consecutive from 100000000`);
  if (labels && found.members.some((m, i) => m.label !== labels[i])) {
    return fail(`${found.key} options are ${found.members.map((m) => `${m.label}=${m.value}`).join(', ')}`);
  }
  return pass();
}

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): cr_ticket is identified as NOT existing',
  ({ fixture }) => resultOf(missingEntityProblems(fixture, ['cr_ticket']))
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes choice column definitions for priority and status under Choice Columns, with numeric option values starting at 100000000',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const block = planEntityBlocks(fixture.genpagePlan).find((b) => b.suffix === 'ticket');
    if (!block) return fail('## Entity Creation Required has no "### ticket" block');
    for (const name of ['priority', 'status']) {
      const choice = block.choices.find((c) => c.suffix === name);
      if (!choice) return fail(`Choice Columns has no ${name} row`);
      if (!choice.options.length) return fail(`${name} lists no "Label (value)" options`);
      const values = choice.options.map((o) => o.value);
      if (values.some((value, i) => value !== 100000000 + i)) return fail(`${name} option values ${values.join(', ')} do not run from 100000000`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes a datetime column for due date',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const block = planEntityBlocks(fixture.genpagePlan).find((b) => b.suffix === 'ticket');
    if (!block) return fail('## Entity Creation Required has no "### ticket" block');
    const due = block.columns.find((c) => /due/.test(c.suffix));
    if (!due) return fail('ticket defines no due-date column');
    return /\bdate\s*(?:time|only)?\b/i.test(due.type) ? pass() : fail(`${due.suffix} has type ${due.type}, not datetime`);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Solution selection question is asked (because new entity will be created) and recorded in ## Environment',
  ({ fixture }) => resultOf(solutionChoiceProblems(fixture))
);

PHASE_EXPECTATIONS.set(
  'Phase 2a: scripts/check-auth.js returns ok:true before entity-builder is invoked',
  ({ fixture }) => {
    const problems = authGateProblems(fixture, { required: true });
    if (problems.length) return fail(problems[0]);
    const calls = workflowCalls(fixture);
    const builderAt = calls.findIndex((c) => BUILDER_CALL.test(c.command));
    if (builderAt === -1) return fail('entity-builder was never invoked');
    const gate = calls.slice(0, builderAt).filter((c) => isAuth(c.command)).at(-1);
    return resultObject(gate || {})?.ok === true ? pass() : fail('the last check-auth.js result before the entity-builder is not ok:true');
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Priority picklist has 4 options starting at 100000000 (Low=100000000, Medium=100000001, High=100000002, Critical=100000003)',
  ({ fixture }) => picklistResult(fixture, 'ticket', 'priority', { count: 4, labels: ['Low', 'Medium', 'High', 'Critical'] })
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Status picklist has 4 options starting at 100000000',
  ({ fixture }) => picklistResult(fixture, 'ticket', 'status', { count: 4 })
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Solution is specified via provision-entities.js input JSON; verified through ## Environment → Solution: declaration',
  ({ fixture }) => {
    const calls = provisionCalls(fixture);
    if (!calls.length) return fail('provision-entities.js was not run');
    if (!calls.some((c) => typeof c.flags.input === 'string')) return fail('provision-entities.js was not run with --input <json>');
    if (legacyProvisionCalls(fixture).length) return fail('per-object scripts were run instead of the input JSON');
    const solution = planSolution(fixture.genpagePlan);
    if (!solution) return fail('plan ## Environment declares no Solution');
    // provision-entities.js reads the solution from the JSON; an explicit flag must not contradict it.
    const flagged = calls.find((c) => typeof c.flags.solution === 'string' && c.flags.solution !== solution);
    if (flagged) return fail(`provision-entities.js --solution ${flagged.flags.solution} contradicts Solution: ${solution}`);
    const log = entityLog(fixture.entityCreationLog);
    if (log?.solution && log.solution !== solution) return fail(`transaction log records Solution: ${log.solution}, plan declares ${solution}`);
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Transaction log (genpage-entity-creation-log.md) records each create with its returned metadataId',
  ({ fixture }) => {
    const { problems, log } = entityLogCoverageProblems(fixture);
    if (problems.length) return fail(problems[0]);
    // provision-entities.js returns logical/schema names but no metadata ids, so the entity-builder
    // (Step 5) records `Metadata ID: n/a (SDK does not surface metadata ids)`. A GUID or that
    // documented n/a is a recorded value; an empty cell or a `...` placeholder is not.
    const recorded = (value) => /^(?:n\/a\b.*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(value || '').trim());
    const table = log.tables.find((t) => !recorded(t.metadataId));
    if (table) return fail(`Created Tables ${table.resolved || table.title} has Metadata ID ${table.metadataId || 'missing'}`);
    const column = log.columns.find((c) => !recorded(c.metadataId));
    return column ? fail(`Created Columns ${column.resolved} has Metadata ID ${column.metadataId ?? 'missing'}`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 4: pac model genpage generate-types picks up the enum registrations',
  ({ fixture }) => {
    const problems = generateTypesProblems(fixture, createdTableNames(fixture));
    if (problems.length) return fail(problems[0]);
    if (!fixture.runtimeTypes) return skip('RuntimeTypes.ts was not captured');
    const blocks = planEntityBlocks(fixture.genpagePlan);
    if (!blocks.some((b) => b.choices.length)) return fail('plan defines no choice columns whose enums could be registered');
    for (const block of blocks) {
      for (const choice of block.choices) {
        const found = choiceEnum(fixture.runtimeTypes, block.suffix, choice.suffix);
        if (!found?.members) return fail(`RuntimeTypes.ts EnumRegistrations has no ${block.suffix}-${choice.suffix} entry`);
        const want = choice.options.map((o) => o.value).join(',');
        const got = found.members.map((m) => m.value).join(',');
        if (want !== got) return fail(`${found.key} values ${got} differ from the plan's ${want}`);
      }
    }
    return pass();
  }
);

// --- Eval 19 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Edit Phase 1b: After app selection, pac model genpage list --app-id <selected> is run to discover pages — orchestrator does NOT guess or invent page names',
  ({ fixture }) => {
    if (!fixture.workflowLog) return fail('no workflow-log.md');
    const calls = workflowCalls(fixture);
    const at = (pattern) => calls.findIndex((c) => pattern.test(c.command));
    const download = commandCalls(fixture, /\bpac(?:\.exe|\.cmd)?\s+model\s+genpage\s+download\b/)[0];
    if (!download) return fail('pac model genpage download was not run, so no page was selected');
    const app = String(download.flags['app-id'] || '').toLowerCase();
    const page = String(download.flags['page-id'] || '').toLowerCase();
    const lists = commandCalls(fixture, GENPAGE_LIST).filter((c) => String(c.flags['app-id'] || '').toLowerCase() === app);
    if (!lists.length) return fail(`pac model genpage list --app-id ${app || '<selected>'} was not run`);
    // The edited page must come from that listing's recorded output, not from a guess. The call's
    // text also carries the selection that followed it (`- User selected "Seattle Weather"
    // (\`bb22…\`)`), which restates the id and so cannot count as the listing:
    //   - `pac model genpage list --app-id aa11…` → 2 pages found:
    //     - Seattle Weather — `bb223344-2233-2233-2233-bbccddee2345`
    const listed = (c) => c.text.split(/\r?\n/).some((line) => !/\bselect/i.test(line) && line.toLowerCase().includes(page));
    if (!page || !lists.some(listed)) return fail(`page ${page || '(none)'} does not appear in the recorded genpage list output`);
    const appsAt = at(/\bpac(?:\.exe|\.cmd)?\s+model\s+list(?![\w-])/);
    // commandCalls re-reads the log, so locate its calls in `calls` by their recorded command text.
    const positionOf = (entry) => calls.findIndex((c) => c.command === entry.call.command);
    const listAt = positionOf(lists[0]);
    if (appsAt === -1 || appsAt > listAt) return fail('pages were listed before the app was discovered with pac model list');
    if (listAt > positionOf(download)) return fail('the page was downloaded before pages were listed');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 4: genpage-edit-plan.md is written to the working directory root (not inside <page-id>/)',
  ({ fixture }) => {
    const log = fixture.workflowLog || '';
    if (!fixture.genpageEditPlan && !/\bEdit\s+Phase\b/i.test(log)) return skip('create flow — no genpage-edit-plan.md is written');
    // The loader reads genpage-edit-plan.md from the fixture root only, so its presence there is
    // the root write; a copy under the downloaded `<page-id>/` folder is the regression.
    if (!fixture.genpageEditPlan) return fail('genpage-edit-plan.md is not at the working-directory root');
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]+genpage-edit-plan\.md/i.test(log)) {
      return fail('workflow-log records genpage-edit-plan.md written inside the <page-id>/ folder');
    }
    let nested = [];
    try {
      nested = fs.readdirSync(fixture.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(fixture.dir, entry.name, 'genpage-edit-plan.md')))
        .map((entry) => entry.name);
    } catch { /* a fixture object without a directory on disk has no nested copy to find */ }
    return nested.length ? fail(`genpage-edit-plan.md also exists inside ${nested[0]}/`) : pass();
  }
);

// ---------------------------------------------------------------------------------------------
// Evals 3, 8, 9, 12, 14 and 16 — current contract-2 traces
// ---------------------------------------------------------------------------------------------
//
// These fixtures record commands as ordered tool-result events and the conversation (questions,
// plan presentations) in workflow-log.md, so checks read commands through workflowCalls/commandCalls
// and the conversation through conversationSteps or the log lines.

const PAC_MODEL_LIST = /\bpac(?:\.exe|\.cmd)?\s+model\s+list(?![\w-])/;
const PAC_MODEL_CREATE = /\bpac(?:\.exe|\.cmd)?\s+model\s+create\b/;
const GENPAGE_DOWNLOAD = /\bpac(?:\.exe|\.cmd)?\s+model\s+genpage\s+download\b/;
const PAGE_FILES_GATE = /\bcheck-page-files\.js\b/;
const WORKER_STAMP = /\bgenpage-worker-output\.js\b[^\n]*--stamp\b/;
const PAGE_BUILDER = /\b(?:Task|Dispatched)\s+genpage-page-builder\b/;
const PROVENANCE_VERIFY = /\bgenpage-plan-provenance\.js\b[^\n]*\bverify\b/;
const PROVENANCE_PREPARE = /\bgenpage-plan-provenance\.js\b[^\n]*\bprepare\b/;

function artifactOrNull(fixture, name) {
  try { return artifactText(fixture, name); } catch { return null; }
}

// Index of a commandCalls entry inside workflowCalls (commandCalls re-reads the evidence, so match on
// the recorded command text).
function callIndex(fixture, entry) {
  return entry ? workflowCalls(fixture).findIndex((c) => c.command === entry.call.command) : -1;
}

// The answer recorded with a question step: `… → <answer>` in a log line, or `"answer":"<answer>"`
// in an AskUserQuestion tool-result event.
function answerOf(step) {
  const json = /"answer"\s*:\s*"([^"]*)"/.exec(step);
  if (json) return json[1];
  const arrow = /(?:\u2192|->)\s*(.+)$/m.exec(step);
  return arrow ? arrow[1].trim() : null;
}

// The app and page the edit flow actually downloaded (`pac model genpage download --app-id --page-id`).
function downloadTarget(fixture) {
  const entry = commandCalls(fixture, GENPAGE_DOWNLOAD)[0];
  if (!entry) return null;
  return { entry, app: String(entry.flags['app-id'] || '').toLowerCase(), page: String(entry.flags['page-id'] || '').toLowerCase() };
}

// The question that follows a PAC listing must offer the listing's own rows — each offered GUID is
// one the listing returned, shown with the name the listing gave it — and the item the run went on
// with must be one of them. A log may record only the option the maker picked, so the check grades
// what was offered and chosen, not whether every listed row appeared.
function presentedFromListingProblems(fixture, { listing, noun, selected }) {
  const entry = commandCalls(fixture, listing).at(-1);
  if (!entry) return [`the ${noun} listing command was not run`];
  const rows = listingRows(entry.call);
  if (!rows.length) return [`the ${noun} listing recorded no ${noun}s to present`];
  const steps = conversationSteps(fixture);
  const listedAt = steps.findIndex((s) => listing.test(s));
  const question = steps.slice(listedAt + 1).find((s) => /AskUserQuestion/.test(s));
  if (!question) return [`no AskUserQuestion followed the ${noun} listing`];
  const offered = [...new Set([...question.matchAll(new RegExp(GUID_RE.source, 'gi'))].map((m) => m[0].toLowerCase()))];
  if (!offered.length) return [`the ${noun} question offers no ${noun} id from the listing`];
  for (const id of offered) {
    const row = rows.find((r) => r.id === id);
    if (!row) return [`the ${noun} question offers ${id}, which the listing does not contain`];
    if (row.name && !question.includes(row.name)) return [`the ${noun} question offers ${id} without its listed name "${row.name}"`];
  }
  if (selected && !rows.some((r) => r.id === selected)) return [`the ${noun} the run continued with (${selected}) is not in the listing`];
  if (selected && !offered.includes(selected)) return [`the ${noun} the run continued with (${selected}) was not among the offered ${noun}s`];
  return [];
}

// A lookup from the new table `child` to the new table `parent`, declared in the child's block.
function planLookupProblems(plan, child, parent) {
  if (!plan) return ['no genpage-plan.md'];
  const blocks = planEntityBlocks(plan);
  for (const suffix of [child, parent]) if (!blocks.some((b) => b.suffix === suffix)) return [`## Entity Creation Required has no "### ${suffix}" definition`];
  return newTableLookups(plan).some((l) => l.child === child && l.parent === parent) && blocks.find((b) => b.suffix === child).relationships.some((r) => r.related === parent && r.lookup)
    ? []
    : [`${child} has no lookup relationship to ${parent}`];
}

// provision-input.json, when captured: the App Spec the entity-builder handed provision-entities.js.
function provisionInput(fixture) {
  const entry = provisionCalls(fixture).find((c) => typeof c.flags.input === 'string');
  const name = entry ? fileName(String(entry.flags.input).replace(/^@/, '')) : 'provision-input.json';
  const text = artifactOrNull(fixture, name);
  if (text === null) return null;
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return undefined; }
}

const schemaSuffix = (name) => suffixOf(String(name || '').toLowerCase());

// Plan presentations and their outcomes, in log order. Shapes recorded by the skill:
//   - EnterPlanMode called with the initial plan:
//   - ExitPlanMode called → changes requested (revised): "add a search box in addition to …"
//   - Task genpage-planner re-invoked with the revision request …
//   - ExitPlanMode called → approved
//   - `node scripts\genpage-plan-provenance.js prepare --plan genpage-plan.md`   (the plan write starts)
function planModeEvents(log) {
  const events = [];
  String(log || '').split(/\r?\n/).forEach((line, at) => {
    if (/\bEnterPlanMode\b/.test(line) && !/\bnot\b/i.test(line)) events.push({ at, kind: 'present', line });
    else if (/\bExitPlanMode\b/.test(line)) {
      const kind = /changes?\s+requested|\brevis|\breject/i.test(line) ? 'changes' : /\bapproved\b/i.test(line) ? 'approved' : 'unknown';
      events.push({ at, kind, line });
    } else if (PROVENANCE_PREPARE.test(line)) events.push({ at, kind: 'write', line });
    else if (/\bgenpage-planner\b/.test(line) && /\b(?:re-?invoked|Task|Dispatched)\b/i.test(line)) events.push({ at, kind: 'planner', line });
  });
  return events;
}

function stalePlans(fixture) {
  return Object.entries(fixture.artifacts || {})
    .filter(([name]) => /^\.genpage-provenance\/genpage-plan\.stale-[^/]+\.md$/.test(name))
    .map(([, text]) => text);
}

// The first plan the run approved: the quarantined copy when the plan was rewritten, else the plan.
function initialPlan(fixture) {
  return stalePlans(fixture)[0] ?? fixture.genpagePlan;
}

const sameTargets = (a, b) => Boolean(a && b) && a.kind === b.kind && a.targets.join('\n') === b.targets.join('\n');
const sortedFiles = (files) => [...files].map((f) => String(f).trim()).sort();
const pageFilesOf = (plan) => pageRowsOf(plan).map((r) => r.file);

// --- Eval 3 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Edit Phase 1a: Apps are presented to the user via AskUserQuestion using the actual Display Name and app-id GUID from pac model list output',
  ({ fixture }) => resultOf(presentedFromListingProblems(fixture, { listing: PAC_MODEL_LIST, noun: 'app', selected: downloadTarget(fixture)?.app }))
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 1b: Pages are presented to the user via AskUserQuestion using the actual page names and page-id GUIDs from pac model genpage list output',
  ({ fixture }) => resultOf(presentedFromListingProblems(fixture, { listing: GENPAGE_LIST, noun: 'page', selected: downloadTarget(fixture)?.page }))
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 1c: Selection is restated to the user before proceeding to download',
  ({ fixture }) => {
    const target = downloadTarget(fixture);
    if (!target) return fail('pac model genpage download was not run, so nothing was selected');
    // e.g. `- "Editing **Contacts Directory** (2222…) in app **Sales Hub** (1111…). Continuing to download…"`
    // — a statement (not a question) naming both selected ids, after the page was chosen and before
    // the download command.
    const lines = String(fixture.workflowLog || '').split(/\r?\n/);
    const downloadAt = lines.findIndex((l) => GENPAGE_DOWNLOAD.test(l));
    if (downloadAt === -1) return fail('workflow-log does not record the download');
    let chosenAt = -1;
    lines.slice(0, downloadAt).forEach((l, i) => { if (/AskUserQuestion/.test(l) && l.toLowerCase().includes(target.page)) chosenAt = i; });
    const restated = lines.slice(chosenAt + 1, downloadAt).some((l) => !/AskUserQuestion/.test(l)
      && l.toLowerCase().includes(target.page) && l.toLowerCase().includes(target.app));
    return restated ? pass() : fail('no restatement of the selected app and page between the selection and the download');
  }
);

PHASE_EXPECTATIONS.set(
  "Edit Phase 3: config.json is read; since dataSources contains 'contact', RuntimeTypes.ts is generated",
  ({ fixture }) => {
    const target = downloadTarget(fixture);
    if (!target) return fail('pac model genpage download was not run');
    const configText = artifactOrNull(fixture, 'before/config.json');
    if (configText === null) return skip('the downloaded config.json was not captured');
    let config;
    try { config = JSON.parse(configText); } catch (error) { return fail(`downloaded config.json is not JSON: ${error.message}`); }
    const sources = (config.dataSources || []).map((s) => String(s).toLowerCase());
    if (!sources.includes('contact')) return fail(`downloaded config.json dataSources are ${listText(sources)}, not contact`);
    if (!/\bconfig\.json\b/.test(headingSection(fixture.workflowLog, /^#{2,3}\s+Edit Phase 3\b/i) || '')) return fail('Edit Phase 3 does not record reading config.json');
    const types = generateTypesCalls(fixture);
    const run = types.find((c) => sameSet(c.sources, sources));
    if (!run) return fail(`generate-types was not run with config.json's dataSources ${listText(sources)} (saw ${types.map((c) => listText(c.sources)).join('; ') || 'none'})`);
    if (callIndex(fixture, run) < callIndex(fixture, target.entry)) return fail('generate-types ran before the page was downloaded');
    return fileName(run.flags['output-file']) === 'RuntimeTypes.ts' ? pass() : fail('generate-types did not write RuntimeTypes.ts');
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 4: edit-planner reads page.tsx, config.json, and prompt.txt from the <page-id>/ folder',
  ({ fixture }) => {
    const plan = fixture.genpageEditPlan;
    if (!plan) return fail('no genpage-edit-plan.md');
    const target = downloadTarget(fixture);
    if (!target) return fail('pac model genpage download was not run');
    const prompt = artifactOrNull(fixture, 'before/prompt.txt');
    const configText = artifactOrNull(fixture, 'before/config.json');
    if (prompt === null || configText === null) return skip('the downloaded <page-id>/ snapshot was not captured');
    // The edit plan restates what the planner read (agents/genpage-edit-planner.md Step 4):
    //   - **Absolute path:** D:/work/x/<page-id>/page.tsx
    //   - **Original prompt (from prompt.txt):** <the downloaded prompt>
    //   - **Original data sources (from config.json):** contact
    // so each value is compared with the downloaded file it claims to come from.
    const field = (label) => new RegExp(`\\*\\*${label}[^*\\n]*\\*\\*\\s*(.+)`, 'i').exec(plan)?.[1].trim() ?? null;
    const file = String(field('Absolute path') || '').replace(/\\/g, '/').toLowerCase();
    if (!file.endsWith(`${target.page}/page.tsx`)) return fail(`edit plan's page.tsx (${file || 'none'}) is not inside the downloaded ${target.page}/ folder`);
    if (normalized(field('Original prompt')) !== normalized(prompt)) return fail('edit plan\'s original prompt differs from the downloaded prompt.txt');
    let config;
    try { config = JSON.parse(configText); } catch (error) { return fail(`downloaded config.json is not JSON: ${error.message}`); }
    const want = (config.dataSources || []).map((s) => String(s).toLowerCase());
    const got = csvList(field('Original data sources') || '');
    if (!sameSet(got, want)) return fail(`edit plan's original data sources ${listText(got)} differ from config.json's ${listText(want)}`);
    const planner = commandCalls(fixture, /\bgenpage-edit-planner\b/)[0];
    if (planner && callIndex(fixture, planner) < callIndex(fixture, target.entry)) return fail('the edit planner ran before the page was downloaded');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Edit Phase 5: Orchestrator reads genpage-edit-plan.md, rules.md, RuntimeTypes.ts, and page.tsx',
  ({ fixture }) => {
    const section = headingSection(fixture.workflowLog, /^#{2,3}\s+Edit Phase 5\b/i);
    if (section === null) return fail('workflow-log has no Edit Phase 5 section');
    // `- Orchestrator read genpage-edit-plan.md, references/rules.md, RuntimeTypes.ts and <id>/page.tsx`
    const reads = section.split(/\r?\n/).filter((l) => /\bread\b/i.test(l)).join('\n');
    const wanted = ['genpage-edit-plan.md', 'rules.md', 'page.tsx'];
    // RuntimeTypes.ts exists only when Edit Phase 3 generated it (a mock page has none to read).
    if (generateTypesCalls(fixture).length) wanted.push('RuntimeTypes.ts');
    const missing = wanted.filter((name) => !reads.includes(name));
    return missing.length ? fail(`Edit Phase 5 does not record reading ${missing.join(', ')}`) : pass();
  }
);

// The attribute text of every `<Name …>` opening tag in literal-blanked code. Attributes can hold
// arrow functions (`getRowId={(row) => row.id}`), so the tag ends at the first `>` outside braces,
// not at the first `>`.
function openingTags(code, name) {
  const tags = [];
  for (const m of code.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
      else if (code[i] === '>' && depth === 0) break;
    }
    tags.push(code.slice(m.index + m[0].length, i));
  }
  return tags;
}

PHASE_EXPECTATIONS.set(
  'Edit Phase 5: Search implementation uses Fluent UI V9 SearchBox or Input; sort uses column header handlers',
  ({ fixture }) => {
    const page = (fixture.files || []).find((f) => /(?:^|\/)page\.tsx$/.test(f.name)) || (fixture.files || [])[0];
    if (!page) return fail('no edited page.tsx');
    // Code view: comments and strings blanked, so a comment naming SearchBox proves nothing.
    const code = blankLiterals(page.content);
    const fluent = /import\s*\{([^}]*)\}\s*from\s*['"]@fluentui\/react-components['"]/.exec(page.content)?.[1] || '';
    const control = ['SearchBox', 'Input'].find((name) => new RegExp(`\\b${name}\\b`).test(fluent) && new RegExp(`<${name}\\b`).test(code));
    if (!control) return fail(`${page.name}: no Fluent UI V9 SearchBox or Input is imported and rendered`);
    if (/<(?:input|select|textarea)\b/.test(code)) return fail(`${page.name}: uses a raw HTML form element`);
    // Header-driven sorting: a sortable DataGrid with a sort handler and per-column compare, or table
    // header cells with click/sort handlers.
    const grid = openingTags(code, 'DataGrid').some((attrs) => /\bsortable\b/.test(attrs) && /\bonSortChange\b/.test(attrs)) && /\bcompare\s*:/.test(code);
    const headers = ['DataGridHeaderCell', 'TableHeaderCell'].some((tag) => openingTags(code, tag).some((attrs) => /\b(?:onClick|sortDirection)\b/.test(attrs)));
    return grid || headers ? pass() : fail(`${page.name}: columns are not sorted through column header handlers`);
  }
);

// --- Eval 8 ------------------------------------------------------------------------------------

function returnedAppId(entry) {
  const result = entry.call.historical ? null : resultObject(entry.call);
  const id = result?.appId || GUID_RE.exec(entry.text.split(/\r?\n/).slice(1).join('\n'))?.[0];
  return id ? String(id).toLowerCase() : null;
}

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): pac model list returns zero apps',
  ({ fixture }) => {
    const entry = commandCalls(fixture, PAC_MODEL_LIST)[0];
    if (!entry) return fail('pac model list was not run');
    const rows = listingRows(entry.call);
    if (rows.length) return fail(`pac model list returned ${rows.length} app(s)`);
    // Zero rows must be STATED, so an unparsed listing is never mistaken for an empty one:
    //   {"apps":[]}   /   → no model-driven apps found (0 apps returned)
    return /"apps"\s*:\s*\[\s*\]|\bno model-driven apps\b|\b0 apps\b/i.test(entry.text) ? pass() : fail('pac model list result does not record zero apps');
  }
);

// The create-or-cancel question asked after an empty app listing, with its recorded answer.
function createAppDecision(fixture) {
  const steps = conversationSteps(fixture);
  const listedAt = steps.findIndex((s) => PAC_MODEL_LIST.test(s));
  if (listedAt === -1) return { problem: 'pac model list was not run' };
  const question = steps.slice(listedAt + 1).find((s) => /AskUserQuestion/.test(s) && /\bcreate\b/i.test(s) && /\bcancel\b/i.test(s));
  if (!question) return { problem: 'no AskUserQuestion offered to create a new app or cancel after the app listing' };
  const answer = answerOf(question);
  return answer ? { answer, steps, listedAt } : { problem: 'the create-or-cancel answer is not recorded' };
}

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): User is asked via AskUserQuestion whether to create a new app or cancel',
  ({ fixture }) => {
    const decision = createAppDecision(fixture);
    return decision.problem ? fail(decision.problem) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): Plan records 'create new app' decision",
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const decision = createAppDecision(fixture);
    if (decision.problem) return fail(decision.problem);
    if (!/\bcreate\b/i.test(decision.answer) || /\bcancel\b/i.test(decision.answer)) return fail(`maker answered "${decision.answer}", not create`);
    if (!newAppNeeded(fixture.genpagePlan)) return fail('## Environment does not record "App: create new: <name>"');
    // When the maker named the app, the plan creates THAT app.
    const named = decision.steps.slice(decision.listedAt + 1).find((s) => /AskUserQuestion/.test(s) && /\bcalled\b|\bname\b/i.test(s));
    const name = named && answerOf(named);
    const app = /^\s*[-*]?\s*App:\s*(.+)$/im.exec(planSection(fixture.genpagePlan, 'Environment') || '')?.[1] || '';
    return name && !app.includes(name) ? fail(`plan App "${app.trim()}" is not the app the maker named ("${name}")`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Because a new app will be created, the planner asks the solution selection question and records the choice in ## Environment',
  ({ fixture }) => {
    if (!newAppNeeded(fixture.genpagePlan)) return fail('plan does not record a new app');
    return resultOf(solutionChoiceProblems(fixture));
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 3: The new app-id returned from pac model create is stored for Phase 6',
  ({ fixture }) => {
    const create = commandCalls(fixture, PAC_MODEL_CREATE)[0];
    if (!create) return fail('pac model create was not run');
    const solution = planSolution(fixture.genpagePlan);
    if (create.flags.solution !== solution) return fail(`pac model create --solution ${create.flags.solution || 'missing'} is not the plan's Solution: ${solution}`);
    const appId = returnedAppId(create);
    if (!appId) return fail('pac model create recorded no returned app-id');
    const upload = uploadCalls(fixture)[0];
    if (!upload) return fail('no upload consumed the stored app-id');
    if (callIndex(fixture, upload) < callIndex(fixture, create)) return fail('the first upload ran before the app was created');
    const used = String(upload.flags['app-id'] || '').toLowerCase();
    return used === appId ? pass() : fail(`the first upload used --app-id ${used || 'missing'}, not the created ${appId}`);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Upload uses the newly created app-id',
  ({ fixture }) => {
    const create = commandCalls(fixture, PAC_MODEL_CREATE)[0];
    if (!create) return fail('pac model create was not run');
    const appId = returnedAppId(create);
    if (!appId) return fail('pac model create recorded no returned app-id');
    const uploads = uploadCalls(fixture);
    if (!uploads.length) return fail('no genpage upload command recorded');
    const other = uploads.find((u) => String(u.flags['app-id'] || '').toLowerCase() !== appId);
    if (other) return fail(`${other.file || 'upload'}: --app-id ${other.flags['app-id'] || 'missing'} is not the created app ${appId}`);
    const result = uploads.map((u) => (u.call.historical ? null : resultObject(u.call))).find((r) => r?.appId && String(r.appId).toLowerCase() !== appId);
    return result ? fail(`upload result names app ${result.appId}, not the created ${appId}`) : pass();
  }
);

// --- Eval 9 ------------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): cr_project and cr_milestone confirmed as NOT existing',
  ({ fixture }) => resultOf(missingEntityProblems(fixture, ['cr_project', 'cr_milestone']))
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan includes a lookup relationship (cr_milestone → cr_project)',
  ({ fixture }) => resultOf(planLookupProblems(fixture.genpagePlan, 'milestone', 'project'))
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Solution selection question is asked because new entities will be created',
  ({ fixture }) => {
    if (!entitiesNeedCreating(fixture.genpagePlan)) return fail('plan schedules no entity creation');
    return resultOf(solutionChoiceProblems(fixture));
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): cr_project and cr_milestone entities are provisioned with lookup relationship (cr_milestone → cr_project) via provision-entities.js; dependency ordering is handled automatically',
  ({ fixture }) => {
    const calls = provisionCalls(fixture).filter((c) => typeof c.flags.input === 'string' && c.flags.apply === true);
    if (!calls.length) return fail('provision-entities.js was not run with --input <json> --apply');
    if (legacyProvisionCalls(fixture).length) return fail('per-object scripts were run, so ordering was not left to provision-entities.js');
    const failed = calls.find((c) => !c.call.historical && resultObject(c.call)?.ok !== true);
    if (failed) return fail('a provision-entities.js run did not return ok:true');
    const input = provisionInput(fixture);
    if (input === undefined) return fail('provision-input.json is not JSON');
    if (input) {
      // The App Spec declares both tables and the lookup; the CLI, not the builder, orders them.
      const tables = (input.entities || []).map((e) => schemaSuffix(e.schemaName));
      for (const suffix of ['project', 'milestone']) if (!tables.includes(suffix)) return fail(`provision-input.json does not declare ${suffix}`);
      const rel = (input.relationships || []).some((r) => /^OneToMany$/i.test(r.type)
        && schemaSuffix(r.referenced || r.referencedEntity) === 'project' && schemaSuffix(r.referencing || r.referencingEntity) === 'milestone');
      if (!rel) return fail('provision-input.json declares no project → milestone OneToMany relationship');
    }
    const log = entityLog(fixture.entityCreationLog);
    if (!log) return fail('no genpage-entity-creation-log.md');
    const order = log.tables.map((t) => suffixOf(t.resolved || ''));
    if (order.indexOf('project') === -1 || order.indexOf('milestone') === -1) return fail('Created Tables does not record both tables');
    if (order.indexOf('project') > order.indexOf('milestone')) return fail('milestone (has the lookup) was provisioned before project');
    if (!log.relationships.some((r) => suffixOf(r.from) === 'project' && suffixOf(r.to) === 'milestone')) return fail('Created Relationships has no project → milestone (1:N) row');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Sample data is created because the user explicitly requested it in the prompt',
  ({ fixture }) => {
    if (!/\bsample\s+data\b/i.test(planSection(fixture.genpagePlan, 'User Requirements') || '')) return fail('## User Requirements does not ask for sample data');
    const decision = recordedAnswer(fixture.workflowLog, SAMPLE_DATA_QUESTION);
    if (!decision) return fail('workflow-log records no answered sample-data question');
    if (!/^\s*yes\b|\badd\b/i.test(decision.answer) || /^\s*no\b|\bskip/i.test(decision.answer)) return fail(`sample data was requested but the answer was "${decision.answer}"`);
    const seeded = provisionCalls(fixture).filter((c) => c.flags['sample-data'] === true);
    if (!seeded.length) return fail('no provision-entities.js --sample-data run');
    if (seeded.some((c) => !c.call.historical && resultObject(c.call)?.ok !== true)) return fail('the --sample-data run did not return ok:true');
    const input = provisionInput(fixture);
    if (input && !Object.values(input.sampleData || {}).some((rows) => Array.isArray(rows) && rows.length)) return fail('provision-input.json carries no sampleData rows');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Sample records respect relationships (milestones reference projects via $parent/match convention)',
  ({ fixture }) => {
    const input = provisionInput(fixture);
    if (input === null) return skip('provision-input.json was not captured');
    if (input === undefined) return fail('provision-input.json is not JSON');
    // Each child row names its parent row the agents/genpage-entity-builder.md Step 7 way:
    //   "$parent": { "entity": "cr_Project", "match": { "cr_name": "Contoso Website Redesign" } }
    // and the match must hit a parent row actually seeded in the same input.
    const entries = Object.entries(input.sampleData || {});
    const rowsOf = (suffix) => entries.filter(([name]) => schemaSuffix(name) === suffix).flatMap(([, rows]) => rows || []);
    const parents = rowsOf('project');
    const children = rowsOf('milestone');
    if (!parents.length || !children.length) return fail('sampleData does not seed both projects and milestones');
    for (const [i, row] of children.entries()) {
      const ref = row.$parent;
      if (!ref || schemaSuffix(ref.entity) !== 'project' || !ref.match || !Object.keys(ref.match).length) return fail(`milestone row ${i + 1} has no $parent/match reference to a project`);
      const hit = parents.some((p) => Object.entries(ref.match).every(([k, v]) => p[k] === v));
      if (!hit) return fail(`milestone row ${i + 1} matches no seeded project (${JSON.stringify(ref.match)})`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Deployment includes --data-sources with both entity names',
  ({ fixture }) => {
    const created = createdTableNames(fixture);
    if (created.length !== 2) return fail(`expected two created tables, the run records ${listText(created)}`);
    return resultOf(uploadSourcesProblems(fixture, created));
  }
);

// --- Eval 12 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Initial plan is presented via EnterPlanMode',
  ({ fixture }) => {
    const events = planModeEvents(fixture.workflowLog);
    const first = events.find((e) => e.kind === 'present');
    if (!first) return fail('workflow-log records no EnterPlanMode presentation');
    const before = events.filter((e) => e.at < first.at).find((e) => ['approved', 'changes', 'write'].includes(e.kind));
    return before ? fail(`"${before.line.trim()}" precedes the first plan presentation`) : pass();
  }
);

// The first outcome after the first presentation, which must be a change request.
function revisionRequest(log) {
  const events = planModeEvents(log);
  const first = events.findIndex((e) => e.kind === 'present');
  const outcome = first === -1 ? null : events.slice(first + 1).find((e) => ['approved', 'changes', 'unknown'].includes(e.kind));
  return { events, first, outcome };
}

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): User requests a revision (ExitPlanMode with changes-requested response)',
  ({ fixture }) => {
    const { events, outcome } = revisionRequest(fixture.workflowLog);
    if (!outcome) return fail('no ExitPlanMode outcome follows the first presentation');
    if (outcome.kind !== 'changes') return fail(`the first ExitPlanMode outcome is "${outcome.line.trim()}", not a change request`);
    if (!/["\u201c][^"\u201d]+["\u201d]/.test(outcome.line)) return fail('the change request does not record what the maker asked for');
    const write = events.find((e) => e.kind === 'write' && e.at < outcome.at);
    return write ? fail('genpage-plan.md was written before the revision was requested') : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Planner revises the plan based on user feedback and re-enters plan mode',
  ({ fixture }) => {
    const { events, outcome } = revisionRequest(fixture.workflowLog);
    if (!outcome || outcome.kind !== 'changes') return fail('no change request to revise from');
    const after = events.filter((e) => e.at > outcome.at);
    const planner = after.find((e) => e.kind === 'planner');
    const again = after.find((e) => e.kind === 'present');
    if (!planner) return fail('genpage-planner was not re-invoked after the change request');
    if (!again) return fail('plan mode was not re-entered after the change request');
    return planner.at < again.at ? pass() : fail('plan mode was re-entered before the planner revised the plan');
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): Revised plan reflects the user's requested changes (search box added)",
  ({ fixture }) => {
    const approved = artifactOrNull(fixture, '.approved-genpage-plan.md');
    if (approved === null) return fail('the approved (revised) plan body .approved-genpage-plan.md was not saved');
    // The request was a search box IN ADDITION TO the filter toolbar, so both must be in the plan.
    if (!/\bsearch\s*box\b/i.test(approved)) return fail('the approved revised plan has no search box');
    if (!/\bfilter\s+toolbar\b/i.test(approved)) return fail('the approved revised plan dropped the filter toolbar');
    const spec = planSection(fixture.genpagePlan, 'Per-Page Specifications') || '';
    return /\bSearchBox\b|\bsearch\s*box\b/i.test(spec) ? pass() : fail('genpage-plan.md per-page specification has no search box');
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): User approves the revised plan on the second presentation',
  ({ fixture }) => {
    const events = planModeEvents(fixture.workflowLog);
    const presents = events.filter((e) => e.kind === 'present');
    if (presents.length < 2) return fail(`the plan was presented ${presents.length} time(s)`);
    const outcomeAfter = (p) => events.find((e) => e.at > p.at && ['approved', 'changes', 'unknown'].includes(e.kind));
    if (outcomeAfter(presents[0])?.kind !== 'changes') return fail('the first presentation was not answered with a change request');
    const second = outcomeAfter(presents[1]);
    if (second?.kind !== 'approved') return fail('the second presentation was not approved');
    if (presents[2] && presents[2].at < second.at) return fail('a third presentation preceded the approval');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): genpage-plan.md reflects the approved (revised) version, not the initial version',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('no genpage-plan.md');
    const approved = artifactOrNull(fixture, '.approved-genpage-plan.md');
    if (approved === null) return fail('the approved plan body .approved-genpage-plan.md was not saved');
    // The approval preview and the written plan are different documents; what both state is the page
    // files the run will write (plugins/model-apps/scripts/genpage-plan-provenance.js planTargets).
    const want = planTargets(approved, { kind: 'create' });
    const got = planTargets(fixture.genpagePlan, { kind: 'create' });
    if (!sameTargets(want, got)) return fail(`genpage-plan.md targets ${JSON.stringify(got?.targets)}, the approved plan ${JSON.stringify(want?.targets)}`);
    // The revision is what separates the approved version from the initial one.
    if (!/\bsearch\s*box\b|\bSearchBox\b/i.test(fixture.genpagePlan)) return fail('genpage-plan.md is the initial version: it has no search box');
    const events = planModeEvents(fixture.workflowLog);
    const approval = events.filter((e) => e.kind === 'approved').at(-1);
    const write = events.find((e) => e.kind === 'write');
    if (!approval || !write || write.at < approval.at) return fail('genpage-plan.md was not written after the final approval');
    const verify = commandCalls(fixture, PROVENANCE_VERIFY).at(-1);
    if (!verify || !/approved-genpage-plan\.md/.test(String(verify.flags.approved || ''))) return fail('genpage-plan.md was not provenance-verified against the approved body');
    return resultObject(verify.call)?.ok === true ? pass() : fail('provenance verification of genpage-plan.md did not pass');
  }
);

// --- Eval 14 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): Plan initially contains a Pages table with 2 pages',
  ({ fixture }) => {
    const plan = initialPlan(fixture);
    if (!plan) return fail('no genpage-plan.md');
    const rows = pageRowsOf(plan);
    return rows.length === 2 ? pass() : fail(`the first plan's ## Pages has ${rows.length} row(s), expected 2`);
  }
);

// The Phase 5a page-file gate's first verdict, with the dispatch steps it must precede.
function firstPageFilesGate(fixture) {
  const calls = workflowCalls(fixture);
  const at = calls.findIndex((c) => PAGE_FILES_GATE.test(c.command));
  const dispatchAt = calls.findIndex((c) => WORKER_STAMP.test(c.command) || PAGE_BUILDER.test(c.command) || isGeneration(c.command) || isUpload(c.command));
  return { calls, at, dispatchAt, result: at === -1 ? null : resultObject(calls[at]) };
}

PHASE_EXPECTATIONS.set(
  'Phase 5a: Orchestrator reads the Pages table and detects duplicate filenames',
  ({ fixture }) => {
    const plan = initialPlan(fixture);
    if (!plan) return fail('no genpage-plan.md');
    const files = pageFilesOf(plan);
    const { at, dispatchAt, result } = firstPageFilesGate(fixture);
    if (at === -1) return fail('check-page-files.js was not run');
    if (dispatchAt !== -1 && dispatchAt < at) return fail('page dispatch started before the page-file gate ran');
    if (!result || !Array.isArray(result.files)) return fail('check-page-files.js result is missing or malformed');
    if (sortedFiles(result.files).join('|') !== sortedFiles(files).join('|')) return fail(`the gate read ${listText(result.files)}, but the plan's Pages table lists ${listText(files)}`);
    // Recompute with the plugin's own rule so the recorded verdict cannot be taken on trust.
    const collisions = pageFileProblems(files, { workingDir: path.resolve(workingDirectoryOf(plan) || '.') }).filter((p) => p.code === 'collision');
    if (!collisions.length) return fail(`the first plan's files ${listText(files)} do not collide`);
    if (result.ok !== false || !(result.problems || []).some((p) => p.code === 'collision')) return fail('check-page-files.js did not report the collision');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 5a: check-page-files.js refuses the colliding plan and the orchestrator halts and re-plans through the planner (it never renames files itself), so genpage-plan.md carries unique, re-approved filenames (e.g., account-list.tsx, account-edit.tsx) before any builder is dispatched",
  ({ fixture }) => {
    const { calls, at, result } = firstPageFilesGate(fixture);
    if (at === -1 || result?.ok !== false) return fail('check-page-files.js did not refuse the first plan');
    const passAt = calls.findIndex((c, i) => i > at && PAGE_FILES_GATE.test(c.command) && resultObject(c)?.ok === true);
    if (passAt === -1) return fail('no later check-page-files.js run passed a re-planned genpage-plan.md');
    const between = calls.slice(at + 1, passAt);
    // Never renamed in place: the orchestrator does not edit the plan, the old plan is quarantined by
    // `prepare`, and the rewrite is provenance-verified against a re-approved body. Checked before the
    // dispatch rule because an in-place rename edit names `.tsx` files and would read as generation.
    if (between.some((c) => /^(?:Edit|Write)\b[^\n]*genpage-plan\.md/i.test(c.command))) return fail('the orchestrator edited genpage-plan.md itself');
    const dispatched = between.find((c) => WORKER_STAMP.test(c.command) || PAGE_BUILDER.test(c.command) || isGeneration(c.command) || isUpload(c.command));
    if (dispatched) return fail(`"${dispatched.command}" ran after the refusal, before a passing re-plan`);
    const firstDispatch = calls.findIndex((c) => WORKER_STAMP.test(c.command) || PAGE_BUILDER.test(c.command));
    if (firstDispatch !== -1 && firstDispatch < passAt) return fail('a builder target was stamped or dispatched before the re-planned files passed the gate');
    const prepare = between.find((c) => PROVENANCE_PREPARE.test(c.command));
    if (!prepare || !resultObject(prepare)?.quarantinedPath) return fail('the colliding plan was not quarantined before the planner rewrote it');
    const verify = between.filter((c) => PROVENANCE_VERIFY.test(c.command)).at(-1);
    if (resultObject(verify || {})?.ok !== true) return fail('the rewritten genpage-plan.md was not provenance-verified');
    const lines = String(fixture.workflowLog || '').split(/\r?\n/);
    // The refusal as logged under the gate command, e.g. `- Result: exit 3, {"ok":false,…"collision"…}`.
    // Anchored after the first check-page-files.js line and never a heading, so a title that merely
    // mentions the collision cannot stand in for it.
    const gateLine = lines.findIndex((l) => PAGE_FILES_GATE.test(l));
    const refusedAt = gateLine === -1 ? -1
      : lines.findIndex((l, i) => i >= gateLine && !/^\s*#/.test(l) && /"ok"\s*:\s*false|\bcollision\b|\bHALTED\b|\brefus/i.test(l));
    if (refusedAt === -1) return fail('workflow-log does not record the refusal');
    const after = planModeEvents(fixture.workflowLog).filter((e) => e.at > refusedAt);
    const planner = after.find((e) => e.kind === 'planner');
    const approval = after.find((e) => e.kind === 'approved');
    if (!planner || !approval || approval.at < planner.at) return fail('the renamed files were not re-planned by genpage-planner and re-approved');
    const files = pageFilesOf(fixture.genpagePlan);
    if (pageFileProblems(files, { workingDir: path.resolve(workingDirectoryOf(fixture.genpagePlan) || '.') }).length) return fail(`genpage-plan.md files ${listText(files)} are still unsafe`);
    const approved = artifactOrNull(fixture, '.approved-genpage-plan.md');
    if (approved === null) return fail('the re-approved plan body was not saved');
    const want = planTargets(approved, { kind: 'create' });
    const got = planTargets(fixture.genpagePlan, { kind: 'create' });
    return sameTargets(want, got) ? pass() : fail(`genpage-plan.md files ${JSON.stringify(got?.targets)} are not the re-approved ${JSON.stringify(want?.targets)}`);
  }
);

// `Task genpage-page-builder: Accounts, target file account-list.tsx` → account-list.tsx
function builderDispatches(fixture) {
  const calls = workflowCalls(fixture);
  return calls.map((c, i) => ({ c, i })).filter(({ c }) => PAGE_BUILDER.test(c.command))
    .map(({ c, i }) => ({ at: i, call: c, target: fileName((/target file\s+`?([^\s`,]+\.tsx)/i.exec(c.command) || [])[1] || '') }));
}

PHASE_EXPECTATIONS.set(
  'Phase 5c: Two page-builders are invoked in parallel with distinct target filenames',
  ({ fixture }) => {
    const builders = builderDispatches(fixture);
    if (builders.length !== 2) return fail(`${builders.length} page-builder dispatch(es) recorded, expected 2`);
    const targets = builders.map((b) => b.target);
    if (targets.some((t) => !t)) return fail('a page-builder dispatch names no target file');
    if (targets[0].toLowerCase() === targets[1].toLowerCase()) return fail(`both page-builders target ${targets[0]}`);
    if (!sameSet(targets, pageFilesOf(fixture.genpagePlan))) return fail(`builder targets ${listText(targets)} are not the plan's files`);
    // Parallel = one message: the two dispatches are adjacent, with no result gate between them.
    // That adjacency IS the observable SKILL.md 5c defines ("invoke them in a single message");
    // the log is not required to also SAY "single message" or "in parallel".
    if (builders[1].at !== builders[0].at + 1) return fail('the page-builders were not dispatched together');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 5c: No builder overwrites another builder's output (both .tsx files exist after Phase 5)",
  ({ fixture }) => {
    const files = pageFilesOf(fixture.genpagePlan);
    if (files.length < 2) return fail('the plan has fewer than two pages');
    const pages = files.map((name) => (fixture.files || []).find((f) => f.name === name));
    const missing = files.filter((_, i) => !pages[i]);
    if (missing.length) return fail(`${missing.join(', ')} does not exist after Phase 5`);
    if (new Set(pages.map((p) => p.content)).size !== pages.length) return fail('two page files hold identical content — one builder\'s output replaced the other');
    // Each target was stamped empty before its builder ran and passed the completeness gate after.
    const calls = workflowCalls(fixture);
    for (const name of files) {
      const stamp = calls.find((c) => WORKER_STAMP.test(c.command) && fileName(commandInfo(c).flags.file) === name);
      if (!stamp || resultObject(stamp)?.existed !== false) return fail(`${name} was not stamped as a fresh target`);
      const gate = calls.find((c) => /\bgenpage-worker-output\.js\b/.test(c.command) && !WORKER_STAMP.test(c.command) && fileName(commandInfo(c).flags.file) === name);
      if (resultObject(gate || {})?.ok !== true) return fail(`${name} did not pass the worker-output gate after its builder`);
    }
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 6: Both pages are deployed with their distinct filenames',
  ({ fixture }) => {
    const rows = pageRowsOf(fixture.genpagePlan);
    if (rows.length !== 2) return fail(`## Pages has ${rows.length} row(s), expected 2`);
    if (rows[0].file.toLowerCase() === rows[1].file.toLowerCase()) return fail(`both pages share ${rows[0].file}`);
    return resultOf(createUploadProblems(fixture, rows));
  }
);

// --- Eval 16 -----------------------------------------------------------------------------------

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): genpage-plan.md is written and conforms to references/plan-schema.md',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const errors = validateGenpagePlanSchema(fixture.genpagePlan);
    if (errors.length) return fail(errors[0].message);
    // "Written" by the planner in this run: the provenance verify of the file passed.
    const verify = commandCalls(fixture, PROVENANCE_VERIFY).at(-1);
    if (!verify) return fail('genpage-plan.md was not provenance-verified after it was written');
    const result = resultObject(verify.call);
    if (result?.ok !== true) return fail('provenance verification of genpage-plan.md did not pass');
    const targets = planTargets(fixture.genpagePlan, { kind: 'create' });
    return Array.isArray(result.targets) && targets && sortedFiles(result.targets).join('|') === targets.targets.join('|')
      ? pass() : fail(`the verified targets ${listText(result.targets || [])} are not this plan's files`);
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): genpage-plan.md contains ALL required sections with exact headings: # Genpage Plan, ## User Requirements, ## Working Directory, ## Plugin Root, ## Environment, ## Pages, ## Entity Creation Required, ## Existing Entities, ## Design Preferences, ## Relevant Samples, ## Per-Page Specifications',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const headings = ['# Genpage Plan', '## User Requirements', '## Working Directory', '## Plugin Root', '## Environment', '## Pages',
      '## Entity Creation Required', '## Existing Entities', '## Design Preferences', '## Relevant Samples', '## Per-Page Specifications'];
    const lines = fixture.genpagePlan.split(/\r?\n/).map((l) => l.trimEnd());
    const missing = headings.filter((h) => !lines.includes(h));
    return missing.length ? fail(`missing exact heading "${missing[0]}"`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): ## Pages table has at least one row with columns Page, File, Purpose, Entities',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (!rows.length) return fail('## Pages has no table with Page, File, Purpose and Entities columns, or no rows');
    const empty = rows.find((r) => ['page', 'file', 'purpose', 'entities'].some((c) => !String(r[c] || '').trim()));
    return empty ? fail(`## Pages row "${empty.page || '?'}" has an empty cell`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): ## Per-Page Specifications has one ### <Page Name> subsection for each row in ## Pages',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const rows = pageRowsOf(fixture.genpagePlan);
    if (!rows.length) return fail('## Pages has no rows');
    const blocks = parsePerPageBlocks(planSection(fixture.genpagePlan, 'Per-Page Specifications') || '');
    const missing = rows.find((r) => !blocks.has(r.page));
    if (missing) return fail(`## Per-Page Specifications has no "### ${missing.page}" subsection`);
    const extra = [...blocks.keys()].find((name) => !rows.some((r) => r.page === name));
    return extra ? fail(`"### ${extra}" has no ## Pages row`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): File names in ## Pages are unique',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const files = pageFilesOf(fixture.genpagePlan);
    if (!files.length) return fail('## Pages has no rows');
    // The plugin's own rule: names that collide on a case-insensitive filesystem are duplicates too.
    const collision = pageFileProblems(files, { workingDir: path.resolve(workingDirectoryOf(fixture.genpagePlan) || '.') }).find((p) => p.code === 'collision');
    return collision ? fail(`## Pages file names collide: ${collision.message}`) : pass();
  }
);

PHASE_EXPECTATIONS.set(
  "Phase 1 (Planner): Because the account entity exists, ## Entity Creation Required contains the literal string 'No entity creation required — all entities already exist.'",
  ({ fixture }) => {
    const problems = existingEntityProblems(fixture, ['account']);
    if (problems.length) return fail(problems[0]);
    const section = planSection(fixture.genpagePlan, 'Entity Creation Required') || '';
    return section.includes('No entity creation required — all entities already exist.') ? pass()
      : fail('## Entity Creation Required does not contain the exact no-entity sentence');
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 1 (Planner): ## Existing Entities contains the entity logical name used for RuntimeTypes generation (account)',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const existing = existingEntities(fixture.genpagePlan);
    if (!existing.includes('account')) return fail(`## Existing Entities lists ${listText(existing)}, not account`);
    const calls = generateTypesCalls(fixture);
    if (!calls.length) return fail('pac model genpage generate-types was not run');
    const unlisted = calls.flatMap((c) => c.sources).filter((s) => !existing.includes(s));
    if (unlisted.length) return fail(`generate-types used ${unlisted.join(', ')}, which ## Existing Entities does not list`);
    return calls.some((c) => c.sources.includes('account')) ? pass() : fail('generate-types was not run for account');
  }
);

module.exports = {
  WORKFLOW_ASSERTIONS,
  PHASE_EXPECTATIONS,
  planSection,
  validateGenpagePlanSchema,
  entitiesNeedCreating,
  newAppNeeded,
  logHas,
};
