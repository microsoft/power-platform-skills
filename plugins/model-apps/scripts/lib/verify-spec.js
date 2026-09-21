'use strict';
// Reconcile an App Spec against a DEPLOYED app: for every declared entity/column/view/chart/form and
// every sitemap subarea (+ icon), check whether it actually exists server-side. Catches silent
// partial builds. Pure/testable: `read` provides the server lookups; `verifySpec` returns
// { ok, checks:[{kind,name,present,detail}], missing:[…] }.

const { odataLit } = require('./odata.js');
const { matchContainer, isEngineOwnedSection } = require('./form-container-match.js');
const { decodeXmlEntities } = require('./sitemap-pages.js');
const { normalizePageSource, relationshipSchemaName, manyToManySchemaName, SDK_ROLE_MARKER, canonicalPersonaName, bpfUniqueName, BPF_ROLE_ACCESS, generatedTabName, generatedSectionName, formColumnsOf } = require('./app-spec.js');
const { resolveExistingFormId, resolveRoleBusinessUnit, roleBuClause, appUniqueName, businessRuleFilter, bpfFilter, viewDef } = require('./sdk-build.js');
const { extractNavTargets } = require('./pageref-resolver.js');
const { AI_APP_SETTING, resolveAiFlags, specOptsIntoAi, featureWantValue, sameSettingValue, resolveAppModuleId, proveAppOverride } = require('./ai-app-settings.js');
const { declaredPrivileges, compareRolePrivileges } = require('./role-privileges.js');
const { resolveSurfaces } = require('./surface-resolver.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { isVisualizationUnsupported } = require('./entity-provision.js');

// The PER-APP setting each AI feature writes now lives in ./ai-app-settings.js, together with the
// flag-resolution and override-proof helpers the BUILD uses — see that module for why one source of
// truth matters here. Re-exported below so existing importers of this file keep working.

// `opts.proofAttempts` / `opts.proofDelayMs` tune the app-scope override retry (see the ai-feature
// block below). They exist so tests can drive the absent path without paying real backoff; the
// defaults are what the CLIs use.
async function verifySpec(spec, read, opts = {}) {
  const checks = [];
  const add = (kind, name, present, detail) => checks.push({ kind, name, present: !!present, detail: detail || '' });
  // Artifacts the BUILD reported as impossible on this environment, keyed `entity|name`. Supplied by
  // the caller because verify is also runnable standalone, where no build result exists — in that
  // case the set is empty and every declared rule is checked, which is the right default: absent a
  // build's own report, "not deployed" is the honest verdict.
  const environmentSkippedRules = new Set(
    ((opts.environmentSkipped && opts.environmentSkipped.businessRules) || []).map((k) => String(k)));
  // The phases the invocation actually ran, when it ran a SUBSET. A `--changed-only` fast apply runs
  // `phases: ['pages']`, so the business-rules loop never executes and `skipped.businessRules` comes
  // back empty — which made the skip list above useless on exactly the runs that need it most, and
  // reported every rule as missing on an environment that can never host one.
  //
  // Scoped to business rules on purpose. Business rules are the only artifact class that can be
  // PERMANENTLY absent through no fault of the run; everything else is absent because something
  // failed or has not been built yet, which is precisely what verify exists to report. Generalising
  // this would turn "verify is spec-complete regardless of --phases" into "verify checks whatever
  // this run happened to touch", and the failure mode of getting THAT wrong is a verify that
  // silently checks nothing.
  const ranPhases = Array.isArray(opts.phases) ? new Set(opts.phases) : null;
  const businessRulesPhaseRan = !ranPhases || ranPhases.has('business-rules');
  // Two DIFFERENT reasons a check was not performed, kept apart because they warrant opposite
  // messages. Reporting a phase that simply did not run as "this environment cannot host it" tells
  // an operator on a perfectly healthy environment that their environment is broken — and on the
  // normal `--changed-only` fast-apply path that would be wrong every single time.
  const environmentSkipped = [];
  const phaseSkipped = [];

  const selectedDefaultForms = new Map();
  for (const f of spec.forms || []) {
    const formType = f.formType || 'Main';
    if (formType !== 'Main') continue;
    const entity = String(f.entity || '').toLowerCase();
    if (!entity) continue;
    // Mirror the BUILD's promotion guard exactly (sdk-build.js `isOwnCustomTable`): the build
    // refuses to re-point the default form of a reused or stock table, because that is an
    // environment-wide side effect on a table the spec does not own. Asserting `isdefault` for a
    // table the build deliberately never promotes makes `--verify` permanently unsatisfiable for any
    // spec that puts a Main form on `account`, `contact`, or an `existing: true` table.
    const entSpec = (spec.entities || []).find((e) => e && String(e.schemaName || '').toLowerCase() === entity);
    const prefix = spec.solution && spec.solution.publisherPrefix;
    const isOwnCustomTable = !!(entSpec && entSpec.existing !== true && prefix &&
      String(entSpec.schemaName).toLowerCase().startsWith(String(prefix).toLowerCase() + '_'));
    if (!isOwnCustomTable) continue;
    const current = selectedDefaultForms.get(entity);
    if (!current || (f.isDefault === true && current.isDefault !== true)) selectedDefaultForms.set(entity, f);
  }

  // Entities + their declared columns.
  for (const e of spec.entities || []) {
    const logical = e.schemaName.toLowerCase();
    const tbl = await read.findTable(logical);
    add('entity', e.schemaName, tbl);
    if (tbl) {
      const cols = new Set(((await read.findColumns(logical)) || []).map((c) => String(c.logicalName || c).toLowerCase()));
      for (const c of e.columns || []) add('column', `${e.schemaName}.${c.schemaName}`, cols.has(String(c.schemaName).toLowerCase()));
      // Grid data visualization (preview). Reconciled by VALUE, not existence: the build writes a
      // specific renderer, so "a config row exists" would pass even if the deployed renderer were a
      // star rating where the spec asked for a radial dial.
      //
      // Guarded on the reader exposing the capability — most callers construct a reader with only
      // the methods they need, and an optional preview must never turn into a TypeError for them.
      // A 404 means the preview is not provisioned on this environment, which is exactly the case
      // the build SKIPS; reporting it as a failed check would flag every app on such an org for a
      // divergence the build deliberately declined to create.
      if (typeof read.columnVisualization === 'function') {
        for (const c of e.columns || []) {
          if (!c || c.visualization === undefined) continue;
          const name = `${e.schemaName}.${c.schemaName}`;
          let deployed;
          try {
            deployed = await read.columnVisualization(logical, String(c.schemaName).toLowerCase());
          } catch (err) {
            // Skip ONLY the "preview not provisioned here" case, matched on the server's
            // segment-missing phrasing rather than on the status alone. A bare `status === 404`
            // test also swallowed a row-level 404, turning a real divergence into silence.
            if (isVisualizationUnsupported(err)) continue;
            throw err;
          }
          add('column-visualization', name, deployed === c.visualization,
            deployed === c.visualization ? '' : `expected '${c.visualization}', deployed '${deployed}'`);
        }
      }
    }
  }

  // Views / charts / forms — by (entity, name) identity.
  for (const v of spec.views || []) {
    const viewName = `${String(v.entity).toLowerCase()}.${v.name}`;
    // Also select layoutxml so a CONTENT check can catch a view whose column set drifted from the spec
    // (reconcileView is additive-union, so a removed/renamed spec column would otherwise silently NOT
    // apply and still pass an existence-only verify). Best-effort: the column check only runs when the
    // deployed row actually carries layoutxml — an existence-only reader (no layoutxml) skips it.
    let rows = [];
    let readError = null;
    try {
      rows = await read.queryRecords('savedquery', { select: ['savedqueryid', 'layoutxml', 'fetchxml'], filter: `returnedtypecode eq '${String(v.entity).toLowerCase()}' and name eq '${odataLit(v.name)}'`, top: 1 });
    } catch (error) {
      readError = error;
    }
    const row = rows && rows[0];
    add('view', viewName, row, readError ? String(readError.message || readError) : '');
    const specCols = (v.columns || []).map((c) => String(c).toLowerCase());
    if (row && row.layoutxml && specCols.length) {
      // Deployed column set from the saved view's layoutxml (<cell name="…"/> per column). We require
      // spec columns ⊆ deployed columns (NOT set-equality): a deployed EXTRA column (default-view
      // enrichment, or a maker's manual add) is fine; a MISSING spec column is the divergence we flag.
      const deployed = new Set(layoutColumnNames(row.layoutxml));
      const missingCols = specCols.filter((c) => !deployed.has(c));
      add('view-columns', viewName, missingCols.length === 0, missingCols.length ? `missing column(s): ${missingCols.join(', ')}` : '');
    }
    if (row && Object.prototype.hasOwnProperty.call(row, 'fetchxml')) {
      const expected = expectedViewFetchParts(spec, v);
      // Dataverse stores savedquery.fetchxml as the authoritative query content for a system view, so
      // the verifier proves the DEPLOYED predicates/orders rather than trusting the build's intended
      // view definition. Subset semantics are deliberate: Dataverse may add platform-owned predicates
      // that the App Spec never authored, and those must not block a good app.
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/savedquery
      if (!row.fetchxml && (expected.conditions.length || expected.orders.length)) {
        if (expected.conditions.length) add('view-filters', viewName, false, 'could not read deployed savedquery.fetchxml to prove authored filters');
        if (expected.orders.length) add('view-sort', viewName, false, 'could not read deployed savedquery.fetchxml to prove authored sort');
        continue;
      }
      const actual = parseFetchXml(row.fetchxml);
      if (expected.conditions.length) {
        const missing = expected.conditions.filter((want) => !actual.conditions.some((got) => conditionMatches(want, got)));
        add('view-filters', viewName, missing.length === 0, missing.length ? `missing filter(s): ${missing.map(formatCondition).join('; ')}` : '');
      }
      if (expected.orders.length) {
        // Sort PRECEDENCE is the whole point of a sort, so membership is not enough: a deployed
        // `[name asc, createdon desc]` would satisfy an authored `[createdon desc, name asc]` under a
        // per-order `some(...)`, even though the two views return rows in different orders.
        //
        // Authored orders must therefore appear as an ordered SUBSEQUENCE of the deployed ones.
        // Extra platform-owned orders are still tolerated (same subset rule as the filters above),
        // but the authored ones may not be reordered relative to each other.
        let ei = 0;
        for (const got of actual.orders) {
          if (ei < expected.orders.length && orderMatches(expected.orders[ei], got)) ei++;
        }
        const satisfied = ei === expected.orders.length;
        const absent = expected.orders.filter((want) => !actual.orders.some((got) => orderMatches(want, got)));
        add('view-sort', viewName, satisfied, satisfied ? ''
          : absent.length
            ? `missing sort(s): ${absent.map(formatOrder).join('; ')}`
            : `deployed sort order does not match the authored precedence ${expected.orders.map(formatOrder).join(', ')} (deployed: ${actual.orders.map(formatOrder).join(', ')})`);
      }
    }
  }
  for (const ch of spec.charts || []) {
    const rows = await read.queryRecords('savedqueryvisualization', { select: ['savedqueryvisualizationid'], filter: `primaryentitytypecode eq '${String(ch.entity).toLowerCase()}' and name eq '${odataLit(ch.name)}'`, top: 1 });
    add('chart', ch.name, rows && rows[0]);
  }
  for (const f of spec.forms || []) {
    const name = f.name || `${f.entity} form`;
    // Resolve with the SAME identity the build reconcile uses — (entity, name, TYPE) or a validated pinned
    // formId (which checks the row's table/type/name) — so verify can't be fooled by a same-named sibling
    // of another type, a mismatched pin, or a residual (entity,type,name) collision. resolveExistingFormId
    // THROWS on a collision / bad pin → treat as NOT cleanly present (present:false surfaces the problem);
    // a not-yet-created table (MetadataCache 400) resolves to null → correctly reported missing.
    let id = null;
    try {
      id = await resolveExistingFormId(read, { entityLogicalName: String(f.entity).toLowerCase(), name, formType: f.formType, formId: f.formId });
    } catch { id = null; }
    add('form', name, id);
    const entityLogical = String(f.entity || '').toLowerCase();
    if (id && selectedDefaultForms.get(entityLogical) === f && typeof read.formDefaultState === 'function') {
      let state = null;
      let readError = null;
      try { state = await read.formDefaultState(entityLogical, id); } catch (e) { readError = (e && e.message) || String(e); }
      // Default-form promotion is a stored systemform flag, not a property of the App Spec or the
      // build result. A form can exist with the right name/type while still not being the table's
      // default, so this proves the platform row the model-driven runtime uses.
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform
      const present = !!(state && state.isDefault === true);
      add('form-default', `${entityLogical}.${name}`, present, present ? '' :
        readError
          ? `could not read deployed systemform.isdefault: ${readError}`
          : `expected this Main form to be the table default, but deployed systemform.isdefault is ${state && state.isDefault === false ? 'false' : 'unreadable'}`);
    }
  }

  // Relationships (existence) — currently a build can declare a relationship that silently fails to
  // materialize and still pass verify (relationships weren't checked at all). Best-effort: only when the
  // reader can list a child entity's relationship schema names (`entityRelationships`). Match the same
  // schema name the build/teardown compute (relationshipSchemaName / manyToManySchemaName), so an
  // explicit schemaName or an auto-prefixed system-table relationship is compared correctly.
  if (typeof read.entityRelationships === 'function') {
    const prefix = spec.solution && spec.solution.publisherPrefix;
    const relCache = new Map(); // childLogical -> Set(schemaName lower) — one metadata read per child
    for (const r of spec.relationships || []) {
      const schema = String(r.type === 'ManyToMany' ? manyToManySchemaName(r, prefix) : relationshipSchemaName(r, prefix)).toLowerCase();
      // A 1:N relationship lives on the referencing (child) entity; an N:N is symmetric — check entity1.
      const child = String((r.type === 'ManyToMany' ? (r.entity1 || r.entity2) : r.referencing) || '').toLowerCase();
      if (!child) continue;
      if (!relCache.has(child)) {
        let names = [];
        try { names = (await read.entityRelationships(child)) || []; } catch { names = []; }
        relCache.set(child, new Set(names.map((n) => String(n).toLowerCase())));
      }
      add('relationship', schema, relCache.get(child).has(schema));
    }
  }

  // Form TOPOLOGY. Existence is not proof of shape: every wrong-layout defect this plugin has hit —
  // fields flattened into the first section, a duplicate tab appended on each rebuild, a relocated
  // field piled into an already-full row — deployed a form that EXISTS with the right name and type,
  // so verify reported an unqualified PASS while the layout was wrong.
  //
  // Scope is deliberately the AUTHORED subset, not an exact match: the engine appends sub-grid and
  // notes sections the spec never declares, and a maker may add their own. So this asserts that every
  // tab and section the author declared is present, and that every field lands in the section the
  // author put it in — and says nothing about containers it did not declare.
  //
  // Only EXPLICIT layouts are checked. An `auto` layout declares no shape to honour, so there is
  // nothing to verify beyond the field list the existing checks already cover.
  //
  // Fail-closed: when the formxml cannot be read the check is reported NOT present with the read
  // error, never skipped — "we could not look" must not read as "the layout is correct". That
  // applies to a MISSING READER CAPABILITY too: gating the whole oracle on
  // `typeof read.formTopology === 'function'` let a reader without it skip every layout check, so an
  // explicit form passed verify on identity and default checks alone with no layout proof at all.
  const canReadTopology = typeof read.formTopology === 'function';
  {
    for (const f of spec.forms || []) {
      if (!Array.isArray(f.tabs) || !f.tabs.length) continue;
      const entity = String(f.entity || '').toLowerCase();
      const name = f.name || `${f.entity} form`;
      if (!canReadTopology) {
        add('form-topology', `${entity}.${name}`, false,
          'this reader exposes no deployed-layout source, so the layout is UNVERIFIED — not proven correct');
        continue;
      }
      let id = null;
      let idError = null;
      try {
        id = await resolveExistingFormId(read, { entityLogicalName: entity, name, formType: f.formType, formId: f.formId });
      } catch (e) { idError = (e && e.message) || String(e); }
      if (!id) {
        // A form that genuinely does not exist was already reported by the existence check above, so
        // saying it twice adds nothing. A FAILED resolution is different: the form may well be there
        // and correct, and silently skipping the layout check let a transient read failure pass as a
        // verified layout.
        if (idError) {
          add('form-topology', `${entity}.${name}`, false,
            `could not resolve the deployed form id (${idError}) — the layout is unverified, not proven correct`);
        }
        continue;
      }

      let xml = null;
      let readError = null;
      try { xml = await read.formTopology(entity, id); } catch (e) { readError = (e && e.message) || String(e); }
      if (!xml) {
        add('form-topology', `${entity}.${name}`, false,
          `could not read the deployed form layout${readError ? `: ${readError}` : ''} — the layout is unverified, not proven correct`);
        continue;
      }

      const deployed = parseFormTopology(xml);
      // Where the DEPLOYED form actually placed each bound field, as the IDENTITY of the section
      // holding it — not merely its name.
      //
      // A name alone aliases: the builder can produce two sections called `packed_fields` in
      // DIFFERENT tabs (one holding the fields, one empty in the requested tab), and a name-keyed
      // comparison found the empty one equal to the real one and reported verify PASS while the
      // requested relocation had not happened. Live-reproduced: 28/28 PASS against a form whose
      // fields were in the wrong tab.
      //
      // The identity is the section object itself, so a later comparison can ask "is this the SAME
      // section I matched?" rather than "does it have the same name as the one I matched?".
      const placedIn = new Map();
      for (const t of deployed) for (const c of t.columns || []) for (const sec of c.sections || []) {
        for (const fl of sec.fields || []) if (!placedIn.has(fl)) placedIn.set(fl, sec);
      }

      const problems = [];
      // Match containers the way the BUILD does — name, then label, then position — using the same
      // function it uses. A label- or position-matched container deliberately KEEPS its deployed
      // name (form scripts and business rules reference section names), so looking one up by the
      // AUTHORED name reported a perfectly good auto-to-explicit migration as "section absent" and
      // failed a build that had done exactly what was asked. Live-reproduced.
      const claimedTabs = new Set();
      f.tabs.forEach((t, ti) => {
        if (!t || typeof t !== 'object') return;
        const tabName = String(t.name || generatedTabName(ti)).toLowerCase();
        // Match the label the COMPILER emits, not the raw authored one. `compileFormIntent` defaults
        // a tab to 'General' and a section to 'Details', so the deployed container carries the
        // default — comparing against `undefined` would skip the label pass and fall through to
        // position, picking a different container than the build did.
        const tabHit = matchContainer(deployed, { name: tabName, label: t.label || 'General' }, ti, { claimed: claimedTabs });
        if (!tabHit) { problems.push(`tab '${tabName}' is absent`); return; }
        claimedTabs.add(tabHit.index);
        const got = tabHit.item;
        const authoredColumns = formColumnsOf(t);
        if ((got.columns || []).length < authoredColumns.length) {
          problems.push(`tab '${tabName}' has ${(got.columns || []).length} form-column(s), the spec declares ${authoredColumns.length}`);
        }
        authoredColumns.forEach((col, ci) => {
          const sections = (col && Array.isArray(col.sections)) ? col.sections : [];
          const deployedSections = ((got.columns || [])[ci] || {}).sections || [];
          const claimedSections = new Set();
          sections.forEach((sec, si) => {
            if (!sec || typeof sec !== 'object') return;
            const secName = String(sec.name || generatedSectionName(ti, ci, si)).toLowerCase();
            const secHit = matchContainer(deployedSections, { name: secName, label: sec.label || 'Details' }, si,
              { claimed: claimedSections, skip: isEngineOwnedSection });
            if (!secHit) {
              problems.push(`section '${secName}' is absent from tab '${tabName}' form-column ${ci + 1}`);
              return;
            }
            claimedSections.add(secHit.index);
            // The AUTHORED grid width — the expectation. Absent means the author stated none, so the
            // deployed width is not compared and a span is checked against its raw authored value.
            const wantCols = Number(sec.columns);
            const haveWantCols = Number.isFinite(wantCols) && wantCols >= 1;
            // GRID WIDTH. Checked independently, because the span comparison below derives its
            // expectation from the AUTHORED width: without this, a section deployed narrower than
            // asked would go unreported AND would quietly lower the span expectation to match
            // itself.
            const secCols = Number(secHit.item.columns);
            if (haveWantCols && Number.isFinite(secCols) && secCols !== wantCols) {
              problems.push(`section '${secName}' is deployed ${secCols} column(s) wide, the spec declares ${wantCols}`);
            }
            // OCCUPANCY: no deployed row may carry more columns of content than its section has.
            // This is the shape defect the reconcile fixes (a field packed into a full row, or a
            // widened span overflowing one), and a field-to-section check alone cannot see it.
            // Skipped when the deployed section declares no width — unknown is not "one".
            if (Number.isFinite(secCols) && secCols >= 1) {
              for (const [ri, drow] of (secHit.item.rows || []).entries()) {
                const used = (drow.cells || []).reduce((n, c) => n + (Number(c.colspan) || 1), 0);
                if (used > secCols) {
                  problems.push(`section '${secName}' row ${ri + 1} carries ${used} columns of content in a ${secCols}-column section`);
                }
              }
            }
            // A span the author DECLARED must be the deployed span. An UNDECLARED one is not
            // checked — the build never writes it, so a maker's hand-widened cell must survive
            // both the rebuild and the verification.
            const deployedCellOf = (logical) => (secHit.item.rows || [])
              .flatMap((r2) => r2.cells || [])
              .find((c) => c.control && c.control.fieldName === logical);
            for (const entry of (sec.fields || [])) {
              if (!entry || typeof entry !== 'object') continue;
              const fl = String(entry.name || '').toLowerCase();
              if (!fl) continue;
              const dc = deployedCellOf(fl);
              if (!dc) continue; // placement is reported separately below
              for (const key of ['colspan', 'rowspan']) {
                const declared = Number(entry[key]);
                if (!Number.isFinite(declared) || declared < 1) continue; // not declared
                // Compare the EFFECTIVE span, clamped against the AUTHORED grid width — never the
                // deployed one. Deriving the expectation from what was deployed let a section that
                // came out too narrow LOWER ITS OWN EXPECTATION and excuse a wrong span: authored
                // `columns: 4, colspan: 4` deployed as `columns: 1, colspan: 1` verified PASS. The
                // deployed width is now reported separately above, so both faults are visible.
                //
                // Only `colspan` is bounded by the grid; `rowspan` has no such limit, so it is
                // compared as authored.
                const want = key === 'colspan' && haveWantCols ? Math.min(declared, wantCols) : declared;
                const got = Number(dc[key]) || 1;
                if (got !== want) {
                  problems.push(`field '${fl}' has ${key} ${got}, the spec declares ${declared}`
                    + (want !== declared ? ` (clamped to ${want} by the ${wantCols}-column section)` : ''));
                }
              }
            }
            // Fields are compared against the section OBJECT that was matched, not its name — the
            // deployed section legitimately keeps its own name, and two sections can share one.
            // Identity comparison is what catches a field sitting in a same-named section under a
            // DIFFERENT tab, which a name comparison reported as correct.
            for (const entry of (sec.fields || [])) {
              const fieldName = typeof entry === 'string' ? entry : (entry && entry.name);
              if (!fieldName) continue;
              const fl = String(fieldName).toLowerCase();
              const where = placedIn.get(fl);
              if (where === undefined) problems.push(`field '${fl}' is not placed on the deployed form`);
              else if (where !== secHit.item) {
                const whereName = String(where.name || '').toLowerCase();
                problems.push(`field '${fl}' is deployed in section '${whereName}'`
                  + (whereName === secName ? ' under a different tab' : '')
                  + `, the spec places it in '${secName}'`);
              }
            }
          });
        });
      });

      add('form-topology', `${entity}.${name}`, problems.length === 0,
        problems.length ? `deployed layout does not match the authored one — ${problems.slice(0, 6).join('; ')}${problems.length > 6 ? `; +${problems.length - 6} more` : ''}` : '');
    }
  }

  // Commands (existence) — a spec can declare a command bar that didn't build and still pass verify
  // (commands weren't checked). The SDK models one command bar per entity, so verify per entity. Best-
  // effort: only when the reader can resolve a command bar (`commandBar(entity)` -> truthy when present).
  if (typeof read.commandBar === 'function') {
    const cmdEntities = new Set((spec.commands || []).map((c) => String(c.entity).toLowerCase()));
    for (const entity of cmdEntities) {
      let present = false;
      try { present = !!(await read.commandBar(entity)); } catch { present = false; }
      add('command', `${entity} command bar`, present);
    }
  }

  // Business rules. A rule that EXISTS is not a rule that RUNS: a Draft (statecode 0) rule is inert,
  // and a duplicate means the same logic fires twice. Both are states the BUILD can legitimately end
  // in without failing — activation is best-effort, and the SDK's fallback can leave a duplicate it
  // cannot remove (#482) — so the build warns and relies on verify to report the outcome. Without
  // this block that promise was empty: a missing, inert, or duplicated rule still verified PASS.
  //
  // Reconciled on THREE axes, because each fails differently and silently:
  //   existence   — the rule never built at all
  //   cardinality — more than one row for the same (entity, name) fires the logic repeatedly
  //   state       — deployed Draft when the spec asked for Active (or the reverse)
  for (const rule of spec.businessRules || []) {
    const entityLogical = String(rule.entity).toLowerCase();
    const name = `${entityLogical}.${rule.name}`;
    // A rule the BUILD skipped because this environment cannot host business rules at all is not a
    // verification failure — it is a capability gap the operator was already told about, by name,
    // during the build. Checking it anyway would report `not deployed` forever on the 18-of-20
    // environments that lack the bound member.
    //
    // That is not merely noisy. `verify.ok` gates the process EXIT CODE, whether
    // `.last-applied.json` is written, and whether the `--changed-only` snapshot is persisted — and
    // page-bearing specs make verify MANDATORY. So a permanently-false `ok` would permanently
    // withhold the changed-only baseline, forcing a full build on every subsequent run forever.
    // Those three gates are built for TRANSIENT failures that a later run clears; this one never
    // clears.
    //
    // Reported as its own outcome rather than passed: nothing here claims the rule exists.
    if (environmentSkippedRules.has(`${entityLogical}|${rule.name}`)) {
      environmentSkipped.push(`business-rule:${name}`);
      continue;
    }
    // A phase-limited run (a `--changed-only` fast apply is `phases: ['pages']`) never executed the
    // business-rules phase, so it has no skip list to offer and demanding the rule here would fail
    // a run that never touched it. On a gated environment that turned every fast apply into a
    // non-zero exit plus an invalidated snapshot, alternating full/failing-fast forever, and the log
    // line blamed PAGES for a business-rule gate.
    //
    // Reported SEPARATELY from the environment gate: on a healthy environment the rules are deployed
    // and fine, and telling that operator their environment cannot host business rules would be
    // wrong on every fast apply they ever run.
    if (!businessRulesPhaseRan) {
      phaseSkipped.push(`business-rule:${name}`);
      continue;
    }
    let rows;
    try {
      // `top: 50`, not 1 — the whole point is to SEE duplicates. Scoped to DEFINITION rows only
      // (see businessRuleFilter): activating a rule makes the platform create a second, `type 2`
      // activated copy, so counting both would report every healthy ACTIVE rule as duplicated.
      rows = await read.queryRecords('workflow', {
        select: ['workflowid', 'statecode'],
        filter: businessRuleFilter(rule.name, entityLogical),
        top: 50,
      });
    } catch (e) {
      // Fail CLOSED: a read that could not run must not read as "present and correct".
      add('business-rule', name, false, `could not be read: ${e && e.message}`);
      continue;
    }
    const list = rows || [];
    if (!list.length) {
      // Name the most likely cause instead of the bare fact. The SDK writes rules ONLY through the
      // bound `CreateProcessWithWfomJson` member and no longer compiles a workflow-XAML fallback, so
      // an environment that does not declare that member cannot host business rules at all — and
      // that is the COMMON case. The build already skips them with a warning, so
      // without this hint the operator reads "not deployed" as a build failure and goes looking for
      // one that is not there.
      //
      // It stays a FAIL, not a pass or a skip: the app genuinely does not have the rule the spec
      // asks for, and verify's job is to report the deployed truth.
      add('business-rule', name, false,
        'not deployed — if the build reported "business rules were NOT created", this environment does not expose the CreateProcessWithWfomJson member and cannot host them');
      continue;
    }
    if (list.length > 1) {
      add('business-rule', name, false, `${list.length} rules share this name on ${entityLogical} — duplicates fire the same logic more than once (see issue #482)`);
      continue;
    }
    const wantActive = (rule.status || 'Active') === 'Active';
    const isActive = list[0].statecode === 1;
    add('business-rule', name, wantActive === isActive,
      wantActive === isActive ? '' : (wantActive ? 'deployed but DRAFT — the rule does not run' : 'deployed ACTIVE but the spec asks for Draft — the rule is running'));
  }

  // Business process flows. Reconciled on the same three axes as business rules, because a BPF fails
  // the same three silent ways: it never built, it built twice (users are offered the same process
  // more than once), or it is deployed Draft and therefore invisible on the form. Activation is
  // best-effort in the build, so verify is what makes the outcome loud.
  for (const flow of spec.businessProcessFlows || []) {
    const entityLogical = String(flow.entity).toLowerCase();
    const name = `${entityLogical}.${flow.name}`;
    let rows;
    try {
      // DEFINITION rows only, BusinessFlow only (see bpfFilter) — counting the platform's activated
      // `type 2` copy would report every healthy ACTIVE flow as a duplicate, and counting task flows
      // would report an unrelated process as one.
      rows = await read.queryRecords('workflow', {
        select: ['workflowid', 'statecode'],
        filter: bpfFilter(flow.name, entityLogical),
        top: 50,
      });
    } catch (e) {
      // Fail CLOSED: a read that could not run must not read as "present and correct".
      add('business-process-flow', name, false, `could not be read: ${e && e.message}`);
      continue;
    }
    const list = rows || [];
    if (!list.length) { add('business-process-flow', name, false, 'not deployed'); continue; }
    if (list.length > 1) {
      add('business-process-flow', name, false, `${list.length} process flows share this name on ${entityLogical} — users are offered the same process more than once`);
      continue;
    }
    const wantActive = (flow.status || 'Active') === 'Active';
    const isActive = list[0].statecode === 1;
    add('business-process-flow', name, wantActive === isActive,
      wantActive === isActive ? '' : (wantActive ? 'deployed but DRAFT — the process does not appear on the form' : 'deployed ACTIVE but the spec asks for Draft — the process is running'));
  }

  // Sitemap subareas (+ icons). Scope every check to the specific element type (and, for a subarea
  // icon, the owning entity) so an icon/entity value reused elsewhere in the XML can't satisfy an
  // unrelated check (e.g. an Area icon must not make a missing SubArea icon look present).
  const xml = (await read.sitemapXml()) || '';
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) add('area-icon', a.label || '', hasElement(xml, 'Area', { Icon: a.icon }));
    if (a.vectorIcon) add('area-vectorIcon', a.label || '', hasElement(xml, 'Area', { VectorIcon: a.vectorIcon }));
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.entity) add('subarea', sa.title || sa.entity, hasElement(xml, 'SubArea', { Entity: sa.entity }));
        if (sa.dashboard) {
          // Resolve the declared dashboard (a system dashboard = systemform type 0) by name, then
          // confirm the sitemap points a SubArea at THAT dashboard id — not just that some dashboard
          // subarea exists. Missing/unresolvable dashboard => not present.
          const rows = await read.queryRecords('systemform', { select: ['formid'], filter: `type eq 0 and name eq '${odataLit(sa.dashboard)}'`, top: 1 });
          const dashId = rows && rows[0] && rows[0].formid;
          add('subarea', sa.title || sa.dashboard, dashId ? subareaHasDashboard(xml, dashId) : false);
        }
        if (sa.icon) {
          // Prefer matching the icon on the SubArea that also declares this entity; fall back to any
          // SubArea carrying the icon when the subarea has no entity identity.
          const present = sa.entity ? hasElement(xml, 'SubArea', { Entity: sa.entity, Icon: sa.icon }) : hasElement(xml, 'SubArea', { Icon: sa.icon });
          add('subarea-icon', sa.title || '', present);
        }
        if (sa.vectorIcon) {
          // VectorIcon serializes as its own sitemap attribute, so check it independently from the
          // raster Icon attribute while keeping the same SubArea scoping rules.
          const present = sa.entity ? hasElement(xml, 'SubArea', { Entity: sa.entity, VectorIcon: sa.vectorIcon }) : hasElement(xml, 'SubArea', { VectorIcon: sa.vectorIcon });
          add('subarea-vectorIcon', sa.title || '', present);
        }
      }
    }
  }

  // App-module TABLE membership (appmodulecomponent componenttype 1).
  //
  // The sitemap and the app's component list are SEPARATE facts, and they can disagree: an app can
  // show a table in navigation while omitting it from its Tables list. That is an internally
  // inconsistent app definition and it breaks consumers that read app-module membership — but every
  // check above passes, because the table EXISTS and the sitemap DOES name it. Verify reported PASS
  // on exactly that app, which is what made the divergence invisible.
  //
  // Scoped to SITEMAP-VISIBLE entities on purpose. A spec entity with no subarea is a legitimate
  // data-model-only/supporting table that the build does not pin, so requiring it would fail every
  // app that declares one.
  //
  // Optional capability: verify-spec is also driven by minimal readers, and an optional reader must
  // never become a TypeError for them (same rule as `columnVisualization`).
  if (typeof read.appEntityComponents === 'function') {
    const sitemapEntities = [];
    for (const a of (spec.appShell && spec.appShell.areas) || []) {
      for (const g of a.groups || []) {
        for (const sa of g.subAreas || []) {
          const logical = sa && sa.entity ? String(sa.entity).toLowerCase() : null;
          if (logical && !sitemapEntities.includes(logical)) sitemapEntities.push(logical);
        }
      }
    }
    if (sitemapEntities.length) {
      const res = await read.appEntityComponents(sitemapEntities);
      if (!res || res.ok !== true) {
        // Fail closed. "We could not look" must never read as "the app is fine" — that is the exact
        // shape of the bug this check exists to catch.
        add('app-table-component', 'app tables', false, `could not be read: ${(res && res.reason) || 'unknown'}`);
      } else {
        // Case-insensitive: Dataverse does not guarantee the casing of a resolved logical name.
        const present = new Set((res.present || []).map((n) => String(n).toLowerCase()));
        for (const logical of sitemapEntities) add('app-table-component', logical, present.has(logical));
        // The known corruption: a table pinned as an `entity` INSTANCE pins the `entity` METADATA
        // table itself, so the row points at no real table. Those rows are junk, they accumulate
        // across reconciliation attempts, and they are worth naming even when every declared table
        // is present.
        if (res.placeholder) {
          add('app-table-component', 'invalid `entity` placeholder component(s)', false,
            'the app module contains component(s) pointing at the `entity` metadata table rather than a real table — remove them.');
        }
      }
    }
  }

  // Pages (design §13.1). Match BY ID against three authorities — IDENTITY (manifest), EXISTENCE
  // (env-wide id set), MEMBERSHIP (app sitemap ids). Reader must supply sitemapPageIds(),
  // existenceIds(), manifest(), and pageCode(id) when any page has nav. Fail-closed (Imp7):
  // reader-incapacity OR an absent/uncorrelatable manifest on a page-bearing spec → unableToRun
  // (NOT "every page missing" — without an id correlation we cannot tell what is there vs. absent).
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  const hasNavPages = implementedPages.some((p) => (p.navigatesTo || []).length > 0);
  // Reader-incapacity: required methods absent → cannot run, distinct from pages being absent in live.
  let unableToRun = !!(implementedPages.length && (
    typeof read.sitemapPageIds !== 'function' ||
    typeof read.existenceIds !== 'function' ||
    typeof read.manifest !== 'function'
  )) || !!(hasNavPages && typeof read.pageCode !== 'function');
  if (implementedPages.length) {
    if (unableToRun) {
      // Reader is missing required page-authority methods — add a sentinel check and skip the loop.
      add('page-verify', 'pages', false, 'the verify reader cannot read existence / membership / manifest (unable to run)');
    } else {
      // ONE cached snapshot of each authority (Imp7 — never re-query per page). Throws from
      // sitemapPageIds/existenceIds propagate out of verifySpec; the build gate's try/catch converts them
      // to a non-zero exit (design §13.1). The caller that constructed the reader bears fail-closed responsibility.
      const sitemapIds = new Set((await read.sitemapPageIds()).map((id) => String(id).toLowerCase()));
      const existenceIds = new Set((await read.existenceIds()).map((id) => String(id).toLowerCase()));
      const man = await read.manifest();
      // Build key→id from the manifest (IDENTITY authority). A spec page's own pageId (edit-snapshot,
      // C3) OUTRANKS the manifest entry for the same key — use idOf() consistently.
      const idByKey = new Map(
        ((man && man.pages) || [])
          .filter((p) => p && p.key && p.pageId)
          .map((p) => [p.key, p.pageId]),
      );
      // idOf: spec pageId first (highest authority), then manifest key→id (C3 outranks C1).
      const idOf = (p) => p.pageId || idByKey.get(p.key || p.name);
      // Imp7: if NO implemented page can be given an id (manifest empty/absent AND no spec pageIds),
      // the verifier cannot correlate spec pages to live ids → unableToRun (page-identity), NOT N misses.
      const resolvable = implementedPages.filter((p) => !!idOf(p));
      if (resolvable.length === 0) {
        unableToRun = true;
        add('page-verify', 'pages', false, 'the page manifest is missing/empty/uncorrelatable — cannot map any spec page to a deployed id (page-identity)');
      } else {
        // specIds tracks which live ids are accounted for by spec pages (for set-equality below).
        const specIds = new Set();
        for (const p of implementedPages) {
          const key = p.key || p.name;
          const id = idOf(p);
          if (!id) {
            // Partially-resolvable manifest: some pages have ids, this one doesn't — emit a specific miss.
            add('page', p.name, false, 'no manifest/spec id for this page (page-identity)');
            continue;
          }
          specIds.add(String(id).toLowerCase());
          // page present ⟺ id ∈ existenceIds (deployed env-wide) AND id ∈ sitemapIds (placed in this app).
          // Both conditions required: existence alone doesn't mean the page belongs to this app.
          const present = existenceIds.has(String(id).toLowerCase()) && sitemapIds.has(String(id).toLowerCase());
          add('page', p.name, present);
          if (!present) continue;
          // page-subarea: verify the sitemap XML specifically carries a GenPageId="<id>" binding.
          // Only emitted when the appShell references this page key (headless pages have no subarea to verify).
          if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, id));
          const nav = p.navigatesTo || [];
          if (!nav.length) continue;
          let code;
          try {
            // Download THAT page's code by id (not all pages) — the real reader caches per id.
            code = (await read.pageCode(id)) || '';
          } catch (e) {
            // A single page's download blip is a specific verifiable miss, not reader-incapacity.
            add('page-code', p.name, false, String((e && e.message) || e));
            continue;
          }
          // THE SINGLE STRUCTURAL ORACLE: parse the deployed page's real navigateTo call sites.
          // A decoy id in a comment, a stale GUID, or a dynamic pageId all FAIL (C1).
          const targets = extractNavTargets(code);
          // No residual/malformed PAGEREF_ in deployed code means the resolve+upload step ran on this page.
          add('page-no-pageref', p.name, !targets.some((t) => t.kind === 'pageref' || t.kind === 'pageref-malformed'));
          // Every declared nav edge must resolve to the ACTUAL target's deployed id at a REAL call site.
          const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
          for (const edge of nav) {
            // Target id via the same resolution order (spec pageId > manifest) for nav targets.
            const targetPage = (spec.pages || []).find((pp) => (pp.key || pp.name) === edge.targetKey);
            const targetId = targetPage ? idOf(targetPage) : undefined;
            add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
          }
        }
        // Set-equality (Imp7): a live sitemap page not mapped by any spec page's id → page-extra.
        // The deployed app has a page the spec doesn't declare — surface it rather than silently ignore.
        for (const liveId of sitemapIds) {
          if (!specIds.has(liveId)) add('page-extra', liveId, false, 'a sitemap page not declared in the spec');
        }
      }
    }
  }

  // Persona security roles. Existence + SDK-ownership is a sufficient content oracle here (unlike the
  // additive view/form checks): the SDK applies a role's privileges with ReplacePrivilegesRole, so an
  // existing role the SDK authored necessarily holds exactly its declared (converged) privilege set —
  // there is no additive-drift path where the role exists but a privilege silently failed to apply. We
  // therefore verify the role exists AND carries the SDK ownership marker (a same-name role someone
  // else built would pass a bare existence check but is NOT the role the security phase authored).
  const roleBuCache = {}; // memoize the root-BU lookup across personas in this verify pass
  let appRoleIdsP;
  const appRoleIds = async () => {
    if (!appRoleIdsP) appRoleIdsP = read.appRoleIds();
    return appRoleIdsP;
  };
  for (const p of spec.personas || []) {
    const roleName = canonicalPersonaName(p); // trimmed — matches the SDK's created name
    if (!roleName) continue;
    let row;
    try {
      // Roles table (logical `role`); exact-match name literal, scoped to the persona's business unit
      // (explicit, else the org root BU) so a same-named marker role in a DIFFERENT BU can't false-pass
      // the check. FAIL CLOSED if the BU can't be resolved: report the role missing rather than fall back
      // to a name-only match that could pass on the wrong BU's role. Best-effort on a reader without role
      // support (no queryRecords): `row` stays undefined and the check fails loudly as "missing".
      const bu = await resolveRoleBusinessUnit((e, o) => read.queryRecords(e, o), p.businessUnitId, roleBuCache);
      if (bu) {
        const rows = await read.queryRecords('role', { select: ['roleid', 'description', 'ismanaged'], filter: `name eq '${odataLit(roleName)}'${roleBuClause(bu)}`, top: 5 });
        row = (rows || []).find((r) => r.ismanaged !== true && (r.description || '') === SDK_ROLE_MARKER);
      }
    } catch { row = undefined; }
    add('role', roleName, row, row ? '' : 'persona security role not found (or its business unit could not be resolved)');

    if (row && p.appAccess !== false && typeof read.appRoleIds === 'function') {
      let res = null;
      try { res = await appRoleIds(); } catch (e) { res = { ok: false, reason: (e && e.message) || String(e) }; }
      if (!res || res.ok !== true) {
        add('app-role', roleName, false, `could not read appmoduleroles_association rows: ${(res && res.reason) || 'unknown'}`);
      } else {
        const ids = new Set((res.roleIds || []).map((id) => String(id).toLowerCase()));
        add('app-role', roleName, ids.has(String(row.roleid).toLowerCase()),
          ids.has(String(row.roleid).toLowerCase()) ? '' : 'persona role is not associated to the app module, so the app may not appear for users with this role');
      }
    }

    // Privilege depth check — reader-gated (see `entityRelationships` / `commandBar` above for the
    // same pattern), so an existence-only reader behaves exactly as before. Proving the role ROW
    // exists says nothing about what it GRANTS: a role created with the wrong access, or one whose
    // privilege write failed after the row landed, verified clean until this check existed.
    // SUBSET semantics — see lib/role-privileges.js for why equality would be wrong.
    if (row && typeof read.rolePrivileges === 'function' && typeof read.entityPrivileges === 'function') {
      const declared = declaredPrivileges(p);
      let actual = null;
      try {
        actual = await read.rolePrivileges(row.roleid);
      } catch { actual = null; }
      if (!Array.isArray(actual)) {
        // Fail CLOSED: an unreadable role is not a role we can call correct.
        add('role-privileges', roleName, false, 'could not read the role\'s privileges');
      } else {
        const actualByPrivilegeId = new Map(actual.map((a) => [String((a && a.privilegeId) || '').trim().toLowerCase(), a && a.depth]));
        const entityPrivileges = new Map();
        for (const entity of new Set(declared.map((d) => d.entity))) {
          try {
            const privs = await read.entityPrivileges(entity);
            if (Array.isArray(privs)) entityPrivileges.set(entity, privs);
          } catch { /* left absent → reported as a finding by compareRolePrivileges */ }
        }
        const cmp = compareRolePrivileges(declared, entityPrivileges, actualByPrivilegeId);
        const detail = cmp.ok
          ? `${declared.length} declared privilege(s) held`
          : cmp.missing.map((m) => `${m.entity}.${m.access}: ${m.reason}`).join('; ');
        add('role-privileges', roleName, cmp.ok, detail);
      }
    }
  }

  // Role grants (`roleGrants[]`) — privileges ADDED to a pre-existing role. AB#6686429.
  //
  // Verified with the SAME subset comparison as personas, and for a stronger reason: unlike a persona
  // role (converged by ReplacePrivilegesRole, so existence implies content), a grant is ADDITIVE onto a
  // role we do not own. Nothing else proves the grant landed — the role existed before and still exists
  // whether or not the privileges were added. A subset check is exactly right here: every privilege the
  // role holds beyond the declared set is somebody else's and must never be a finding.
  //
  // Deliberately NOT checked: the SDK ownership marker. The role belongs to someone else by definition.
  for (const g of spec.roleGrants || []) {
    const declaredName = typeof g.role === 'string' ? g.role.trim() : '';
    const label = declaredName || String(g.roleId || '?');
    let row;
    try {
      if (g.roleId) {
        const rows = await read.queryRecords('role', { select: ['roleid', 'name'], filter: `roleid eq ${g.roleId}`, top: 1 });
        row = (rows || [])[0];
      } else {
        // Same fail-closed BU scoping as the apply path: a name-only fallback could verify against a
        // same-named role in another business unit and report a grant that never happened as held.
        const bu = await resolveRoleBusinessUnit((e, o) => read.queryRecords(e, o), g.businessUnitId, roleBuCache);
        if (bu) {
          const rows = await read.queryRecords('role', { select: ['roleid', 'name'], filter: `name eq '${odataLit(declaredName)}'${roleBuClause(bu)}`, top: 5 });
          row = (rows || []).length === 1 ? rows[0] : undefined; // ambiguity is not proof
        }
      }
    } catch { row = undefined; }
    add('role-grant', label, row, row ? '' : 'the role named by this roleGrant was not found (or its business unit could not be resolved, or the name is ambiguous)');
    if (!row || typeof read.rolePrivileges !== 'function' || typeof read.entityPrivileges !== 'function') continue;
    // `declaredPrivileges` folds in an `appmodule` read for a persona; a roleGrant grants exactly what it
    // declares and must not imply app access, so the triples are flattened here instead of reusing it.
    const declared = [];
    for (const pr of g.privileges || []) {
      for (const a of pr.access || []) declared.push({ entity: String(pr.entity || '').toLowerCase(), access: String(a), scope: pr.scope || 'user' });
    }
    let actual = null;
    try {
      actual = await read.rolePrivileges(row.roleid);
    } catch { actual = null; }
    if (!Array.isArray(actual)) {
      add('role-grant-privileges', label, false, 'could not read the role\'s privileges');
      continue;
    }
    const actualByPrivilegeId = new Map(actual.map((a) => [String((a && a.privilegeId) || '').trim().toLowerCase(), a && a.depth]));
    const entityPrivileges = new Map();
    for (const entity of new Set(declared.map((d) => d.entity))) {
      try {
        const privs = await read.entityPrivileges(entity);
        if (Array.isArray(privs)) entityPrivileges.set(entity, privs);
      } catch { /* left absent → reported as a finding by compareRolePrivileges */ }
    }
    const cmp = compareRolePrivileges(declared, entityPrivileges, actualByPrivilegeId);
    add('role-grant-privileges', label, cmp.ok, cmp.ok
      ? `${declared.length} granted privilege(s) held`
      : cmp.missing.map((m) => `${m.entity}.${m.access}: ${m.reason}`).join('; '));
  }

  // Business process flow role grants (`businessProcessFlows[].securityRoles`). #513.
  //
  // Verified on the flow's BACKING TABLE, not on the flow row: activation creates an org-owned table
  // named `bpfUniqueName(flow.name)` (live-measured), and holding privileges on it is what lets a
  // persona run the process. Subset semantics as everywhere else — a persona legitimately holds far
  // more than this one grant.
  for (const f of spec.businessProcessFlows || []) {
    if (!f || !f.securityRoles || !Array.isArray(f.securityRoles.personas)) continue;
    if (typeof read.rolePrivileges !== 'function' || typeof read.entityPrivileges !== 'function') continue;
    // READ the deployed unique name, do not derive it. A flow authored in Maker, or one renamed
    // after creation, keeps a `uniquename` unrelated to its display name — and that name IS the
    // backing table. Verifying against the derivation would report a real grant as missing, or (if
    // an unrelated table happens to hold the derived name) PASS while the actual flow is ungranted,
    // which is the worse of the two. Falls back to the derivation only when the row cannot be read,
    // where it remains correct for anything this tool created.
    // See https://learn.microsoft.com/en-us/power-automate/developer/business-process-flows-code
    //
    // Three outcomes, kept apart because two of them used to collapse into one. A successful query
    // returning NO ROWS means the flow does not exist — it was never created, or never activated —
    // and the derivation must NOT be used then: `bpfUniqueName(f.name)` could coincide with an
    // unrelated table, whose privileges would verify clean and report a PASS for a flow that is
    // absent. That is the one direction this check exists to prevent. A read that THREW is different:
    // we could not look, so the derivation stands and the privilege read below fails closed anyway.
    let backingTable = bpfUniqueName(f.name);
    let flowMissing = false;
    try {
      const rows = await read.queryRecords('workflow', {
        select: ['workflowid', 'uniquename'],
        filter: bpfFilter(f.name, String(f.entity).toLowerCase()),
        orderBy: 'createdon asc',
        top: 5,
      });
      const row = rows && rows[0];
      if (!row) flowMissing = true;
      else if (row.uniquename) backingTable = String(row.uniquename).toLowerCase();
      // A row WITHOUT a uniquename keeps the derivation: the flow demonstrably exists, so the
      // derived name is the best available answer for anything this tool created.
    } catch { /* could not look — keep the derivation; the privilege read below fails closed */ }
    if (flowMissing) {
      add('bpf-roles', f.name, false,
        `no business process flow named '${f.name}' exists on '${String(f.entity).toLowerCase()}', so its backing table cannot be identified and no role grant on it can be verified`);
      continue;
    }
    let privs = null;
    try {
      privs = await read.entityPrivileges(backingTable);
    } catch { privs = null; }
    if (!Array.isArray(privs)) {
      // Fail CLOSED: an unreadable backing table is not proof the grant landed. It also catches the
      // realistic case that the flow never activated, so the table does not exist at all.
      add('bpf-roles', f.name, false, `could not read privileges for the flow's backing table '${backingTable}' — it is created by ACTIVATION, so this also means the flow may not be active`);
      continue;
    }
    for (const personaName of f.securityRoles.personas) {
      // Resolve the reference to the persona's CANONICAL name, case-insensitively — the validator
      // accepts a case-mismatched reference, and the deployed role carries the persona's own casing.
      // Querying `name eq '<as written>'` would miss it and report a real grant as missing.
      const declaredPersona = (spec.personas || []).find((p) => String(canonicalPersonaName(p) || '').toLowerCase() === String(personaName).trim().toLowerCase());
      const roleName = String((declaredPersona && canonicalPersonaName(declaredPersona)) || personaName).trim();
      let row;
      try {
        const bu = await resolveRoleBusinessUnit((e, o) => read.queryRecords(e, o), declaredPersona && declaredPersona.businessUnitId, roleBuCache);
        if (bu) {
          const rows = await read.queryRecords('role', { select: ['roleid', 'description', 'ismanaged'], filter: `name eq '${odataLit(roleName)}'${roleBuClause(bu)}`, top: 5 });
          row = (rows || []).find((r) => r.ismanaged !== true && (r.description || '') === SDK_ROLE_MARKER);
        }
      } catch { row = undefined; }
      if (!row) { add('bpf-roles', `${f.name} / ${roleName}`, false, 'persona role not found'); continue; }
      let actual = null;
      try { actual = await read.rolePrivileges(row.roleid); } catch { actual = null; }
      if (!Array.isArray(actual)) { add('bpf-roles', `${f.name} / ${roleName}`, false, "could not read the role's privileges"); continue; }
      const actualByPrivilegeId = new Map(actual.map((a) => [String((a && a.privilegeId) || '').trim().toLowerCase(), a && a.depth]));
      const declared = BPF_ROLE_ACCESS.map((access) => ({ entity: backingTable, access, scope: 'organization' }));
      const cmp = compareRolePrivileges(declared, new Map([[backingTable, privs]]), actualByPrivilegeId);
      add('bpf-roles', `${f.name} / ${roleName}`, cmp.ok, cmp.ok
        ? `${declared.length} privilege(s) held on ${backingTable}`
        : cmp.missing.map((m) => `${m.access}: ${m.reason}`).join('; '));
    }
  }

  // AI app features. The verifier previously had NO awareness of `spec.ai` at all, so a build whose
  // every requested AI feature was skipped (admin gate off) or silently not persisted still reported a
  // clean PASS — a false success signal for automation (ADO 6603383).
  //
  // The oracle is the APP-SCOPE OVERRIDE ROW, not the effective value. `RetrieveSetting(name,
  // { appUniqueName })` FALLS BACK to the environment value when the app has no override, so a
  // matching effective read does NOT prove the build's app-scope write landed: if the environment
  // already holds the requested value, a write the platform silently ignored reads back as a match
  // and verify reports PASS for a feature that was never applied to this app. That is precisely the
  // false-PASS in ADO 6603383, so this proves the override in `appsettings` instead — the same
  // authoritative signal the SDK's own `setAppAiFeatures` uses to decide its `applied` bucket.
  //
  // CRITICAL: the set checked here is `resolveAiFlags(spec)`, the EXACT set the build writes — not
  // `spec.ai.appFeatures`. The build seeds a default for every feature whenever `spec.ai` exists, so
  // reconciling only what a spec DECLARED left a spec with `ai.summaries` and no `ai.appFeatures`
  // with three features written and ZERO verified: a clean PASS for features the platform may never
  // have stored. One resolver, both callers.
  //
  // A feature whose write did not persist therefore FAILS here, which is intended: the spec asked for
  // it and it is not configured on the app. That includes one the SDK bucketed as `skipped` — since
  // AB#6688904 that means "attempted, absent, and an org gate reads off", i.e. an admin action is
  // outstanding, not that the request was withdrawn. The effective value is still read, but only as
  // context in the failure message ("in effect as X by environment fallback").
  //
  // Reader-gated like the other content checks: this needs BOTH `retrieveSetting` (context) and
  // `queryRecords` (the proof), so an existence-only reader skips it entirely rather than falling
  // back to the unsound effective-value compare. The shipped CLI reader has both.
  const requestedFeatures = resolveAiFlags(spec);
  if (requestedFeatures && typeof read.retrieveSetting === 'function' && typeof read.queryRecords === 'function') {
    // MUST be the same identity the build wrote under — `appUniqueName(spec)`, which falls back to
    // `<publisherPrefix>_<app.name>` for an authored spec that carries no explicit `app.uniqueName`
    // (neither shipped sample does, and hydrate never emits `ai`, so that is the COMMON case). Reading
    // `spec.app.uniqueName` directly yields undefined there, and the SDK omits the `AppUniqueName` path
    // segment when it is absent — which silently reads the ENVIRONMENT-scoped value instead of the app's.
    const appUnique = appUniqueName(spec);
    // Resolved ONCE for the whole loop (see ai-app-settings.js for why it is never cached longer).
    const app = await resolveAppModuleId(read, appUnique);
    for (const [feature, requested] of Object.entries(requestedFeatures)) {
      const setting = AI_APP_SETTING[feature];
      if (!setting) continue; // unknown key — validation already reports it
      // Feature-aware: `true` means '2' for the form-fill family and '1' elsewhere. Comparing
      // against the wrong spelling reports a correctly-applied feature as missing.
      const want = featureWantValue(requested, feature);

      // (1) Authoritative: does an app-scope override row exist, holding `want`?
      //     A small retry on the ABSENT case only: an override row can lag briefly behind the write
      //     that created it, and a single read turns that lag into a false FAIL on the build's exit
      //     code (`--verify` gates it). A read ERROR is not retried — see proveAppOverride.
      const proof = app.error ? { error: app.error } : await proveAppOverride(read, app.appModuleId, setting, { attempts: opts.proofAttempts === undefined ? 3 : opts.proofAttempts, delayMs: opts.proofDelayMs === undefined ? 500 : opts.proofDelayMs });

      // (2) Context only: what is currently in force (may be the ENVIRONMENT fallback). This read is
      //     genuinely non-load-bearing — it never participates in the comparison, so a transport
      //     failure here can only cost detail in a message, never flip the verdict.
      let effective;
      try {
        const res = await read.retrieveSetting(setting, { appUniqueName: appUnique });
        effective = res && res.value !== undefined && res.value !== null ? String(res.value).trim() : '';
      } catch { /* informational only */ }

      // Fail-closed: when the proof could not be run we could LOOK and looking failed, so we must not
      // claim PASS on the strength of a value that may simply be the environment default.
      const present = !proof.error && proof.exists && sameSettingValue(proof.value, want);
      const inForce = effective === undefined ? '(unreadable)' : effective === '' ? '(unset)' : effective;
      add('ai-feature', feature, present, present ? '' :
        proof.error
          ? `could not prove the app-scope setting '${setting}' was applied: ${proof.error}`
          : !proof.exists
            ? `requested '${want}' but this app has NO app-scope override for '${setting}' (it is in effect as '${inForce}' only by environment fallback, so the app was never configured)`
            : `requested '${want}' but the app-scope override for '${setting}' holds '${proof.value === '' || proof.value === undefined ? '(empty)' : proof.value}'`);
    }
  }

  // AI row summaries (`ai.summaries`). AB#6689110.
  //
  // Without this a spec that REQUESTS a row summary verified clean when none was created: the build
  // legitimately degrades to a skip when the environment does not license AI Builder (see the
  // ai-features phase), but nothing downstream re-asserted the request, so a licensed-environment
  // failure and an unlicensed skip both ended in a green `PASS`. The reporter saw `PASS, 45/45` with
  // the requested summary absent — a build that reports success while a declared artifact does not
  // exist is the one outcome verification exists to prevent.
  //
  // `selectSummaryTables` is the SAME selector the build uses, so the set verified is exactly the set
  // requested — including the `default: 'off'` + per-table `enabled: true` opt-in the reporter used.
  // Duplicating the default-vs-override rule here would let the two drift, which is how a verifier
  // starts proving something other than what was built.
  //
  // The oracle is the `msdyn_aimodel` row the SDK creates, named `<entity> row summary` — the same
  // name the build's own orphan sweep matches, and the name the platform quotes back in its
  // duplicate-key error, so it is the stored value rather than a guess.
  //
  // Reader-gated: `queryRecords` only. A reader without it skips rather than guessing.
  //
  // AI-OPT-IN gated FIRST, via the shared predicate. `selectSummaryTables` is a candidate selector,
  // not an opt-in test: handed a spec with no `ai` block it reads `summaries` as `{}` — "default
  // auto" — and returns every entity with a descriptive column. Calling it ungated made verify FAIL
  // a spec that never mentioned AI, reporting "ai.summaries requests a row summary for 'x'" for a
  // summary nobody requested and the build never created. That is a false failure on the build's own
  // `--verify` exit code, and it hits most specs, since almost every table has a text column.
  const summaryTables = specOptsIntoAi(spec) ? selectSummaryTables(spec) : [];
  if (summaryTables.length && typeof read.queryRecords === 'function') {
    for (const logical of summaryTables) {
      const modelName = `${String(logical).toLowerCase()} row summary`;
      let rows = null;
      let readError = null;
      try {
        rows = await read.queryRecords('msdyn_aimodel', {
          select: ['msdyn_aimodelid', 'msdyn_name', 'statecode'],
          filter: `msdyn_name eq '${odataLit(modelName)}'`,
          top: 5,
        });
      } catch (e) { readError = (e && e.message) || String(e); }
      // Fail CLOSED. `msdyn_aimodel` is readable by any role that can run the build, so an
      // unreadable list is not evidence of absence — and reporting PASS on a read we could not make
      // is the same false confidence this check exists to remove.
      if (!Array.isArray(rows)) {
        add('ai-summary', logical, false,
          `could not read the AI model list to prove the requested row summary exists${readError ? `: ${readError}` : ''}`);
        continue;
      }
      const active = rows.filter((r) => Number(r && r.statecode) === 1);
      const present = active.length > 0;
      // `statecode` was selected but not USED — existence alone was the test. That is a reachable
      // false PASS rather than a theoretical one: on an environment that does not license the
      // row-summary capability the SDK CREATES the `msdyn_aimodel` row and only then fails to
      // publish it, leaving a committed but unusable row behind (the same orphan the build's own
      // sweep tries to remove, and deliberately leaves in place when it cannot). Verify then found a
      // row with the right name and reported PASS for a summary nobody can use.
      //
      // The encoding is MEASURED from the environment's own metadata, not assumed:
      //   EntityDefinitions(LogicalName='msdyn_aimodel')/Attributes(LogicalName='statecode') →
      //   0 = Inactive (defaultStatus 0), 1 = Active (defaultStatus 1)
      // See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities
      add('ai-summary', logical, present, present ? `'${modelName}' exists and is active` :
        rows.length
          ? `ai.summaries requests a row summary for '${logical}', and an AI model named '${modelName}' exists but is INACTIVE `
            + `(statecode ${rows.map((r) => Number(r && r.statecode)).join(', ')}). The model row is created before it is published, so an `
            + 'environment that does not license the row-summary (AI Builder) capability leaves exactly this behind — the summary will not run.'
          : `ai.summaries requests a row summary for '${logical}', but no AI model named '${modelName}' exists in this environment. `
            + 'The build reports this as a skip when the environment does not license the row-summary (AI Builder) capability — '
            + 'run against a licensed environment, or set the table to enabled:false so the spec stops requesting it.');
    }
  }

  // JTBD rollup — translates a technical failure into the business impact it caused. Every other
  // check answers "is this artifact deployed?"; this one answers "can this persona still do this
  // job?".
  //
  // Deliberately a PURE ROLLUP over checks already computed — no extra reads, so it costs nothing
  // and cannot fail independently. A job fails when a surface it names resolves to a spec artifact
  // whose own check failed. An UNRESOLVED surface is NOT failed here: it may name an out-of-the-box
  // artifact this spec never authors (see lib/surface-resolver.js), and spec-lint already warns at
  // authoring time — failing it here would turn a plan-time smell into a deploy-time error.
  const failedNames = new Set(checks.filter((c) => !c.present).map((c) => String(c.name).toLowerCase()));
  if (failedNames.size) {
    // Each check kind names itself differently (a view is `<entity>.<name>`, a form/page/subarea is
    // its bare name, an entity is its schemaName), so a resolved surface is mapped to the candidate
    // check-name(s) its kind would have produced. Derived here rather than in the resolver because
    // the naming convention belongs to THIS file — a resolver that guessed it would silently rot
    // the moment a check kind renamed itself.
    const candidatesFor = (m) => {
      const name = String(m.name || '');
      if (m.kind === 'view') return [`${String(m.entity || '').toLowerCase()}.${name}`];
      if (m.kind === 'entity') return [String(m.entity || name)];
      return [name]; // form · page · subarea · dashboard
    };
    for (const r of resolveSurfaces(spec).resolved) {
      const broken = r.matches
        .flatMap(candidatesFor)
        .filter((n) => n && failedNames.has(n.toLowerCase()));
      if (broken.length) {
        add('job-surface', `${r.persona} → ${r.job}`, false, `surface "${r.surface}" is not deployed (${[...new Set(broken)].join(', ')})`);
      }
    }
  }

  const missing2 = checks.filter((c) => !c.present);
  // Keep unableToRun absent (undefined) on the normal path so existing callers and tests are unaffected.
  // `environmentSkipped` / `phaseSkipped` are likewise omitted when empty, for the same reason.
  return {
    ok: missing2.length === 0 && !unableToRun,
    checks,
    missing: missing2,
    unableToRun: unableToRun || undefined,
    ...(environmentSkipped.length ? { environmentSkipped } : {}),
    ...(phaseSkipped.length ? { phaseSkipped } : {}),
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectedViewFetchParts(spec, view) {
  const def = viewDef(spec, view);
  const conditions = [];
  const walk = (group) => {
    for (const c of (group && group.conditions) || []) {
      conditions.push({
        attribute: String(c.attribute || '').toLowerCase(),
        operator: String(c.operator || 'eq').toLowerCase(),
        value: c.value === undefined ? undefined : String(c.value),
      });
    }
    for (const child of (group && group.groups) || []) walk(child);
  };
  walk(def.filters);
  const orders = (def.sort || []).map((s) => ({
    attribute: String(s.attribute || '').toLowerCase(),
    descending: s.descending === true,
  }));
  return { conditions: conditions.filter((c) => c.attribute && c.operator), orders };
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tagAttrs(tag) {
  const attrs = {};
  const re = /\b([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(String(tag || ''))) !== null) attrs[String(m[1]).toLowerCase()] = xmlDecode(m[2] != null ? m[2] : m[3]);
  return attrs;
}

// Parse only the FetchXML facts the App Spec authors and the verifier must prove. Raw deployed
// shape, with the platform quirks that matter:
//   <fetch><entity name="new_ticket">
//     <filter type="and">
//       <condition attribute="ownerid" operator="eq-userid" />
//       <condition attribute="modifiedon" operator="this-week"></condition>
//       <condition attribute="new_priority" operator="ne" value="100000000" />
//     </filter>
//     <order attribute="createdon" descending="true" />
//   </entity></fetch>
// Current-user and relative-date operators serialize with NO `value` attribute; that is a correct
// deployed condition, not malformed XML. Attribute order and quote style vary, and Dataverse may add
// extra filters, so callers compare for presence rather than byte equality.
// Strip every `<link-entity>` subtree, leaving only what belongs to the view's ROOT `<entity>`.
//
// FetchXML puts a joined table's own predicates and ordering inside `<link-entity>`:
//   <entity name="account">
//     <filter><condition attribute="statecode" operator="eq" value="0" /></filter>
//     <link-entity name="contact" from="parentcustomerid" to="accountid">
//       <filter><condition attribute="statecode" operator="eq" value="0" /></filter>
//     </link-entity>
//   </entity>
// Both conditions read `statecode eq 0`, but only the first is a predicate on `account`. Scanning the
// whole document let the linked one satisfy an authored base-entity condition by coincidence — a
// verifier reporting PASS on a view that does not filter the way the spec says, which is the one
// outcome an oracle must never produce.
//
// Written as a depth scanner rather than a regex because link-entities NEST, and `<link-entity ... />`
// may also be self-closing (a join used only for its column projection) — a non-greedy regex would
// stop at the first `</link-entity>` and let an outer subtree leak back in.
function baseEntityFetchXml(xml) {
  const s = String(xml || '');
  const re = /<(\/?)link-entity\b([^>]*)>/gi;
  let out = '';
  let last = 0;
  let depth = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] === '/') {
      if (depth > 0) depth -= 1;
      if (depth === 0) last = re.lastIndex;
      continue;
    }
    if (depth === 0) out += s.slice(last, m.index);
    // A self-closing start tag opens nothing, so only its own text is dropped.
    if (!/\/\s*$/.test(m[2])) depth += 1;
    last = re.lastIndex;
  }
  // An unbalanced document (depth still open) contributes no trailing text rather than guessing.
  if (depth === 0) out += s.slice(last);
  return out;
}

function parseFetchXml(xml) {
  // Both scans are scoped to the root entity — see baseEntityFetchXml. Orders are scoped for the
  // same reason as conditions: an `<order>` inside a link-entity sorts the joined table, and letting
  // it into this list would satisfy — or break — the authored sort precedence with a foreign order.
  const scoped = baseEntityFetchXml(xml);
  const conditions = [];
  const conditionRe = /<condition\b[^>]*?(?:\/>|>[\s\S]*?<\/condition>)/gi;
  let m;
  while ((m = conditionRe.exec(scoped)) !== null) {
    const tag = m[0];
    const attrs = tagAttrs(tag);
    if (!attrs.attribute || !attrs.operator) continue;
    // `in`/`not-in`/`between` serialize their operands as SIBLING <value> elements:
    //   <condition attribute="statuscode" operator="in"><value>1</value><value>2</value></condition>
    // Reading only the first made an authored `in 2` unprovable against a view that really does
    // filter on it. Single-operand conditions use the `value` ATTRIBUTE instead, which wins when
    // present; an operator with no operand at all (`eq-userid`, `last-x-days`) yields [undefined],
    // which conditionMatches treats as "attribute+operator is the whole claim".
    const inner = [];
    const valueRe = /<value\b[^>]*>([\s\S]*?)<\/value>/gi;
    let vm;
    while ((vm = valueRe.exec(tag)) !== null) inner.push(xmlDecode(vm[1].trim()));
    const values = attrs.value !== undefined ? [attrs.value] : (inner.length ? inner : [undefined]);
    for (const value of values) {
      conditions.push({
        attribute: String(attrs.attribute).toLowerCase(),
        operator: String(attrs.operator).toLowerCase(),
        value: value === undefined ? undefined : String(value),
      });
    }
  }
  const orders = [];
  const orderRe = /<order\b[^>]*>/gi;
  while ((m = orderRe.exec(scoped)) !== null) {
    const attrs = tagAttrs(m[0]);
    if (!attrs.attribute) continue;
    orders.push({
      attribute: String(attrs.attribute).toLowerCase(),
      descending: String(attrs.descending || 'false').toLowerCase() === 'true',
    });
  }
  return { conditions, orders };
}

// Parse a deployed form's FormXml into the container tree `--verify` needs to prove a layout.
//
// Why this exists: form verification used to prove only that a form row EXISTS with the right
// (entity, name, type), plus whether it is the table default. Every wrong-layout failure this plugin
// has hit — fields flattened into the first section, a tab appended on every rebuild, a relocated
// field piled into a full row — therefore finished with an unqualified PASS. Existence is not proof
// of shape.
//
// Shape being parsed (attribute order varies; quotes may be single or double):
//   <form><tabs>
//     <tab name="tab_overview" ...><columns>
//       <column width="60%"><sections>
//         <section name="sec_summary" ...><rows>
//           <row><cell ...><control datafieldname="new_name" .../></cell></row>
//   … and a cell may carry no control at all (a spacer), or a control with no datafieldname
//   (a sub-grid, the notes timeline, a web resource) — those are NOT bound fields and are skipped.
//
// Written as a depth scanner rather than nested non-greedy regexes: tabs contain columns contain
// sections contain rows contain cells, and a non-greedy `<section>[\s\S]*?</section>` stops at the
// first close tag, which for nested containers attributes children to the wrong parent.
function parseFormTopology(xml) {
  const s = String(xml || '');
  const tabs = [];
  let tab = null, column = null, section = null, row = null, cell = null;
  // A <cell> carries its own <labels>, so a cell's label must not be attributed to its section.
  let inCell = false;
  const re = /<(\/?)(tab|column|section|row|cell|control|label)\b([^>]*?)(\/?)>/gi;
  const attr = (raw, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(raw || '');
    return m ? (m[1] != null ? m[1] : m[2]) : undefined;
  };
  let m;
  while ((m = re.exec(s)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const raw = m[3];
    const selfClosing = m[4] === '/';
    if (closing) {
      if (tag === 'tab') { tab = null; column = null; section = null; }
      else if (tag === 'column') { column = null; section = null; }
      else if (tag === 'section') { section = null; row = null; cell = null; }
      else if (tag === 'row') { row = null; cell = null; }
      else if (tag === 'cell') { inCell = false; cell = null; }
      continue;
    }
    if (tag === 'tab') { tab = { name: attr(raw, 'name'), label: undefined, columns: [] }; tabs.push(tab); if (selfClosing) tab = null; }
    else if (tag === 'column' && tab) { column = { width: attr(raw, 'width'), sections: [] }; tab.columns.push(column); if (selfClosing) column = null; }
    else if (tag === 'section' && column) {
      const ratio = attr(raw, 'columns');
      // `columns` is a width RATIO string, not a count: "11" is two equal columns, "1111" is four.
      // ABSENT means the width is UNKNOWN — left undefined so the occupancy check skips rather than
      // assuming a 1-column grid and inventing an overflow that is not there.
      section = { name: attr(raw, 'name'), label: undefined, columns: ratio ? String(ratio).length : undefined, rows: [], fields: [] };
      column.sections.push(section);
      if (selfClosing) section = null;
    }
    else if (tag === 'row' && section) { row = { cells: [] }; section.rows.push(row); if (selfClosing) row = null; }
    else if (tag === 'cell') {
      inCell = !selfClosing;
      // A cell with no <control> child stays control-less, which is what keeps a SPACER from
      // reading as engine-owned.
      cell = { colspan: Number(attr(raw, 'colspan')) || 1, rowspan: Number(attr(raw, 'rowspan')) || 1 };
      if (row) row.cells.push(cell);
      if (selfClosing) cell = null;
    }
    // FormXML carries the display label in a nested <labels><label description="..."/></labels>,
    // not an attribute. The BUILD matches containers name -> label -> position, so without this the
    // verifier can never make the label pass and would disagree with a label-matched reshape.
    else if (tag === 'label' && !inCell) {
      const d = attr(raw, 'description') === undefined ? undefined : decodeXmlEntities(attr(raw, 'description'));
      if (d !== undefined) {
        if (section && section.label === undefined) section.label = d;
        else if (!section && tab && tab.label === undefined) tab.label = d;
      }
    }
    else if (tag === 'control' && section) {
      // Only BOUND fields reach `fields[]`. A control with no `datafieldname` is a sub-grid, the
      // notes timeline or a web resource — engine-owned, never something the spec's field list
      // claims to place. The CELL still records that a control was present, because that is what
      // distinguishes an engine-owned section from a merely empty one.
      const f = attr(raw, 'datafieldname');
      if (f) section.fields.push(String(f).toLowerCase());
      if (cell) cell.control = f ? { fieldName: String(f).toLowerCase() } : {};
    }
  }
  return tabs;
}

function conditionMatches(want, got) {
  if (want.attribute !== got.attribute || want.operator !== got.operator) return false;
  return want.value === undefined || String(want.value) === String(got.value);
}

function orderMatches(want, got) {
  return want.attribute === got.attribute && want.descending === got.descending;
}

function formatCondition(c) {
  return `${c.attribute} ${c.operator}${c.value === undefined ? '' : ` ${c.value}`}`;
}

function formatOrder(o) {
  return `${o.attribute} ${o.descending ? 'desc' : 'asc'}`;
}

// Extract the deployed column logical names from a saved view's layoutxml. Shape (Dataverse grid
// layout), e.g.:
//   <grid name='resultset' ...><row ...><cell name='new_name' width='200' /><cell name='new_status' /></row></grid>
// Only <cell name="…"> carries a column; attribute order varies and quotes may be single or double, so
// match the `name` attribute on a `<cell` start-tag specifically (a `name` on <grid>/<row> is not a
// column). Returned lower-cased for case-insensitive comparison with spec column logical names.
function layoutColumnNames(xml) {
  const out = [];
  const re = /<cell\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) out.push(String(m[1] != null ? m[1] : m[2]).toLowerCase());
  return out;
}

// True when the sitemap XML contains a `<tag ...>` start-tag whose attributes include every
// name="value" pair in `attrs` (order-independent, scoped to a single element). Used so icon/entity
// checks match on the intended element type rather than anywhere in the document.
function hasElement(xml, tag, attrs) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const pairs = Object.entries(attrs);
  let m;
  while ((m = re.exec(xml)) !== null) {
    const startTag = m[0];
    if (pairs.every(([name, val]) => new RegExp(`\\b${escapeRe(name)}="${escapeRe(String(val))}"`, 'i').test(startTag))) return true;
  }
  return false;
}

// True when some `<SubArea ... DefaultDashboard="...">` in the sitemap points at `dashId`. Dataverse
// may store the GUID with braces and/or upper-cased, so compare normalized (braces stripped, lower).
function subareaHasDashboard(xml, dashId) {
  const norm = (s) => String(s).replace(/[{}]/g, '').toLowerCase();
  const target = norm(dashId);
  const re = /<SubArea\b[^>]*\bDefaultDashboard="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) if (norm(m[1]) === target) return true;
  return false;
}

// True when some sitemap `<SubArea GenPageId="<id>">` in the XML binds this page id. Generative-page
// subareas store the id in the GenPageId attribute SPECIFICALLY (vendor cds-maker-sdk.cjs:50 parses
// /GenPageId="([0-9a-fA-F-]{36})"/), so match THAT attribute only — a decoy id elsewhere on the
// SubArea start-tag (e.g. Url, Id) must NOT satisfy the check. Braces stripped, case-insensitive.
function subareaHasGenPage(xml, genPageId) {
  const norm = (s) => String(s).replace(/[{}]/g, '').toLowerCase();
  const target = norm(genPageId);
  const re = /<SubArea\b[^>]*\bGenPageId="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) if (norm(m[1]) === target) return true;
  return false;
}

// True when any appShell subarea targets this page key (via `s.page === key`), indicating the sitemap
// MUST carry a `<SubArea GenPageId="…">` binding for this page. An unreferenced (headless) page has
// no sitemap entry to verify, so the page-subarea check is only emitted when this returns true.
function appShellReferencesPage(spec, key) {
  for (const a of (spec.appShell && spec.appShell.areas) || [])
    for (const g of a.groups || [])
      for (const s of g.subAreas || []) if (s && s.page === key) return true;
  return false;
}

module.exports = { verifySpec, hasElement, subareaHasDashboard, subareaHasGenPage, appShellReferencesPage, layoutColumnNames, parseFetchXml };
