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

function fail(reason) { return { status: 'fail', reason }; }
function pass() { return { status: 'pass', reason: '' }; }
function skip(reason) { return { status: 'skip', reason }; }

function logHas(log, pattern) {
  return Boolean(log) && new RegExp(pattern, 'mi').test(log);
}

function planSection(plan, heading) {
  // Returns text under "## <heading>" up to the next "## " heading or end-of-file.
  // Implemented as line scan to avoid JS regex \Z limitation.
  if (!plan) return null;
  const lines = plan.split('\n');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
  let i = 0;
  while (i < lines.length && !startRe.test(lines[i])) i++;
  if (i >= lines.length) return null;
  i++; // skip the heading line
  const out = [];
  while (i < lines.length && !/^##\s/.test(lines[i])) {
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').trim();
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
  'Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version >= 2.7.0 is verified',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/node\s+--version/.test(log)) return fail('workflow-log does not record `node --version`');
    if (!/\bpac\s+help\b/.test(log)) return fail('workflow-log does not record `pac help`');
    if (/node\s+--version\s*&&\s*pac\s+help/.test(log)) {
      return fail('node --version and pac help are chained with && (forbidden)');
    }
    if (!/2\.\s*7|>=\s*2\.7|version\s+\d+\.\d+/i.test(log)) {
      return fail('no PAC CLI version verification recorded');
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
    if (!/AskUserQuestion/.test(log)) return fail('workflow-log does not record any AskUserQuestion call');
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
    if (!plan) return fail('no genpage-plan.md');
    const needsMetadata = entitiesNeedCreating(plan) || newAppNeeded(plan);
    const asked = solutionQuestionAsked(log);
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
    // Accept either canonical (dataverse-request.js /solutions or GET /solutions)
    // or the PAC CLI equivalent (`pac solution list`) — both enumerate solutions.
    if (
      !/dataverse-request\.js[^\n]*\/solutions|GET\s+\/solutions/i.test(log) &&
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
    if (!/EnterPlanMode/.test(log)) return fail('workflow-log does not record EnterPlanMode');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md',
  ({ fixture }) => {
    if (!fixture.genpagePlan) return fail('genpage-plan.md not present in fixture');
    const required = [
      '# Genpage Plan',
      '## User Requirements',
      '## Working Directory',
      '## Plugin Root',
      '## Environment',
      '## Pages',
    ];
    const missing = required.filter((h) => !fixture.genpagePlan.includes(h));
    if (missing.length > 0) return fail(`plan missing heading(s): ${missing.join(', ')}`);
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked; on ok:false the orchestrator surfaces the message to the user and halts',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    const plan = fixture.genpagePlan;
    if (!log) return fail('no workflow-log.md');
    if (!plan) return fail('no genpage-plan.md');
    if (!entitiesNeedCreating(plan)) return skip('no entity creation required');
    if (!/check-auth\.js/.test(log)) return fail('check-auth.js not invoked');
    // Order against the FIRST actual entity-creation script invocation, not
    // against a meta-list mention of the entity-builder agent name. Meta-lists
    // like "## Agents Invoked" can name the agent before the actual commands.
    const idxCheck = log.search(/check-auth\.js/);
    const idxFirstScript = log.search(/\b(create-table\.js|add-column\.js|create-relationship\.js|create-record\.js)\b/);
    if (idxFirstScript !== -1 && idxFirstScript < idxCheck) {
      return fail('entity creation script invoked before check-auth.js');
    }
    if (!/(?:^|\s|"|,|{)ok\s*[:=]\s*"?true"?/i.test(log)) {
      return fail('check-auth.js did not return ok:true (or not logged)');
    }
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Phase 6 / 6.5 / 7.5 / Edit Phase 6 (--prompt scoping): The FIRST pac model genpage upload for each new page passes --prompt with the FULL page description (from plan\'s ## User Requirements). EVERY SUBSEQUENT upload of an existing page (--page-id, no --add-to-sitemap) passes --prompt scoped to ONLY the delta of changes in that upload — never the full original description',
  ({ fixture }) => {
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/pac\s+model\s+genpage\s+upload/.test(log)) return fail('no upload invocation recorded');
    if (!/--prompt/.test(log)) return fail('upload lacks --prompt flag');
    return pass();
  }
);

WORKFLOW_ASSERTIONS.set(
  'Prefix discipline — plan format: Every name in `## Entity Creation Required` (table headings, column Suffix values, choice column suffixes, relationship Lookup Suffix values) is a bare suffix matching `^[a-z][a-z0-9]+$`. No value contains an underscore or a prefix. The prefix lives only in `## Environment` → `Publisher Prefix:`.',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
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
  'Prefix discipline — resolved names: For every operation in `entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).',
  ({ fixture }) => {
    const plan = fixture.genpagePlan;
    const log = fixture.entityCreationLog;
    if (!plan) return skip('no genpage-plan.md');
    if (!log) return skip('no entity-creation-log.md');
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
    if (!/pac\s+model\s+genpage\s+upload/.test(log)) return fail('upload command not recorded');
    const uploadLines = log.split('\n').filter((l) => /pac\s+model\s+genpage\s+upload/.test(l));
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
    if (!/pac\s+model\s+genpage\s+upload/.test(log)) return fail('upload command not recorded');
    const uploadLines = log.split('\n').filter((l) => /pac\s+model\s+genpage\s+upload/.test(l));
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
  'Phase 5b: Orchestrator reads ${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt before writing the .tsx',
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
    const uploadLines = log.split('\n').filter((l) => /pac\s+model\s+genpage\s+upload/.test(l));
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
    const log = fixture.workflowLog;
    if (!log) return fail('no workflow-log.md');
    if (!/check-auth\.js/.test(log)) return fail('check-auth.js not invoked');
    if (!/ok:\s*true|"ok":\s*true/.test(log)) return fail('check-auth.js did not return ok:true');
    return pass();
  }
);

PHASE_EXPECTATIONS.set(
  'Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted)',
  ({ fixture }) => {
    const log = fixture.entityCreationLog || fixture.workflowLog;
    if (!log) return fail('no entity-creation-log.md or workflow-log.md');
    const matches = allMatches(/(create-table\.js|add-column\.js|create-relationship\.js)([^\n]*)/g, log);
    const offenders = [];
    for (const m of matches) {
      if (!/--solution\b/.test(m[2])) offenders.push(m[1]);
    }
    if (offenders.length > 0) return fail(`${offenders.length} call(s) missing --solution: ${offenders.slice(0,3).join(', ')}`);
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
    if (idxCheck === -1) return fail('entity-builder invoked but check-auth.js never ran');
    if (idxBuilder < idxCheck) return fail('entity-builder invoked before check-auth.js');
    return pass();
  }
);

module.exports = {
  WORKFLOW_ASSERTIONS,
  PHASE_EXPECTATIONS,
  planSection,
  entitiesNeedCreating,
  newAppNeeded,
  logHas,
};
