'use strict';
// SDK build engine: turn a validated App Spec into ordered @maker-studio/cds-maker-sdk
// calls, emitting granular progress events the orchestrator narrates. Deterministic and
// IDEMPOTENT — every table/column/relationship/solution is checked-then-created, so new,
// existing, and mixed environments all work (create-table is automatically optional).
// All Dataverse access goes through the SDK (findTables/findColumns/fetchEntityMetadata for
// discovery, create* for writes), so the workspace ends up holding the metadata for reuse.
//
// Phases (ordered): solution · data-model · sample-data · views · charts · forms · app-shell
//   · publish.  Select a subset with opts.phases (see resolvePhases).
// emit(event): { phase, status:'start'|'ok'|'skip'|'error', label, n, total, detail? }
// On an SDK error, throws a BuildHalt the orchestrator can gate on (AskUserQuestion).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256 } = require('./hash.js');
const { resolveAppSource } = require('./app-source-path.js');
const { readPageOwnership, recordPageCreation, recordPagePending, readPendingCreations, completePendingCreations, creationIds } = require('./page-ownership-records.js');
const { readPublishedPages, writePublishedPages, sameFileVersions } = require('./page-publish-records.js');
const { leftOnDiskWarning } = require('./left-on-disk.js');
// The pages lock: two files (one keyed without regard to case, one spelled as every earlier release spells it), each taken through the snapshot
// lease's exclusive create-and-reclaim and reclaimed only from a build that is provably gone; and the build lease an apply holds outside it
// (lib/app-operation-lease.js).
const { acquireAppPagesLease, withAppBuildLease, applyWorkspaceOf } = require('./app-operation-lease.js');
const { unreadableAnswer } = require('./collection-answers.js');
// normalizePageSource: read the page source from the discriminated `source` field (v2) or the
// legacy top-level `codeFile` (pre-migration). PHASES: canonical ordered phase list — imported
// here so the engine and the stage layer can never drift.
const { describeRelationship, describeIncomplete, readExact, compareRelationship, findRelationshipHolder } = require('./relationship-metadata.js');
const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  lookupColumnsFor,
  childRelationshipsFor,
  relationshipSchemaName,
  manyToManyFor,
  manyToManySchemaName,
  normalizePageSource,
  quickCreateEnabledFor,
  askedPrimaryNameLength,
  keyWaitsForNameLength,
  isPlatformIconRef,
  FORM_TYPE_CODE,
  formIdentityKey,
  FORM_GUID_RE,
  canonicalPersonaName,
  BUSINESS_RULE_VALUELESS_OPERATORS,
  bpfUniqueName,
  labelText,
  choiceValueMap,
  BPF_ROLE_ACCESS,
  dashboardNameKey,
  formLayoutNames,
  subgridRelationshipName,
  lookupLabelFor,
  lookupParentNeedsEnvironment,
  statedPageBindings,
} = require('./app-spec.js');
const { PHASES } = require('./stages.js');
const { pagesStatingBindings, pagesMadeUnchecked, pagesLeftOutAsDeployed, bindingReads, readBindingTargets, judgeBindingTargets, unconfirmedDeployedText } = require('./page-binding-targets.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
const {
  isMainForm,
  isOwnCustomTable,
  declaredMainForms,
  listedMainForms,
  selectDefaultForm,
  ordersByHand,
  plannedMainFormSequence,
} = require('./form-order.js');
const {
  makeRunner,
  runBestEffort,
  requireSuccessfulPush,
  pushFailed,
  reportPartialPush,
  errorCodeChain,
  RESET_WORKSPACE,
  makeEntitySetResolver,
  provisionSolution,
  provisionDataModel,
  settleOwedLengths,
  provisionSampleData,
  BuildHalt: _BuildHalt,
  SDK_COLUMN_TYPE: _SDK_COLUMN_TYPE,
  findExistingTable,
  findExistingColumns,
  relationshipExists,
  localizedLabelLcidsInSpec,
  lookupsWithDefaultLabel,
  relationshipsInCreateOrder,
} = require('./entity-provision.js');
const { repairLookupCellLabels } = require('./lookup-cell-labels.js');
const { diffBpfStages, deployedBpfStages, desiredBpfStages, describeBpfEdit, describeBpfRefusals } = require('./bpf-stages.js');
const { hasLabelUses, makeChoiceReader, makeGlobalChoiceReader, resolveViewFilterLabels, checkViewFilterLabelsBeforeBuild, describeProblem, describeProblems } = require('./view-filter-labels.js');
// Pure App Spec -> canonical SDK intent compiler (new form topology + generic-surface intents).
const {
  compileFormIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  findFieldCellPointer,
  findFieldCellLocation,
  findFieldCellLocations,
  findFieldOuterCells,
  findSectionLocation,
  findSectionById,
  declaredSectionByField,
  subgridCellIntent,
  subgridSectionIntent,
  notesSectionIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  firstColumnSectionsPointer,
  cellFitsInRow,
  rowsFromCells,
} = require('./artifact-intent.js');
const { makeGenpageSdk, suppliedButBlank, unescapePacName, sourceText, holdsWhatWasSent, describeDivergence, entityTablesOfSiteMap } = require('./genpage-sdk.js');
const { genPageSubArea } = require('./genpage-subarea.js');
const { matchContainer, isEngineOwnedSection, isEngineHostSection, holdsControlOf, claimedByAuthoredName, planOrderMoves } = require('./form-container-match.js');
const { rowOccupancy, fitsGrid, strandedRows } = require('./form-occupancy.js');
const { TIMELINE_CONTROL_ID, FULL_BUILD, timelineInSection, controlIdTaken, timelineRepairPlan, timelineRefusal } = require('./form-timeline.js');
const { placementOf, resolvePlacement, columnSequence, neighbourOf, findGridSection: findSubgridSection } = require('./form-subgrid-placement.js');
const { manifestResourceName, buildManifest, serializeManifest, parseManifestBase64, reconcilePageIds } = require('./page-manifest.js');
// MEMBERSHIP authority (the app's live sitemap) + the cross-app shared-page scan. fetchSitemap is
// fail-closed & discriminated; fetchAppsForPages is the only way to prove a generative page is not
// shared, since a genpage has no appmodulecomponent row (grounded live probe).
const { fetchSitemap, navigationProof, fetchAppsForPages } = require('./sitemap-pages.js');
// Structural nav oracle — used in the §9 PAGEREF_ scan/parity/resolve pipeline. `extractNavTargets`
// classifies every generative navigateTo pageId at a REAL call site (never a decoy string / comment GUID).
const { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, navTargetParity, strayPageRefs, describePageRefLocations, pageRefAdvice, frontierNote, PAGEREF_RULE } = require('./pageref-resolver.js');
const { griffelStyleProblems, describeGriffelRefusal, describeGriffelWarning } = require('./griffel-styles.js');
const { recordedContentSha } = require('./content-hash.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { AI_APP_SETTING, resolveAiFlags, encodeAiFlags, rebucketNonEnablingSkips, rebucketPendingPublish, specOptsIntoAi, featureWantValue, sameSettingValue, resolveAppModuleId, proveAppOverride, proofBudget } = require('./ai-app-settings.js');
const { DASHBOARD_LAUNCHER_URL, adoptLiveSitemap, chromeByTargetKey, describeSitemapNotes } = require('./sitemap-merge.js');
const { buildPromptSpec } = require('./ai-prompt.js');
const { odataLit } = require('./odata.js');
const { isRestrictedSolution } = require('./system-solutions.js');
const { tableRefs, pinAppTables, publishAppComponents, resolveMainForms, appComponentsFor, applyAppMainForms, explainAppPushWarnings, savedPageRows } = require('./app-components.js');
const { appWriteTables, appPushTables, preAppTables, publishTablesXml, readSavedNotPublished, describeSavedNotPublished, readAppFormChartTables, describePreAppRefusal, describeUnreadAppComponents } = require('./table-publish.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');
const { createSolutionMembership, ensureSolutionComponent } = require('./solution-membership.js');
const { readPageComponentType, pageComponent } = require('./page-solution.js');
const { openUnconfirmedWebResources } = require('./web-resource-records.js');
const { openDashboardCreations } = require('./dashboard-creation-records.js');
const { ownValue } = require('./own-keys.js');
const { navigationEntryKind, navigationHolds, navigationIsPagesOnly, navigationVerdict } = require('./app-navigation.js');
const { isAppTextMap, appTextKind, localizedAppText } = require('./app-header-text.js');
// The build's retry policy (retry-policy.js): every halt below is raised with what a run again may do — RETRY.NEVER, or a policy decided from the failure it wraps — and every failure the engine
// raises itself is made by refusal() (deterministic) or serviceFailure() (the plugin's words around a failure of the service), because the build's retry reads a failure's STRUCTURE and the
// service's words, never a message that quotes what the maker named. tests/halt-retry-policy.test.js enumerates the halts in this file and holds each to a table.
const { RETRY, isTransientStatus, judgeFailure, retryPolicyFor, retryFrom, refusal, serviceFailure, withCause } = require('./retry-policy.js');
const { HTTP_SEND_HISTORY } = require('./sdk-http-client.js');

// Re-export from entity-provision so the export surface stays unchanged
const BuildHalt = _BuildHalt;
const SDK_COLUMN_TYPE = _SDK_COLUMN_TYPE;


// Dataverse control class ids. The vendored bundle does NOT export the SDK's ControlClassId enum, so
// these stable platform GUIDs are pinned here (matching the SDK's
// @maker-studio/cds-designer-models ControlClassIds) and passed as intent to the generic addElement
// surface — the SDK adapter derives a BOUND FIELD's classId from its attribute type, but a
// notes/subgrid/quick-view control's classId IS the intent, so the caller supplies it.
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E'; // ControlClassId.TimelineControl
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B'; // ControlClassId.SubgridControl
const QUICK_VIEW_CLASS_ID = '5C5600E0-1D6E-4205-A272-BE80DA87FD42'; // ControlClassId.QuickViewControl
// Dashboard tile control class ids (DashboardAdapter TILE_CLASS_ID). chart and list share the grid
// control id; ChartGridMode (Chart vs Grid) disambiguates them.
const TILE_CLASS_ID = {
  chart: 'E7A81278-8635-4D9E-8D4D-59480B391C5B',
  list: 'E7A81278-8635-4D9E-8D4D-59480B391C5B',
  iframe: 'FD2A7985-3187-444E-908D-6624B21F69C0',
  webresource: '9FDF5F91-88B1-47F4-AD53-C11EFC01A01D',
};
// Solution component types. `workflow` is 29 — a business rule is a workflow row (category 2), so it
// is added to the solution under that type, not under a bespoke one.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, dashboard: 60, webResource: 61, sitemap: 62, app: 80, role: 20, workflow: 29 };

// Which of `ids` (dashboard systemform ids) are components of the solution `solutionUniqueName`.
//
// A dashboard's only identity in an App Spec is its name, and Dataverse neither keeps names unique nor
// compares them exactly (it ignores case, most accents and trailing spaces), so a lookup by name can
// return other apps' dashboards too. Every dashboard the build creates is added to the app's solution
// (the dashboards phase below) — which makes membership the evidence of ownership that the name alone
// cannot give. Used by the build (which of several matches to reuse) and by teardown (which to delete).
//
// Returns a Set of bare lower-case ids, or null when there is no solution to ask: none named, a
// built-in container (it holds every unmanaged customization, so it proves nothing), or one that no
// longer exists. Throws when a read fails; each caller decides how to fail closed.
async function dashboardsInSolution(sdk, solutionUniqueName, ids) {
  if (!solutionUniqueName || isRestrictedSolution(solutionUniqueName)) return null;
  const bare = (g) => String(g == null ? '' : g).replace(/[{}]/g, '').toLowerCase();
  const sols = await sdk.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solutionUniqueName)}'`, top: 1 });
  const solId = sols && sols[0] && sols[0].solutionid;
  if (!solId) return null;
  const wanted = [...new Set((ids || []).map(bare).filter(Boolean))];
  const members = new Set();
  // In chunks, so the OR-list — and the URL — stays bounded however many name matches there are
  // (findDashboardsByName reads them all). A component appears once per solution, so a chunk of 25
  // ids answers at most 25 rows and `top: 50` never truncates.
  for (let i = 0; i < wanted.length; i += 25) {
    const chunk = wanted.slice(i, i + 25);
    const rows = await sdk.queryRecords('solutioncomponent', {
      select: ['objectid'],
      filter: `_solutionid_value eq ${bare(solId)} and componenttype eq ${COMPONENT_TYPE.dashboard} and (${chunk.map((id) => `objectid eq ${id}`).join(' or ')})`,
      top: 50,
    });
    for (const r of rows || []) {
      const id = bare(r && r.objectid);
      if (id) members.add(id);
    }
  }
  return members;
}

// Every dashboard whose name matches `name` (Dataverse's comparison: case, most accents and trailing
// spaces ignored), as `[{ id, name }]`. The vendored `resolveArtifact('dashboard', { name })` reads ONE
// page — `top: 10` with no `$orderby`, so the server picks which ten — and with more matches than that
// the app's own dashboard can sort beyond it, leaving every ownership decision (reuse, check, delete)
// made without it. So a full page is re-read in full. A reader without resolveArtifact (verify's)
// always reads in full. Shared by build, verify and teardown so all three see the same set.
const DASHBOARD_LOOKUP_PAGE = 10;
async function findDashboardsByName(sdk, name) {
  if (typeof sdk.resolveArtifact === 'function') {
    const page = (await sdk.resolveArtifact('dashboard', { name })) || [];
    if (page.length < DASHBOARD_LOOKUP_PAGE) return page;
  }
  const rows = (await sdk.queryRecords('systemform', { select: ['formid', 'name'], filter: `type eq 0 and name eq '${odataLit(name)}'`, paginate: true })) || [];
  return rows.map((r) => ({ id: String(r.formid), name: String(r.name) }));
}

// The dashboard a downloaded spec's `dashboards[].dashboardId` pins — the one it was read from — as
// `{ id, name }`, or null when this environment has no row with that id (a spec downloaded from another
// environment, or a dashboard deleted since). A row that exists but is not a dashboard (systemform
// `type` 0) is a wrong pin and throws: pointing a nav entry at a form would break it. Shared by build,
// verify and teardown, so all three bind the same dashboard.
async function findPinnedDashboard(sdk, pin) {
  const id = String(pin === undefined || pin === null ? '' : pin).trim().replace(/^\{|\}$/g, '').toLowerCase();
  if (!FORM_GUID_RE.test(id)) return null;
  const rows = await sdk.queryRecords('systemform', { select: ['formid', 'name', 'type'], filter: `formid eq ${id}`, top: 1 });
  const row = rows && rows[0];
  if (!row) return null;
  if (row.type !== undefined && row.type !== null && Number(row.type) !== 0) {
    throw refusal(`dashboardId ${id} is a type-${row.type} form, not a dashboard — correct the id, or remove it to find the dashboard by name`);
  }
  return { id: String(row.formid), name: String(row.name === undefined || row.name === null ? '' : row.name) };
}

// One systemform row read by its id in the SAVED layer, through the SDK's own client:
//   GET /systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,type
//   200 { "@odata.etag": "W/\"1234567\"", "formid": "11111111-1111-4111-8111-111111111111", "name": "Ops Overview", "type": 0 }
//   404 { "error": { "code": "0x80040217", "message": "systemform With Id = 11111111-… Does Not Exist" } }
// The saved layer answers for a row whether or not it was ever published — MEASURED by the bundled SDK, whose readSystemFormType reads the same function:
// a never-published form, a new dashboard and an out-of-box form all answer with their type, and a missing id answers 404 0x80040217. A plain read
// (`$filter=formid eq <id>`, or the name lookup) answers the PUBLISHED layer only, where a dashboard an interrupted build created is not, so a miss there
// proves nothing. It is not read through the build workspace either: a fetch into it can hand back the local copy the interrupted run left there, which
// is not the service's word. `dataverse.get` answers a non-2xx as a response (it throws only when no answer came), so the status is read here, and only
// the documented "Does Not Exist" proves the row absent — any other answer, a 404 without that code included, proves nothing either way.
// Answers { state: 'present', id, name, type } | { state: 'absent', id } | { state: 'unreadable', id, why, status?, answered?, error? }.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublished
async function readSavedSystemForm(provision, id) {
  const client = provision && provision.dataverse;
  if (!client || typeof client.get !== 'function') return { state: 'unreadable', id, why: 'the SDK has no reader of the saved layer' };
  let response;
  try {
    response = await client.get(`/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,type`);
  } catch (error) {
    return { state: 'unreadable', id, why: (error && error.message) || String(error), error };
  }
  const status = response && response.status;
  const body = response && response.body;
  const answered = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : undefined;
  if (status === 404 && answered && answered.code === '0x80040217') return { state: 'absent', id };
  if (status >= 200 && status < 300 && body && typeof body === 'object' && String(body.formid || '').replace(/[{}]/g, '').toLowerCase() === id) {
    return { state: 'present', id, name: typeof body.name === 'string' ? body.name : '', type: body.type };
  }
  return { state: 'unreadable', id, status, answered, why: `HTTP ${status}${answered && typeof answered.message === 'string' ? `: ${answered.message}` : ' with no row the build can read'}` };
}

// A systemform `type` as the integer it is, strictly (the platform answers a number; a text of digits is read as one). Anything else is NaN, never 0 —
// 0 is a real type, the standard dashboard the build creates.
function systemFormType(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : NaN;
  return typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
}

// The dashboard an earlier, interrupted run of this build created for `dash` and never saw join the solution (lib/dashboard-creation-records.js), settled
// before any dashboard is looked up by name. `ids` are what the record holds: `sent`, the id the create was sent with, then `reported`, the one its push
// reported when that was another. The two are not equal evidence: after such a re-key the reported row is the one the create made, and the sent id was
// never seen to make anything. Each is read in the saved layer (readSavedSystemForm):
//   - none is there: the create never committed, or the row was deleted since — the record is cleared and the build goes on as it always did, looking the
//     dashboard up by name (answers undefined). Unless another build sharing the workspace has changed the entry since this build read it — recorded the
//     id its push reported, say, which names the row its create made: then the absence of the ids THIS build read proves nothing, the entry is left, and
//     the step stops without creating a dashboard;
//   - the row the create made is (the sent one, or the reported one after a re-key), a standard dashboard with this name: THAT row is added to the
//     solution — idempotent: a component the solution already holds is not added twice — and reused, and the record cleared (answers its id). Its tiles
//     are what the interrupted run pushed, and are not repaired;
//   - anything else — a read that fails, a row of another kind, a dashboard renamed since, both ids answering, or, after a re-key, only the SENT id
//     answering (a row the build never saw its create make: another maker can have made it since, and adding it would give teardown the authority to
//     delete it): nothing is added and nothing deleted, no dashboard is created, the record is kept, and the step stops with what a maker can do —
//     never asking for a row to be deleted that may be another app's. Creating a dashboard there could make the second one this record exists to
//     prevent, and adding the row could adopt what the build does not know to be its own.
// Never deletes anything: the record proves which ids the build sent and was answered with, not that a row which answers to one now is used by nobody else.
async function recoverRecordedDashboard(provision, { dash, ids, sol, runner, creations }) {
  const [sent, reported] = ids;
  const reads = [];
  for (const id of ids) reads.push(await readSavedSystemForm(provision, id));
  const label = `dashboard "${dash.name}"`;
  const created = reported ? `${sent} (the service reported ${reported})` : sent;
  const stop = (error) => runner.run('dashboards', label, async () => { throw error; });
  const unreadable = reads.find((r) => r.state === 'unreadable');
  if (unreadable) {
    // A run again may settle it: whether it does follows what the service answered (its status and its own error), never the dashboard's name.
    return stop(serviceFailure(`dashboard "${dash.name}": an earlier build created it as ${created} and stopped before adding it to solution '${sol.uniqueName}', and whether it still exists could not be read (${unreadable.why}). Nothing was added to the solution or deleted, and no second dashboard was created; run the build again.`, { status: unreadable.status, answered: unreadable.answered, cause: unreadable.error }));
  }
  const present = reads.filter((r) => r.state === 'present');
  if (!present.length) {
    // Absent — but only by the ids this build READ. Another build sharing the workspace may have changed the entry since (recorded the id its own push
    // reported, which names the row its create made): the clear then leaves the entry (it answers null), and nothing is created on the older word.
    if (creations.clear(dash.name) === null) {
      return stop(refusal(`dashboard "${dash.name}": the record this build read named ${created} for it — a create an earlier build had not seen join solution '${sol.uniqueName}' — and no row has ${reported ? 'either id' : 'that id'} now, but another build sharing this workspace has changed that entry of ${creations.path()} since this build read it. Nothing was added to the solution or deleted, and no dashboard was created: this build does not act on what it read. Run the build again once the other build has finished; it then reads the record as it is.`));
    }
    return undefined;
  }
  // The way out names the row the service reported and asks for no delete: either row may be another app's, and this record is no authority over it.
  if (present.length > 1) {
    return stop(refusal(`dashboard "${dash.name}": an earlier build stopped after creating it, and both ids it recorded for it name a row now — ${sent}, the id its create was sent with, and ${reported}, the id the service reported for the dashboard it made — so it cannot tell on its own which one is this app's. Nothing was added to the solution or deleted. Do not delete either dashboard to settle this: the other one may be another app's. Check in Maker which one this app's build made (the service reported ${reported}), add that one to solution '${sol.uniqueName}' and publish it there, then remove the entry '${dash.name}' from ${creations.path()} and run the build again: it then reuses the dashboard the solution holds and leaves the other as it is.`));
  }
  const [row] = present;
  if (reported && row.id !== reported) {
    return stop(refusal(`dashboard "${dash.name}": an earlier build stopped after creating it. Its create was sent as ${sent}, but the service reported the dashboard it made as ${reported}, which is gone now, and ${sent} names a row this build never saw its create make. Nothing was added to the solution or deleted, and no dashboard was created. That row is not known to be this app's: do not delete or change it on this build's account. Find out whose it is, then remove the entry '${dash.name}' from ${creations.path()} and run the build again: it then finds the dashboard by name, as it does when nothing is recorded.`));
  }
  const type = systemFormType(row.type);
  if (type !== 0) {
    return stop(refusal(`dashboard "${dash.name}": an earlier build recorded ${row.id} for it before it stopped, and that id now names ${Number.isNaN(type) ? 'a systemform whose type could not be read' : `a systemform of type ${type}`}, not a dashboard of the kind the build creates (type 0). Nothing was added to the solution or deleted. Check the id, then remove the entry '${dash.name}' from ${creations.path()} and run the build again.`));
  }
  if (dashboardNameKey(row.name) !== dashboardNameKey(dash.name)) {
    return stop(refusal(`dashboard "${dash.name}": an earlier build created it as ${row.id} and stopped before adding it to solution '${sol.uniqueName}', and that dashboard is now named '${row.name}'. Nothing was added to the solution or deleted. If it is this app's, rename it back to '${dash.name}' in Maker and run the build again: it is then added to the solution and reused. If it is not wanted, delete it in Maker and run the build again: '${dash.name}' is then created afresh.`));
  }
  await runner.run('dashboards', `${label} (created by an interrupted build as ${row.id} — added to the solution, and reused)`, async () => {
    try {
      await provision.addSolutionComponent({ componentId: row.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
    } catch (err) {
      // Kept, and not undone: deleting the row on this record's word is what it must never do. A run again tries the add again.
      throw serviceFailure(`dashboard "${dash.name}" (${row.id}), which an earlier build created and stopped before adding to solution '${sol.uniqueName}', could not be added to it now (${(err && err.message) || err}). Nothing was deleted, and the record of it is kept: run the build again to add it.`, {
        status: err && (err.statusCode || err.status), words: judgeFailure(err).text, cause: err,
      });
    }
    creations.clear(dash.name);
  });
  return row.id;
}

// Web-resource kinds (App Spec `type`) -> SDK createWebResource `type` token. The SDK maps
// the token to the Dataverse webresourcetype code (js=3, html=1, css=2, …).
const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
// Form-event kinds the engine can wire (onload/onsave/onchange) via the /bag/c <events> region.
const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);

// The ONLY supported way to author a business rule: the bound member the modern business-rule
// designer itself uses. Named here for the warning text so the operator can search for it, and so a
// rename shows up in one place rather than inside a string.
//
// The vendored SDK writes rules through this member or refuses — it no longer compiles a client-side
// WWF XAML substitute. Environments where the member is undeclared therefore cannot host business
// rules at all; that is a platform-side rollout, not something a spec can work around.
const BUSINESS_RULE_MEMBER = 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson';
// What an environment that declares the member but has it switched off answers to EVERY create, whatever the rule holds (garbage content
// included) — the answer a platform feature gate gives, which names nothing:
//   POST <env>/api/data/v9.0/workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson
//   HTTP 400  {"error":{"code":"0x80040216","message":"An unexpected error occurred."}}
// The code is generic (0x80040216 is the platform's "unexpected error"), so it is read together with the status AND the member that was
// asked, and only for the FIRST create of a build (see isConfirmedBusinessRuleRefusal). Measured on every production-geo environment tried.
const BUSINESS_RULE_SWITCHED_OFF_CODE = '0x80040216';

// True when `err` is the DEFINITIVE answer to the first send of a business-rule create that the platform answers when the member is switched off — the HTTP 400 above to
// a call of the business-rule member — and nothing in it or behind it leaves the create's outcome open. The SDK throws the answer as
//   Error 'HTTP 400 from <url>: An unexpected error occurred.'  { code: 'CONNECTION_ERROR', statusCode: 400, url, cause: <the response body> }
// and, where a push reports it by value, `requireSuccessfulPush` wraps it in a BuildHalt whose `cause` is that error — so the chain is walked rather than only the top.
// The words of the message are never read: the platform answers in the caller's language, the code does not change.
//
// A 400 is a refusal OF THE SEND THAT GOT IT, and says nothing of one before it. An earlier send of the same create that got no answer, or a gateway's 5xx, can have
// created the rule; the plugin's HTTP client sends such a create again, and the SDK may call it again, and the 400 that finally comes would then read as "nothing was
// created". So the answer is accepted only when
//   - nothing in the chain says the outcome is unknown or partial (`outcome: 'unknown'`, a code naming an unknown outcome such as UPSERT_OUTCOME_UNKNOWN, the rule left
//     deactivated) or is itself an answer that proves nothing (no answer, status 0; a 5xx; a success status the SDK could not use): that wins over a match further down.
//     (`transient: false` alone is NOT such a mark: the halt requireSuccessfulPush makes around a refusal carries it, and that wrapper is transparent.) And
//   - the plugin's HTTP client reports, on the answer's body, that no earlier send of this request was ambiguous (HTTP_SEND_HISTORY). A transport that reports nothing is
//     not confirmed: it halts, as it did before this gate. This does not depend on the create being sent only once by anything else.
// The member is told by the request, never by a substring of a URL: the build's own reads of the rule's name (workflows?$filter=name eq '…') can quote the member's name.
function isConfirmedBusinessRuleRefusal(err) {
  const chain = [];
  for (let e = err; e && typeof e === 'object' && chain.length < 6 && !chain.includes(e); e = e.cause) chain.push(e);
  for (const e of chain) {
    const status = e.statusCode != null ? e.statusCode : e.status;
    if (e.outcome === 'unknown' || /outcome[-_ ]?unknown/i.test(String(e.code || '')) || e.code === 'BUSINESS_RULE_LEFT_DEACTIVATED') return false;
    if (Number.isInteger(status) && (status === 0 || status >= 500 || (status >= 200 && status < 300))) return false;
  }
  const answered = chain.find((e) => (e.statusCode != null ? e.statusCode : e.status) === 400 && isBusinessRuleMemberUrl(e.url));
  const body = answered && answered.cause;
  if (!body || typeof body !== 'object') return false;
  const code = body.error && body.error.code;
  if (typeof code !== 'string' || code.toLowerCase() !== BUSINESS_RULE_SWITCHED_OFF_CODE) return false;
  const history = body[HTTP_SEND_HISTORY];
  return Boolean(history) && history.earlierAmbiguous === false;
}

// Whether a request URL is a call of the business-rule member: a path that ends with it. The create is a POST of
//   <env>/api/data/v9.0/workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson
// and nothing else the build sends ends so; a query string that quotes the name (…/workflows?$filter=name eq 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson') is not it.
function isBusinessRuleMemberUrl(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://placeholder.invalid').pathname; } catch { return false; }
  return pathname.endsWith(`/${BUSINESS_RULE_MEMBER}`);
}

// The per-app setting name that turns on the modern ("new look") shell. Verified live against a real
// organization: `settingdefinition` uniquename `NewLookAlwaysOn`, datatype 2 (boolean), default
// "false". See the app-shell phase for why this one rather than the other new-look definitions.
const NEW_LOOK_SETTING = 'NewLookAlwaysOn';
// The Wave 2 header/navigation refresh (public preview) — a DIFFERENT `settingdefinition` from
// NEW_LOOK_SETTING above. Named here only for the warning message; the value encoding (a Number
// tri-state where ON is '2', not '1') lives in the SDK's setHeaderAndNavigationRefresh, which is
// why the plugin does not write this row by hand.
const HEADER_NAV_SETTING = 'HeaderAndNavigationRefresh';

// Map a dashboard tile (App Spec) to the SDK's AddDashboardTileOptions. chart/list tiles resolve
// the underlying view (savedqueryid) — and the chart its visualization id — from what the build
// already created; the target entity is derived from the referenced view. iframe/webresource tiles
// carry a url / web-resource name.
//
// Views AND charts are keyed `entity|name`, and a tile resolves both on its OWN target entity. A chart
// keyed by name alone let two same-named charts on different tables collide, so a tile took whichever
// was built last — one table's view with another table's chart, which the platform accepts and
// publishes (live-measured). Validation guarantees the named chart exists on the tile's table.
function dashboardTileOpts(spec, tile, result) {
  const viewEntity = (name) => { const v = (spec.views || []).find((x) => x.name === name); return v && v.entity.toLowerCase(); };
  const span = (o) => { if (tile.colspan) o.colspan = tile.colspan; if (tile.rowspan) o.rowspan = tile.rowspan; return o; };
  // ID passthrough (round-tripped dashboards): a tile may carry the deployed view/chart ids + entity
  // directly, so it binds to the EXISTING views/charts without re-declaring them in views[]/charts[].
  const targetEntity = tile.entity ? tile.entity.toLowerCase() : viewEntity(tile.view);
  if (tile.type === 'chart') {
    return span({ type: 'chart', name: tile.name || tile.chart, targetEntity,
      viewId: tile.viewId || result.created.views[`${targetEntity}|${tile.view}`], visualizationId: tile.visualizationId || result.created.charts[`${targetEntity}|${tile.chart}`] });
  }
  if (tile.type === 'list') {
    return span({ type: 'list', name: tile.name || tile.view, targetEntity, viewId: tile.viewId || result.created.views[`${targetEntity}|${tile.view}`] });
  }
  if (tile.type === 'iframe') return span({ type: 'iframe', name: tile.name, url: tile.url });
  return span({ type: 'webresource', name: tile.name, webResourceName: tile.webResource });
}

// Map a resolved dashboard tile (dashboardTileOpts output) to a canonical DashboardComponent for
// addElement('dashboard', id, '/components', …). The adapter mints the cell/control ids and lays the
// tiles out in the first section: a grid two columns wide, filled in tile order from left to right,
// where a tile too wide for what is left of a row starts the next one and a `colspan` wider than the
// grid is narrowed to it (measured on the bundled SDK; `dashboard-roundtrip.test.js` pins it). The
// caller supplies the classId (chart/list share the grid control id — ChartGridMode disambiguates),
// the `<parameters>` map, and the size. Param keys match the Dataverse control XML; note that a chart
// tile keys its visualization as `VisualizationId`, NOT `ChartId` — see the comment on that line,
// and `lcid-real-bundle.test.js`, which pushes this exact payload through the real bundle.
//
// A tile's height is its rowspan, in rows of the dashboard grid, and the app draws a one-row tile as
// its title bar alone: no chart, no list. The platform's own dashboards give chart and list tiles 9 to
// 24 rows, most often 12, so a tile the spec does not size gets that common height. The default used
// to be 1, which rendered every tile of a generated dashboard as a bare title bar. The width stays 1
// column, so two unsized tiles share a row. An authored `rowspan` or `colspan` wins, a `rowspan` of 1
// included. Only a dashboard the build CREATES gets this: an existing one is reused as it is.
const DEFAULT_TILE_ROWSPAN = 12;
function dashboardComponent(t, index) {
  const parameters = {};
  if (t.type === 'chart') {
    // `VisualizationId`, NOT `ChartId`. The platform validates dashboard FormXML against a schema
    // that enumerates the legal children of `<parameters>`, and `ChartId` is not one of them:
    //   The element 'parameters' has invalid child element 'ChartId'. List of possible elements
    //   expected: 'ViewId, IsUserView, ... VisualizationId, ...'
    // A chart tile therefore failed the whole dashboards phase with a 400. Caught by a live build;
    // the mock-based test had asserted the wrong name, so the suite agreed with the bug.
    // `download-model-app.js` already reads `VisualizationId`, so this also makes a dashboard
    // round-trip through download -> rebuild instead of losing its chart binding.
    parameters.TargetEntityType = t.targetEntity; parameters.ViewId = t.viewId;
    parameters.VisualizationId = t.visualizationId; parameters.ChartGridMode = 'Chart';
  } else if (t.type === 'list') {
    parameters.TargetEntityType = t.targetEntity; parameters.ViewId = t.viewId;
    parameters.IsUserView = 'false'; parameters.ChartGridMode = 'Grid'; parameters.RecordsPerPage = '10';
  } else if (t.type === 'iframe') {
    parameters.Url = t.url;
  } else {
    parameters.WebResourceName = t.webResourceName;
  }
  return {
    type: t.type, name: t.name || '', classId: TILE_CLASS_ID[t.type] || TILE_CLASS_ID.webresource,
    position: { tabIndex: 0, columnIndex: 0, sectionIndex: 0, rowIndex: index, cellIndex: 0 },
    colspan: t.colspan || 1, rowspan: t.rowspan || DEFAULT_TILE_ROWSPAN, parameters,
  };
}

// Command-bar locations (CommandBarJson.location). MainTab = the entity's form/grid command bar.
const COMMAND_LOCATIONS = new Set(['MainTab', 'HomeTab', 'ContextualTab']);

// What a JS command must be handed so its function can do anything.
//
// `onclickeventjavascriptparameters` is a JSON array of `{type,value}` CrmParameter descriptors. When
// it is null the function is invoked with NO arguments — so the near-universal handler shape
// `function doThing(primaryControl) { primaryControl.getAttribute(...) }` throws on its first
// property access and the button silently does nothing. The error surfaces only in the browser
// console, which is exactly how this shipped unnoticed: the build, the server-side state and
// `--verify` all look perfect.
//
// LIVE-MEASURED from the platform's own maker-authored commands on a real org (the numeric codes are
// not documented in the SDK, which passes the string through verbatim):
//   location 0 (form)   -> [{"type":5}]              e.g. AppCommon.KnowledgeArticle…markInternalOpenDialog
//                                                         …discard, …translateArticle — all type 5
//   location 1 (grid)   -> [{"type":12},{"type":24}] e.g. AppCommon.KnowledgeArticle.GridCommandActions.markInternal
//   location 2 (subgrid)-> [{"type":12}]             e.g. …relateCategoryFromSubGridStandard
// So 5 = PrimaryControl, 12 = SelectedControl, 24 = SelectedControlSelectedItemIds.
//
// MainTab is the form command bar (live-verified: our MainTab buttons deploy with `location` 0).
// HomeTab/ContextualTab are mapped to the grid/subgrid shapes by the same correspondence; those two
// are inferred from the classic ribbon meanings rather than live-verified, so an author who needs
// something else can still override with an explicit `parameters` string.
const COMMAND_DEFAULT_PARAMETERS = {
  MainTab: '[{"type":5,"value":null}]',
  ContextualTab: '[{"type":12,"value":null}]',
  HomeTab: '[{"type":12,"value":null},{"type":24,"value":null}]',
};


// control gets a GUID `id` with `command` set to the same id (the appactionid). A button with a
// `library` + `function` gets a functional JS on-click action bound to the created web resource;
// `hidden`/`disabled` set static visibility. A flyout/split container (type FlyoutAnchor|SplitButton)
// carries `children` instead of an action — the SDK's CommandAdapter synthesizes the required
// intervening Group between a flyout and its buttons (Dataverse forbids a button parented directly
// to a flyout). Throws if a referenced web resource wasn't created.
function buildCommandControl(c, webResources, location = 'MainTab') {
  const id = randomUUID();
  const type = c.type || 'Button';
  const control = { id, type, label: c.label, command: id };
  if (c.icon) control.icon = c.icon;
  if (c.library && c.function) {
    const wrId = webResources[c.library];
    if (!wrId) throw refusal(`command "${c.label}" references web resource '${c.library}' which wasn't created — declare it in webResources[] and don't skip the web-resources phase`);
    control.action = { type: 'javascript', webResourceId: wrId, functionName: c.function };
    // Default the parameters when the author did not say. A JS command with none is handed nothing
    // and cannot act on the record — see COMMAND_DEFAULT_PARAMETERS. An explicit value (including
    // an empty string, for a genuinely argument-less function) always wins.
    control.action.parameters = c.parameters !== undefined
      ? c.parameters
      : (COMMAND_DEFAULT_PARAMETERS[location] || COMMAND_DEFAULT_PARAMETERS.MainTab);
  }
  if (c.hidden) control.hidden = true;
  if (c.disabled) control.disabled = true;
  if ((type === 'FlyoutAnchor' || type === 'SplitButton') && Array.isArray(c.children)) {
    // Children live on the same command bar as their anchor, so they inherit its location.
    control.children = c.children.map((ch) => buildCommandControl(ch, webResources, location));
  }
  return control;
}

// Build a command (modern command-bar) artifact for one entity's buttons. Controls are emitted as
// LOOSE controls in a single empty-title group per location (id '' — not a real appaction, so the
// adapter emits its controls directly). A control may be a flyout/split button carrying `children`:
// that works because the adapter parents the synthesized intervening group to the flyout control.
// TITLED groups are intentionally NOT emitted — a from-scratch titled group is a Group appaction
// that needs a parent command-bar row the adapter doesn't synthesize (Dataverse 400 "Group button
// must have parentappactionid", confirmed live on a fresh entity), so grouping stays deferred.
function commandDef(entityLogical, cmds, webResources) {
  const byLocation = new Map(); // location -> controls[]
  for (const c of cmds) {
    const location = c.location || 'MainTab';
    if (!byLocation.has(location)) byLocation.set(location, []);
    byLocation.get(location).push(buildCommandControl(c, webResources, location));
  }
  const commandBars = [...byLocation.entries()].map(([location, controls]) => ({
    location,
    groups: [{ id: '', title: '', controls }],
  }));
  return { entityLogicalName: entityLogical, commandBars };
}

// Group an entity's commands (keyed by lowercased entity logical name). A null-prototype map: the name is the spec's text, and
// `(map[k] = map[k] || []).push(…)` on a plain object throws for `constructor` or `__proto__` (it reads the inherited member).
function commandsByEntity(spec) {
  const byEntity = Object.create(null);
  for (const c of spec.commands || []) {
    const k = String(c.entity).toLowerCase();
    (byEntity[k] = byEntity[k] || []).push(c);
  }
  return byEntity;
}

/** Resolve --only/--skip/--from/--to into the ordered set of phases to run. Rejects unknown
 *  phase names (a typo previously ran a surprising/empty subset — from/to indexOf(-1) was a no-op). */
function resolvePhases({ only, skip, from, to } = {}) {
  const known = new Set(PHASES);
  const named = [from, to, ...[].concat(only || []), ...[].concat(skip || [])].filter(Boolean);
  const bad = [...new Set(named.filter((p) => !known.has(p)))];
  if (bad.length) throw refusal(`unknown phase(s): ${bad.join(', ')} (valid: ${PHASES.join(', ')})`);
  let active = PHASES.slice();
  if (from) { const i = active.indexOf(from); active = active.slice(i); }
  if (to) { const i = active.indexOf(to); active = active.slice(0, i + 1); }
  const onlySet = only && new Set([].concat(only));
  const skipSet = skip && new Set([].concat(skip));
  return active.filter((p) => (!onlySet || onlySet.has(p)) && (!skipSet || !skipSet.has(p)));
}

// Resolve a view-filter value: a Choice/MultiChoice label becomes its option int; everything
// else (raw ints, strings, ISO dates) passes through. No-value operators omit the value entirely.
//
// `resolution` (ADO 6691114, lib/view-filter-labels.js) is what the build resolved against the
// ENVIRONMENT's option metadata before it wrote any view. It answers first, because the spec can only prove
// a value for an option set this build created: 100000000 + index is wrong for a global choice that already
// existed with other values, and the spec says nothing of a column it does not declare. Without one — a
// caller with no environment to read, `viewDef(spec, v)` in a test — this is the spec-only rule it always was.
//
// The spec-only rule goes through `choiceValueMap`, the SHARED rule, rather than `options.indexOf(val)`.
// Two reasons, and the first is a real defect the naive version had: a LOCALIZED option is an
// object (`{ "1033": "Open", "3082": "Abierto" }`), so `indexOf("Abierto")` returns -1 and the
// LABEL was sent as the value of a numeric picklist condition — an invalid or silently ineffective
// view filter. The second is that `choiceValueMap` also resolves a column bound to a `globalChoice`,
// which the inline-only lookup never did.
function resolveFilterValue(spec, entityLogical, attr, val, resolution) {
  if (typeof val !== 'string') return val;
  const resolved = resolution ? resolution.value(entityLogical, attr, val) : undefined;
  if (resolved !== undefined) return resolved;
  const e = entityByLogical(spec, entityLogical);
  const c = e && (e.columns || []).find((x) => x.schemaName.toLowerCase() === String(attr).toLowerCase());
  if (!c || (c.type !== 'Choice' && c.type !== 'MultiChoice')) return val;
  const byLabel = choiceValueMap(e, spec)[String(c.schemaName).toLowerCase()];
  const hit = byLabel && byLabel[val];
  return typeof hit === 'number' ? hit : val;
}

function primaryNameOf(spec, logical) {
  const e = entityByLogical(spec, logical);
  return e ? e.primaryAttribute.schemaName.toLowerCase() : `${String(logical).toLowerCase()}name`;
}

// Map an App Spec web resource to SDK createWebResource options. Content comes from inline
// `content` (text), `contentBase64`, or a `contentPath` read relative to the app folder.
function webResourceOpts(wr, appDir) {
  const o = { name: wr.name, displayName: wr.displayName || wr.name, type: String(wr.type || 'js').toLowerCase() };
  if (wr.description) o.description = wr.description;
  if (wr.contentBase64 !== undefined) o.contentBase64 = wr.contentBase64;
  else if (wr.content !== undefined) o.content = wr.content;
  else if (wr.contentPath) o.content = fs.readFileSync(resolveAppSource(appDir, wr.contentPath), 'utf8');
  else o.content = '';
  return o;
}

// How the spec's web resource `wr` compares with the content an environment holds for it — `deployed`, the base64 text a read of
// `webresourceset` answers in `content` (the published layer, for a plain read):
//   { state: 'same' }               the bytes the build would write are the deployed bytes
//   { state: 'differs' }            they are not
//   { state: 'unknown', reason }    one side cannot be read: the spec's source (a contentPath that is not there), or an answer with no content
// The bytes are the ones the SDK sends — `contentBase64` as given, `content` as UTF-8 (webResourceOpts) — and compares when it reads a write back
// to confirm it, so a web resource an earlier build wrote from the same spec compares the same. The ONE comparison behind the build's reuse line
// and verify's web-resource check, so the two cannot disagree about whether an edit was deployed.
function webResourceContentState(wr, appDir, deployed) {
  if (typeof deployed !== 'string') return { state: 'unknown', reason: 'the environment answered no content' };
  let options;
  try {
    options = webResourceOpts(wr, appDir);
  } catch (err) {
    const source = typeof wr.contentPath === 'string' && wr.content === undefined && wr.contentBase64 === undefined ? `contentPath ${JSON.stringify(wr.contentPath)}: ` : '';
    return { state: 'unknown', reason: `the spec's content could not be read (${source}${(err && err.message) || err})` };
  }
  const wanted = options.contentBase64 !== undefined ? Buffer.from(String(options.contentBase64), 'base64') : Buffer.from(String(options.content), 'utf8');
  return { state: Buffer.from(deployed, 'base64').equals(wanted) ? 'same' : 'differs' };
}

// --- the ordered plan (dry-run + totals) -----------------------------------------------
function planFor(spec, opts) {
  const has = (p) => !opts.phases || opts.phases.includes(p);
  const items = [];
  const sol = spec.solution;
  if (has('solution')) items.push({ phase: 'solution', label: `solution ${sol.uniqueName} (publisher ${sol.publisherPrefix})` });
  if (has('data-model')) {
    // The relationship probe identity must match the one the APPLY path uses, or an existing
    // relationship reads as `create`. `provisionDataModel` queries the REFERENCED (parent) entity's
    // OneToManyRelationships — the child's collection does not contain it — and builds the schema
    // name WITH the publisher prefix. Getting either wrong is invisible for a self-referencing
    // relationship (referenced === referencing), which is exactly the shape this was first tested on.
    const relPrefix = spec.solution && spec.solution.publisherPrefix;
    for (const gc of spec.globalChoices || []) items.push({ phase: 'data-model', label: `global choice ${gc.name}` });
    for (const e of spec.entities) {
      // `labelText` returns "" for an absent displayName, or for a localized map with nothing usable
      // — which rendered a dry-run line as `table new_order ("")`, an empty quoted string the reader
      // has to decode. Fall back to the schema name, which is what the CREATE itself falls back to
      // (`displayName || schemaName`), so the plan says what the build will actually do.
      const shown = labelText(e.displayName, spec && spec.languageCode) || e.schemaName;
      items.push({ phase: 'data-model', label: `table ${e.schemaName} ("${shown}")`, key: { kind: 'table', entity: e.schemaName } });
      if (quickCreateEnabledFor(spec, e)) items.push({ phase: 'data-model', label: `enable quick create on ${e.schemaName.toLowerCase()}` });
      for (const c of e.columns || []) {
        if (SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer') items.push({ phase: 'data-model', label: `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`, key: { kind: 'column', entity: e.schemaName, name: c.schemaName } });
      }
      const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
      for (const c of [e.primaryAttribute, ...buildable]) {
        if (c && c.schemaName && Object.prototype.hasOwnProperty.call(c, 'required')) {
          items.push({ phase: 'data-model', label: `required ${e.schemaName}.${c.schemaName}` });
        }
      }
      for (const c of buildable) {
        if (c.type !== 'Customer' && (
          c.defaultValue !== undefined || c.integerFormat !== undefined
          || c.isValidForCreate !== undefined || c.isValidForUpdate !== undefined || c.isValidForRead !== undefined
        )) {
          items.push({ phase: 'data-model', label: `column capabilities ${e.schemaName}.${c.schemaName}` });
        }
      }
      for (const c of e.columns || []) {
        if (c && c.schemaName && c.visualization !== undefined) {
          items.push({ phase: 'data-model', label: `visualization ${e.schemaName}.${c.schemaName} (${c.visualization})` });
        }
      }
      for (const sr of e.statusReasons || []) items.push({ phase: 'data-model', label: `status reason ${e.schemaName}: ${sr.label}` });
      for (const k of e.alternateKeys || []) {
        if (!keyWaitsForNameLength(e, k)) items.push({ phase: 'data-model', label: `alt key ${e.schemaName}.${k.schemaName}` });
      }
    }
    // The relationships in the order the data-model phase creates them (relationshipsInCreateOrder): localized
    // lookups first. The plan lists what the build does, in the order it does it.
    for (const r of relationshipsInCreateOrder(spec)) {
      if (r.type === 'OneToMany') items.push({ phase: 'data-model', label: `relationship 1:N ${r.referenced}->${r.referencing}`, key: { kind: 'relationship', entity: r.referenced, name: relationshipSchemaName(r, relPrefix), relType: 'OneToMany', declared: r } });
      else if (r.type === 'ManyToMany') items.push({ phase: 'data-model', label: `relationship N:N ${r.entity1}<->${r.entity2}`, key: { kind: 'relationship', entity: r.entity1, name: manyToManySchemaName(r, relPrefix), relType: 'ManyToMany', declared: r } });
    }
    // ADO 6691205: one step per lookup whose label the build owns (the spec sets none). On a rebuild it
    // repairs a column an older build labelled with its old default; on a fresh build it is a skip. The
    // predicate is the one the data-model phase emits by, so [n/total] holds.
    for (const r of lookupsWithDefaultLabel(spec)) {
      const { label, source } = lookupLabelFor(spec, r);
      const parent = String(r.referenced).toLowerCase();
      const humanized = `"${labelText(label, spec && spec.languageCode)}"`;
      let shown = humanized;
      if (source === 'derived') {
        // A parent whose name the spec cannot give (a table it does not declare, or an `existing: true` one it
        // declares without a displayName) is named by the environment at build time; the spec cannot say how.
        if (lookupParentNeedsEnvironment(spec, r)) shown = `the display name of ${parent}`;
        // A declared table with no displayName that is not flagged: the build creates it, or finds it already
        // there and takes its label from the environment — which the plan cannot know, so it says both.
        else if (entityByLogical(spec, r.referenced)) shown = `${humanized}, or the label from the environment if ${parent} is already there`;
      }
      items.push({ phase: 'data-model', label: `lookup label ${String(r.referencing).toLowerCase()}.${r.lookup.schemaName} (default ${shown})` });
    }
    // Present exactly when the spec gives a name column a length: provisionDataModel narrates one step for it either way (run, or
    // skipped with the reason), so the count holds. Listed after the relationships and the lookup labels because that is where the build sets the
    // length of a table it creates: once every labelled create and repair of the phase is done.
    for (const e of spec.entities) {
      if (askedPrimaryNameLength(e) !== undefined) items.push({ phase: 'data-model', label: `primary column length ${e.schemaName}.${e.primaryAttribute.schemaName}` });
    }
    // Then the alternate keys over a name column whose length is set: the build makes such a key once that length is right
    // (keyWaitsForNameLength, which depends on what the key's label is sent as and not on the language the build writes in, so the plan and the
    // apply cannot disagree about it). The plan lists it
    // where a table the build creates has it; a table that already exists is not written to, and
    // its keys are made with the table — the same steps, in another place, so the count holds. The same goes for a key labelled in several
    // languages that the environment made the name column too long to fit beside (keyMustWaitForShorterNameColumn, lib/entity-provision.js):
    // only the environment can say, so the plan lists such a key with its table, and the apply makes it after the length step.
    for (const e of spec.entities) {
      for (const k of e.alternateKeys || []) {
        if (keyWaitsForNameLength(e, k)) items.push({ phase: 'data-model', label: `alt key ${e.schemaName}.${k.schemaName}` });
      }
    }
  }
  if (has('sample-data') && opts.sampleData) {
    for (const e of spec.entities) { const n = sampleRecordsFor(spec, e).length; if (n) items.push({ phase: 'sample-data', label: `${n} sample record(s) -> ${e.schemaName}` }); }
  }
  if (has('web-resources')) for (const wr of spec.webResources || []) items.push({ phase: 'web-resources', label: `web resource ${wr.name} (${wr.type || 'js'})` });
  if (has('web-resources')) for (const e of spec.entities || []) if (e.icon || e.vectorIcon) items.push({ phase: 'web-resources', label: `table icon for ${e.schemaName.toLowerCase()}` });
  if (has('views')) for (const v of spec.views || []) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}`, key: { kind: 'view', entity: v.entity, name: v.name, declared: v } });
  if (has('views')) for (const e of spec.entities || []) if (enrichesDefaultViews(spec, e)) items.push({ phase: 'views', label: `enrich default views for ${e.schemaName.toLowerCase()}` });
  if (has('charts')) for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}`, key: { kind: 'chart', entity: c.entity, name: c.name } });
  if (has('forms')) for (const f of spec.forms || []) {
    const ft = f.formType || 'Main';
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    // The form's Dataverse NAME is whatever compileFormIntent derives (the author may omit `name`),
    // and that is the name the reuse lookup keys on — so derive it the same way rather than guessing.
    // Wrapped because planFor must stay total: a spec shape compileFormIntent rejects should still
    // produce a plan LINE (it just cannot be probed live), never crash the dry run.
    let formKey;
    try {
      const def = compileFormIntent(spec, f, { notesClassId: NOTES_CLASS_ID });
      formKey = { kind: 'form', entity: def.entityLogicalName, name: def.name, formType: ft, formId: f.formId };
    } catch { formKey = undefined; }
    items.push({ phase: 'forms', label: `${ft === 'Main' ? 'form' : `${ft} form`} for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}`, ...(formKey ? { key: formKey } : {}) });
    if ((f.events || []).length) items.push({ phase: 'forms', label: `wire ${f.events.length} event handler(s) on ${f.entity}` });
    if ((f.quickViews || []).length) items.push({ phase: 'forms', label: `place ${f.quickViews.length} quick-view(s) on ${f.entity}` });
  }
  // AB#6736948: one step per table with Main forms, after all of them exist — it sets the table's Main
  // Form Set order, or keeps it (a form new on a table the spec orders nothing on goes after the others).
  // None where the author orders the forms by hand (`securityRoles.order`).
  if (has('forms')) {
    const orderSteps = new Set();
    for (const f of (spec.forms || []).filter(isMainForm)) {
      const key = String(f.entity || '').toLowerCase();
      if (!key || orderSteps.has(key)) continue;
      orderSteps.add(key);
      if (!ordersByHand(spec, key)) items.push({ phase: 'forms', label: `form order for ${f.entity}` });
    }
  }
  if (has('business-rules')) for (const r of spec.businessRules || []) items.push({ phase: 'business-rules', label: `business rule "${r.name}" on ${r.entity}` });
  if (has('business-process-flows')) for (const p of spec.businessProcessFlows || []) {
    const stages = (p.stages || []).length;
    items.push({ phase: 'business-process-flows', label: `business process flow "${p.name}" on ${p.entity} (${stages} stage${stages === 1 ? '' : 's'})` });
  }
  if (has('commands')) for (const [entity, cmds] of Object.entries(commandsByEntity(spec))) items.push({ phase: 'commands', label: `command bar for ${entity} (${cmds.length} button(s))` });
  if (has('dashboards')) for (const d of spec.dashboards || []) items.push({ phase: 'dashboards', label: `dashboard "${d.name}" (${(d.tiles || []).length} tile(s))` });
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap`, key: { kind: 'app', uniqueName: appUniqueName(spec) } });
  if (has('app-shell') && !(spec.app && spec.app.icon)) items.push({ phase: 'app-shell', label: `app icon (generated) ${appUniqueName(spec)}_icon` });
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length && appHasCrossPageNav(spec)) items.push({ phase: 'pages', label: 'resolve cross-page navigation' });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  // Budgeted whenever the pages phase runs, NOT only when the spec has page subareas. The runtime
  // finalizes on `appHasPageSubareas(spec) || appWasExisting`, and `appWasExisting` is a LIVE fact
  // planFor cannot see — so gating the plan on the spec alone under-counted every rebuild against an
  // app that already existed, and the run overran its own denominator ([37/36], live-reproduced on a
  // page-less spec). The runner's total is fixed at construction from plan.length, so the only way to
  // stay in step is to budget the step and have the runtime emit an explicit `skip` when it does not
  // fire — the same shape as the existing-column "applied on create" skips.
  if (has('pages')) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
  if (has('ai-features') && specOptsIntoAi(spec)) {
    items.push({ phase: 'ai-features', label: 'enable app AI features' });
    // Do NOT short-circuit on `summaries.default === 'off'`. `selectSummaryTables` already implements
    // the documented semantics — `default` is the app-level DEFAULT and `tables[x].enabled: true` is
    // a per-table OVERRIDE that wins over it — and bailing here made that opt-in branch unreachable,
    // silently dropping a summary the author explicitly asked for.
    for (const logical of selectSummaryTables(spec)) {
      items.push({ phase: 'ai-features', label: `row summary for ${logical}` });
    }
  }
  if (has('security')) for (const p of spec.personas || []) {
    const n = (p.jobs || []).length;
    items.push({ phase: 'security', label: `security role "${p.persona}" (${n} job${n === 1 ? '' : 's'})` });
  }
  // Role grants are planned after personas because they run after them (a grant on a role this spec
  // also authors is rejected at validation, but the ORDER still matters for reading the plan).
  if (has('security')) for (const g of spec.roleGrants || []) {
    const n = (g.privileges || []).length;
    items.push({ phase: 'security', label: `grant privileges on ${n} table${n === 1 ? '' : 's'} to existing role ${roleGrantLabel(g)}` });
  }
  // Form role assignment is planned under `security` (not `forms`) because it can only run once the
  // roles exist — see the 7b block in the engine for why.
  if (has('security')) for (const f of spec.forms || []) {
    if (f && f.securityRoles) items.push({ phase: 'security', label: `form roles for ${f.name || f.formType || 'Main'} on ${f.entity}` });
  }
  // Flow role grants are planned under `security` for the same reason form ones are: they target the
  // backing table ACTIVATION creates, and they need persona roles that do not exist until this phase.
  if (has('security')) for (const f of spec.businessProcessFlows || []) {
    if (f && f.securityRoles) items.push({ phase: 'security', label: `flow roles for ${f.name} (backing table ${bpfUniqueName(f.name)})` });
  }
  if (has('publish') && opts.publish) items.push({ phase: 'publish', label: 'publish customizations' });
  return items;
}

// --- phase builders (pure: spec -> SDK payloads) ---------------------------------------
// Build a saved-query def. `v.filters[]` adds rich conditions ({ attr, op, value?/values? });
// no-value operators (eq-userid, this-week, null, …) omit the value, and in/not-in expand to a
// nested or/and group of eq/ne (the SDK's filter serializer is single-value per condition).
// Resolve the savedquery id a form sub-grid should embed. Preference order:
//   1. the view the sub-grid explicitly names (a custom view we built),
//   2. any custom view we built for the child entity,
//   3. the child entity's DEFAULT public view (Dataverse auto-creates one per table) — this is
//      what makes a sub-grid on an entity with no bespoke view (a common N:N case) work.
// Returns undefined only when even the default view can't be found (caller then skips the grid).
async function subgridViewId(provision, createdViews, spec, sg, childLogical) {
  // createdViews is keyed by `entity|name` (see the views build step). The sub-grid's view lives on the
  // CHILD entity, so scope the lookup to childLogical to avoid a same-named view on another entity.
  if (sg.view && createdViews[`${childLogical}|${sg.view}`]) return createdViews[`${childLogical}|${sg.view}`];
  const cv = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
  if (cv && createdViews[`${childLogical}|${cv.name}`]) return createdViews[`${childLogical}|${cv.name}`];
  const rows = await provision.queryRecords('savedquery', {
    select: ['savedqueryid', 'isdefault'],
    filter: `returnedtypecode eq '${odataLit(childLogical)}' and querytype eq 0`,
    top: 20,
  });
  const def = (rows || []).find((r) => r.isdefault) || (rows || [])[0];
  return def && def.savedqueryid;
}

function viewDef(spec, v, resolution) {
  const entityLogical = v.entity.toLowerCase();
  const cols = (v.columns && v.columns.length ? v.columns : [primaryNameOf(spec, entityLogical)]).map((name, i) => ({ name: String(name).toLowerCase(), width: 100, order: i }));
  const conditions = [];
  const groups = [];
  if (v.activeOnly !== false) conditions.push({ attribute: 'statecode', operator: 'eq', value: '0' });
  for (const f of v.filters || []) {
    const attr = String(f.attr).toLowerCase();
    const op = f.op || 'eq';
    if (op === 'in' || op === 'not-in') {
      const subOp = op === 'in' ? 'eq' : 'ne';
      const vals = (f.values || []).map((x) => resolveFilterValue(spec, entityLogical, attr, x, resolution));
      groups.push({ type: op === 'in' ? 'or' : 'and', conditions: vals.map((x) => ({ attribute: attr, operator: subOp, value: String(x) })), groups: [] });
    } else {
      const cond = { attribute: attr, operator: op };
      if (f.value !== undefined) cond.value = String(resolveFilterValue(spec, entityLogical, attr, f.value, resolution));
      conditions.push(cond);
    }
  }
  return { name: v.name, description: String(v.description || '').trim(), entityLogicalName: entityLogical, queryType: 0, isDefault: false, columns: cols,
    filters: { type: 'and', conditions, groups },
    sort: (v.sort || []).map((s) => ({ attribute: String(s.attr).toLowerCase(), descending: s.dir === 'desc' })) };
}

// The raw-client readers every view-label check shares. `read` is null with no client to ask (a test double), and
// every check then does what it did before there was one.
function viewLabelReaders(spec, provision) {
  const client = provision && provision.dataverse;
  const languageCode = spec && spec.languageCode;
  return { read: makeChoiceReader({ client, languageCode }), readGlobalChoice: makeGlobalChoiceReader({ client, languageCode }) };
}

// What the build says of a view that already exists whose spec filters on a label that names no option: `reconcileView`
// never reapplies an existing view's filters, so nothing stops — but verify reads the spec's label, and will report it.
// The dry run says the same, so the user hears it before the apply rather than from `--verify`.
const existingViewLabelNote = (p) => {
  // `ambiguous` is a label that names several options; anything else is one that names none. The first sentence says which, so the
  // reason that follows (the numbers the label sits on, or the refusal of the spec's own number) is not left to contradict it.
  const what = p.reason === 'ambiguous'
    ? `"${p.label}" names more than one option of ${p.entity}.${p.attr} (${(p.values || []).join(', ')})`
    : `"${p.label}" is not an option of ${p.entity}.${p.attr}`;
  return `view "${p.view}" (${p.entity}) already exists, so its filters are left as they are — but ${what}, and verify will report that.${p.refusal ? ` ${p.refusal}` : ''}`;
};

// Of the view-label `problems`, the ones that may stop the build: those on a view it would CREATE. `reconcileView`
// never reapplies an existing view's filters, so the label in the spec of a view that is already there changes
// nothing the build writes (verify still reports it) — that is said once, not raised. The existence lookup is
// made only once a problem is found, so a build with nothing wrong pays no extra read; when the lookup cannot
// tell (a table the build has not created yet has no views to find), the view counts as one to create — the
// fail-closed answer.
async function blockingViewLabelProblems(problems, { provision, say }) {
  const existing = new Map();
  const viewExists = (name, entity) => {
    const key = `${entity}|${name}`;
    if (!existing.has(key)) existing.set(key, Promise.resolve().then(() => provision.findArtifact('view', { name, entity })).then((id) => !!id, () => false));
    return existing.get(key);
  };
  const blocking = [];
  for (const p of problems) {
    if (await viewExists(p.view, p.entity)) say(existingViewLabelNote(p));
    else blocking.push(p);
  }
  return blocking;
}

// `beforeAnyWrite`: the pre-flight stops the build before this run has written anything; the views phase, only
// before it writes a view. The pre-flight is tagged with the phase name the CLI's own pre-flight halts already
// carry (`preflight`): it is not part of the views phase, which has not started.
function viewLabelHalt(blocking, { beforeAnyWrite }) {
  // A label the environment shows to be wrong (`unknown`, `ambiguous`) is wrong on a re-run too, so such a halt is never
  // run again. One that only unanswered option reads left undecided (`unreadable`, each `why` reading e.g. "HTTP 503: …")
  // may be answered next time, but only when every one of those reads was throttled or unavailable (429, 502, 503, 504): it then
  // carries that status, which the CLI's retry check (isTransientHalt) reads. Every other halt is never run again,
  // because the message quotes the user's own filter labels, and a label such as "SQL Timeout" must not read as transient.
  // The status is read from the START of a `why` — both of its forms open with it (`HTTP 503: …` for an answer the read reported by value,
  // `HTTP 503 from <url>: …` for the SDK's error) — and nowhere else: a `why` that quotes a column or a label in its words must not
  // pass for an answer of the service.
  const statusOf = (p) => { const m = /^\s*HTTP (\d{3})\b/.exec(String(p.why || '')); return m ? Number(m[1]) : null; };
  const throttled = blocking.length > 0 && blocking.every((p) => p.reason === 'unreadable' && isTransientStatus(statusOf(p)));
  return new BuildHalt(
    `${blocking.length} view filter value${blocking.length === 1 ? '' : 's'} cannot be resolved to an option of the table. ${beforeAnyWrite ? 'The build stopped before writing anything' : 'No view was written'}:\n${describeProblems(blocking)}`,
    { phase: beforeAnyWrite ? 'preflight' : 'views', code: 'view-filter-label-unresolved', recoverable: false, ...(throttled ? { retry: RETRY.SERVICE, statusCode: statusOf(blocking[0]) } : { retry: RETRY.NEVER }) });
}

// The build's pre-flight (ADO 6691114): before the first write of an apply that writes the data model, stop on a
// view-filter label the environment already shows to be wrong (lib/view-filter-labels.js
// `checkViewFilterLabelsBeforeBuild`). Without it the first sign was Dataverse rejecting the saved view — after
// the tables and columns had been written, which left a half-built app for a typo in a filter.
//
// Only a DEFINITE answer halts here: a label that depends on something the build is about to create is left
// to the views phase, which asks again once the data model exists. So is a label the spec's own number stands in
// for (a maker renamed the option — view-filter-labels.js `specNumberStands`): no problem, and not handed on as
// final, because the views phase resolves it and WARNS about it, once. Returns what the environment already held
// and resolved — final, so the views phase takes it as it is (see checkViewFilterLabelsBeforeBuild) — or
// undefined when nothing was checked.
//
// NOT run at all when the spec carries a localized label (AB#6686428). The pre-flight's reads carry labels
// (every option's, in every language), and the measured hazard — documented on relationshipExists — is that
// a label-bearing metadata read ahead of a create makes Dataverse keep only the base-language label of a
// multi-language one, silently. Those reads were never measured to be safe, and a typo in a filter does not
// justify risking the labels the whole localization feature exists to keep, so a build that may create any
// localized label (any map on a table, column, option, lookup… — which of them the environment lacks is
// not knowable without reads) leaves the check to the views phase. That phase runs after every create, so
// it is still before any view is written; what is lost is only the guarantee that NOTHING was written yet.
// The dry run is unaffected: it creates nothing, so no create follows its reads.
async function preflightViewLabels(spec, provision, say) {
  const labelViews = (spec.views || []).filter((v) => hasLabelUses(spec, v));
  if (!labelViews.length) return undefined;
  if (localizedLabelLcidsInSpec(spec).length) return undefined;
  const { problems, resolved } = await checkViewFilterLabelsBeforeBuild(spec, labelViews, viewLabelReaders(spec, provision));
  if (problems.length) {
    const blocking = await blockingViewLabelProblems(problems, { provision, say });
    if (blocking.length) throw viewLabelHalt(blocking, { beforeAnyWrite: true });
  }
  return resolved;
}

// The views phase's gate (ADO 6691114): the FINAL resolution of every option label a view filters on, against the
// ENVIRONMENT as the build left it (lib/view-filter-labels.js), halting — before any view is written — on one
// that names nothing. The alternative is a filter whose value is the label's own text: Dataverse rejects it, or
// stores it and matches nothing, so a build that "succeeds" would ship it. A fresh reader, not the pre-flight's:
// the data model has been written since, and what the build created is what this reads. `prior` is what the
// pre-flight resolved from what already existed — a column, or the global choice a column the build creates is
// bound to — which the build leaves as it was. A localized spec has no `prior` (its pre-flight is skipped), so a
// column bound to a global choice whose own options cannot be read is resolved from the set itself.
//
// Returns what `viewDef` resolves values with, or null when no view names a label (nothing was read).
async function resolveViewLabelsOrHalt(spec, provision, say, prior) {
  const labelViews = (spec.views || []).filter((v) => hasLabelUses(spec, v));
  if (!labelViews.length) return null;
  const { read, readGlobalChoice } = viewLabelReaders(spec, provision);
  const resolution = await resolveViewFilterLabels(spec, labelViews, { read, prior, readGlobalChoice });
  for (const w of resolution.warnings) say(w);
  if (!resolution.problems.length) return resolution;
  const blocking = await blockingViewLabelProblems(resolution.problems, { provision, say });
  if (!blocking.length) return resolution;
  throw viewLabelHalt(blocking, { beforeAnyWrite: false });
}

// Pick a "good" default-view column set: the primary name column plus up to DEFAULT_VIEW_MAX_EXTRA
// meaningful declared columns (in declared order), skipping wide/opaque types that read poorly in a
// grid. Used to enrich the auto-generated "Active/Inactive <Entity>" views (which ship with only
// the primary column).
//
// #7 (drop "Created On" from enriched default views): this set only ever contains declared spec
// columns (primary + scalars + relationship lookups) — never the stock `createdon`. The vendored
// SDK's enrichDefaultViews REPLACES the view's /columns with this array and then reconciles the
// fetchxml + grid to exactly this set (removing the Dataverse-shipped createdon cell/attribute), so
// the enriched default views ship without Created On. See cds-maker-sdk view serializer f3()/v3().
const DEFAULT_VIEW_MAX_EXTRA = 6;
const DEFAULT_VIEW_SKIP_TYPES = new Set(['Memo', 'File', 'Image']);
function defaultViewColumns(spec, entity, opts = {}) {
  const primary = entity.primaryAttribute.schemaName.toLowerCase();
  const includeLookups = opts.includeLookups !== false;
  // #2 / Gap 6: parent lookups are the key "which parent?" columns and must NOT be truncated by the cap
  // (before, scalars filled the cap first and a lookup-heavy table dropped its parent links). Reserve the
  // lookups' slots up front so scalar columns fill only the REMAINING budget, then always append every
  // lookup. Teardown passes { includeLookups:false } to get the lookup-free reset set (a lookup column on
  // an un-deletable default view would otherwise block the relationship's delete), so no slots are
  // reserved on that path and scalars fill the full cap.
  const lookups = includeLookups ? lookupColumnsFor(spec, entity.schemaName.toLowerCase()) : [];
  const scalarBudget = Math.max(0, DEFAULT_VIEW_MAX_EXTRA - lookups.length);
  const picked = [{ name: primary, width: 300, order: 0 }];
  const chosen = new Set([primary]);
  for (const c of entity.columns || []) {
    if (picked.length - 1 >= scalarBudget) break; // -1: exclude the primary from the extra-column count
    const logical = c.schemaName.toLowerCase();
    if (chosen.has(logical)) continue;
    if (DEFAULT_VIEW_SKIP_TYPES.has(c.type)) continue;
    chosen.add(logical);
    picked.push({ name: logical, width: 150, order: picked.length });
  }
  for (const lk of lookups) {
    if (chosen.has(lk.logical)) continue;
    chosen.add(lk.logical);
    picked.push({ name: lk.logical, width: 150, order: picked.length });
  }
  return picked;
}
// #5: resolve a sub-grid's display TITLE. An explicit `sg.label` wins; otherwise a sub-grid is a LIST
// of children, so the child entity's plural display name reads best ("Tickets"), then its singular
// display name, then the child logical name as a last resort. Pure (no I/O) so the eval harness and
// the forms phase share ONE definition instead of drifting.
function subgridLabel(spec, sg) {
  if (sg.label) return sg.label;
  const child = entityByLogical(spec, String(sg.childEntity || '').toLowerCase());
  // Resolved through labelText: a LOCALIZED plural/display name is an object, and returning it here
  // put "[object Object]" into the form's section and control labels — and, because the form
  // projection stringifies for change detection, made two DIFFERENT localized labels hash the same.
  const lang = spec && spec.languageCode;
  return labelText(child && child.pluralName, lang) || labelText(child && child.displayName, lang) || sg.childEntity;
}
// True when a table has enough declared columns to make enriching its default views worthwhile
// (opt out per-entity with enrichDefaultViews:false).
//
// `existing: true` tables are excluded outright. Enrichment REPLACES the Active/Inactive views'
// column set, and `existing` means "this build did not create this table and cannot prove it owns
// it" — the same reasoning that stops teardown from deleting such a table. Rewriting another app's
// default views is destructive and unrecoverable from here, whereas leaving them alone costs
// nothing. This matters most for a `download -> rebuild` round trip: `download-model-app` flags
// every recovered table `existing: true` precisely because ownership is unprovable.
function enrichesDefaultViews(spec, entity) {
  if (!entity) return false;
  // An `existing: true` table is excluded UNLESS the author explicitly opts in. Enrichment REPLACES
  // the Active/Inactive views' column set, and `existing` means this build did not create the table
  // and cannot prove it owns it — the same reasoning that stops teardown from deleting it. Rewriting
  // another app's default views is destructive and unrecoverable from here. This matters most for a
  // `download -> rebuild` round trip: `download-model-app` flags every recovered table `existing`
  // precisely because ownership is unprovable.
  //
  // `enrichDefaultViews: true` is honoured as a deliberate override, because judging "this reused
  // table really is mine" is exactly the call an author can make and this code cannot.
  if (entity.existing === true && entity.enrichDefaultViews !== true) return false;
  return entity.enrichDefaultViews !== false && defaultViewColumns(spec, entity).length >= 2;
}

// Resolve the id of an EXISTING deployed form to reconcile, disambiguating by TYPE (form names are unique
// only per (entity, type)). Returns the formid, or null when the form isn't deployed yet (→ a fresh create).
// Shared by the build's form phase AND the preflight op-diff discovery so both agree on the target.
//   - `def.formId` set → resolve by id (the escape hatch for the residual same-(entity, type, name)
//     collision, e.g. two Main forms both named "Information"). Validated as a GUID because it is
//     interpolated UNQUOTED into an Edm.Guid OData filter, and confirmed to belong to the same table — so a
//     malformed / stale / foreign id fails loud instead of silently reconciling the wrong form.
//   - else → query systemform by (objecttypecode, name, type eq <code>). A `formType:"Main"` edit thus
//     matches ONLY the Main form; same-named Quick View / Card siblings never block it. >1 match (two forms
//     share entity+type+name) throws an ACTIONABLE error telling the author to pin forms[].formId — we
//     refuse to guess rather than reconcile an arbitrary form (fail-closed).
async function resolveExistingFormId(provision, def) {
  if (def.formId) {
    if (!FORM_GUID_RE.test(String(def.formId))) throw refusal(`form "${def.name}": formId '${def.formId}' is not a valid GUID`);
    const rows = await provision.queryRecords('systemform', { select: ['formid', 'objecttypecode', 'type', 'name'], filter: `formid eq ${def.formId}`, top: 1 });
    const row = rows && rows[0];
    // A pinned id names an EXISTING form to reconcile. If it's ABSENT this is a stale/wrong pin, NOT a
    // create trigger — returning null would drop to the create path and mint a NEW form on EVERY rerun
    // (the pin stays in the spec), silently accumulating duplicate forms. Fail loud instead.
    if (!row) throw refusal(`form "${def.name}": pinned formId ${def.formId} does not exist on this environment — remove the pin to create a new form, or correct the id`);
    // The pin must point at the SAME (table, type, name) the spec intends. reconcileForm blindly pushes the
    // spec layout onto whatever id it gets, so a wrong pin (a Quick View id under formType:"Main", a form on
    // another table, or an unrelated form) would CORRUPT that form. The pin's only legitimate use — two
    // forms with identical (entity, type, name) — matches all three, so validating all three never rejects
    // a valid pin, only a mistaken one.
    const wantType = FORM_TYPE_CODE[def.formType || 'Main'];
    if (String(row.objecttypecode).toLowerCase() !== String(def.entityLogicalName).toLowerCase()) {
      throw refusal(`form "${def.name}": formId ${def.formId} belongs to table '${row.objecttypecode}', not '${def.entityLogicalName}'`);
    }
    if (wantType != null && row.type != null && Number(row.type) !== wantType) {
      throw refusal(`form "${def.name}": formId ${def.formId} is a type-${row.type} form but the spec declares formType "${def.formType || 'Main'}" (type ${wantType}) — pin a form of the matching type`);
    }
    if (row.name != null && String(row.name).toLowerCase() !== String(def.name).toLowerCase()) {
      throw refusal(`form "${def.name}": formId ${def.formId} is named '${row.name}', not '${def.name}' — pin the form whose name matches the spec`);
    }
    return String(row.formid);
  }
  const typeCode = FORM_TYPE_CODE[def.formType || 'Main'];
  // A known formType always maps to a code; an unknown one falls back to a name-only match (no worse than
  // the old behavior, and authored formType is lint-constrained to Main/QuickCreate/QuickView anyway).
  const typeFilter = typeCode != null ? ` and type eq ${typeCode}` : '';
  let rows;
  try {
    rows = await provision.queryRecords('systemform', {
      select: ['formid'],
      filter: `objecttypecode eq '${odataLit(def.entityLogicalName)}' and name eq '${odataLit(def.name)}'${typeFilter}`,
      top: 2,
    });
  } catch (err) {
    // A brand-new table isn't in the metadata cache yet, so filtering `objecttypecode eq '<t>'` 400s with
    // "The entity with a name = '<t>' ... was not found in the MetadataCache". A form on a table that does
    // not exist definitionally does not exist, so treat this as NOT FOUND (→ build creates it, preflight
    // has nothing to prune, teardown nothing to delete) — mirroring the SDK findArtifact this replaced,
    // which swallowed it. This must NOT swallow a transient/real failure: re-throw anything else so the
    // fail-closed preflight still refuses to write when it truly can't verify safety.
    // Dataverse error shape: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
    if (err && /not found in the MetadataCache/i.test(String(err.message || ''))) return null;
    throw err;
  }
  if (!rows || !rows.length) return null;
  if (rows.length > 1) {
    throw refusal(`form "${def.name}" (${def.formType || 'Main'}) on ${def.entityLogicalName}: ${rows.length} forms share this table, type, and name — pin the exact one with forms[].formId (e.g. "${rows[0].formid}")`);
  }
  return String(rows[0].formid);
}

// The identity query that finds an already-built artifact so a re-run or a retry-after-partial-failure
// REUSES it instead of creating a duplicate. These artifact types (savedquery/savedqueryvisualization/
// systemform) are otherwise always-create — the root of the "16 copies of everything" duplication. Forms
// additionally scope by TYPE (see FORM_TYPE_CODE — a name is unique only per (entity, type)). Returns null
// for types without a stable identity query.
function artifactIdentityQuery(type, def) {
  const name = odataLit(def.name);
  const entity = odataLit(def.entityLogicalName);
  switch (type) {
    case 'view': return { set: 'savedquery', idField: 'savedqueryid', filter: `returnedtypecode eq '${entity}' and name eq '${name}'` };
    case 'chart': return { set: 'savedqueryvisualization', idField: 'savedqueryvisualizationid', filter: `primaryentitytypecode eq '${entity}' and name eq '${name}'` };
    case 'form': {
      // Scope by type when the formType is known so a Main-form identity never collides with a same-named
      // Quick View / Card. An unknown/absent formType falls back to name-only (back-compat).
      const t = FORM_TYPE_CODE[def.formType];
      return { set: 'systemform', idField: 'formid', filter: `objecttypecode eq '${entity}' and name eq '${name}'${t != null ? ` and type eq ${t}` : ''}` };
    }
    // The app is keyed by its (deterministic) unique name. Reusing it on a re-run avoids a duplicate
    // appmodule (Dataverse 400s on a duplicate uniquename). NOTE: reuse does not re-push the sitemap,
    // so a genuine app EDIT must go through the download->hydrate->update flow, not a bare re-run.
    case 'app': return { set: 'appmodule', idField: 'appmoduleid', filter: `uniquename eq '${odataLit(def.uniqueName)}'` };
    default: return null;
  }
}

function chartDef(spec, ch) {  const entityLogical = ch.entity.toLowerCase();
  return { name: ch.name, description: String(ch.description || '').trim(), entityLogicalName: entityLogical, chartType: ch.chartType, isDefault: false,
    series: [{ attribute: `${entityLogical}id`, aggregate: ch.measure || 'count' }],
    categories: [{ attribute: String(ch.groupBy).toLowerCase() }], presentation: { showLegend: true, title: ch.name } };
}

// Form intent construction (compileFormIntent), field cells, notes cells, row grouping, and
// formFieldLogicals now live in the pure ./artifact-intent.js compiler (new SDK topology
// tabs[].columns[].sections[]). The engine imports them at the top of this file.

// Build a Main-form definition -> moved to ./artifact-intent.js `compileFormIntent`
// (new SDK topology tabs[].columns[].sections[]; the adapter derives classId/label).


// The ordered field logical names a form places -> moved to ./artifact-intent.js `formFieldLogicals`
// (walks the new tabs[].columns[].sections[] topology).

// The app module's uniquename. A DOWNLOADED/edit spec carries the app's REAL, immutable uniquename in
// `spec.app.uniqueName` — return it VERBATIM so the build's existing-app lookup (findArtifact) AND teardown
// resolve the SAME deployed app even after a display-name RENAME. A Dataverse appmodule uniquename never
// changes once created, so deriving it from the MUTABLE display name would miss the existing app on a
// rebuild and CREATE A DUPLICATE. An AUTHORED create-fresh spec has no `app.uniqueName`, so
// derive it deterministically from the publisher prefix + display name — the exact rule the builder creates
// with. Shared with the teardown engine so both agree on the identity.
function appUniqueName(spec) {
  if (spec.app && spec.app.uniqueName) return String(spec.app.uniqueName);
  const sol = spec.solution;
  return `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
}

// A simple, self-contained default app-tile icon (SVG) — a rounded square with the app's initial.
// Generated INTO the app's solution so the app never depends on an arbitrary external/managed icon
// (which fails to import into an environment where that managed solution isn't installed).
function defaultAppIconSvg(appName) {
  const letter = (String(appName || 'A').trim()[0] || 'A').toUpperCase().replace(/[<>&"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">` +
    `<rect width="44" height="44" rx="8" fill="#0F6CBD"/>` +
    `<text x="22" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600" text-anchor="middle" fill="#ffffff">${letter}</text>` +
    `</svg>`;
}

// --- web resources whose publication the SDK could not confirm ---------------------------------------------------------------------------------------------
// The bundled SDK reads a web resource's PUBLISHED content back after every create and every write of content it publishes, and throws
// WEB_RESOURCE_UNVERIFIED when its publish failed or the read-back could not confirm the content — AFTER the row exists, with its id:
//   { code: 'WEB_RESOURCE_UNVERIFIED', id: '<guid>', webResourceName: '<name>' (after a create), message: "Web resource '<name>' (<id>) was written,
//     but publishing it failed, so whether its published content is what was sent is unconfirmed (<the failure>). …", cause: <the failure, not enumerable> }
// The row is therefore never created again (a second create of the name is refused), and its content may be what was written, the old content, or
// none. What the build does about it is the same at every site that writes one (the spec's web resources, the generated app icon, the page manifest):
// it records the row — in the run's result, and in the workspace (lib/web-resource-records.js), so that the run that follows writes its content again
// by id instead of reusing it untouched (the page manifest: unless its published copy already holds what that run would write, which it keeps) — adds it
// to the solution as the success path does, and stops with what a run again does.
const isUnconfirmedWrite = (e) => Boolean(e) && e.code === 'WEB_RESOURCE_UNVERIFIED' && typeof e.id === 'string' && e.id.length > 0;
// The SDK's answer to a write by an id whose row is gone: HTTP 404 (`ensureSuccess` throws it as a ConnectionError).
const isGoneRow = (e) => Boolean(e) && e.code === 'CONNECTION_ERROR' && e.statusCode === 404;
const contentOf = (options) => (options.contentBase64 !== undefined ? { contentBase64: options.contentBase64 } : { content: options.content });

// The error a step stops with for such a row: the SDK's own words (which name the row, its id, why its publication is unconfirmed, and the SDK call
// that recovers it), then the plugin's — what this build did with the row and what a run again does, which makes that call. Its code is the SDK's, so the
// runner's halt carries it, and the SDK's error is its cause: the build's retry reads that as the wrapper it is (lib/retry-policy.js, CAUSE_WRAPPER_CODES),
// judged by the failure the SDK's error carries, and run again when it carries none.
// What a run again does is not the same at every site. The spec's web resources and the generated icon are written again by id whatever was published
// (writeOwnedWebResource). The page manifest is first compared with its PUBLISHED copy, and written again only where that copy is not the content the run
// would write (persistPageManifest, `comparesPublished`): live, a manifest created and never published — each of its publishes refused — was read back
// with that content by the run that followed (the build's own retry), and kept, its record cleared. So its stop says so, and does not promise a write.
function unconfirmedWebResource(error, { name, recorded, inSolution, comparesPublished = false }) {
  const solution = inSolution === true ? 'added it to the solution' : `could not add it to the solution (${(inSolution && inSolution.message) || inSolution}; a run again adds it)`;
  const nextRun = comparesPublished
    ? 'it reads the published copy and keeps it if it already holds the content that build would write; otherwise it writes the content again by that id, publishes it and reads it back (the call the message names is made for you)'
    : 'it writes the content again by that id, publishes it and reads it back (the call the message names is made for you)';
  const remedy = recorded
    ? `this build recorded the row as its own and ${solution}. Its publication is UNCONFIRMED, not lost: run the build again — ${nextRun}.`
    : `this build ${solution}, but could not save its local recovery record. Its publication is UNCONFIRMED, not lost: this build will not automatically retry it without that record. Write its content again by the id above in Power Apps once the cause is resolved; keep the same writable build workspace for automatic recovery.`;
  // SDK updates report only the id; the build also knows the authored name, which is what a maker needs to find the resource.
  const detail = error.webResourceName ? error.message : `Web resource '${name}' (${error.id}): ${error.message}`;
  const failure = Object.assign(serviceFailure(`${detail} — ${remedy}`, { cause: error }), { code: 'WEB_RESOURCE_UNVERIFIED', id: error.id });
  // A phase replay without a saved identity could create the name again when the row has no published layer. Likewise, a permanent
  // solution-add refusal must be resolved first even when the publish itself was transient.
  if (!recorded || (inSolution !== true && retryPolicyFor(inSolution) === RETRY.NEVER)) failure.transient = false;
  return failure;
}

// Records a row the SDK wrote and could not confirm, puts it in the solution, and answers the error to stop the step with (unconfirmedWebResource).
// The record is written FIRST: it is local, and it is what the next run needs whatever happens to the add. `comparesPublished` is the page manifest's:
// the next run compares it with its published copy before it writes it again (see unconfirmedWebResource).
async function keepUnconfirmedWebResource(error, { name, unconfirmed, addToSolution, comparesPublished = false }) {
  const recorded = unconfirmed.note(name, error.id);
  let inSolution = true;
  try { await addToSolution(error.id); } catch (e) { inSolution = e; }
  return unconfirmedWebResource(error, { name, recorded, inSolution, comparesPublished });
}

// A receipt authorizes only its original id, never a different row that came to hold the same name after it. This check costs nothing
// on an ordinary rebuild: the manifest already reads by name; spec resources/icons check only after an update proves their recorded row gone.
function assertUnconfirmedWebResourceIdentity(name, recordedId, foundId) {
  if (!recordedId || !foundId || String(recordedId).toLowerCase() === String(foundId).toLowerCase()) return;
  throw Object.assign(refusal(`Web resource '${name}' was recorded as ${recordedId}, but its name now belongs to ${foundId}. Refusing to overwrite or adopt that replacement; inspect both ids and resolve the local recovery record before rebuilding.`), { code: 'WEB_RESOURCE_IDENTITY_CONFLICT' });
}

async function checkRecordedWebResourceName(provision, name, id) {
  let row;
  try { row = await provision.getWebResource(id); } catch (e) {
    // A plain GET can miss a never-published row; the receipt still proves which id this build wrote. Unpublished content
    // is not ownership evidence, and a later publish may still serve old content. Only the subsequent PATCH's 404 proves the row gone.
    if (isGoneRow(e)) return;
    throw e;
  }
  if (row && typeof row.name === 'string' && row.name.toLowerCase() === String(name).toLowerCase()) return;
  throw Object.assign(refusal(`Web resource '${name}' was recorded as ${id}, but that id now reads as ${row && typeof row.name === 'string' ? `'${row.name}'` : 'a row with no verifiable name'}. Refusing to overwrite it; inspect the row and resolve the local recovery record before rebuilding.`), { code: 'WEB_RESOURCE_IDENTITY_CONFLICT' });
}

// Write a web resource the build OWNS by name — the spec's, or the generated app icon — and add it to the solution: create it, or, when an earlier run
// of this build wrote it and could not confirm its publication (`recordedId`, from the record), write its content again by that id, which publishes and
// verifies it again. The entry is cleared only once that write verified and the row is in the solution. A row that is gone by then (404) is created as on
// a first build. Answers the row's id. A web resource of that name that the record does not hold is the caller's to reuse untouched, as before.
async function writeOwnedWebResource(provision, unconfirmed, sol, options, recordedId) {
  const addToSolution = (componentId) => provision.addSolutionComponent({ componentId, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
  if (recordedId) {
    await checkRecordedWebResourceName(provision, options.name, recordedId);
    let gone = false;
    try {
      await provision.updateWebResource(recordedId, contentOf(options));
    } catch (e) {
      if (isUnconfirmedWrite(e)) throw await keepUnconfirmedWebResource(e, { name: options.name, unconfirmed, addToSolution });
      if (!isGoneRow(e)) throw e;
      gone = true;
    }
    if (!gone) {
      // Keep the receipt when only the solution add fails. Its 404 is not proof that the web-resource row is gone.
      await addToSolution(recordedId);
      unconfirmed.clear(options.name);
      return recordedId;
    }
    const rows = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${odataLit(options.name)}'`, top: 1 });
    assertUnconfirmedWebResourceIdentity(options.name, recordedId, rows && rows[0] && rows[0].webresourceid);
    unconfirmed.clear(options.name);
  }
  let created;
  try {
    created = await provision.createWebResource(options);
  } catch (e) {
    if (isUnconfirmedWrite(e)) throw await keepUnconfirmedWebResource(e, { name: options.name, unconfirmed, addToSolution });
    throw e;
  }
  await addToSolution(created.id);
  return created.id;
}

// Runs a write of a web resource and hands the id of the row it leaves to `keep` — when the write stops the step because the row's publication
// could not be confirmed too (isUnconfirmedWrite: the row exists, under `error.id`), so the run's result names the row either way.
async function keepRowOf(write, keep) {
  try {
    const id = await write();
    keep(id);
    return id;
  } catch (e) {
    if (isUnconfirmedWrite(e)) keep(e.id);
    throw e;
  }
}

// Resolve the app's tile-icon web resource id, ensuring it lives IN this solution. Uses
// spec.app.icon (a declared web resource) when set; otherwise generates a default SVG icon named
// `<appUniqueName>_icon` and adds it to the solution (idempotent — reused by name on a re-run).
// Returns the web-resource id, or undefined if it can't be resolved (the SDK then falls back).
// A generated icon an earlier run created and could not confirm the publication of is written again by id
// (writeOwnedWebResource), and is not looked up by name.
async function ensureAppIcon(spec, created, deps) {
  const { provision, sol, runner, unconfirmed = openUnconfirmedWebResources() } = deps;
  const findByName = async (name) => {
    const rows = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${odataLit(name)}'`, top: 1 });
    return rows && rows[0] && rows[0].webresourceid;
  };
  if (spec.app && spec.app.icon) {
    // An explicit author icon — created this run (in webResources) or already present by name.
    return (created.webResources && created.webResources[spec.app.icon]) || (await findByName(spec.app.icon)) || undefined;
  }
  const name = `${appUniqueName(spec)}_icon`;
  const recordedId = unconfirmed.idOf(name);
  const existing = recordedId ? undefined : await findByName(name);
  if (existing) {
    created.webResources[name] = existing;
    runner.skip('app-shell', `app icon (generated) ${name} (exists — reuse)`);
    return existing;
  }
  let id;
  await runner.run('app-shell', `app icon (generated) ${name}${recordedId ? ' (written again: its publication was not confirmed)' : ''}`, async () => {
    await keepRowOf(() => writeOwnedWebResource(provision, unconfirmed, sol, { name, displayName: `${spec.app.name} Icon`, type: 'svg', content: defaultAppIconSvg(spec.app.name) }, recordedId), (row) => {
      id = row;
      created.webResources[name] = row;
    });
    return name;
  });
  return id;
}

// Read the durable page manifest (`<appUnique>_pagemanifest`). Looked up by NAME via queryRecords
// (getWebResource needs the GUID we don't have yet). content is base64; `text` is the decoded serialized
// content, used by persist's content-dedup. Returns a DISCRIMINATED shape:
//   present:false — the web resource is ABSENT (a fresh app, or never authored pages). manifest is null;
//                   the caller reconciles as "no identity" and creates pages. NOT a corrupt state.
//   present:true  — the web resource EXISTS with non-empty content. manifest is the parsed payload, OR
//                   null when the content fails to parse — a CORRUPT manifest. The caller MUST HALT
//                   fail-closed (`pages-manifest-corrupt`) rather than treat a corrupt payload as "no
//                   identity → recreate", which would orphan the real (still-live) pages.
// An empty/whitespace content row is treated as ABSENT (present:false): there is nothing to parse and
// nothing corrupt, so it must not trigger the corrupt HALT — but we keep `id` so persist reuses the row.
async function readPageManifest(provision, appUnique) {
  const name = manifestResourceName(appUnique);
  const rows = await provision.queryRecords('webresource', { select: ['webresourceid', 'content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
  const wr = rows && rows[0];
  if (!wr) return { id: undefined, manifest: null, text: undefined, present: false };
  const hasContent = typeof wr.content === 'string' && wr.content.length > 0;
  const text = hasContent ? Buffer.from(wr.content, 'base64').toString('utf8') : undefined;
  return { id: wr.webresourceid, manifest: parseManifestBase64(wr.content), text, present: hasContent };
}

// Create or UPDATE the durable page manifest and (idempotently) re-assert its solution membership EVERY
// run (design §7.3). CONTENT-DEDUP: the write is SKIPPED when the manifest already holds exactly `content`
// (== lastContent). Called immediately after EVERY page create (crash-safety) AND once at the end;
// dedup means a single-page first build issues one create + zero updates, an N-new-page first build one
// create + (N-1) updates, and a no-op final persist. Stored as type 'js' (webresourcetype 3): there is no
// 'json' web-resource kind and 'js' round-trips arbitrary text unchanged. Returns { id, content } for the
// next call. The first seven parameters are the long-standing positional signature; `solutionMembers` is an
// optional eighth that only spares the add when the solution is proven to hold the manifest already (see
// solution-membership.js). Every call goes through it, including the one that creates the manifest, which is
// why a first build that deploys pages makes the membership read.
// `unconfirmed` (optional ninth) is the run's record of the web resources whose publication could not be confirmed (lib/web-resource-records.js). A write
// the SDK could not confirm (WEB_RESOURCE_UNVERIFIED) is recorded and stops the step (keepUnconfirmedWebResource). The next run writes the manifest again
// whenever its PUBLISHED copy — what readPageManifest reads, and `lastContent` is — is not what the run wants, by the id that read finds or, when no plain
// read finds the row (a manifest created and never published), by the id the record holds; the name is never created again while the record holds it.
async function persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent, solutionMembers, unconfirmed = openUnconfirmedWebResources()) {
  const name = manifestResourceName(appUnique);
  const content = serializeManifest(buildManifest(spec, keyToId));
  const recordedId = unconfirmed.idOf(name);
  assertUnconfirmedWebResourceIdentity(name, recordedId, existingId);
  let id = existingId || recordedId;
  const addToSolution = (componentId) => ensureSolutionComponent(provision, solutionMembers, { componentId, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
  const write = async (writeId) => {
    try {
      if (writeId) {
        await provision.updateWebResource(writeId, { content });
        return writeId;
      }
      return (await provision.createWebResource({ name, displayName: `${spec.app.name} Page Manifest`, type: 'js', content })).id;
    } catch (e) {
      if (isUnconfirmedWrite(e)) throw await keepUnconfirmedWebResource(e, { name, unconfirmed, addToSolution, comparesPublished: true });
      throw e;
    }
  };
  if (content !== lastContent) {
    try {
      id = await write(id);
    } catch (e) {
      // The row the record names, which no plain read found, is gone: the manifest is created again, as on a first build.
      if (!(recordedId && id === recordedId && isGoneRow(e))) throw e;
      unconfirmed.clear(name);
      id = await write(undefined);
    }
  }
  if (id) await addToSolution(id);
  // Written and verified now, or its published copy already holds what this run wants: either way it is confirmed.
  unconfirmed.clear(name);
  return { id, content };
}

// Add the app's sitemap (componenttype 62) to the solution. Adding the app module alone leaves the
// sitemap only in the Default solution, so the app's own solution is incomplete on export. Resolve
// it by the naming convention of SDK-created apps (the app's unique name). This additive lookup is
// not an ownership proof for a renamed or externally created sitemap. Best-effort + idempotent:
// a re-add of an already-present component is tolerated so this never fails an otherwise-good build.
async function ensureSitemapInSolution(provision, sol, appUnique, solutionMembers) {
  try {
    const rows = await provision.queryRecords('sitemap', { select: ['sitemapid'], filter: `sitemapnameunique eq '${odataLit(appUnique)}'`, top: 1 });
    const sitemapId = rows && rows[0] && rows[0].sitemapid;
    if (!sitemapId) return;
    await ensureSolutionComponent(provision, solutionMembers, { componentId: sitemapId, componentType: COMPONENT_TYPE.sitemap, solutionUniqueName: sol.uniqueName });
  } catch { /* best-effort — the app + its sitemap already exist; a component-pin hiccup must not fail the build */ }
}

// True when any sitemap subarea targets a generative page — the app must then be created first
// (app_early) and its sitemap rewritten after the pages phase resolves the genPageIds.
function appHasPageSubareas(spec) {  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const s of g.subAreas || []) if (s && s.page) return true;
    }
  }
  return false;
}

// True when any page declares cross-page navigation. Deterministic from the spec, so planFor can plan
// the single "resolve cross-page navigation" step without runtime state.
function appHasCrossPageNav(spec) {
  return ((spec && spec.pages) || []).some((p) => (p.navigatesTo || []).length > 0);
}

// Whether this run writes the spec's navigation to an app that ALREADY exists — the question the navigation check
// (app-navigation.js) needs answered, because a navigation that is not written leaves the app as it is: nothing for the
// build to say of an empty one. It mirrors the two writers in runSdkBuildPhases, and the test that drives each of them
// pins that it does:
//   * with the pages phase in the run, the pages finalizer writes the whole navigation, page entries included (appDef
//     without `omitUnbuiltPages`) — except in a changed-only re-upload, which skips it;
//   * without it, the app step writes the navigation from the spec, but only for a spec with no page entry: that step has
//     no pages to point such an entry at, and writing the navigation without them would detach every live page, so for a
//     spec with one it writes no navigation at all.
function existingAppSitemapIsWritten(spec, phases, changedOnly) {
  if (phases.includes('pages')) return !(changedOnly && changedOnly.skipSitemapFinalize);
  return !appHasPageSubareas(spec);
}

// Whether this run creates a NEW app's pages BEFORE the app, so that the app's first navigation already holds its page entries — the one
// way a new app whose navigation holds only pages can be built, since Dataverse refuses to CREATE a sitemap with no entry (app-navigation.js).
// It mirrors what runSdkBuildPhases does for such an app, and the tests that drive the engine pin that it does:
//   * the app step and the pages phase are both in the run: the app step leaves the create to the pages phase, which makes the app once
//     the pages exist (`createAppWithPages`);
//   * it is not a changed-only re-upload (`skipSitemapFinalize`), which uploads the changed pages of an app that exists and creates no app;
//   * every page entry names a page of `pages[]` the run builds — a tsx source with a codeFile, the pages phase's `implemented` — because the
//     app's first navigation is made from the pages the run created. Validation's deploy profile, which `--apply` uses, already demands that
//     (a page entry names a declared page, and every page is implemented), so this guards a caller that did not validate.
// Returns { newAppPagesFirst: true }, or { newAppPagesFirst: false, whyNotPagesFirst } — the rule navigationVerdict takes, with the words of
// its refusal.
function pagesFirstRule(spec, phases, changedOnly) {
  if (!phases.includes('app-shell')) return { newAppPagesFirst: false, whyNotPagesFirst: 'this run has no app step' };
  if (!phases.includes('pages')) return { newAppPagesFirst: false, whyNotPagesFirst: 'this run does not have the pages phase, which would create them first' };
  if (changedOnly && changedOnly.skipSitemapFinalize) return { newAppPagesFirst: false, whyNotPagesFirst: 'this run only re-uploads changed pages, and creates no app' };
  const built = new Set((spec.pages || []).filter((p) => {
    const src = normalizePageSource(p);
    return src && src.kind === 'tsx' && src.codeFile;
  }).map((p) => p.key || p.name));
  const unbuilt = navigationHolds(spec).pages.filter((key) => !built.has(key));
  if (unbuilt.length) return { newAppPagesFirst: false, whyNotPagesFirst: `this run builds no page for ${unbuilt.map((key) => `'${key}'`).join(', ')} (a page of pages[] with source.kind 'tsx' and a codeFile)` };
  return { newAppPagesFirst: true };
}

// The dry run's share of the navigation check: say, on the app step's own line, that an apply would stop there, and why.
// The line is marked as a view the build would refuse is (annotateLivePlan): `? unknown` with the reason, and `wouldHalt` so
// the summary counts it among the steps that would stop the build and not among those it could not read. Whether the app
// exists is what the live plan found out on that same line; without a live plan, or when its read failed, it is unknown.
// A navigation the build goes on with but its author should hear of — an app of unknown existence it would refuse if new,
// or an existing app it leaves with no entries — is a warning, not a mark: nothing would stop the build.
function checkNavigationInPlan(plan, spec, { phases, changedOnly, warn }) {
  const item = plan.find((p) => p.key && p.key.kind === 'app');
  if (!item) return;
  const verdict = navigationVerdict(spec, {
    appExists: item.state === 'create' ? false : item.state === 'reuse' ? true : undefined,
    existingAppIsWritten: existingAppSitemapIsWritten(spec, phases, changedOnly),
    ...pagesFirstRule(spec, phases, changedOnly),
    whyUnknown: item.state === 'unknown' ? (item.stateWhy || 'the app could not be read') : 'this dry run did not read the environment',
  });
  if (verdict.outcome === 'refuse') {
    item.state = 'unknown';
    item.stateWhy = `the build would stop before writing anything: ${verdict.message}`;
    item.wouldHalt = true;
  } else if ((verdict.outcome === 'unknown' || verdict.outcome === 'warn') && typeof warn === 'function') {
    warn(`app "${spec.app.name}": ${verdict.message}`);
  }
}

// The apply's share: before the first write, refuse a navigation Dataverse will refuse. Left to the app step it stopped the
// build there, after the solution, tables, columns, views and forms were written. The verdict comes from the spec alone,
// except for a navigation that depends on whether the app exists — pages only, or no entry at all: fine for an app that
// exists, refused for a new one — which pays for one read of that, the very read the app step makes next. A read that fails
// leaves the answer unknown: the build goes on as it always did and says what it could not check. Halts as the view-filter
// pre-flight does (phase `preflight`, never retried).
// A navigation of pages only, in a run that creates a new app's pages first (pagesFirstRule), builds whichever the answer is, and
// the read is made all the same: so that a build of an app that exists makes exactly the requests it always made. What decides
// whether the pages come first is the app step's own read, right before the create, never this one.
async function checkNavigationBeforeWriting(spec, { provision, phases, changedOnly, warn }) {
  const written = { existingAppIsWritten: existingAppSitemapIsWritten(spec, phases, changedOnly) };
  const rule = { ...written, ...pagesFirstRule(spec, phases, changedOnly) };
  const readsExistence = navigationVerdict(spec, written).outcome === 'unknown';
  let appExists;
  let whyUnknown;
  if (readsExistence) {
    try {
      appExists = !!(await provision.findArtifact('app', { uniqueName: appUniqueName(spec) }));
    } catch (err) {
      whyUnknown = (err && err.message) || String(err);
    }
  }
  const verdict = navigationVerdict(spec, readsExistence ? { ...rule, appExists, whyUnknown } : rule);
  if (verdict.outcome === 'refuse') {
    // The message quotes the author's own page keys, so it must never be read as one of the texts the CLI retries on (isTransientHalt), and a re-run reads the same spec.
    throw new BuildHalt(`app "${spec.app.name}" cannot be built: ${verdict.message} The build stopped before writing anything.`, { phase: 'preflight', code: verdict.code, recoverable: false, retry: RETRY.NEVER });
  }
  if ((verdict.outcome === 'unknown' || verdict.outcome === 'warn') && typeof warn === 'function') warn(`app "${spec.app.name}": ${verdict.message}`);
}

// A page's bindings are written as the spec states them, and the spec cannot make what they name: a connection reference, which a page calls its connector through by its logical name, or a Custom API. So the
// build reads what the environment has for the names the pages it writes state (lib/page-binding-targets.js) and judges it, before it writes anything:
//   - a reference that is there for ANOTHER connector stops the build (phase `preflight`, never retried: a run again reads the same reference). The page would call that connector under this name, with the
//     signed-in user's connection to it, and nothing in the name tells the two apart — so it is refused, and nothing is guessed or made: the author gives the binding the name of the right reference, or states
//     the connector this environment has. Left to the pages phase it would stop after the solution, the tables, the views, the forms and the app were written, as the navigation check used to;
//   - a reference or a Custom API that is not there, a reference that has no connection, an operation a binding calls that the custom connector there does not define, a Custom API of the other kind or bound
//     to another table, and a read that failed are SAID, by name, and the build goes on: the page is written with its binding (a reference made, or given its connection, later makes the page work without a
//     rebuild), and an ordinary read failure says only that the bindings were not checked. A refused throttle wait is still the attempt's budget stop, checked by its runner before any mutation.
// Only a run that has the pages phase writes a binding, and a changed-only run writes the pages it selected and the navigation targets it has to make (pagesStatingBindings). A spec that states none reads nothing.
// `seen` is what the attempt has read of what bindings name (bindingReads); the pages phase's check of a target it makes is given the same one.
async function readPageBindingVerdict(spec, { provision, phases, changedOnly, seen }) {
  if (!phases.includes('pages')) return null;
  return judgePageBindings(provision, pagesStatingBindings(spec, { changedOnly: bindingCheckScope(phases, changedOnly) }), seen);
}

// What a run is told of the pages that are deployed (`changedOnly.deployedKeys`, pagesStatingBindings) is heeded only by a run whose pages phase is its FIRST writer — the changed-only fast apply runs that
// phase alone (lib/changed-only-flow.js). A target the run was told of and that the pages phase finds absent is checked there, before it is made (pagesMadeUnchecked); in such a run that is still before
// anything is written, so the refusal says so truly. A run with an earlier phase (the solution, the tables, the app) would have written them by then, so it is not told: it checks every navigation target
// before it writes anything, as every run did before it could be told. A phase this build does not know is taken to come first.
function bindingCheckScope(phases, changedOnly) {
  if (!changedOnly || changedOnly.deployedKeys === undefined) return changedOnly;
  const pagesWriteFirst = phases.every((phase) => PHASES.indexOf(phase) >= PHASES.indexOf('pages'));
  return pagesWriteFirst ? changedOnly : { ...changedOnly, deployedKeys: undefined };
}

// What the environment has for the names `pages` state, judged (lib/page-binding-targets.js): null when no page states one, which reads nothing. A name `seen` already holds is not read again.
async function judgePageBindings(provision, pages, seen) {
  if (!pages.length) return null;
  return judgeBindingTargets(pages, await readBindingTargets(provision, pages, seen));
}

// The apply's answer to a verdict: a conflict stops the build, and all else is said.
function haltOnPageBindingConflicts(verdict, warn) {
  if (!verdict) return;
  const refused = verdict.findings.filter((finding) => finding.severity === 'refuse');
  if (refused.length) {
    // The message quotes the author's own page and binding names, so it must never be read as one of the texts the CLI retries on (isTransientHalt); `retry: RETRY.NEVER` marks it outright.
    throw new BuildHalt(
      `${refused.length} connector binding(s) name a connection reference this environment already has for ANOTHER connector: ${refused.map((finding) => finding.text).join('; ')}. The build stopped before writing anything. `
      + 'A page calls a binding through its reference\'s logical name, so each of these pages would call the other connector. Either give the binding the logical name of a reference that is for the right connector '
      + '(create-connection-reference.js makes one), or, if the reference that is here is the one the page should call (a custom connector made separately in each environment has another id in each), set the binding\'s connectorId in the spec to the connector this environment has.',
      { phase: 'preflight', code: 'pages-binding-reference-conflict', recoverable: false, retry: RETRY.NEVER },
    );
  }
  if (typeof warn === 'function') for (const text of [...verdict.unchecked.map((u) => u.text), ...verdict.findings.map((finding) => finding.text)]) warn(text);
}

async function checkPageBindingsBeforeWriting(spec, { provision, phases, changedOnly, warn, seen }) {
  haltOnPageBindingConflicts(await readPageBindingVerdict(spec, { provision, phases, changedOnly, seen }), warn);
}

// A dry run has no pages phase, which is what finds a navigation target absent (reconcilePageIds: the spec's page id, or the manifest's, that the environment still lists). So for each target a
// changed-only run was told is deployed (`changedOnly.deployedKeys`) and would leave unread (pagesLeftOutAsDeployed), the dry run asks the environment, read only, whether the page is still there —
// never taking the record of an earlier apply as proof. Two reads, made only when there is such a target:
//   GET <webresource set>?$select=webresourceid,content&$filter=name eq '<app>_pagemanifest'&$top=1                    the manifest (readPageManifest): each page's key and id
//   GET /uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=uxagentprojectid eq <id> or …
//                                                                                                                    the pages in the SAVED layer, a never-published one included (savedPageRows)
// A target whose page answers to the id the spec or the manifest gives it is there: its binding is left unread, as the apply leaves it. One whose ids answer to no page is absent — the apply
// makes it — and one these reads cannot settle (no id, a read that fails) is not known to be there: both are checked, as if the build will make them, and a read that failed is said. Answers the
// run's `changedOnly` with `deployedKeys` keeping only the targets found.
async function confirmDeployedTargets(spec, { provision, phases, changedOnly, warn }) {
  const scoped = bindingCheckScope(phases, changedOnly);
  const leftOut = pagesLeftOutAsDeployed(spec, scoped);
  if (!leftOut.length) return scoped;
  const found = new Set();
  let unsettled;
  try {
    const { manifest } = await readPageManifest(provision, appUniqueName(spec));
    const manifestIds = new Map(((manifest && manifest.pages) || []).map((entry) => [entry.key, entry.pageId]));
    const specIds = new Map((spec.pages || []).map((page) => [page.key || page.name, page.pageId]));
    const idsOf = new Map(leftOut.map((page) => [page.key, [specIds.get(page.key), manifestIds.get(page.key)].filter((id) => typeof id === 'string' && FORM_GUID_RE.test(id)).map((id) => id.toLowerCase())]));
    const wanted = [...new Set([...idsOf.values()].flat())];
    if (wanted.length && !(provision.dataverse && typeof provision.dataverse.get === 'function')) unsettled = 'the pages cannot be read here';
    else if (wanted.length) {
      const rows = await savedPageRows(provision.dataverse, wanted, { label: 'the pages recorded as deployed' });
      for (const page of leftOut) if (idsOf.get(page.key).some((id) => rows.has(id))) found.add(page.key);
    }
  } catch (error) {
    unsettled = (error && error.message) || String(error);
  }
  if (unsettled !== undefined && typeof warn === 'function') warn(unconfirmedDeployedText(leftOut, unsettled));
  const unfound = new Set(leftOut.filter((page) => !found.has(page.key)).map((page) => page.key));
  return unfound.size ? { ...scoped, deployedKeys: scoped.deployedKeys.filter((key) => !unfound.has(key)) } : scoped;
}

// The dry run's share: say on the page's own line that an apply would stop there, and why. The line is marked as a view the build would refuse is (annotateLivePlan): `? unknown` with the reason, and `wouldHalt` so
// the summary counts it among the steps that would stop the build. What an apply would only say is said the same way. The pages judged are those an apply judges before it writes anything
// (readPageBindingVerdict) — save a target the run was told is deployed that the dry run does not find in the environment (confirmDeployedTargets): the apply's pages phase makes that one, and
// stops on it (pagesMadeUnchecked), so the plan judges it too.
async function checkPageBindingsInPlan(plan, spec, { provision, phases, changedOnly, warn }) {
  const verdict = await readPageBindingVerdict(spec, { provision, phases, changedOnly: await confirmDeployedTargets(spec, { provision, phases, changedOnly, warn }) });
  if (!verdict) return;
  const refusedBy = new Map();
  for (const finding of verdict.findings.filter((f) => f.severity === 'refuse')) refusedBy.set(finding.page.name, [...(refusedBy.get(finding.page.name) || []), finding.text]);
  for (const [name, texts] of refusedBy) {
    const item = plan.find((p) => p.phase === 'pages' && p.label === `page "${name}"`);
    if (!item) continue;
    item.state = 'unknown';
    item.stateWhy = `the build would stop before writing anything: ${texts.join('; ')}`;
    item.wouldHalt = true;
  }
  if (typeof warn === 'function') for (const text of [...verdict.unchecked.map((u) => u.text), ...verdict.findings.filter((f) => f.severity !== 'refuse').map((f) => f.text)]) warn(text);
}

// The pages lock (acquireAppPagesLease) lives in lib/app-operation-lease.js, beside the build lease that every apply holds outside it; it is
// still exported from this module, where the build and its callers have always found it.

function appDef(spec, result, opts = {}) {
  const sol = spec.solution;
  const uniqueName = appUniqueName(spec);
  // A subarea is an Entity (table) by default, a DashBoard (a built dashboard, by name — the SDK
  // auto-pins its dashboardId as an app component so the nav actually includes it), or a URL.
  const subAreaJson = (s, id) => {
    // Preserve a platform icon path VERBATIM (case-sensitive — an OOB/WebResources path like
    // `/WebResources/.../SitemapIcon/CDSEntity` breaks if lower-cased); lower-case only a BARE local
    // web-resource NAME (Dataverse web-resource names are case-insensitive and the icon lookup
    // lower-cases). This is what lets a downloaded app's entity-subarea icon round-trip unchanged.
    const iconVal = s.icon ? (isPlatformIconRef(s.icon) ? s.icon : String(s.icon).toLowerCase()) : undefined;
    const base = { id, title: s.title, ...(iconVal ? { icon: iconVal } : {}) };
    // Carry a VALID `vectorIcon` on ANY subarea — INCLUDING Entity. Live-probed: the vendored SDK
    // serializes `<SubArea Entity="…" … VectorIcon="/WebResources/<pub>/icons/x.svg">` correctly, and
    // the modern app accepts a path/$webresource VectorIcon on an entity nav entry (the reporter's live
    // app uses one). Previously ALL entity vectorIcons were dropped, silently losing a custom nav icon
    // on every build and breaking the download→build round-trip. We still DROP a BARE Fluent TOKEN on an
    // entity subarea (that specific shape breaks the modern app-designer property pane; validation
    // surfaces it as a warning). Non-entity subareas keep emitting any vectorIcon as before.
    const emitVector = s.vectorIcon && (isPlatformIconRef(s.vectorIcon) || !s.entity);
    const withVector = emitVector ? { ...base, vectorIcon: s.vectorIcon } : base;
    // The kind is decided by the function the navigation check (app-navigation.js) counts entries with, so the
    // page entries left out of a new app's first navigation below are the ones it does not count.
    const kind = navigationEntryKind(s);
    if (kind === 'dashboard') {
      // Read as an OWN entry (lib/own-keys.js): a dashboard may be called `constructor` or `__proto__`, and a map a caller hands in — or the
      // `{}` of a result with no dashboards — answers those names with an inherited member, which would pass for a built dashboard's id.
      const dashboardId = ownValue(result.dashboards, s.dashboard);
      if (!dashboardId) throw refusal(`sitemap subarea "${s.title}" references dashboard '${s.dashboard}' which wasn't built — declare it in dashboards[] and don't skip the dashboards phase`);
      // The designer gives every dashboard entry it creates this launcher Url, recognizes a dashboard
      // entry by it, and the runtime shows the dashboard glyph only for it — without it the entry
      // renders a placeholder icon (AB#6726727). The SDK's from-scratch node omits it.
      return { ...withVector, type: 'DashBoard', dashboardId, dashboardUrl: DASHBOARD_LAUNCHER_URL };
    }
    if (kind === 'page') {
      // An own entry too: a page key is a lowercase slug, so `constructor` is a key a page can have.
      const genPageId = ownValue(result.pages, s.page);
      if (!genPageId) {
        // During the initial app-create (app_early) pages aren't uploaded yet — omit the subarea;
        // the pages phase rewrites the sitemap once the genPageIds exist. A genuinely-missing page
        // (finalize/edit time) still throws.
        if (opts.omitUnbuiltPages) return null;
        throw refusal(`sitemap subarea "${s.title}" references page '${s.page}' which wasn't built — declare it in pages[] and don't skip the pages phase`);
      }
      return genPageSubArea(withVector, genPageId);
    }
    if (kind === 'url') return { ...withVector, type: 'URL', url: s.url };
    return { ...withVector, type: 'Entity', entity: s.entity && s.entity.toLowerCase() };
  };
  // `appShell` is OPTIONAL to validation (the deploy profile deliberately accepts a spec without
  // one — download and many callers rely on that), but it is NOT optional here: without it there is
  // no sitemap to build. Dereferencing it unguarded produced a bare
  // `Cannot read properties of undefined (reading 'areas')` at this phase, AFTER the solution,
  // tables, columns, views and the generated app icon were already created — a half-built app plus
  // an error naming nothing the author could act on. Fail with the same actionable shape the
  // subarea errors above use.
  if (!spec.appShell || !Array.isArray(spec.appShell.areas)) {
    throw refusal("the spec has no appShell.areas, so the app has no navigation to build — add appShell: { areas: [ { label, groups: [ { label, subAreas: [ { entity: '<table>', title: '<label>' } ] } ] } ] }");
  }
  const areas = (spec.appShell.areas || []).map((a, ai) => ({ id: `area_${ai}`, title: a.label,
    // Same rule as subAreaJson: preserve a platform icon path VERBATIM (case-sensitive OOB/WebResources
    // path); lower-case only a bare local web-resource NAME. Leaving the area icon unconditionally
    // lower-cased would corrupt a round-tripped OOB area icon (now that validation tolerates it).
    ...(a.icon ? { icon: isPlatformIconRef(a.icon) ? a.icon : String(a.icon).toLowerCase() } : {}),
    ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
    groups: (a.groups || []).map((g, gi) => ({ id: `group_${ai}_${gi}`, title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => subAreaJson(s, `sub_${ai}_${gi}_${si}`)).filter(Boolean) })) }));
  return { name: spec.app.name, uniqueName, description: spec.app.description || '', siteMap: { areas },
    // #583: the routing description, only when the spec sets one (see applyAppAiDescription).
    ...(spec.app.aiDescription ? { aiDescription: spec.app.aiDescription } : {}),
    ...(opts.iconWebResourceId ? { iconWebResourceId: opts.iconWebResourceId } : {}),
    components: appComponentsFor(result, opts.mainFormsByTable) };
}

// #583: set the routing description (`app.aiDescription` → `appmodule.aiappdescription`) on the FETCHED
// artifact of an app that already exists. Returns true when the artifact changed and needs a push.
//
//   * Only when the spec sets one. Absent means "leave the deployed value alone" — the platform can write
//     this text itself — so an omitted field is never written, and never blanked.
//   * Only when it differs from the FETCHED artifact, which is the draft layer
//     (RetrieveUnpublishedMultiple) the SDK's own push compares the header against. So `true` here means
//     exactly "the push will write the header", and a plain rebuild neither pushes nor publishes for
//     nothing. Same rule as the chart description reconcile: read the layer the write targets.
//   * A fetched app carries `aiDescription` only when the row has one, and `updateElement` refuses a
//     path that is not there (PATH_NOT_FOUND). So the key is ADDED at the artifact root when absent and
//     updated when present.
// LIVE-MEASURED: addElement at the root and a push write `aiappdescription` (read back before and after
// publish); a later updateElement and push change it; an unrelated edit and push leave it untouched.
async function applyAppAiDescription(provision, spec, appId) {
  const want = spec.app && spec.app.aiDescription;
  if (typeof want !== 'string' || !want.trim()) return false;
  const current = (await provision.getArtifact('app', appId)) || {};
  if (current.aiDescription === want) return false;
  if (current.aiDescription === undefined) await provision.addElement('app', appId, '', { aiDescription: want });
  else await provision.updateElement('app', appId, '/aiDescription', want);
  return true;
}

// The app's display NAME and its tile DESCRIPTION, set on the FETCHED artifact of an app that already exists. They were set when the
// app was created and never again: a rebuild with an edited description reported the app step as done and left the old text. Returns
// the text each edit REPLACED — `{ description: 'Tickets' }`, `{}` when nothing was edited — which is what a refused push puts back
// (pushAppHeader), and which says whether the artifact now needs a push.
//
// The SDK's header push writes only the texts that CHANGED: in ONE PATCH, conditioned on the row's own token, the artifact's `name`, `description` and routing
// description that differ from the header it has just read (no PATCH when none does), and it neither compares nor writes a text REMOVED from the copy
// (cds-maker-sdk 9a0c9f03; pinned against the real bundle in app-header-text-real-bundle.test.js). It used to write the whole copy, the texts an edit had not
// changed included. So these edits ride the push the app already gets (the sitemap rewrite): never a second push from the same fetch, which would race the
// first on its If-Match.
//
//   * Only a non-blank string is written, and only when it differs from the FETCHED artifact (the draft layer the push compares the
//     header against). The two guards a view's and a chart's description already have: a spec that leaves the text out — or carries
//     the "" a download writes, which validateDescription allows for `app.description` alone — says nothing, and writing it would
//     blank text a maker typed.
//   * The unique name is never written. It is the app's identity: appUniqueName takes it from `app.uniqueName` when the spec pins one
//     (a download does) and otherwise derives it from the name, so a spec that renames an app without pinning it names a different
//     app, which the app step creates, rather than renaming this one.
//   * A fetched app always carries both keys (the adapter reads `description` as '' when the row has none), so updateElement has a
//     path to write — unlike the routing description, which is added when the row has none.
//   * A TEXT THAT IS NOT PLAIN is never edited and never sent, and holds nothing else back. Both columns are localizable, and whether a plain write of the
//     base-language text keeps a translation beside it has not been measured against an environment; the adapter hands back one string, so a translation
//     held beside it is invisible here. What this can see is a value that is not a string at all — a text per language, as an LCID map, a list, a number — and
//     that is never sent: not as it is (these are String columns, and a map-shaped PATCH of one is no write the platform defines), and not replaced by a
//     scalar. Its OWN edit is held back and reported as not applied, with the reason (a warning, never a halt); a localized value the spec's text already
//     equals (the unchanged-name, changed-description case) needs no edit and no word. The other text, and the routing description (applyAppHeader), are
//     applied as usual and written alone: that is what the SDK's partial write is for. (While the SDK wrote the whole copy, one text that was not plain held
//     the whole header back, and this said so.)
//   * It is kept off the wire by being kept off the COPY. The SDK decides for itself whether the header is written: when its own comparison read of the
//     header cannot be made (503, 403, a thrown error, an empty 200) it writes EVERY text the copy holds. So the texts the copy holds that are not plain
//     (`held`, answered by applyAppHeader) are taken off it with `removeElement('app', id, '/name')` right before the push (pushAppHeader), and the SDK
//     then neither compares nor writes them — now its documented contract, where it was once an internal (the serializer dropping `undefined`) whose failure,
//     a re-vendor that writes `name: ''`, would blank an app's name; the bundle's behaviour is pinned, and so is that nothing else of the copy changes. Not
//     here, and not earlier: a copy holding an edit that no push follows is refused by the next run (refuseUnpushedAppCopy), and the routing description
//     of a page-backed app is pushed only when it changed.
//   * The client every SDK is made with still refuses a write of a text that is not plain (lib/app-header-text.js, APP_HEADER_NOT_PLAIN_TEXT, wired in
//     lib/maker-sdk.js), whatever the copy holds: the last line of defence for a push of a copy the build did not clean (the page backend's, say).
// name holds at most 100 characters and description 2,000 (validateDescription).
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
async function applyAppHeaderText(provision, spec, appId, warn) {
  return (await editAppHeaderText(provision, spec, appId, warn)).replaced;
}

// applyAppHeaderText's work, which also answers `held` — the header's texts that are not plain, `[{ key, have }]` — for applyAppHeader to hand on to the push,
// which takes them off the copy (see applyAppHeaderText).
async function editAppHeaderText(provision, spec, appId, warn) {
  const app = (spec && spec.app) || {};
  const current = (await provision.getArtifact('app', appId)) || {};
  // Read BEFORE any write: getArtifact can hand back the stored tree itself, which updateElement then changes under `current`.
  const have = { name: current.name, description: current.description };
  const held = ['name', 'description'].filter((key) => typeof have[key] !== 'string').map((key) => ({ key, have: have[key] }));
  const replaced = {};
  for (const key of ['name', 'description']) {
    const want = app[key];
    if (typeof want !== 'string' || !want.trim() || have[key] === want) continue;
    const kept = whyAppTextIsKept(key, have[key], want);
    if (kept !== undefined) {
      if (kept && typeof warn === 'function') warn(`app "${app.name}": its ${key} was not applied: ${kept}`);
      continue;
    }
    await provision.updateElement('app', appId, `/${key}`, want);
    replaced[key] = have[key];
  }
  return { replaced, held };
}

// How a header text that is not plain reads in a warning (isAppTextMap, localizedAppText, appTextKind) is lib/app-header-text.js's:
// the client refuses a write of such a text in the same words.

// Why an app's name or description (`have`, as fetched) is NOT written over with the spec's text (`want`) — or `undefined` when it is
// plain text, which nothing else holds back: not the other text of the header, plain or not. `''` means the spec asks for nothing the
// header does not already say, so there is nothing to report.
function whyAppTextIsKept(key, have, want) {
  if (typeof have === 'string') return undefined;
  if (isAppTextMap(have)) {
    if (Object.values(have).includes(want)) return '';
    return `it is ${localizedAppText(have)}, and a rebuild does not replace a localized text — it cannot tell which language the spec's text is for, nor that the other translations would be kept. Change it in Power Apps.`;
  }
  return `the app's ${key} could not be read as plain text (it came back as ${appTextKind(have)}), so a rebuild does not replace it. Change it in Power Apps.`;
}

// Everything of an existing app's header the spec can change: its text and its routing description, applied to one fetched copy so
// that one push writes them all. `text: false` leaves the name and description alone — for an app THIS run created, whose create
// already wrote the spec's (appDef), the compare would be a read the build never made for a new app. Answers
//   changed   whether the artifact now holds any header change, and so needs a push;
//   routing   whether one of them is the routing description — an explicit request that a never-published app's refusal must HALT on;
//   replaced  the text the name / description edits replaced (applyAppHeaderText), for pushAppHeader to put back;
//   held      the texts of the copy that are not plain, `[{ key, have }]`, which pushAppHeader takes off the copy before it pushes it.
// A text that is not plain holds back its own edit only, with a warning, never a halt: the other text and the routing description are applied as usual
// (see applyAppHeaderText), and the navigation is the app step's own work and goes on.
async function applyAppHeader(provision, spec, appId, { text = true, warn } = {}) {
  const { replaced, held } = text ? await editAppHeaderText(provision, spec, appId, warn) : { replaced: {}, held: [] };
  const routing = await applyAppAiDescription(provision, spec, appId);
  return { changed: routing || Object.keys(replaced).length > 0, routing, replaced, held };
}

// An app's tile icon is written when the app is created and a rebuild cannot replace it: the appmodule's `webresourceid` is effectively
// write-once, and the SDK's header push — the name, the description, the routing description — does not carry it (pinned in
// app-header-text-real-bundle.test.js). So when the spec NAMES an icon (`app.icon`) that is not the one the app has, the build says so
// instead of letting the app step read as done over an icon that stayed. A spec with no `app.icon` gets the generated default at create
// and is left alone afterwards (a maker may have chosen another), so there is nothing to compare. Read-only and best-effort: a read
// that fails proves nothing, so it says nothing.
async function warnAppIconNotApplied(provision, spec, wantIconId, warn) {
  const app = (spec && spec.app) || {};
  if (!app.icon || !wantIconId || typeof warn !== 'function') return;
  let have;
  try {
    const rows = await provision.queryRecords('appmodule', { select: ['webresourceid'], filter: `uniquename eq '${odataLit(appUniqueName(spec))}'`, top: 1 });
    have = rows && rows[0] && rows[0].webresourceid;
  } catch {
    return;
  }
  const same = (a, b) => String(a).replace(/[{}]/g, '').toLowerCase() === String(b).replace(/[{}]/g, '').toLowerCase();
  if (!have || same(have, wantIconId)) return;
  warn(`app "${app.name}": its icon was NOT changed — the spec's app.icon ('${app.icon}') is not the icon the app has. An app's icon is set when the app is created and a rebuild does not replace it: change it in the app designer, or point app.icon at the web resource the app already uses.`);
}

// #583: halt precisely when the push of an app whose routing description this run changed was refused
// because the app was never PUBLISHED: Dataverse takes no write to a draft appmodule's name, description
// or routing description until it is, and the SDK THROWS APP_DRAFT_HEADER_NOT_WRITABLE (see
// pushAppHeader), naming that state, so no read is needed. Called before requireSuccessfulPush, whose
// generic remedy (re-download and rebuild) reads the same draft and fails the same way.
//
// A 412 (VERSION_CONFLICT) is NOT re-explained, wherever it lands. Before cds-maker-sdk 8930278f the
// header PATCH carried the unpublished-aware read's CONTENT token, which runs one ahead of the row while
// a header change is unpublished, so a header write over such a change (saved in Maker, or by a build
// whose publish did not complete) answered 412 although nothing had changed since the fetch, and this
// halt told the operator to publish first. 8930278f sends the appmodule's ROW token. LIVE-MEASURED with
// the vendored bundle: over another writer's unpublished header change saved BEFORE the fetch, the push
// now saves and keeps that change; when another writer moves the row AFTER the fetch, it still answers
// 412 — where the previous bundle answered 412 to both. So a 412 on the appmodule row is a concurrent
// edit, as one on the sitemap always was, and takes the generic path: the copy holding this run's edits
// is kept (discardUnrecordedEdits), which is what stops a blind re-run from overwriting the other edit.
// Re-explaining it as "publish, then re-run" reset that copy. The row token is pinned against the real
// bundle in app-ai-description-real-bundle.test.js.
//
// Before halting it RESETS the workspace copy to the server's. The refused push left this run's edits in
// it; once the operator publishes, the server moves, and a plain fetch then refuses to discard unpushed
// edits (LOCAL_EDITS_WOULD_BE_LOST) — so "publish, then re-run" would halt again. Measured against the
// vendored bundle. The edits were projected from the spec and the re-run re-applies them, so nothing is
// lost; if the reset itself fails, the halt names the workspace to delete instead.
async function haltOnUnpublishedAppHeader(provision, appId, pushed, name) {
  // pushFailed reads `saved`, then the older SDK spelling `success`, then a bare error — the same reading
  // requireSuccessfulPush applies, so the precise halt fires for either result shape.
  const code = pushFailed(pushed) && pushed.error && pushed.error.code;
  if (code !== 'APP_DRAFT_HEADER_NOT_WRITABLE') return;
  let reset = true;
  try {
    await provision.fetchArtifact('app', appId, { overwrite: true });
  } catch {
    reset = false;
  }
  const workspace = reset ? ''
    : ` First reset the workspace, which still holds this run's unpushed copy of the app (a re-run would refuse to overwrite it): ${RESET_WORKSPACE}.`;
  // `retry: NEVER`: publishing the app is the maker's step, and the app's name is in the message.
  throw new BuildHalt(`push app ${name} failed: the app has never been published, and Dataverse refuses a write to its name, description or routing description until it is. Re-downloading reads the same draft and fails the same way: publish the app in Power Apps, then re-run the build.${workspace}`, { phase: 'push', code: 'app-header-unpublished', recoverable: true, cause: pushed.error, retry: RETRY.NEVER });
}

// #583: push an app artifact whose header this run may have changed (the routing description, the app's text). A refusal
// that means "publish first" — thrown or returned — goes through haltOnUnpublishedAppHeader; everything
// else is exactly the plain push (the result is still for requireSuccessfulPush to judge) — except that a
// FAILED push first resets the workspace copy (discardUnrecordedEdits).
//
// `header` is what applyAppHeader answered (or the bare boolean the routing-description callers pass: true says the push
// carries a header change a never-published app's refusal must halt on).
//
// ONE refusal is not a halt: the never-published app's refusal of an edit of its NAME or DESCRIPTION alone. Those edits are
// applied because a rebuild reaches them, and nothing is lost by leaving them unapplied; stopping every other phase for them
// — the navigation this push also writes, and everything after it — was a regression for an app that had always rebuilt. The
// SDK throws APP_DRAFT_HEADER_NOT_WRITABLE before it writes its sitemap, naming that nothing was modified by the call ("Nothing was
// modified by this call", pinned against the real bundle in app-header-text-real-bundle.test.js), and writes the header only when the
// artifact holds one that differs from the row's. So the fetched text is put back on the copy (`header.replaced`) and the push
// is made once more: it now writes the navigation and the rest alone, exactly as a rebuild with no text edit always has, and the build
// says the text was not applied. Not recovered from, because each is a different fact: a routing description in the push (an explicit request
// that cannot be honoured — it halts, as it always did), a 412 (a concurrent edit), any other failure, and a refusal that comes back
// with the header already put back (halted on, never looped on). A header that cannot be put back halts too: pushing a copy that
// still holds the edit would be refused again.
//
// A text of the copy that is not plain (`header.held`) is taken off it first (takeNonPlainTextOffCopy): the SDK writes every text the copy holds when its own comparison read of
// the header cannot be made, and it neither compares nor writes a text that is not on the copy, so it has no text that is not plain to write. That is done here and not when the
// header is edited because this is the one place the build pushes a copy: a copy that is taken from and then not pushed would be left holding an edit (refuseUnpushedAppCopy).
//
// The HTTP client still refuses a write of a text that is not plain, whatever pushes it, and that refusal is not recovered from: a name or description that is not plain text never
// leaves the process (APP_HEADER_NOT_PLAIN_TEXT, lib/app-header-text.js). This push does not meet it — the text is off the copy — but a push the build does not make through here can: the page
// backend's push of the app, say. It is thrown before the header or the navigation is written, so the generic path below is the right one: the copy, which that push never recorded, is
// reset to the server's, and the typed error is thrown as it is. Its message says a re-run normally succeeds, and `transient: false` keeps the build from running the phase again on its own:
// whether the read answers next time is for that re-run to find out, and a retry of the same push here would hide the one thing the message tells.
async function pushAppHeader(provision, appId, name, header, mainFormsByTable, warn) {
  const { routing, replaced, held } = header !== null && typeof header === 'object' ? header : { routing: header === true, replaced: {}, held: [] };
  const textKeys = Object.keys(replaced || {});
  const carriesHeader = routing || textKeys.length > 0;
  const attempt = async (first) => {
    try {
      if (first) {
        await applyAppMainForms(provision, appId, mainFormsByTable);
        await takeNonPlainTextOffCopy(provision, appId, held);
      }
      return { pushed: await explainAppPushWarnings(provision.dataverse, await provision.pushArtifact('app', appId), name) };
    } catch (thrown) {
      return { thrown };
    }
  };
  let outcome = await attempt(true);
  const refusal = outcome.thrown || (pushFailed(outcome.pushed) ? outcome.pushed.error : undefined);
  if (!routing && textKeys.length && refusal && refusal.code === 'APP_DRAFT_HEADER_NOT_WRITABLE' && await putBackAppText(provision, appId, replaced)) {
    outcome = await attempt(false);
    if (!outcome.thrown && !pushFailed(outcome.pushed) && typeof warn === 'function') {
      warn(`app "${name}": its ${textKeys.join(' and ')} ${textKeys.length === 1 ? 'was' : 'were'} not applied: the app was never published; publish it in Power Apps and re-run. Dataverse takes no write to a never-published app's name or description until it is published, so the navigation and the rest of this build went ahead without ${textKeys.length === 1 ? 'it' : 'them'}.`);
    }
  }
  if (outcome.thrown) {
    if (carriesHeader) await haltOnUnpublishedAppHeader(provision, appId, { saved: false, error: outcome.thrown }, name);
    await discardUnrecordedEdits(provision, appId, outcome.thrown, true);
    throw outcome.thrown;
  }
  const pushed = outcome.pushed;
  if (carriesHeader) await haltOnUnpublishedAppHeader(provision, appId, pushed, name);
  if (pushFailed(pushed)) await discardUnrecordedEdits(provision, appId, pushed.error, false);
  return pushed;
}

// Take the texts of the copy that are not plain (applyAppHeader's `held`) off it, right before the push that would offer them to the SDK. The SDK neither compares nor writes a text that is
// not on the copy — even when its own comparison read of the header fails, which makes it write every text the copy holds — so none of them can be in its request. A text with no value is not on
// the copy: there is nothing to take off. A path the copy no longer has is as gone as it needs to be.
async function takeNonPlainTextOffCopy(provision, appId, held) {
  for (const { key, have } of held || []) {
    if (have === undefined) continue;
    try {
      await provision.removeElement('app', appId, `/${key}`);
    } catch (err) {
      if (!err || err.code !== 'PATH_NOT_FOUND') throw err;
    }
  }
}

// Put the text a refused push's edits replaced (applyAppHeaderText's answer) back on the workspace copy, so the next push carries no
// header write. True when every one is back; false when a write failed, which leaves the copy holding an edit the caller must not push.
async function putBackAppText(provision, appId, replaced) {
  try {
    for (const [key, text] of Object.entries(replaced)) await provision.updateElement('app', appId, `/${key}`, text);
    return true;
  } catch {
    return false;
  }
}

// #583: after a push of the app FAILED, reset the workspace copy to the server's. Its edits were never
// recorded, and a copy still holding them hurts the re-run: its plain fetch refuses to discard them
// (LOCAL_EDITS_WOULD_BE_LOST) once the server has moved; the next run that pushes the app refuses such a
// copy outright (refuseUnpushedAppCopy); and applyAppAiDescription would compare against it, so a pending
// routing description read as "already set". The edits are projected from the spec, so the re-run
// re-applies them and nothing is lost. (Only a push that carried a header change used to reset; a failed
// sitemap-only push left the copy holding its edits.)
//
// A concurrent edit is the one failure that KEEPS the copy: a VERSION_CONFLICT, or a returned failure
// with no code at all (the bare 412 requireSuccessfulPush reads the same way). There the remedy is a
// fresh download, and the unrecorded copy is what makes a blind re-run stop instead of overwriting the
// other edit. Best-effort: a reset that fails leaves the copy exactly as it was before this existed.
async function discardUnrecordedEdits(provision, appId, error, thrown) {
  const code = error && error.code;
  if (code === 'VERSION_CONFLICT' || (!thrown && !code)) return;
  try {
    await provision.fetchArtifact('app', appId, { overwrite: true });
  } catch { /* see above */ }
}

// #583 review: an app copy an earlier run left holding unpushed edits — a build interrupted between its edit
// and its push, say — goes out with the next push of the app, whatever that run asked for. A plain fetch
// keeps such a copy while the server has not moved, and the SDK serializes every field that differs from
// its stored server copy: a routing description the spec leaves out ("leave the deployed one alone") was
// overwritten with the earlier run's, a wanted one read as already set (so its push skipped the
// unpublished-header halt), and a stale sitemap rewrite was replayed, detaching live pages with no gate. So
// a run that will push the app refuses such a copy before it applies anything.
async function refuseUnpushedAppCopy(provision, appId, name) {
  const listed = (await provision.listArtifacts('app')).find((a) => a && a.id === appId);
  if (listed && listed.isDirty) {
    // `retry: NEVER`: the copy stays dirty until the operator resets it, and the app's name is in the message.
    throw new BuildHalt(`app ${name}: the workspace copy holds edits an earlier run did not push (an interrupted build, say), and this run's push of the app would send them too. To reset it, ${RESET_WORKSPACE}, and re-run.`, { phase: 'app-shell', code: 'app-copy-unpushed-edits', recoverable: true, retry: RETRY.NEVER });
  }
}

// A business-rule row filter that selects only the DEFINITION, never the platform's activated copy.
//
// LIVE-MEASURED. Activating a business rule makes Dataverse create a SECOND `workflows` row:
//   type=1, parentworkflowid=(none)  -> the definition the author wrote
//   type=2, parentworkflowid=<def>   -> the platform's activated copy of it
// That pair is normal for every activated process, and the vendored SDK's own orphan probe filters
// `category eq 2 and type eq 1` for exactly this reason.
//
// Omitting `type` is not cosmetic: it made the build try to deactivate and delete the activated copy
// (which the platform refuses, 405), emit a false "the SDK created a duplicate" warning, and would
// have made `--verify` fail EVERY active business rule as "duplicated".
//
// category 2 = Business Rule; type 1 = definition, 2 = activated copy.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow
function businessRuleFilter(name, entityLogical) {
  return `category eq 2 and type eq 1 and name eq '${odataLit(name)}' and primaryentity eq '${odataLit(String(entityLogical).toLowerCase())}'`;
}

// A BPF is a `workflows` row like a business rule, but a DIFFERENT category, so it needs its own
// filter rather than a parameterized one — sharing it would invite passing the wrong category.
//
// category 4 = BusinessProcessFlow; type 1 = definition (activating a process creates a `type 2`
// activated copy the platform owns and refuses to delete directly — see businessRuleFilter for the
// full story, which cost real time there). `businessprocesstype eq 0` excludes TASK FLOWS, which are
// also category 4; without it a task flow with the same name would be adopted as this flow.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow
function bpfFilter(name, entityLogical) {
  return `category eq 4 and type eq 1 and businessprocesstype eq 0 and name eq '${odataLit(name)}' and primaryentity eq '${odataLit(String(entityLogical).toLowerCase())}'`;
}

// Map one App Spec `businessProcessFlows[]` entry to the vendored SDK's BpfArtifact shape.
//
// Pure: spec shape -> SDK shape. Three normalizations that are easy to get wrong:
//   1. `entity` (a spec schemaName) becomes `entityLogicalName`, lower-cased — Dataverse logical
//      names are lower-case and the XAML binds on them.
//   2. Each stage repeats the entity. The SDK models a per-stage entity (that is how a cross-entity
//      flow is expressed); v1 validates them equal, and stamping it here keeps the artifact valid
//      rather than relying on the adapter's `''` default.
//   3. The step's column key is `fieldName`, NOT `fieldLogicalName`. The adapter's step normalizer
//      copies exactly `id`/`name`/`fieldName`/`required` and DROPS anything else, so a mis-named key
//      is silently discarded and the step deploys bound to nothing. Measured against the real bundle
//      and pinned in bpf-real-bundle.test.js.
//
// Ids are deliberately NOT minted here: the adapter assigns any missing stage/step id itself. The
// edit-in-place path (applyBpfStages) works on the ids the SDK minted and the build read back from the
// deployed flow, so nothing here needs a stable one — and a stage or step it adds is written from this
// same mapping, exactly as a create writes it.
function bpfDef(flow) {
  const entityLogicalName = String(flow.entity).toLowerCase();
  const def = {
    name: flow.name,
    entityLogicalName,
    // Active unless the author asks for Draft. A BPF is not merely inert when inactive — the stage
    // bar does not render at all — so Active is the only useful default.
    status: flow.status || 'Active',
    stages: (flow.stages || []).map((st) => ({
      name: st.name,
      entityLogicalName,
      steps: (st.steps || []).map((step) => ({
        name: step.name,
        ...(step.field !== undefined ? { fieldName: String(step.field).toLowerCase() } : {}),
        ...(step.required !== undefined ? { required: step.required } : {}),
      })),
    })),
  };
  if (flow.description !== undefined) def.description = flow.description;
  if (flow.order !== undefined) def.order = flow.order;
  return def;
}

// --- Stage edits to a flow a rebuild reuses ---------------------------------------------------------
// lib/bpf-stages.js decides WHICH edits a rebuild applies and which it refuses, and why (it is pure,
// and the change classifier asks it the same question of two specs). These read the deployed flow and
// write the edits.

// Read the deployed flow and compare its stages with the spec's. Resolves { kind, plan?, reason? }:
//   'same' | 'edit' | 'refused' — diffBpfStages' verdict, with its `plan`;
//   'unchecked'                 — the flow could not be read, or came back with no stages: `reason` says why;
//   'unavailable'               — the SDK handle cannot fetch a flow (a test double), so nothing is compared.
// It NEVER throws: a flow that cannot be compared is left as it is — as every flow was before stage
// edits were applied — and the build goes on; one unreadable flow must not stop an otherwise good app.
//
// The flow is fetched with `overwrite: true` so the plan is made on what is DEPLOYED. A plain fetch
// keeps a workspace copy still holding edits an earlier run never pushed (a build interrupted between
// an edit and its push, or one whose push was refused), and the plan would then call the flow "already
// as the spec says" while the environment holds none of it: the edit would be lost and the flow
// reported as reused. Nothing else edits a flow's copy, and applyBpfStages pushes or abandons every
// edit it makes, so there is no other writer's change for the overwrite to lose — unlike the app's
// copy, which several phases edit (see refuseUnpushedAppCopy).
async function inspectBpfStages(provision, flow, flowId) {
  if (typeof provision.fetchArtifact !== 'function') return { kind: 'unavailable' };
  let artifact;
  try {
    artifact = await provision.fetchArtifact('bpf', flowId, { overwrite: true });
  } catch (e) {
    return { kind: 'unchecked', reason: String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300) };
  }
  if (!artifact || !Array.isArray(artifact.stages)) return { kind: 'unavailable' };
  if (!artifact.stages.length) return { kind: 'unchecked', reason: 'the SDK read the flow with no stages' };
  const plan = diffBpfStages(deployedBpfStages(artifact.stages), desiredBpfStages(flow), { entity: flow.entity });
  return { kind: plan.verdict, plan };
}

// Write the edits of an applicable plan (inspectBpfStages' `edit`) onto the workspace copy it just
// read, then push ONCE. Throws what the SDK throws; a push that comes back refused halts through
// requireSuccessfulPush.
//
// The order keeps the flow valid after EVERY element operation, because the SDK validates after each
// one — a stage with no step, or an id used twice, is refused on the spot. So a stage only ever GAINS
// steps (added first, in the spec's order; nothing is removed, the plan refuses any removal), and a
// stage or step is found again by its id before each operation, since an insert shifts every index
// after it. A stage is renamed by id, never recreated: the id is what a record's stage refers to.
//
// What a stage or step this ADDS carries is bpfDef's own mapping, so it is written exactly as the
// create path writes it. What goes over the wire is the SDK's: a Draft flow takes one PATCH of its
// definition; an Active flow takes ONE `$batch` change set (the header under the row's token, then
// the XAML) when the transport has `postRaw`, as this plugin's has — otherwise the SDK deactivates the
// flow, patches it and reactivates it (BPF_LEFT_DEACTIVATED if the reactivation fails, which halts
// the build). Both are pinned against the vendored bundle in bpf-stage-edits.test.js.
async function applyBpfStages(provision, flow, flowId, plan, opts = {}) {
  const wanted = bpfDef(flow).stages;
  const stageOf = async (stageId) => {
    const stages = ((await provision.getArtifact('bpf', flowId)) || {}).stages || [];
    const index = stages.findIndex((s) => s && s.id === stageId);
    if (index < 0) throw refusal(`stage ${stageId} is not in the flow the SDK holds`, { code: 'PATH_NOT_FOUND' });
    return { index, stage: stages[index] };
  };
  for (let j = 0; j < plan.target.length; j += 1) {
    const target = plan.target[j];
    if (target.isNew) {
      // Existing stages never move, so when stage j is reached the flow holds exactly the first j
      // stages of the target followed by the deployed ones still to come: index j is its place.
      await provision.addElement('bpf', flowId, '/stages', wanted[j], { position: { index: j } });
      continue;
    }
    const { index } = await stageOf(target.stageId);
    if (target.renamedFrom) await provision.updateElement('bpf', flowId, `/stages/${index}/name`, target.name);
    if (!target.stepsChanged) continue;
    const stepsPointer = `/stages/${index}/steps`;
    for (let k = 0; k < target.steps.length; k += 1) {
      const step = target.steps[k];
      if (!step.stepId) {
        await provision.addElement('bpf', flowId, stepsPointer, wanted[j].steps[k], { position: { index: k } });
        continue;
      }
      const steps = (await stageOf(target.stageId)).stage.steps || [];
      const at = steps.findIndex((s) => s && s.id === step.stepId);
      // Steps 0..k-1 are already final, so the one wanted at k is at or after k: this only ever
      // moves a step EARLIER, which keeps `index` unambiguous (it is the place after the removal).
      if (at !== k) await provision.moveElement('bpf', flowId, `${stepsPointer}/${at}`, stepsPointer, { index: k });
      const live = steps[at];
      // Only what differs, as a merge patch of the step: the SDK throws PATH_NOT_FOUND for a leaf
      // such as `/required` that the step does not carry yet.
      const patch = {};
      if (live.name !== step.name) patch.name = step.name;
      if (String(live.fieldName || '').toLowerCase() !== step.field) patch.fieldName = step.field;
      if ((live.required === true) !== step.required) patch.required = step.required;
      if (Object.keys(patch).length) await provision.updateElement('bpf', flowId, `${stepsPointer}/${k}`, patch);
    }
  }
  return requireSuccessfulPush(await provision.pushArtifact('bpf', flowId), `business process flow ${flow.name}`, opts.warn);
}

// The codes with which the SDK refuses a stage edit BEFORE it writes anything to the environment: an
// edit it cannot author (NOT_IMPLEMENTED — adding, removing or reordering the stages of a flow whose
// primary composite holds something that is not a stage, or the steps of a stage that holds something
// that is not a step, is thrown at push with no request sent; a rename or a rebind is not refused), or one that
// does not validate (INVALID_ARGUMENT, VALIDATION_ERROR, PATH_NOT_FOUND). An element operation only
// edits the workspace copy, so for any of them the environment's flow DEFINITION is exactly as it was
// (its Active/Draft state is converged on its own) and the build goes on with it. Only the error's
// OWN code is read, never its cause chain:
// BPF_LEFT_DEACTIVATED — a flow the SDK deactivated and could not reactivate — carries the failure
// that started it as its cause, and following the chain would make a half-applied live flow look
// untouched.
const BPF_EDIT_NOT_WRITTEN = new Set(['NOT_IMPLEMENTED', 'INVALID_ARGUMENT', 'VALIDATION_ERROR', 'PATH_NOT_FOUND']);

// What the build says about a flow whose stage edit the plan refused: the reason, why a build never
// goes ahead, and the ways forward. No stage or step edit is applied — not even the ones that would
// have been safe — but that is NOT "nothing is written to the flow": the Active/Draft state the spec
// asks for is converged by a step of its own (a flow left in the wrong one is invisible or running),
// so the warning says what was not done and that the state is handled independently.
function bpfRefusalWarning(flow, refusals) {
  return `business process flow "${flow.name}" on ${flow.entity}: NOT changed — ${describeBpfRefusals(refusals).join('; ')}. A build never removes or moves a stage or a step: a record that is partway through the flow sits on one of its stages, and the platform does not document what becomes of a record whose stage is removed or moved. No stage or step edits were applied; the requested Active/Draft state is handled independently. That includes the edits that would have been safe. To keep the flow as it is, list in the spec what it has (a stage or step added in Maker, say). To make the flow match the spec, make the change in Maker (move or finish the records on a stage before removing it); the next build then finds the flow as the spec says. If the flow's process records can be lost, delete the flow (which deletes its backing table and the records in it) and run the build again, which creates it afresh.`;
}


// Map one App Spec business rule to the SDK's BusinessRuleArtifact shape.
//
// The SDK's condition model is NOT the obvious one, and getting it wrong is SILENT: `updateElement`
// merges unknown keys onto the node, the serializer ignores them, and the push succeeds with a
// workflow object model that references none of the author's columns — a rule that deploys,
// activates, and never fires. So the mapping is explicit and the App Spec shape is validated before
// we get here.
//
//   conditions[] -> rootCondition.clauses[]   (ANDed; `logic: 'AND'`)
//   actions[]    -> rootCondition.trueBranch[]
//
// `valueType` is always `'Value'`: the SDK's other axes (`Field`, `Lookup`, `Expression`, `Clear`)
// need shapes the App Spec does not model, so exposing the name would offer authors a choice they
// cannot use. The App Spec calls the type hint `dataType` rather than the SDK's `valueWorkflowType`,
// because `valueType` already means that other thing here. See BUSINESS_RULE_DATA_TYPES in
// app-spec.js.
//
// `dataType` is NO LONGER decorative on the CONDITION path, and that changed under us in the SDK
// uptake. The previous bundle consulted `valueWorkflowType` only for `valueType: 'Clear'` and
// hard-typed every ordinary literal as `WorkflowAttributeType.String`; the current bundle uses the
// field for ALL value types, VERBATIM, with no name -> enum mapping of its own
// (`… : e.valueWorkflowType ?? WorkflowAttributeType.String`).
//
// `WorkflowAttributeType` is a NUMERIC-STRING enum — `{ Boolean:'0' … Money:'7', Picklist:'10',
// String:'14' … }` — so passing the App Spec's human token would put an out-of-domain value on the
// wire. MEASURED against the vendored bundle before this mapping existed, the condition literal
// carried `"String"`, `"Money"`, and even `"NotAWorkflowType"` straight through, while the SDK's own
// fallback for the same field is `'14'`. Note this hit EVERY rule, not only ones that authored a
// `dataType`, because the default below is the token `'String'` rather than the enum value.
//
// LIVE-MEASURED that this fails SILENTLY rather than loudly: a build carrying the raw tokens
// deployed all four probe rules with 0 failures and activated them. The platform does not reject the
// value, so nothing upstream of a user noticing the rule never fires would surface it — and
// `--verify` cannot, because it checks existence, duplicate count and statecode, never the rule's
// WFOM.
//
// The ACTION path still types every literal as String on the SDK side, so it is unaffected — the
// asymmetry is deliberate and pinned in business-rules.test.js.
const WORKFLOW_ATTRIBUTE_TYPE = {
  boolean: '0', customer: '1', datetime: '2', decimal: '3', float: '4', double: '4', integer: '5',
  lookup: '6', money: '7', owner: '8', partylist: '9', picklist: '10', key: '11', state: '12',
  status: '13', string: '14', memo: '14', uniqueidentifier: '15', entitynamereference: '16',
  entity: '17', entitycollection: '18', multiselectpicklist: '23',
};
// Unknown tokens fall back to String rather than being forwarded. The spec gate already restricts
// `dataType` to BUSINESS_RULE_DATA_TYPES, so this is unreachable from a valid spec; forwarding an
// unmapped token would reopen exactly the out-of-domain write this mapping exists to close.
function workflowAttributeType(dataType) {
  return WORKFLOW_ATTRIBUTE_TYPE[String(dataType || 'String').toLowerCase()] || '14';
}
function businessRuleDef(rule) {
  const ids = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };
  const clauseId = ids('c');
  const actionId = ids('a');
  const valueless = (op) => BUSINESS_RULE_VALUELESS_OPERATORS.has(op);
  return {
    name: rule.name,
    entityLogicalName: String(rule.entity).toLowerCase(),
    scope: rule.scope || 'Entity',
    // Omitted when the spec has none, so a rebuild never blanks one added in the maker.
    ...(rule.description ? { description: rule.description } : {}),
    // Active unless the author asks for Draft. A rule is inert until activated, so defaulting to
    // Active is what makes `businessRules[]` do something on the first build.
    status: rule.status || 'Active',
    rootCondition: {
      id: 'r1',
      displayName: rule.name,
      logic: 'AND',
      clauses: (rule.conditions || []).map((c) => ({
        id: clauseId(),
        field: String(c.field).toLowerCase(),
        operator: c.operator,
        valueType: 'Value',
        ...(valueless(c.operator) ? {} : { value: String(c.value), valueWorkflowType: workflowAttributeType(c.dataType) }),
      })),
      trueBranch: (rule.actions || []).map((a) => {
        const node = { id: actionId(), type: a.type, displayName: a.label || `${a.type} ${a.field}`, field: String(a.field).toLowerCase() };
        if (a.type === 'SetVisibility') node.visible = a.visible;
        else if (a.type === 'LockUnlock') node.lock = a.lock;
        else if (a.type === 'SetBusinessRequired') node.required = a.required;
        else if (a.type === 'SetFieldValue') { node.value = String(a.value); node.valueType = 'Value'; node.valueWorkflowType = workflowAttributeType(a.dataType); }
        return node;
      }),
      falseBranch: [],
    },
  };
}

// Map one App Spec persona to the vendored SDK's PersonaRoleSpec (cds-maker-sdk createPersonaRole).
// Pure: spec shape -> SDK shape. Two normalizations:
//   1. `entity` is lower-cased to a Dataverse logical name (the SDK resolves prv* ids from metadata
//      by logical name).
//   2. App-open injection (WHY): the SDK "authors exactly the privileges you declare", so a persona
//      role that only grants table access still cannot OPEN the generated app for a non-admin. Unless
//      the persona opts out (`appAccess:false`), add a read privilege on the `appmodule` table so the
//      role can read the app definition. appmodule is an ORG-owned table, so a valid read depth is
//      Global (`organization`) — a user/BU-scoped read on an org-owned table is not a real depth. The
//      matching app<->role association (which scopes WHICH app appears) is done separately in the
//      security phase via ensureAppAvailableToRole. Both are needed for the app to actually appear.
// The SDK dedupes/unions privileges (max scope wins per entity+access), so an injected appmodule read
// that overlaps an author-declared one is harmless.
function personaRoleSpecFor(persona) {
  const normPriv = (pr) => ({
    entity: String(pr.entity).toLowerCase(),
    access: (pr.access || []).slice(),
    ...(pr.scope ? { scope: pr.scope } : {}),
  });
  const jobs = (persona.jobs || []).map((j) => ({
    name: j.name,
    ...(j.description ? { description: j.description } : {}),
    privileges: (j.privileges || []).map(normPriv),
  }));
  const additional = (persona.additionalPrivileges || []).map(normPriv);
  if (persona.appAccess !== false) {
    additional.push({ entity: 'appmodule', access: ['read'], scope: 'organization' });
  }
  return {
    // Canonical (trimmed) name — the SDK trims before its (name, BU) lookup, so teardown/verify (which
    // key on the same canonical name) and this create call must all agree on the trimmed identity.
    persona: canonicalPersonaName(persona),
    jobs,
    ...(additional.length ? { additionalPrivileges: additional } : {}),
    ...(persona.businessUnitId ? { businessUnitId: persona.businessUnitId } : {}),
    ...(persona.assignTo ? { assignTo: persona.assignTo } : {}),
  };
}

// True when an error from an app<->role `$ref` associate/dissociate means the desired end state already
// holds (associate: the link exists; dissociate: it's already gone), so a re-run is idempotent. Matches
// the vendored SDK's REAL error shapes (verified against scripts/vendor/cds-maker-sdk.cjs), NOT a guessed
// one: a ConnectionError carries `.statusCode` (not `.status`) and the raw Dataverse body on `.cause`
// (its `error.code` is the concrete Dataverse code, e.g. 0x80060891 "duplicate"/0x80040217 "not found");
// a 412 becomes an `SdkError` with code/message `VERSION_CONFLICT`. A bare 400/404 is NOT swallowed
// unless the body/message specifically says duplicate/exists (associate) or not-found (dissociate) — so a
// genuine failure still surfaces. `mode` is 'associate' or 'dissociate'.
function isBenignAssociationError(err, mode) {
  if (!err) return false;
  const status = err.statusCode != null ? err.statusCode : err.status;
  const code = String(err.code || ''); // SdkError code, e.g. 'VERSION_CONFLICT'
  const body = err.cause; // raw Dataverse body on a ConnectionError
  const dvCode = String((body && body.error && body.error.code) || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  if (mode === 'associate') {
    // 412 (precondition) / VERSION_CONFLICT is the "already exists" path; a 400 duplicate carries the
    // duplicate code in the body or an "already exists"/"duplicate" message.
    if (status === 412 || status === 409 || /version_conflict/i.test(code) || /version conflict/.test(msg)) return true;
    return /duplicate|already exists?/.test(msg) || /0x80060891|0x80040237/.test(dvCode) || /duplicate/.test(dvCode);
  }
  // dissociate: a link that is already gone is a 404 / "does not exist" — the desired end state.
  if (status === 404) return true;
  return /does not exist|not found|cannot be found/.test(msg) || /0x80040217/.test(dvCode);
}

// Make the generated app available to a persona role by associating the role to the app module
// (the model-designer "Manage roles" relation). WHY this is required IN ADDITION to the appmodule
// read privilege: prvReadAppModule lets the role read app definitions, but a model-driven app only
// APPEARS for a non-admin when a security role is associated to it (appmoduleroles). Without this the
// persona gets data access but the app never shows in their app list. Idempotent: a re-run re-POSTs the
// same $ref, which Dataverse rejects as a duplicate — swallowed (the link already exists) via the
// SDK-accurate isBenignAssociationError; any other error re-throws. See appmodule N:N `appmoduleroles`:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
async function ensureAppAvailableToRole(sdk, appId, roleId) {
  try {
    await sdk.associateRecords('appmodule', appId, { relationshipName: 'appmoduleroles_association', targetEntity: 'role', targetId: roleId });
  } catch (err) {
    if (!isBenignAssociationError(err, 'associate')) throw err;
  }
}

// Reverse of ensureAppAvailableToRole: remove the app<->role association so the app STOPS appearing for
// a persona whose `appAccess` flipped to false. The injected appmodule-read privilege is already removed
// by the role's ReplacePrivileges convergence, but the association is grant-only and would otherwise
// persist — so a role flipped to data-only would still surface the app for a user who has appmodule read
// from any other role. Best-effort + idempotent: a link that's already gone (404) is the desired state.
async function ensureAppNotAvailableToRole(sdk, appId, roleId) {
  if (typeof sdk.disassociateRecords !== 'function') return; // older bundle without dissociate → no-op
  try {
    await sdk.disassociateRecords('appmodule', appId, 'appmoduleroles_association', roleId);
  } catch (err) {
    if (!isBenignAssociationError(err, 'dissociate')) throw err;
  }
}

// Resolve the business unit a persona's role lives in, so role QUERIES (teardown, verify) scope to the
// SAME (name, BU) identity the SDK uses on create (createPersonaRole keys a role by name WITHIN a BU).
// Returns the explicit `businessUnitId`, else the org ROOT business unit (the SDK's own default — a BU
// with no parent), else NULL when it cannot be resolved. Every current caller treats null as FAIL
// CLOSED and reports the role as missing rather than matching on name alone (teardown
// sdk-teardown.js, verify verify-spec.js, and the roleGrant apply path) — a name-only match could
// touch a same-named role in a DIFFERENT business unit, which for a grant is privilege escalation.
// `q` is a queryRecords fn (the teardown `sdk` or the verify `read`); `cache` memoizes the root-BU
// lookup for the run — as the lookup IN FLIGHT, not its answer: verify resolves several personas' and
// grants' roles at once, and a cache that only held the answer (or a placeholder set before the read
// settled) handed every concurrent caller but the first an unresolved BU, which they all reported as
// "role not found".
async function resolveRoleBusinessUnit(q, businessUnitId, cache = {}) {
  if (businessUnitId && FORM_GUID_RE.test(businessUnitId)) return businessUnitId;
  if (!cache.rootBuLookup) {
    cache.rootBuLookup = (async () => {
      try {
        if (typeof q === 'function') {
          // Root BU has no parent. Mirrors the vendored SDK's own resolveRootBusinessUnit query.
          const rows = await q('businessunit', { select: ['businessunitid'], filter: '_parentbusinessunitid_value eq null', top: 1 });
          const id = rows && rows[0] && rows[0].businessunitid;
          if (id && FORM_GUID_RE.test(String(id))) return String(id);
        }
      } catch { /* best-effort: fall back to a name-only match */ }
      return null;
    })();
  }
  return cache.rootBuLookup;
}

// The `_businessunitid_value eq <guid>` OData clause (Edm.Guid is UNQUOTED) that scopes a role query to a
// business unit. Empty string when the BU is unknown — but no caller reaches that today: every one
// treats an unresolved BU as fail-closed before calling this. `bu` is GUID-validated by
// resolveRoleBusinessUnit, so interpolation is injection-safe.
function roleBuClause(bu) {
  return bu && FORM_GUID_RE.test(String(bu)) ? ` and _businessunitid_value eq ${bu}` : '';
}

// A stable, human-readable name for a `roleGrants[]` entry, used in plan lines, progress labels and
// errors. Prefers the display name the author wrote; falls back to the pinned id.
function roleGrantLabel(g) {
  const name = g && typeof g.role === 'string' ? g.role.trim() : '';
  return name ? `"${name}"` : `${(g && g.roleId) || '?'}`;
}

// Resolve the EXISTING role a `roleGrants[]` entry extends. AB#6686429.
//
// Fail-closed on every ambiguity, because the write is a privilege grant: granting on the wrong role is
// a silent access-control defect that no later phase would catch.
//   - `roleId` pinned → confirm the row EXISTS (an absent id is a stale pin, not a create trigger — this
//     surface never creates a role) and report its name so the build log names what was actually changed.
//   - `role` name → exact-match within the resolved business unit (explicit `businessUnitId`, else the org
//     ROOT BU — the same identity `createPersonaRole`, teardown and verify use). 0 matches and >1 match
//     are BOTH errors; ">1" happens when the same role name exists in several BUs and the author must
//     disambiguate.
//
// Unlike the persona path this deliberately does NOT require the SDK ownership marker: the whole point is
// to extend a role somebody else built. `ismanaged` is not a blocker either — Dataverse permits
// AddPrivilegesRole on a managed role, and refusing would block the bug's actual scenario (a solution's
// shipped roles). It IS surfaced in the returned detail so the log says what was touched.
async function resolveRoleGrantTarget(provision, grant, buCache) {
  if (grant.roleId) {
    const rows = await provision.queryRecords('role', { select: ['roleid', 'name', 'ismanaged'], filter: `roleid eq ${grant.roleId}`, top: 1 });
    const row = rows && rows[0];
    if (!row) throw refusal(`roleGrant: pinned roleId ${grant.roleId} does not exist on this environment — correct the id, or target the role by name`);
    return { roleId: String(row.roleid), name: row.name || '', managed: row.ismanaged === true };
  }
  const name = String(grant.role).trim();
  const bu = await resolveRoleBusinessUnit((e, o) => provision.queryRecords(e, o), grant.businessUnitId, buCache);
  // FAIL CLOSED when the BU cannot be resolved. Teardown/verify fall back to a name-only match because a
  // false negative there is merely noisy; here a name-only match could grant privileges on a same-named
  // role in a DIFFERENT business unit, which is a real privilege escalation.
  if (!bu) throw refusal(`roleGrant "${name}": could not resolve the business unit to scope the role lookup — pin the role with 'roleId' instead`);
  const rows = await provision.queryRecords('role', {
    select: ['roleid', 'name', 'ismanaged'],
    filter: `name eq '${String(name).replace(/'/g, "''")}'${roleBuClause(bu)}`,
    top: 5,
  });
  const matches = (rows || []).filter((r) => r && r.roleid);
  if (!matches.length) throw refusal(`roleGrant "${name}": no security role with that name exists in business unit ${bu} — check the spelling (the name must match EXACTLY), or pin the role with 'roleId'`);
  if (matches.length > 1) throw refusal(`roleGrant "${name}": ${matches.length} roles share that name in business unit ${bu} — pin the one you mean with 'roleId'`);
  return { roleId: String(matches[0].roleid), name: matches[0].name || name, managed: matches[0].ismanaged === true };
}


// Decide, against the LIVE environment, whether each planned item would be created or reused. #559.
//
// The dry run used to print `planFor`'s static, spec-derived listing and exit before any discovery,
// so the identical plan appeared for a spec whose every artifact already exists and for one that
// would create everything from nothing. A caller could not tell CREATE from REUSE — which is the one
// question a dry run exists to answer before a production apply.
//
// This deliberately reuses the BUILD'S OWN discovery — `findExistingTable`, `findExistingColumns`,
// `relationshipExists` and the shared `artifactIdentityQuery` — rather than re-implementing a
// parallel "does it exist?" pass. A second implementation would drift from the one that actually
// decides at apply time, and a dry run that confidently disagrees with the apply is worse than one
// that says nothing.
//
// Read-only: every call here is a GET/query. Nothing is created, updated or published.
//
// Three states, because two would have to lie:
//   create   — probed, not present: the apply will create it.
//   reuse    — probed, present: the apply will discover and skip/reconcile it.
//   unknown  — probed and the read FAILED. Never collapsed into create or reuse: guessing "create"
//              overstates the work and guessing "reuse" understates it, and both read as certainty.
// An item with no `key` is left unprobed (`state` absent) — the plan line still prints.
async function annotateLivePlan(plan, { spec, provision, warn } = {}) {
  // Localization is decided PER ITEM, because that is how the apply path decides it (per entity in
  // entity-provision.js, per relationship lookup label). A spec-wide flag would push a plain-label
  // table down the fail-closed path because some unrelated table is localized, and the plan would
  // then contradict the apply it exists to predict.
  //
  // The entity map is built here rather than carried on the key so it cannot depend on probe ORDER:
  // `tableCache` is keyed by table alone, and a form/view item naming the same table must not be
  // able to seed the cache with a different localization answer than the table item would.
  //
  // The previous spec-wide read also called `localizedLabelLcidsInSpec` without importing it. It
  // lives in entity-provision.js, not app-spec.js, so the identifier was undeclared and the
  // `typeof … === 'function'` guard silently evaluated to false on every run — the flag was never
  // once true.
  const localizedByEntity = new Map();
  for (const e of (spec && spec.entities) || []) {
    localizedByEntity.set(String(e.schemaName || '').toLowerCase(), localizedLabelLcidsInSpec({ entities: [e] }).length > 0);
  }
  const tableCache = new Map();   // entity logical -> { found: bool|null }
  const columnCache = new Map();  // entity logical -> Set<logicalName> | null
  // Relationship collection reads for this plan, keyed `<table>|<kind>`. The typed probe and the
  // case-insensitive fallback share it, so a second relationship on the same tables does not re-read.
  const relationshipReads = new Map();

  // `findExistingColumns` is written for the APPLY path, where a failed read is safe to treat as
  // "assume every column is new" — the create's own already-exists handling absorbs the duplicates.
  // A dry run has no create to absorb anything, so the same `[]` would print `+ create` for columns
  // that exist. The helper calls `warn` exactly when it is returning that fallback, so the warning
  // is the signal that the answer was not conclusive.
  const columnsOf = async (logical) => {
    if (!columnCache.has(logical)) {
      let readFailed = false;
      try {
        const cols = await findExistingColumns(provision, logical, (msg) => {
          readFailed = true;
          if (typeof warn === 'function') warn(msg);
        });
        columnCache.set(logical, readFailed ? null : new Set((cols || []).map((c) => String(c.logicalName || '').toLowerCase())));
      } catch { columnCache.set(logical, null); }
    }
    return columnCache.get(logical);
  };

  // `relationshipExists` falls back to the BROAD `fetchEntityMetadata` read when the narrow one is
  // inconclusive. Two reasons not to take that fallback here: the vendored implementation WRITES the
  // fetched metadata into the on-disk workspace, which a read-only dry run must not do (it would
  // change cached state a later apply reads); and the apply path deliberately treats its `null` as
  // "absent" because the create absorbs the race, which a dry run must not copy. Handing it a
  // reader with no `fetchEntityMetadata` makes an inconclusive probe return `null`, which becomes
  // `unknown` below.
  const relReader = { dataverse: provision && provision.dataverse };

  // ADO 6691114: a view the build would CREATE writes its filter labels as option values, so say now when
  // one cannot be resolved — the apply would halt on it. A dry run writes nothing, so it is asked exactly what the
  // build's pre-flight is asked (lib/view-filter-labels.js `checkViewFilterLabelsBeforeBuild`): only a DEFINITE
  // answer is reported, and a label that depends on something the build is about to create (a status reason it
  // inserts, a table it makes) is not. It only HALTS for a view that is `create`: an existing view's filters are
  // never reapplied, so for one the apply only says (see below). One reader, one read per table. The reader writes
  // nothing, which is why it is not `fetchEntityMetadata`.
  const labelReaders = viewLabelReaders(spec, provision);
  // `wouldHalt` marks the answer as DEFINITE — the environment was asked and the label matches no option — so the
  // dry run's summary does not count it among the items it "could not read". The mark stays `? unknown`: the
  // view's state is still not `create`, since the apply would stop before writing it.
  //
  // A label the build would bind to the spec's own number instead (a maker renamed the option) leaves the view
  // `create`, and the build WARNS about it in the views phase. A dry run has no such phase, so it says the same
  // here, once however many views name the label.
  //
  // An EXISTING view is judged too, for what the apply will SAY about it: the views phase resolves every label the
  // spec filters on, so it gives the same warning whether or not the view is already there, and for a label that
  // names no option it says the view's filters are left as they are and verify will report it. The view stays
  // `reuse` — the apply does not stop on it — so only the words differ from a view it would create.
  const saidViewLabels = new Set();
  const sayOnce = (message) => {
    if (saidViewLabels.has(message)) return;
    saidViewLabels.add(message);
    if (typeof warn === 'function') warn(message);
  };
  const judgeViewLabels = async (item, key) => {
    if (key.kind !== 'view' || (item.state !== 'create' && item.state !== 'reuse') || !key.declared || !hasLabelUses(spec, key.declared)) return;
    const { problems, notes } = await checkViewFilterLabelsBeforeBuild(spec, [key.declared], labelReaders);
    if (item.state === 'create') {
      if (problems.length) { item.state = 'unknown'; item.stateWhy = problems.map(describeProblem).join(' '); item.wouldHalt = true; }
    } else {
      for (const p of problems) sayOnce(existingViewLabelNote(p));
    }
    for (const note of notes) sayOnce(note);
  };

  const tableState = async (logical) => {
    if (!tableCache.has(logical)) {
      try {
        const hit = await findExistingTable(provision, logical, { hasLocalizedLabels: localizedByEntity.get(logical) === true });
        tableCache.set(logical, { found: !!hit });
      } catch (err) {
        // Includes the BuildHalt findExistingTable raises for a LOCALIZED spec whose probe is
        // inconclusive — which is precisely an "unknown", not an absence.
        //
        // `why` is kept SHORT because it is printed once per plan line, and every column, view and
        // form on the table inherits it: the BuildHalt text is a ~390-character remediation
        // paragraph, so a 20-column table would emit ~8 KB of the same prose. The full text is kept
        // on `whyLong` for the table's own line, where it is worth reading once.
        const full = String((err && err.message) || err);
        tableCache.set(logical, { found: null, why: 'the table existence probe was inconclusive', whyLong: full });
      }
    }
    return tableCache.get(logical);
  };

  // Resolve view/chart/form/app the way the BUILD resolves them, so the plan cannot claim a state
  // the apply then contradicts:
  //   - forms go through `resolveExistingFormId`, which validates a pinned `formId` (a stale or
  //     foreign pin makes the apply HALT — reporting that as create/reuse would hide it) and throws
  //     on two same-(entity,type,name) forms;
  //   - views/charts go through `provision.findArtifact`, which raises on an ambiguous identity;
  //   - the app is keyed by its deterministic unique name.
  // Anything thrown becomes `unknown` with the resolver's own message, which is the actionable one.
  const artifactPresent = async (kind, def) => {
    if (kind === 'form') return !!(await resolveExistingFormId(provision, def));
    if ((kind === 'view' || kind === 'chart') && typeof provision.findArtifact === 'function') {
      return !!(await provision.findArtifact(kind, { name: def.name, entity: def.entityLogicalName }));
    }
    const q = artifactIdentityQuery(kind, def);
    if (!q) return null;
    const rows = await provision.queryRecords(q.set, { select: [q.idField], filter: q.filter, top: 1 });
    return !!(rows && rows.length);
  };

  for (const item of plan) {
    const k = item.key;
    if (!k) continue;
    try {
      if (k.kind === 'table') {
        const t = await tableState(String(k.entity).toLowerCase());
        item.state = t.found === null ? 'unknown' : (t.found ? 'reuse' : 'create');
        // The table's own line carries the FULL reason (the halt text names the remediation); every
        // other item on the same table gets the short form, so the paragraph is printed once.
        if (t.found === null) item.stateWhy = t.whyLong || t.why;
      } else if (k.kind === 'column') {
        const logical = String(k.entity).toLowerCase();
        const t = await tableState(logical);
        // A column on a table that does not exist is unambiguously a create — and asking Dataverse
        // for the attributes of a non-existent table only produces a metadata-cache error.
        if (t.found === false) { item.state = 'create'; continue; }
        if (t.found === null) { item.state = 'unknown'; item.stateWhy = t.why; continue; }
        const cols = await columnsOf(logical);
        if (!cols) { item.state = 'unknown'; item.stateWhy = 'the table\'s attributes could not be read'; continue; }
        item.state = cols.has(String(k.name).toLowerCase()) ? 'reuse' : 'create';
      } else if (k.kind === 'relationship') {
        // Tri-state: `null` means the probe could not tell. The apply path treats that as absent
        // (its create absorbs the race); a plan has nothing to absorb it, so it must say so.
        // The localized-label flag is deliberately NOT threaded here. Its only effect inside
        // `relationshipExists` is to suppress the `fetchEntityMetadata` fallback — and `relReader`
        // has no `fetchEntityMetadata` at all (see above), so an inconclusive probe already returns
        // `null` either way. Passing it would be inert code that reads as though it decides
        // something.
        // declared lets a same-name row with different endpoints come back as { mismatch }, which
        // a name-only probe reported as reuse. 'unknown' is the rendered non-reuse state: the plan
        // printer names only that state's reason, and a reader must not see '= reuse'.
        const present = await relationshipExists(relReader, String(k.entity).toLowerCase(), k.name, k.relType, { declared: k.declared, cache: relationshipReads });
        if (present && present.mismatch) {
          item.state = 'unknown';
          item.stateWhy = `schema name '${k.name}' is already used by ${describeRelationship(present.holder)}, not the declared relationship`;
        } else if (present === false) {
          // The typed collection of this end cannot see a holder of the other type (an N:N name
          // held by a 1:N). One exact-name read, no collection scan — the plan stays cheap.
          const exact = await readExact(provision && provision.dataverse, k.name);
          const declared = Object.assign({}, k.declared, { schemaName: (k.declared && k.declared.schemaName) || k.name });
          // A holder that exists is reused only when it states its whole identity. Otherwise the item is unknown, and the reason says
          // whether the name belongs to another relationship or the environment's answer left a part out (compareRelationship).
          const judgeHolder = (heldBy) => {
            const verdict = compareRelationship(declared, heldBy);
            if (verdict.state === 'same') { item.state = 'reuse'; return; }
            item.state = 'unknown';
            item.stateWhy = verdict.state === 'incomplete'
              ? `schema name '${k.name}' exists, but ${describeIncomplete(verdict.missing)}, so it cannot be told from the declared relationship`
              : `schema name '${k.name}' is already used by ${describeRelationship(heldBy)}, not the declared relationship`;
          };
          if (exact.found === true) judgeHolder(exact.holder);
          else if (exact.found === false) {
            // The SchemaName key is case-sensitive. A differently-cased holder 404s here and would
            // otherwise be planned as create. The collection scan is case-insensitive; skipExact
            // because this read already 404'd that spelling.
            const ends = k.declared
              ? (k.relType === 'ManyToMany' ? [k.declared.entity1, k.declared.entity2] : [k.declared.referenced, k.declared.referencing])
              : [k.entity];
            const holder = await findRelationshipHolder(provision && provision.dataverse, k.name, { candidates: ends, cache: relationshipReads, skipExact: true });
            if (holder.found === true) judgeHolder(holder.holder);
            else if (holder.found === false) item.state = 'create';
            else {
              item.state = 'unknown';
              item.stateWhy = 'the relationship metadata read was inconclusive';
            }
          }
          else {
            item.state = 'unknown';
            item.stateWhy = 'the relationship metadata read was inconclusive';
          }
        } else {
          item.state = present === null || present === undefined ? 'unknown' : 'reuse';
          if (item.state === 'unknown') item.stateWhy = 'the relationship metadata read was inconclusive';
        }
      } else if (k.kind === 'app') {
        const present = await artifactPresent('app', { uniqueName: k.uniqueName });
        item.state = present ? 'reuse' : 'create';
      } else if (k.kind === 'view' || k.kind === 'chart' || k.kind === 'form') {
        // A form/view/chart on a table that does not exist yet cannot exist either, and the filter
        // would 400 on the metadata cache — so answer from the table, as the build's own lookup does.
        const t = await tableState(String(k.entity).toLowerCase());
        if (t.found === false) { item.state = 'create'; await judgeViewLabels(item, k); continue; }
        // …and if the TABLE probe was inconclusive, nothing about its artifacts is knowable either.
        // Without this the plan contradicts itself in adjacent lines — `? unknown` for the table and
        // a confident `+ create` for every view and form on it — and the apply never gets that far:
        // findExistingTable raises BuildHalt for exactly this state, outside any runner.run, so the
        // build aborts in `data-model`. The form arm is the worst of the three, because
        // resolveExistingFormId deliberately swallows the MetadataCache 400 and returns null, which
        // `!!` then flattens into a confident "absent".
        if (t.found === null) { item.state = 'unknown'; item.stateWhy = t.why; continue; }
        const present = await artifactPresent(k.kind, { name: k.name, entityLogicalName: String(k.entity).toLowerCase(), formType: k.formType, formId: k.formId, uniqueName: k.uniqueName });
        item.state = present === null ? 'unknown' : (present ? 'reuse' : 'create');
        await judgeViewLabels(item, k);
      }
    } catch (err) {
      item.state = 'unknown';
      item.stateWhy = String((err && err.message) || err);
    }
  }
  return plan;
}

// --- orchestrator ----------------------------------------------------------------------
function normalizeFormId(value) {
  return String(value || '').trim().replace(/^\{+|\}+$/g, '').toLowerCase();
}

function authorizedFormRemovalEntry(map, formId, createdThisRun) {
  if (!(map instanceof Map)) return { fenced: false, authorized: null, normalizedFormId: normalizeFormId(formId) };
  const normalized = normalizeFormId(formId);
  if (map.has(normalized)) return { fenced: true, authorized: map.get(normalized), normalizedFormId: normalized };
  for (const [key, value] of map) {
    if (normalizeFormId(key) === normalized) return { fenced: true, authorized: value, normalizedFormId: normalized };
  }
  if (createdThisRun && createdThisRun.has(normalized)) return { fenced: false, authorized: null, normalizedFormId: normalized };
  return { fenced: true, authorized: new Set(), normalizedFormId: normalized };
}

function sitemapTargetsForFence(container) {
  // Use the destructive-op classifier's target vocabulary so the preflight record and the engine fence
  // cannot drift (entity:<logical>, url:<url>). Required lazily to avoid a module-load cycle: op-diff
  // reaches sdk-build through sdk-teardown, while this helper runs only after sdk-build is initialized.
  return require('./op-diff.js').sitemapTargets(container);
}

async function assertAuthorizedSitemapRewrite(provision, appId, nextSiteMap, authorized, phase) {
  if (!(authorized instanceof Set)) return;
  await provision.fetchArtifact('app', appId, { overwrite: true });
  const live = await provision.getArtifact('app', appId) || {};
  const want = new Set(sitemapTargetsForFence(nextSiteMap || {}));
  const dropped = sitemapTargetsForFence(live.siteMap || {}).filter((target) => !want.has(target));
  const unauthorized = dropped.filter((target) => !authorized.has(target));
  if (unauthorized.length) {
    // `retry: NEVER`: an approval fence. Only a renewed approval authorizes the removal, so running the build again would meet the same fence; the message names live URLs, which are the maker's.
    throw new BuildHalt(`refusing to rewrite the app sitemap because ${unauthorized.join(', ')} appeared after the run's approval and would be removed. Re-run to review it.`, { phase, code: 'sitemap-removal-unapproved', recoverable: true, retry: RETRY.NEVER });
  }
}

// The sitemap to write over an EXISTING app: `desired` re-attached to the live nodes it corresponds
// to, so each keeps its live id and everything the App Spec cannot describe (AB#6726727; see
// sitemap-merge.js). The live tree is the workspace copy, which the caller has just fetched — and
// the removal fence may have re-fetched with overwrite — so it is exactly what this write replaces.
// `opts.baselineSpec` is the spec last applied to, or downloaded from, this environment; with it a
// nav-entry change made in the designer since then is kept rather than reverted by a stale spec.
async function siteMapOverLive(provision, appId, desired, opts, created) {
  const live = await provision.getArtifact('app', appId) || {};
  const baseChrome = opts.baselineSpec ? chromeByTargetKey(opts.baselineSpec, created) : undefined;
  // The LCID the SDK was constructed with — the one it reads and writes sitemap titles in.
  const lcid = opts.preResolvedLanguageCode || opts.languageCode || undefined;
  const { siteMap, notes } = adoptLiveSitemap(desired, live.siteMap, { baseChrome, lcid });
  if (typeof opts.warn === 'function') for (const line of describeSitemapNotes(notes)) opts.warn(line);
  return siteMap;
}

// What a DEFERRED `enrichDefaultViews(…, { publish: false })` had already saved when it failed
// part-way. The SDK attaches that record to the error under a global-registry symbol (its
// `readPartialEnrichment`, errors/index.ts) and looks for it on the error and its `cause` chain; this
// reads it the same way, because the engine is handed an SDK instance and never imports the bundle.
// Those saves are not published, so dropping the record would drop the only proof a publish is owed.
const PARTIAL_ENRICHMENT = Symbol.for('cds-maker-sdk.partialDefaultViewEnrichment');
function partialEnrichment(error) {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    const value = current[PARTIAL_ENRICHMENT];
    if (value && typeof value === 'object') return value;
    current = current.cause;
  }
  return undefined;
}

// Publish `entityTargets` (one artifact per table, `[type, id]`) and then the app, in ONE PublishXml
// envelope when the SDK offers `publishArtifacts`. MEASURED by the SDK: a PublishXml costs ~2-2.5 s
// even with nothing pending and parallel ones queue on the server — four one-table publishes took
// 10-19 s, one envelope 3.6-3.8 s, and folding the app into it saved ~2 s more.
//
// A failed envelope fails every target with the shared error and may already have published some
// scopes, so each failed target is published again on its own, which is what the SDK prescribes. A
// preflight refusal (a target the workspace does not hold) throws before anything is published; the
// per-target path then runs exactly as it did before this opt-in, and reports what it always did.
//
// `keepGoing` is for the halt path (settleOwedPublishes): there a target whose own publish THROWS is
// reported and the others are still published, because nothing else will publish them. The publish
// phase keeps the old behaviour — a thrown publish halts it — so a build reports that as it always did.
//
// A target is `[type, id]` plus an optional third element that names what the publish is FOR: the app's own
// label, or — for a table — the names of what its one publish ships. The publish phase fills it with the saved
// views and forms whose publishes were deferred onto the table (`publishReconciled`), its enriched default views,
// and the views, forms and charts this run created there and a chart whose description it wrote (`noteSaved`); the
// owed record a halted build hands to settleOwedPublishes carries only what was deferred. One artifact stands for
// its whole table in the envelope, so a
// bare `form <guid>` would name the table's untouched Main form in a "publish … FAILED" or "could not be
// CONFIRMED" line, and say nothing about the view that is actually not live.
//
// Returns `{ appPublished, failed }`. `appPublished`: whether the app's own publish went through (a failed one, or no
// app target, is false). The ai-features re-confirmation reads it — an override saved in the app's unpublished layer is
// in force once the app is published, and the publish phase is what does that. `failed`: `{ target, error }` for each
// TABLE target whose last publish the SDK refused by value (`publish.kind === 'failed'`, after the retry below), so its
// saved changes are not live. This function only reports one (a warning); publishReconciledTables, which must not let
// the app be published ahead of such a table, halts on it.
async function publishTargets(provision, runner, concurrency, entityTargets, appTarget, warn, { keepGoing = false } = {}) {
  const labelOf = targetLabel;
  const publishOne = async ([type, id], label) => {
    if (!keepGoing) return reportPartialPush(await provision.publishArtifact(type, id), label, warn);
    try {
      return reportPartialPush(await provision.publishArtifact(type, id), label, warn);
    } catch (e) {
      if (typeof warn === 'function') warn(`publish ${label} FAILED: ${(e && e.message) || e} — the change is SAVED but the runtime still serves the previously published copy; the build is idempotent, so re-run it once the cause is cleared`);
      return undefined;
    }
  };
  // A publish that was not refused. `unverifiable` still means PublishXml answered 2xx; only the read-back that
  // would confirm it was not possible. An outcome that says nothing about publishing proves nothing.
  const published = (result) => !!(result && result.publish && result.publish.kind && result.publish.kind !== 'failed' && result.publish.kind !== 'notRequested');
  const refused = (result) => !!(result && result.publish && result.publish.kind === 'failed');
  const failed = [];
  const all = appTarget ? [...entityTargets, appTarget] : entityTargets;
  const isApp = (target) => !!appTarget && target[0] === 'app' && target[1] === appTarget[1];
  if (all.length > 1 && typeof provision.publishArtifacts === 'function') {
    let results = null;
    try {
      results = await provision.publishArtifacts(all.map(([type, id]) => ({ type, id })));
    } catch {
      results = null;
    }
    if (Array.isArray(results) && results.length === all.length) {
      const retry = [];
      let appResult;
      results.forEach((outcome, i) => {
        if (refused(outcome)) retry.push(all[i]);
        else {
          reportPartialPush(outcome, labelOf(all[i]), warn);
          if (isApp(all[i])) appResult = outcome;
        }
      });
      for (const target of retry) {
        const retried = await publishOne(target, labelOf(target));
        if (isApp(target)) appResult = retried;
        else if (refused(retried)) failed.push({ target, error: retried.publish.error });
      }
      return { appPublished: published(appResult), failed };
    }
  }
  const outcomes = await runner.mapLimit(entityTargets, concurrency, (async (target) => publishOne(target, labelOf(target))));
  entityTargets.forEach((target, i) => {
    const outcome = (outcomes || [])[i];
    if (refused(outcome)) failed.push({ target, error: outcome.publish.error });
  });
  const appResult = appTarget ? await publishOne(['app', appTarget[1]], appTarget[2]) : undefined;
  return { appPublished: published(appResult), failed };
}

// What a publish target is FOR, in the words a warning or a halt prints: the names the target carries (a table's
// deferred and saved artifacts, the app's own label), else `type id`.
function targetLabel([type, id, label]) {
  return (Array.isArray(label) ? label.join(', ') : label) || `${type} ${id}`;
}

// The halt for tables whose publish was refused before the app was written. `failed` is publishTargets' `{ target, error }` per table. The message names the saved artifacts, which are the maker's (a
// view called "SQL Timeout Reader"), and the service's answer to each. What decides whether a run again can help is each refusal's own structure — its status, its type, whether it says it must not be run
// again — never the names: it is run again for a 429 or a 503 (the build re-runs a throttled publish as it did before this publish moved ahead of the app), and NEVER when any one table's refusal is final,
// since the run would stop at that table again. The words that may decide are the answers' own (`retryText`, cut of the url each carries), never the names. The runner wraps this halt once more
// (makeRunner); the policy, the status and the words are read through that wrapper.
function reconciledPublishHalt(failed) {
  const names = failed.map(({ target }) => targetLabel(target)).join('; ');
  const detail = failed.map(({ error }) => (error && error.message) || 'refused').join('; ');
  const errors = failed.map(({ error }) => error);
  const final = errors.some((error) => retryPolicyFor(error) === RETRY.NEVER);
  const status = errors.map((error) => error && (error.statusCode || error.status)).find(isTransientStatus);
  const words = errors.map((error) => (error && typeof error === 'object' ? judgeFailure(error).text : '')).filter(Boolean).join('; ');
  return new BuildHalt(`publish ${names} FAILED before the app was written: ${detail} — the build stopped there, because the app's publish would leave the labels saved on these tables unpublished for good. The changes are saved; re-run the build once the cause is cleared.`, {
    phase: 'app-shell', code: 'reconciled-publish-failed', recoverable: true, cause: errors[0], retry: final ? RETRY.NEVER : RETRY.SERVICE, retryText: words, ...(status ? { statusCode: status } : {}),
  });
}

// The publishes a build still OWED when it stopped: the tables whose saved views and forms — the default
// views its deferred enrichment (4b) saved, and the existing views and forms its reconcile paths pushed —
// no completed publish phase (8) covered. `runSdkBuild` attaches them
// to the halt (`owedPublishes`) instead of publishing them there, because only its caller knows
// whether the halt is final: the CLI retries a transient one (a 429, a customization lock) at once,
// the retry saves those views again and owes their publish again, and a publish sent into that
// throttling would only fail the same way. The CLI keeps what each failed attempt owed, because a later
// attempt can halt before the step an earlier one owed from, until a publish phase pays it (`owedPaid`).
//
// On a FINAL halt the caller publishes them with this (`owed`: `[type, id, names?]` targets, see
// publishTargets). Before the publish was batched, the enrichment and every reconcile published each table
// as it went, so a build that stopped in a later phase left those tables live (live-verified, before and
// after the batching). Without this they would wait, saved but unpublished, for the full re-run that
// recovers from the halt — which saves them again and owes their publish again — and nothing makes an
// operator start one.
// Best-effort and per target: the halt is what the operator must see, so a failure is a warning, never a
// throw, and a target that cannot be published does not keep the others back.
//
// This runs only for a halt the build THROWS. A process killed outright (Ctrl-C, a crash, a closed
// terminal) settles nothing: what a reconcile had saved and deferred stays saved but unpublished until the
// next build, which publishes it (a clean workspace copy is still published, see publishReconciled). No marker
// outlives the process to say it is owed, and the CLI installs no signal handler that could write one. The
// default-view enrichment (4b), whose publish was deferred the same way first, has the same exposure.
//
// What this publishes is what the build DEFERRED, so the warning for a publish that failed names that. It is not all that is saved and
// not live: a table's publish ships everything saved on the table, so one that failed leaves every form, view and chart there not
// live; and what the build CREATED (a first build creates all of it) defers no publish and is owed none here. So after the publishes
// `tables` (the spec's: specTables) are read for what they hold saved and not published, and the warning says what that is — or that it
// could not be read, and which tables to publish. It is read AFTER the publishes, so what they made live is not claimed, and only for
// forms, views and charts (table-publish.js): a column or command saved and not published is not covered, and the line says so. Without
// `tables`, as the CLI passes none for a dry run or a build with no publish phase, nothing is read.
async function settleOwedPublishes(provision, owed, warn, { tables } = {}) {
  const targets = Array.isArray(owed) ? owed.filter((target) => Array.isArray(target) && target[0] && target[1]) : [];
  const say = (message) => { if (typeof warn === 'function') warn(`the build stopped before its publish phase; ${message}`); };
  if (provision && targets.length) {
    try {
      await publishTargets(provision, makeRunner({ emit: () => undefined, total: 0 }), 1, targets, null, say, { keepGoing: true });
    } catch (e) {
      say(`publishing the views and forms it had already saved FAILED: ${(e && e.message) || e} — the change is SAVED but the runtime still serves the previously published copy; the build is idempotent, so re-run it once the cause is cleared`);
    }
  }
  // An SDK with no raw client to read with is a test double: the real one always has it, so there is nothing to say about its absence.
  const client = provision && provision.dataverse;
  if (typeof warn !== 'function' || !Array.isArray(tables) || !tables.length || !client || typeof client.get !== 'function') return;
  try {
    const text = describeSavedNotPublished(await readSavedNotPublished(client, tables), tables);
    if (text) say(text);
  } catch { /* the halt is what the operator must see; a report on what else is not live never hides it */ }
}

// Fold the targets one halted attempt still owes (`err.owedPublishes`) into `byTarget`, keyed by `type:id`, for the
// CLI to settle once no retry follows. A later attempt can stop before a step an earlier one owed from, so the
// names an attempt recorded for a target are UNIONED with what the earlier ones recorded — "last attempt wins"
// would drop the names of whatever only the earlier attempt reached, and a failed settle would name too little.
function collectOwedPublishes(byTarget, owed) {
  for (const target of Array.isArray(owed) ? owed : []) {
    if (!Array.isArray(target)) continue;
    const key = `${target[0]}:${target[1]}`;
    const namesOf = (t) => (Array.isArray(t && t[2]) ? t[2] : []);
    const names = [...new Set([...namesOf(byTarget.get(key)), ...namesOf(target)])];
    byTarget.set(key, names.length ? [target[0], target[1], names] : target);
  }
  return byTarget;
}

// The commands the build's messages give for a page, as scripts/genpage.js takes them (`node scripts/…` from the plugin's folder, as the other commands the build names are written). Each takes the environment
// the build runs in. `app` is { id, note } for a verb that takes `--app-id` (and nothing for one that does not): the id when it is a GUID — the verb refuses anything else — and otherwise `<note>`, in angle
// brackets, which still says whose id goes there.
function genpageCommand(verb, { env, pageId, app, flags = '' }) {
  const appPart = app === undefined ? '' : ` --app-id ${FORM_GUID_RE.test(String(app.id || '')) ? String(app.id).toLowerCase() : `<${app.note}>`}`;
  return `node scripts/genpage.js ${verb} --env ${env || '<envUrl>'}${appPart} --page-id ${pageId}${flags}`;
}

// What to do about a page another app also holds, in the words of the halts and the report of the pages phase: take it out of that app's navigation (`genpage.js remove-from-app` also publishes that app, which publishes
// everything that app has saved, so the user is asked first), or detach it in Maker, or give this app a page of its own. `commands` are the lines `genpageCommand` made, one per app that holds the page.
const detachAdvice = (commands) => `Detach it from the other app — ask the user first, since this changes another app: ${commands.join('; ')} (each takes the page out of that app's navigation and publishes that app, which publishes everything that app has saved; the page itself stays) — or detach it in Maker, or give this app its own page.`;

// The entry every caller enters by. An APPLY holds the app's build lease for the whole of it (lib/app-operation-lease.js): one taken here when the
// caller holds none, or the caller's own (`opts.buildLease`, which buildModelApp hands to each attempt), borrowed and left to the caller to let go. A
// second apply of the same app in the same workspace is refused before anything is read or written, so two builds cannot both find the app's icon,
// the app or a page missing and both create it. A dry run reads only, and takes no lease.
async function runSdkBuild(spec, opts = {}) {
  if (!opts.apply) return runSdkBuildAttempt(spec, opts);
  return withAppBuildLease({ workspaceDir: applyWorkspaceOf(opts), appUniqueName: appUniqueName(spec), buildLease: opts.buildLease, warn: opts.warn }, () => runSdkBuildAttempt(spec, opts));
}

// One attempt; the phases run in runSdkBuildPhases. This wrapper only carries what an attempt
// still owes out of a halt, for the caller that retries:
//  - the deferred publishes (default-view enrichment, reconciled views and forms): `owedPublishes`, and
//    `owedPaid` when this run's publish phase completed — which pays what an earlier attempt of the same
//    build owed too, since every attempt saves the same tables (see settleOwedPublishes);
//  - the primary name column lengths of the tables it created and did not finish setting: `owedLengths`, the
//    records the data-model phase keeps (provisionDataModel) — each with the MetadataId of the table the attempt
//    created, which tells it from another that comes to answer to the same name — which the caller hands to the
//    next attempt as `opts.owedLengths` and which that attempt pays at the end of its own data-model phase, to the
//    table it was recorded for. What is on the halt is everything still owed: what the attempt was handed and did
//    not pay, and what it created.
async function runSdkBuildAttempt(spec, opts = {}) {
  // tables: entity logical -> [type, id, names] of a saved view or form that owes its publish, and the names of
  // what is deferred onto that table: its reconciled views and forms, and its enriched default views
  // (oweTablePublish). lengths: table logical -> { table, column, asked, tried, tableId, columnId? } of a name column whose
  // length is owed.
  const owed = { tables: new Map(), paid: false, lengths: new Map() };
  // A record this attempt was handed is a debt it has not tried to pay yet, whatever an earlier attempt did with it.
  let carriedIn = 0;
  for (const debt of Array.isArray(opts.owedLengths) ? opts.owedLengths : []) {
    if (!debt || typeof debt !== 'object' || typeof debt.table !== 'string' || !debt.table) continue;
    owed.lengths.set(debt.table.toLowerCase(), { ...debt, table: debt.table.toLowerCase(), tried: false });
    carriedIn += 1;
  }
  try {
    return await runSdkBuildPhases(spec, opts, owed);
  } catch (err) {
    if ((owed.tables.size > 0 || owed.paid) && err && typeof err === 'object') {
      try {
        // Not enumerable: they ride along for the caller, never into a serialized error or the journal.
        Object.defineProperty(err, 'owedPublishes', { value: [...owed.tables.values()], enumerable: false, configurable: true, writable: true });
        Object.defineProperty(err, 'owedPaid', { value: owed.paid, enumerable: false, configurable: true, writable: true });
      } catch { /* a frozen error carries nothing; the re-run saves the views again and owes their publish */ }
    }
    // Also when nothing is owed any more but an attempt was handed a debt: the empty list is how the caller learns it was paid.
    if ((owed.lengths.size > 0 || carriedIn > 0) && err && typeof err === 'object') {
      try {
        Object.defineProperty(err, 'owedLengths', { value: [...owed.lengths.values()], enumerable: false, configurable: true, writable: true });
      } catch { /* a frozen error carries nothing; a run that finds the table leaves its name column as it is, which the warning said */ }
    }
    throw err;
  }
}

async function runSdkBuildPhases(spec, opts, owed) {
  const { sdk, apply = false, sampleData = false, publish = false } = opts;
  const emit = opts.emit || (() => undefined);
  // Header-less client for solution lifecycle + artifact pushes (Dataverse rejects the
  // MSCRM.SolutionUniqueName header on createSolution and on savedquery/systemform/appmodule
  // creates); metadata + records keep the header-ful `sdk`. Reads (find*/fetch*) ignore the
  // header, so either client works for discovery.
  const provision = opts.provisionSdk || sdk;
  const phases = opts.phases || PHASES;
  const has = (p) => phases.includes(p);
  const concurrency = opts.concurrency || 4;
  const plan = planFor(spec, { sampleData, publish, phases });

  if (!apply) {
    // #559: resolve create-vs-reuse against the live environment before printing the plan. Opt out
    // with `livePlan: false` for an offline/spec-only listing (the old behaviour). Probing is
    // skipped silently when the caller supplied no reader — a dry run must still work without one.
    const canProbe = opts.livePlan !== false && provision && typeof provision.queryRecords === 'function';
    if (canProbe) {
      try {
        await annotateLivePlan(plan, { spec, provision, warn: opts.warn });
      } catch (err) {
        // The plan itself is still worth printing; say the states are missing rather than implying
        // every item is a create.
        emit({ phase: 'plan', status: 'warn', label: `live plan unavailable (${(err && err.message) || err}) — showing the spec-derived plan only`, n: 0, total: plan.length });
      }
    }
    if (has('app-shell')) checkNavigationInPlan(plan, spec, { phases, changedOnly: opts.changedOnly, warn: opts.warn });
    // What the environment has for the names the pages' bindings state (checkPageBindingsInPlan): it reads, so it is a part of the live plan and is left out of one that is asked not to read the environment.
    if (canProbe && has('pages')) {
      try {
        await checkPageBindingsInPlan(plan, spec, { provision, phases, changedOnly: opts.changedOnly, warn: opts.warn });
      } catch (err) {
        if (typeof opts.warn === 'function') opts.warn(`could not check the bindings of the pages against this environment (${(err && err.message) || err})`);
      }
    }
    plan.forEach((p, i) => emit({ phase: p.phase, status: p.state === 'reuse' ? 'skip' : 'skip', label: p.label, state: p.state, stateWhy: p.stateWhy, n: i + 1, total: plan.length }));
    return {
      ok: true,
      dryRun: true,
      livePlan: canProbe,
      plan: plan.map((p) => (p.state ? `${p.label} [${p.state}]` : p.label)),
      planItems: plan.map((p) => ({ phase: p.phase, label: p.label, ...(p.state ? { state: p.state } : {}), ...(p.stateWhy ? { stateWhy: p.stateWhy } : {}), ...(p.wouldHalt ? { wouldHalt: true } : {}) })),
    };
  }

  // Capture the attempt's checkpoint before best-effort preflight reads can swallow a refused throttle wait as unchecked metadata. The same runner then stops before any mutation, without counting refusals from earlier attempts.
  const runner = makeRunner({ emit, total: plan.length, throttle: opts.throttle });
  // A navigation Dataverse will refuse stops the build here, before anything is written, rather than at the app step
  // after the solution, tables, columns, views and forms have been (app-navigation.js). Only a run that has the app step.
  if (has('app-shell')) await checkNavigationBeforeWriting(spec, { provision, phases, changedOnly: opts.changedOnly, warn: opts.warn });
  // A binding whose connection reference is another connector's stops the build here too, before anything is written, for the same reason (checkPageBindingsBeforeWriting). What it reads is kept for
  // the attempt (bindingReads): the pages phase judges a navigation target it finds it has to make by the same reads, and reads only a name this check did not.
  const bindingReadsOfAttempt = bindingReads();
  await checkPageBindingsBeforeWriting(spec, { provision, phases, changedOnly: opts.changedOnly, warn: opts.warn, seen: bindingReadsOfAttempt });
  runner.stopIfRefused('preflight');

  const createdFormsThisRun = new Set();
  // The maps keyed by a name a maker writes freely — a dashboard's, a page's key, a persona's (its role's), a business process flow's — are
  // null-prototype objects (lib/own-keys.js): any such name can be `__proto__`, `constructor`, `toString`, … and must be stored and read as an
  // entry like any other. On a plain object a dashboard called `__proto__` was never stored, and a page keyed `constructor` that was not built
  // yet read the Object function as its id. JSON.stringify writes them exactly as it writes a plain object with the same entries. The other maps
  // are keyed by Dataverse logical names (a table's, a web resource's: the publisher prefix and `_`, or a system component's), by GUIDs or by
  // `entity|name` pairs, none of which can be such a member.
  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, webResources: {}, views: {}, charts: {}, forms: {}, formIds: {}, businessRules: {}, businessProcessFlows: {}, bpfBackingTables: {}, commands: {}, dashboards: Object.create(null), pages: Object.create(null), pageDeployedShas: Object.create(null), pageSourceShas: Object.create(null), ai: { appFeatures: null, summaries: {} }, roles: Object.create(null), roleGrants: {}, bpfRoleGrants: Object.create(null), app: null }, skipped: { businessRules: [], aiSummaries: [], layout: [], unauthorizedRemovals: [] } };
  // #changed-only (pages-only fast apply): seed the LIVE app id (discovered by unique name upstream) so the
  // pages phase's `pages-requires-app` guard passes WITHOUT running the app-shell phase in this invocation.
  // The full-build path never sets opts.changedOnly, so result.created.app stays null and app-shell
  // creates/updates it exactly as before — this branch is a no-op (byte-identical) on the normal path.
  if (opts.changedOnly && opts.changedOnly.resolvedAppId) result.created.app = opts.changedOnly.resolvedAppId;
  const sol = spec.solution;
  // The web resources an earlier run of this build wrote and could not confirm were published (lib/web-resource-records.js), read at first use: the
  // spec's web resources and the generated app icon are written again by id when they are in it, and the page manifest is written again by its id where
  // its published copy is not what the run wants (kept where it is: persistPageManifest). One per run of the phases, so the
  // build's own re-run of a halt reads what the attempt before it recorded.
  const unconfirmedWebResources = openUnconfirmedWebResources({ workspaceDir: opts.workspaceDir, environment: opts.env, warn: opts.warn });

  // ADO 6691114: a view-filter label the environment already shows to be wrong stops the build here, before it
  // writes anything — in any apply that writes the solution or the data model, whether or not it also builds the
  // views, so the staged flow's data run fails first too — unless the spec carries a localized label, whose
  // creation no label-bearing read may precede (preflightViewLabels). The views phase checks again once the data
  // model exists (the final answer, with the values). A note both of them would make is made once.
  const warnedViewLabels = new Set();
  const sayViewLabel = (message) => {
    if (warnedViewLabels.has(message)) return;
    warnedViewLabels.add(message);
    if (typeof opts.warn === 'function') opts.warn(message);
  };
  let preflightResolved;
  if (has('solution') || has('data-model')) preflightResolved = await preflightViewLabels(spec, provision, sayViewLabel);

  // Solution membership of the components this run REUSES (solution-membership.js): read once, at first use,
  // and a component the solution is PROVEN to hold is not added again. A component this run creates is added
  // directly — a component made a moment ago cannot already be a member — with one exception: the page
  // manifest is persisted after every page create and once more at the end (persistPageManifest), so it always
  // goes through `ensureSolutionComponent`, and a build that deploys pages makes the read even when it is the
  // first. That costs a read and never an add: a manifest the solution lacks is still added.
  //
  // A reused view, chart or form is also proven by its TABLE: one the build created is held by the solution with
  // all its subcomponents, which the platform does not list one by one, so these three have no row of their own to
  // find. The membership asks for the table's MetadataId — the `objectid` of the table's row — only when it needs
  // it, once per table, through the raw client the build already uses for table metadata (`tableRefs`). A client
  // without `get`, a table that does not resolve, any failure at all: no proof, and the component is added.
  const resolveTableId = async (logical) => (await tableRefs(provision.dataverse, [logical])).get(String(logical).toLowerCase()).metadataId;
  const solutionMembers = createSolutionMembership({ read: provision, solutionUniqueName: sol && sol.uniqueName, componentTypes: Object.values(COMPONENT_TYPE), resolveTableId });
  const ensureInSolution = (componentId, componentType, table) => ensureSolutionComponent(provision, solutionMembers, { componentId, componentType, solutionUniqueName: sol.uniqueName }, { table });

  // With --publish, phase 8 publishes the table of every view and form the reconcile paths touch (an entity
  // PublishXml ships every pending customization on that table), so a reconcile's own publish would only
  // repeat it, one ~2.5 s PublishXml per artifact. It is deferred to phase 8 and recorded as owed — the same
  // record the default-view enrichment (4b) keeps — so a build that halts first still gets it published by its
  // caller (settleOwedPublishes); and the owed table is itself a phase 8 target, so deferring cannot leave an
  // entity out of it.
  //
  // One artifact publishes its whole table, so the record keeps the first artifact deferred onto the table as the
  // target and collects the NAMES of every one (`view Open Tickets`, `form Ticket events`, `default views of
  // new_ticket`, …): when that publish fails — or cannot be confirmed — the line says which saved changes are not
  // live, as the per-artifact publish it replaces did, instead of naming whichever form happened to stand for the
  // table (publishTargets). The reconcile paths and the default-view enrichment (4b) both owe through this, so the
  // record is the same whichever of them reaches the table first.
  //
  // Without --publish nothing runs phase 8, so the reconcile publishes its own artifact so the change takes
  // effect, as it always did. That includes a reconcile whose push was skipped as unchanged: a clean workspace
  // copy is the UNPUBLISHED layer, so it cannot show that an earlier run which pushed and then stopped ever
  // published (hasUnsyncedEdits).
  const publishInPhase8 = has('publish') && publish;
  const oweTablePublish = (logical, type, id, name) => {
    const target = owed.tables.get(logical);
    if (!target) owed.tables.set(logical, [type, id, [name]]);
    else if (!(target[2] || []).includes(name)) target[2] = [...(target[2] || []), name];
  };
  // The tables a reconcile deferred onto phase 8: publishTablesBeforeApp pays them before the app is published.
  const reconciledTables = new Set();
  const publishReconciled = async (type, id, entityLogical, label) => {
    const logical = String(entityLogical || '').toLowerCase();
    if (publishInPhase8 && logical) {
      oweTablePublish(logical, type, id, label);
      reconciledTables.add(logical);
      return;
    }
    reportPartialPush(await provision.publishArtifact(type, id), label, opts.warn);
  };

  // ...but not past the app's own publish. Live-measured: when a table's EXISTING form is saved, a PublishXml that
  // names only the app (`<appmodules>`), sent before the table's own publish, leaves the form's LABEL changes
  // unpublished for good. The cell and section labels keep their published text through every later publish of
  // the table, alone or in one envelope with the app; the structure saved with them (a cell's showlabel) does go
  // live. The unpublished layer still holds the new text, so a re-run finds nothing to push and cannot repair it.
  // Publishing the table first, or in the same envelope as the app, leaves the labels live. So does a web resource's
  // or another table's publish in between.
  //
  // 2.13.0 published each reconciled view and form right after its push, so its app publishes always came after.
  // Deferring that publish to phase 8 put the app's own publishes in between: the sitemap finalize on every rebuild of
  // an existing app, the create of a new app (its push publishes it) and the hidden-table pin after that create. A
  // form relabel the reconcile makes (a lookup cell that showed its column's logical name, a section the spec
  // renames) was then saved, reported, and never shown. So the app step publishes these tables, in one envelope,
  // before it writes the app; a view description the reconcile writes is a label too and goes out with them. Every
  // reconcile has run by then, and nothing before that step publishes the app: the command and dashboard steps publish
  // nothing, and the app icon publishes only its web resource. Phase 8 still publishes these tables with everything
  // else. The default views the enrichment (4b) saved stay owed to phase 8 alone as far as THIS publish goes: it re-saves
  // their columns on every build, never a label, so their table waits for phase 8 (and is published earlier only if the app holds, or this build's
  // write of it adds, a form or chart of it: publishTablesBeforeApp), not here.
  // This is the SDK's publish of the reconciled tables: publishTablesBeforeApp sends them by name, with the other tables it publishes before the
  // app, when it can, and comes here when that request is refused and when there is no raw client.
  const publishReconciledTables = async () => {
    const targets = [...reconciledTables].map((logical) => owed.tables.get(logical)).filter(Boolean);
    reconciledTables.clear();
    if (!targets.length) return;
    const { failed } = await publishTargets(provision, runner, concurrency, targets, null, opts.warn);
    if (!failed.length) return;
    // A table whose publish the SDK refused (by value: it never throws for one) still holds its saved labels
    // unpublished, and the app's publish below would strand them for good — so the build stops before it writes the
    // app. Nothing is lost: the halt carries every table this run owes (runSdkBuild), the CLI re-runs a transient
    // refusal at once, and once no retry follows it publishes them without the app (settleOwedPublishes).
    throw reconciledPublishHalt(failed);
  };

  // ...and the tables the app is PROVEN to hold a form or chart of, and the charts this run wrote. The measured strand follows from the order of the
  // publishes, not from who saved the label. The app's publish ships the forms it holds, so a label a maker saved in Maker and never published on one
  // of them can be held back the same way by the app's publish — the sitemap finalize of every rebuild of an existing app, the create of a new one, the
  // hidden-table pin. The chart is the case 2.13.0 left unmeasured: its description is a PATCH of the saved row, made in the charts phase, and was
  // published only with phase 8, after the app's own publish; whether the platform holds that text back as it holds a form's labels was not measured,
  // so the table of a chart this run wrote is published before the app too. So the app step publishes, in ONE PublishXml before it writes the app, the
  // tables the reconcile published, the tables of the charts this run wrote, and the tables whose forms or charts the app holds once this build has
  // written it: those its component list on the server proves it holds (readAppFormChartTables), whether or not the spec names the table, and those whose
  // Main forms the build's own write of the app adds (appPushTables: the tables of the Entity entries of the navigation that write SENDS, which the SDK expands when it writes the app) — the forms
  // of the second kind are not in the component list yet, so no read could prove them, and an existing form that is live with a label saved and not
  // published would be pinned and published by this very write: the same strand, inside one build (preAppTables).
  // Only a form or chart the app holds, or is about to hold, counts, because a table's publish ships everything saved on it, whoever saved it: naming a
  // table the app is not known to hold a form of would release a maker's unfinished work there, for a protection it does not need. So not a table that is
  // only declared, nor the target of a lookup column, nor one only a page reads (the pages phase pins its default VIEW, which is no form or chart), nor one
  // that only `app.tables` pins (a table component: the SDK expands no form of it). The components are read for an EXISTING app, on every build that
  // publishes: a new app has nothing on the server to read, and what it is created with are the forms and charts this build creates or reconciles,
  // which are covered above, and the Main forms its own write adds. The read is complete or it does not count — a component the lookup cannot place, or
  // places ambiguously, and a row of the component list that cannot be placed, make it unreadable — and then the request names what the build changed and what its write
  // of the app adds, and the build says which proof failed (describeUnreadAppComponents). A write adds Main forms only when it PUSHES the app through the SDK, and then those of the
  // tables of the navigation IT sends, which is not always the spec's, so each writer says which tables its write adds forms of (`addedTables`): the spec's navigation for the writers that write
  // the spec's app (the create, the app step's push and the pages finalizer's: appWriteTables); the navigation the SERVER holds for the placement of a default view the app lost, which fetches
  // the app and pushes what it fetched, and tells the hook what it sends (genpage-sdk.js placeInApp: only it knows, and a changed-only re-upload of a page rewrites no navigation, so a
  // maker's changes in the designer stand); and the workspace copy's, which is the server's, for the push that only carries the routing description. A write that only publishes the app adds
  // none. The spec's navigation is never used for a write that does not send it: it would publish, for nothing, a table a maker took out of the app, and leave to strand the form its push adds
  // of one the navigation now names.
  // That one request takes the place of the reconciled tables' envelope, so a build that reconciled something (every rebuild of an app whose
  // views or forms exist) sends the publishes it always did, and a build that reconciled nothing (a first build) sends one more (four one-table
  // publishes took 10-19 s, one envelope 3.6-3.8 s, as the SDK measured).
  //
  // EVERY write of the app asks for it (appWriters, below), and each asks for what ITS write needs: a build whose app step has made the request sends nothing more, because the
  // later writers add only the tables it did not name, which on a full build is none; a run that reaches the app by another writer first — the changed-only re-upload of a page
  // that has to pin a view the app lost has no app step at all — makes the request there, before that writer's first write. The tables a request named are remembered even when it
  // was refused: the refusal is said once, and a later writer does not send the same request again. Concurrent writers cannot interleave (`beforeApp` runs them one after the other).
  //
  // By name through the raw client rather than the SDK's artifact publish, which names a table only through a form, view or chart that
  // the SDK's workspace holds, and a table nothing in the spec saves has none (publishTablesXml; the lookup-label repair does the same).
  // It is the request the SDK's envelope sends for tables. What it does not do is re-baseline the workspace copies of the views and forms
  // it publishes (the SDK does, so that a push after a publish is not refused as stale): nothing pushes one again in this run, and the
  // next run fetches each one before it edits it. If the request is refused, nothing is assumed published: the reconciled tables go
  // through the SDK as before, so a refusal of THEIRS still stops the build before the app, and the others — what this build saved on them, and
  // what other people saved — only get a warning that says the protection did not apply and what that leaves open (describePreAppRefusal).
  // Stopping every build over a table it did not change would be out of proportion, and the client has already re-sent a throttled request.
  // Only with --publish: without it nothing here publishes a table the build did not change, as `--publish` gates the bulk publish; and an
  // SDK with no raw client (a test double) publishes the reconciled tables as before. The gate is the flag and not the publish phase: a run that does not have the
  // phase (the changed-only re-upload of a page) and still writes the app is protected when it was asked to publish. It is checked FIRST: what a write adds (`addedTables`, a function
  // for that reason) is worked out only once the request is going to be made, so a run that does not publish prepares nothing for it — and a writer that applies none of the spec's
  // `app.mainForms` list never looks its names up, which would fail a repair over a form renamed on the server that the repair has no use for.
  const namedBeforeApp = new Set();
  let appHolds; // what the app holds, read by the first writer that finds the app on the server: { tables, forms }, or {} when it could not be read or there was nothing to read
  let beforeApp = Promise.resolve();
  const publishTablesBeforeApp = (existingAppId, { addedTables } = {}) => {
    const run = beforeApp.then(async () => {
      const reconciled = new Set(reconciledTables);
      const client = provision.dataverse;
      if (!publish || !client || typeof client.post !== 'function') return publishReconciledTables();
      const added = (typeof addedTables === 'function' && await addedTables()) || [];
      if (!appHolds) {
        appHolds = {};
        if (existingAppId) {
          const read = await readAppFormChartTables(provision, existingAppId);
          if (read.ok) appHolds = { tables: read.tables, forms: read.forms };
          else if (typeof opts.warn === 'function') opts.warn(describeUnreadAppComponents({ reason: read.reason, added }));
        }
      }
      const wanted = preAppTables({ reconciled, charted: [...chartsToPublish.keys()], added, held: appHolds.tables });
      const tables = wanted.filter((logical) => !namedBeforeApp.has(logical));
      const outcome = await publishTablesXml(client, tables);
      for (const logical of tables) namedBeforeApp.add(logical);
      if (outcome.ok) {
        reconciledTables.clear();
        return undefined;
      }
      await publishReconciledTables();
      const unprotected = tables.filter((logical) => !reconciled.has(logical));
      if (unprotected.length && typeof opts.warn === 'function') {
        opts.warn(describePreAppRefusal({ reason: outcome.reason, tables: unprotected, saved: savedOnTable, described: describedCharts, forms: appHolds.forms, added }));
      }
      return undefined;
    });
    // A failed request (a refused publish of the reconciled tables halts the build) must not poison the chain for the writer that comes after the halt is handled.
    beforeApp = run.catch(() => undefined);
    return run;
  };

  // The ONLY ways the build pushes or publishes the app. Each first awaits publishTablesBeforeApp, so no write of the app can come ahead of the tables whose forms and charts the
  // app's publish ships; a path that called the SDK for the app directly would skip it, which is why the engine makes no such call anywhere else (the contract test in
  // publish-scope-real-bundle.test.js reads this file and fails on one). Each says which tables' Main forms ITS write adds (`addedTables`), from the navigation it sends.
  // Only the create and the push write the spec's app, and so apply the spec's Main-form list (resolvedMainForms: the names are looked up, once); a publish and the placement apply none,
  // and look nothing up.
  // The publish phase publishes the app in the same envelope as the tables the build has artifacts of, and asks for the request too, because a run can reach that phase without the app step.
  const appWriters = {
    // The SDK's create of a new app: it sends the spec's navigation, adds the active Main forms of its tables and publishes the app by the push that makes it. Answers the push.
    async create(def) {
      await publishTablesBeforeApp(undefined, { addedTables: async () => appWriteTables(spec, await resolvedMainForms()) });
      const art = await provision.createArtifact('app', def);
      return provision.pushArtifact('app', art.id);
    },
    // A push of an existing app: the SDK adds the Main forms of the tables of the navigation it sends on every one, whatever it changes. The app step's and the finalizer's write the spec's
    // navigation into the workspace copy before they push it. The push that only carries the routing description writes none (`resendsCopy`): it re-sends the workspace copy's, which is the
    // server's, so the tables are those that navigation names, read when the push is about to be made. The spec's Main-form list is applied to either (pushAppHeader).
    async push(appId, name, headerChanged, { resendsCopy = false } = {}) {
      const mainFormsByTable = await resolvedMainForms();
      await publishTablesBeforeApp(appId, {
        addedTables: async () => (resendsCopy
          ? appPushTables(entityTablesOfSiteMap(((await provision.getArtifact('app', appId)) || {}).siteMap), mainFormsByTable)
          : appWriteTables(spec, mainFormsByTable)),
      });
      return pushAppHeader(provision, appId, name, headerChanged, mainFormsByTable, opts.warn);
    },
    // The publish of an app: it ships the forms the app holds, whoever last saved them. It adds none.
    async publish(appId) {
      await publishTablesBeforeApp(appId);
      return provision.publishArtifact('app', appId);
    },
    // The publish of the app that makes the table components pinned after its create live.
    async publishPinned(appId) {
      await publishTablesBeforeApp(appId);
      return publishAppComponents(provision.dataverse, appId);
    },
    // The page backend's placement of default views: it reads the app, and pushes and publishes it by itself only when it finds a view to pin, so it is handed the request to await
    // right before its first write, and a placement that finds nothing to pin sends nothing and asks for nothing. It pushes the app as the server holds it, not the spec's navigation,
    // so it tells the request what it sends (`write`: whether it pushes, the tables whose Main forms that push adds and the Main-form list it carries), and a backend that
    // tells nothing is taken to add no form. The page backend's own push is limited to the views it pins (lib/app-component-scope.js), so it adds no Main form and names no table.
    placeViews(genpage, appId, options) {
      return genpage.placeInApp(appId, {
        ...options,
        beforeAppWrite: async (write) => publishTablesBeforeApp(appId, { addedTables: () => (write && write.pushes ? appPushTables(write.entityTables, write.mainFormsByTable) : []) }),
      });
    },
  };

  // The names of what this run CREATED on each table (`view Open Tickets`, `form Ticket`, `chart By Area`), and of a
  // chart whose description it wrote — labels only. A created artifact is as unpublished as a reconciled one, but a
  // create defers no publish into `owed.tables` (only the reconcile, event-wiring and quick-view paths and the
  // default-view enrichment do), so on a first build a table's record held no more than what those left (its default
  // views, a quick view's placement, a form's event wiring) and a failed publish read as if only those were not live.
  // These names deliberately stay OUT of `owed.tables`: that record is what a halted build publishes, and a created
  // artifact in it would make a halt publish tables it has never published. Phase 8 reads them (forTable) to
  // complete the label of the table's one publish; no request, read or write depends on them.
  const savedOnTable = new Map();
  const noteSaved = (entityLogical, name) => {
    const logical = String(entityLogical || '').toLowerCase();
    if (!logical) return;
    if (!savedOnTable.has(logical)) savedOnTable.set(logical, new Set());
    savedOnTable.get(logical).add(name);
  };
  // The charts whose DESCRIPTION this run wrote, by table: a PATCH of the saved row, which only a publish of its table makes live. `savedOnTable` names
  // such a chart `chart <name>`, the same as one this run created; the warning for a refused pre-app publish (describePreAppRefusal) says which it was.
  const describedCharts = new Map();
  const noteDescribed = (entityLogical, name) => {
    const logical = String(entityLogical || '').toLowerCase();
    if (!logical) return;
    if (!describedCharts.has(logical)) describedCharts.set(logical, new Set());
    describedCharts.get(logical).add(name);
  };

  // 1. Solution (idempotent; header-less provisioning client).
  if (has('solution')) await provisionSolution({ sdk, provision, runner, solution: sol });

  // 2. Data model — idempotent. Discover existing tables/columns/relationships via the SDK
  //    (find*/fetch*), then create only what's missing. Captures entitySetName for every
  //    entity (fresh -> createTable result, existing -> findTables hit).
  let dataModel = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [], lookupLabels: {} };
  if (has('data-model')) {
    dataModel = await provisionDataModel({ sdk, provision, runner, spec, apply, languageCode: opts.languageCode, warn: opts.warn, provisionedLanguages: opts.provisionedLanguages, preResolvedLanguageCode: opts.preResolvedLanguageCode, reconcileLookupLabels: true, owedLengths: owed.lengths });
    Object.assign(result.created.entities, dataModel.entities);
  }

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetFor = makeEntitySetResolver({ spec, entities: dataModel.entities, provision });

  // 3. Sample data (opt-in): topological, $parent -> @odata.bind on the lookup nav prop.
  if (has('sample-data') && sampleData) {
    const sd = await provisionSampleData({ sdk, provision, runner, spec, dataModel });
    Object.assign(result.created.records, sd.records);
  }

  // 3b. Web resources (opt-in via spec.webResources) — JS/HTML/CSS shipped for form logic.
  //     Idempotent: an existing web resource of the same name is reused (and assumed already
  //     in the solution). Built before forms so a form event handler can bind its library.
  //     One that an earlier run of this build created or wrote and could not confirm was published (WEB_RESOURCE_UNVERIFIED,
  //     recorded in the workspace) is not reused: its content is written again by id (writeOwnedWebResource).
  //     The reuse writes nothing — the phase is discover-then-skip, like charts, command bars and dashboards, whose lines say their
  //     edits are not applied — but it is not silent about the content: the row's deployed (published) content is read with its id and
  //     compared with what the spec would write (webResourceContentState), and a difference is said in the skip line and as a warning.
  //     An `external` web resource is a shared one the build reuses as it finds it, so its content is not the spec's to compare.
  if (has('web-resources')) {
    for (const wr of spec.webResources || []) {
      const recordedId = unconfirmedWebResources.idOf(wr.name);
      if (recordedId) {
        await runner.run('web-resources', `web resource ${wr.name} (${wr.type || 'js'}) (written again: its publication was not confirmed)`, async () => {
          await keepRowOf(() => writeOwnedWebResource(provision, unconfirmedWebResources, sol, webResourceOpts(wr, opts.appDir), recordedId), (id) => { result.created.webResources[wr.name] = id; });
        });
        continue;
      }
      // The row as a plain read answers it (its published layer):
      //   GET /webresourceset?$select=webresourceid,content&$filter=name eq 'contoso_/scripts/form.js'&$top=1
      //   { "value": [ { "webresourceid": "…", "content": "dmFyIEZvcm0gPSB7…" } ] }
      const existing = await provision.queryRecords('webresource', { select: ['webresourceid', 'content'], filter: `name eq '${odataLit(wr.name)}'`, top: 1 });
      if (existing && existing[0] && existing[0].webresourceid) {
        result.created.webResources[wr.name] = existing[0].webresourceid;
        const compared = wr.external === true ? null : webResourceContentState(wr, opts.appDir, existing[0].content);
        if (compared && compared.state === 'differs') {
          runner.skip('web-resources', `web resource ${wr.name} (exists — reuse; its deployed content differs from the spec's: content edits aren't applied on rebuild, recreate to change)`);
          if (typeof opts.warn === 'function') {
            opts.warn(`web resource ${wr.name}: its deployed content differs from the spec's and is left as it is — a rebuild does not write the content of a web resource that exists; delete it (or tear the app down) and build again to deploy the spec's content`);
          }
        } else if (compared && compared.state === 'unknown') {
          runner.skip('web-resources', `web resource ${wr.name} (exists — reuse; its content was not compared: ${compared.reason})`);
        } else {
          runner.skip('web-resources', `web resource ${wr.name} (exists — reuse)`);
        }
        continue;
      }
      await runner.run('web-resources', `web resource ${wr.name} (${wr.type || 'js'})`, async () => {
        await keepRowOf(() => writeOwnedWebResource(provision, unconfirmedWebResources, sol, webResourceOpts(wr, opts.appDir)), (id) => { result.created.webResources[wr.name] = id; });
      });
    }
    // 3c. Table icons — set each entity's OWN icon to a declared web resource (SVG -> IconVectorName
    //     for the modern designer/nav; raster -> IconMediumName). Runs here (after web resources
    //     exist) so the referenced web resource is present + published before we point the table at
    //     it. Skipped for a table not built/reused this run, or an icon whose web resource wasn't
    //     created/reused (e.g. its phase was skipped) — with a clear message rather than a hard fail.
    const builtWrNames = new Set(Object.keys(result.created.webResources).map((n) => n.toLowerCase()));
    for (const e of spec.entities || []) {
      if (!e.icon && !e.vectorIcon) continue;
      const logical = e.schemaName.toLowerCase();
      if (!result.created.entities[logical] && !result.created.entities[e.schemaName]) {
        runner.skip('web-resources', `table icon for ${logical} (table not built this run)`);
        continue;
      }
      const missing = [e.vectorIcon, e.icon].filter((n) => n && !builtWrNames.has(String(n).toLowerCase()));
      if (missing.length) {
        runner.skip('web-resources', `table icon for ${logical} (web resource ${missing.join(', ')} not built this run)`);
        continue;
      }
      // A failed publish can leave this name in saved metadata already. Keep the SDK's
      // specific-table publish on rerun; metadata equality is not publication proof.
      await runner.run('web-resources', `table icon for ${logical}`, async () => {
        await provision.setEntityIcon(logical, { vector: e.vectorIcon || undefined, medium: e.icon || undefined });
        return `${[e.vectorIcon && `vector=${e.vectorIcon}`, e.icon && `raster=${e.icon}`].filter(Boolean).join(', ')}`;
      });
    }
  }

  // --- Form authoring via the SDK's generic surface (addElement/updateElement/removeElement) -------
  // The new SDK removed the per-artifact form mutators; a form is built as canonical intent
  // (./artifact-intent.js) and applied through the generic surface.
  //
  // EVERY read/mutate call below is awaited because the SDK's generic surface is ASYNC as of the
  // upstream "300s cache staleness with async revalidating reads" change: getArtifact, addElement,
  // updateElement, removeElement, moveElement, findElements and queryTree all return Promises now
  // (a read may re-fetch from the server before serving a cached copy). Dropping an `await` here
  // does NOT throw — a Promise is truthy, so the `|| {}` fallbacks stay dormant and the pure
  // helpers below silently see a Promise instead of an artifact (hasSubgrid -> false -> duplicate
  // sub-grid; findFieldCellPointer -> null -> the field is never pruned). That silence is why
  // scripts/tests/sdk-async-surface.test.js scans this file for bare calls.

  // Create a NEW form body: create a MINIMAL form (the adapter seeds one default tab), append each
  // compiled tab (addElement recursively mints cell/section/tab ids — updateElement does NOT, so a
  // coarse whole-tab insert is the adapter-blessed path), then drop the seed tab at index 0. Every
  // intermediate state keeps >=1 tab, so the structural validator never rejects an empty form.
  const createFormShell = async (def) => {
    // `description` is new on forms in this SDK uptake (dashboards, rows in the same systemform
    // table, always had it). Passed only when the spec sets one: omitted on push it is not written,
    // so an existing server-side description survives an edit that did not set one.
    const art = await provision.createArtifact('form', { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status, ...(def.description ? { description: def.description } : {}) });
    const tabs = def.tabs || [];
    // Sequential (not Promise.all): tab ORDER is the on-form order, and addElement appends.
    for (const tab of tabs) await provision.addElement('form', art.id, '/tabs', tab);
    // Drop the adapter's seed tab (my tabs were appended after it) — but ONLY if I actually added at
    // least one tab, so a degenerate spec with an empty `tabs: []` still leaves the valid seed tab
    // rather than a tab-less form the designer can't open.
    if (tabs.length > 0) await provision.removeElement('form', art.id, '/tabs/0');
    return art.id;
  };

  const normClassId = (id) => String(id || '').replace(/[{}]/g, '').toUpperCase();

  // A form hosts at most one sub-grid per relationship, so a sub-grid's semantic identity is its
  // RelationshipName. Scan the fetched form's controls so a rebuild does not splice a duplicate.
  const hasSubgrid = (formJson, relationshipName) => {
    for (const t of formJson.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const ctrl = c.control;
      if (ctrl && normClassId(ctrl.classId) === SUBGRID_CLASS_ID && ctrl.parameters && ctrl.parameters.RelationshipName === relationshipName) return true;
    }
    return false;
  };

  // Add each sub-grid to the form in its OWN full-width (1-column) section (#5), skipping any already
  // present (idempotent rebuild). Re-reads the form between adds so the sections pointer stays valid.
  // A sub-grid used to be spliced as a single cell into the first field section's rows, which rendered
  // it half-width inside a 2-column section; giving it a dedicated section makes the related list span
  // the form. `sg.label` is already resolved to the child's display name by the forms phase.
  //
  // A grid that declares no placement (`tab` / `column` / `after` / `before`) goes where it always has: the end
  // of the first tab's first form-column, and is never moved. One that does is put where it says, and a rebuild
  // CONVERGES it there — see placeGridSection below. `ctx` carries what the topology pass
  // resolved on an existing explicit layout ({ topology, sectionTargets }); a form this run created, or an auto
  // layout, has none and resolves the layout's names on the form itself.
  //
  // The order the grids are placed in matters. Those that name no anchor (no key, or a tab only) are appended to
  // the end of their column first, in declared order, as they always were. The anchored ones follow, each put
  // DIRECTLY beside the nearest token toward its anchor that is on the form already: `after` grids in declared
  // order, so a grid sharing an anchor with an earlier one lands after it; `before` grids in REVERSE declared
  // order, so the one declared last sits against the anchor and the earlier ones in front of it.
  const addSubgrids = async (formId, def, ctx) => {
    const subs = def.__subgrids || [];
    // The anchored grids of each layout form-column, in declared order: what a column's sequence is built from.
    const groups = new Map();
    for (const sg of subs) {
      const resolved = sg.placement && sg.placement.resolved;
      if (!resolved || !resolved.anchor) continue;
      const key = `${resolved.tabIndex}:${resolved.columnIndex}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ key: String(sg.relationshipName).toLowerCase(), [resolved.anchor.side]: resolved.anchor.name });
    }
    const sideOf = (sg) => (sg.placement && sg.placement.resolved.anchor ? sg.placement.resolved.anchor.side : null);
    for (const sg of subs) {
      if (sideOf(sg)) continue;
      if (sg.placement) {
        await placeGridSection(formId, def, sg, groups, ctx);
        continue;
      }
      if (hasSubgrid(await provision.getArtifact('form', formId) || {}, sg.relationshipName)) continue;
      const sectionsPtr = firstColumnSectionsPointer(await provision.getArtifact('form', formId) || {});
      if (!sectionsPtr) continue;
      await provision.addElement('form', formId, sectionsPtr, subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label }));
    }
    for (const sg of subs.filter((s) => sideOf(s) === 'after')) await placeGridSection(formId, def, sg, groups, ctx);
    for (const sg of subs.filter((s) => sideOf(s) === 'before').reverse()) await placeGridSection(formId, def, sg, groups, ctx);
  };

  // --- sub-grid placement (lib/form-subgrid-placement.js) ------------------------------------------------

  const columnAtPointer = (form, pointer) => {
    const t = String(pointer || '').split('/').filter(Boolean);
    if (t.length !== 4) return null;
    const tab = (form.tabs || [])[Number(t[1])];
    return (tab && (tab.columns || [])[Number(t[3])]) || null;
  };
  const columnPointerOfSection = (pointer) => String(pointer).replace(/\/sections\/\d+$/, '');
  // `/tabs/<ti>/columns/<ci>` → the two indices, for naming the tab and form-column in a report.
  const columnIndicesOf = (columnPointer) => {
    const t = String(columnPointer).split('/').filter(Boolean);
    return { ti: Number(t[1]), ci: Number(t[3]) };
  };
  const tabNameAt = (form, ti) => ((form.tabs || [])[ti] || {}).name || `#${ti + 1}`;

  // The section a form holds a relationship's sub-grid control in, with its pointers (lib/form-subgrid-placement.js
  // finds it; `engine` says the build owns it). A grid a maker put in a section of their own is found too, but it
  // is not the build's to move.
  const findGridSection = (form, relationshipName) => {
    const hit = findSubgridSection(form.tabs, relationshipName);
    if (!hit) return null;
    const columnPointer = `/tabs/${hit.ti}/columns/${hit.ci}`;
    return Object.assign(hit, { columnPointer, listPointer: `${columnPointer}/sections`, pointer: `${columnPointer}/sections/${hit.si}` });
  };

  // The recorded section targets address sections by index, so adding a section to a column pushes the ones after
  // it up and taking one out pulls them down. Corrected here, so the prune and the vacated-section sweep that
  // run after the sub-grids still resolve every section the topology pass gave them.
  const shiftSectionTargets = (targets, listPointer, index, delta) => {
    for (const t of Object.values(targets || {})) {
      const m = t && /^(.*\/sections)\/(\d+)$/.exec(String(t.pointer || ''));
      if (!m || m[1] !== listPointer) continue;
      const at = Number(m[2]);
      if (delta > 0 ? at >= index : at > index) t.pointer = `${listPointer}/${at + delta}`;
    }
  };

  // Where the layout's tab `wantTabIndex` is on the live form: the index the topology pass matched it to on an
  // explicit layout, else the tab of that name (a form this run created has its tabs where the compiler put them;
  // an auto layout's only tab is `tab_general`). -1 when it cannot be found.
  const deployedTabIndex = (form, def, wantTabIndex, ctx) => {
    if (ctx && ctx.topology) {
      const matched = ctx.topology.tabIndexOf[wantTabIndex];
      return Number.isInteger(matched) && (form.tabs || [])[matched] ? matched : -1;
    }
    const name = ((def.__subgridLayout || [])[wantTabIndex] || {}).name;
    return (form.tabs || []).findIndex((t) => String((t && t.name) || '').toLowerCase() === name);
  };

  // The live section a layout section name stands for: the section the topology pass matched it to — which can
  // carry another name, matched by label or position — else the section of that name, never an engine host that
  // shares it. `{ pointer, section }`, or null.
  const deployedSectionByName = (form, name, ctx) => {
    const targets = ctx && ctx.sectionTargets;
    const key = targets ? Object.keys(targets).find((k) => k.toLowerCase() === name) : undefined;
    if (key !== undefined) {
      const pointer = resolveSectionPointer(form, targets[key]);
      const section = pointer && sectionAt(form, pointer);
      if (section) return { pointer, section };
    }
    const loc = findSectionLocation(form, name, (s) => !isEngineHostSection(s));
    return loc ? { pointer: loc.pointer, section: loc.section } : null;
  };

  // The form-column a placed grid belongs in on the live form — where its anchor is, or the tab (and column) it
  // names — or null when the layout name it is placed by cannot be found there.
  const gridDestination = (form, def, sg, ctx) => {
    const resolved = sg.placement.resolved;
    if (resolved.anchor) {
      const at = deployedSectionByName(form, resolved.anchor.name, ctx);
      return at ? { columnPointer: columnPointerOfSection(at.pointer), anchored: true } : null;
    }
    const ti = deployedTabIndex(form, def, resolved.tabIndex, ctx);
    if (ti < 0) return null;
    const ci = resolved.createColumn;
    if (!((form.tabs[ti].columns || [])[ci])) return null;
    return { columnPointer: `/tabs/${ti}/columns/${ci}`, tabIndex: ti, anyColumn: resolved.columnIndex === undefined, anchored: false };
  };

  // The live index, in the column at `columnPointer`, of one token of a column's sequence — a section of the
  // layout or an engine grid section — or undefined when it is not in that column.
  const tokenIndexIn = (form, columnPointer, token, ctx) => {
    if (token.grid !== undefined) {
      const hit = findGridSection(form, token.grid);
      return hit && hit.engine && hit.columnPointer === columnPointer ? hit.si : undefined;
    }
    const at = deployedSectionByName(form, token.section, ctx);
    if (!at || columnPointerOfSection(at.pointer) !== columnPointer) return undefined;
    return Number(at.pointer.slice(at.pointer.lastIndexOf('/') + 1));
  };

  // The column's sequence of layout sections and anchored grids (columnSequence) for the layout column a placed
  // grid is anchored in.
  const gridSequence = (def, resolved, groups) => {
    const column = ((def.__subgridLayout || [])[resolved.tabIndex] || { columns: [] }).columns[resolved.columnIndex] || { sections: [] };
    return columnSequence(column.sections, groups.get(`${resolved.tabIndex}:${resolved.columnIndex}`) || []);
  };

  // Where an ANCHORED grid goes in its column right now: DIRECTLY beside the nearest token of its sequence toward
  // its anchor that is already in the column (neighbourOf) — right after it for an `after` grid, right before it
  // for a `before` grid. `gap` is the insertion point in the column as it stands, i.e. the index the grid would
  // be inserted before. That is where a fresh build puts the grid, so a rebuilt form and a new one agree.
  const anchoredPosition = (form, columnPointer, seq, gridKey, ctx) => {
    const near = neighbourOf(seq, gridKey, (token) => tokenIndexIn(form, columnPointer, token, ctx) !== undefined);
    if (!near) return null;
    const refIndex = tokenIndexIn(form, columnPointer, near.token, ctx);
    return { side: near.side, token: near.token, refIndex, gap: near.side === 'after' ? refIndex + 1 : refIndex };
  };

  // Put ONE placed grid where the spec says: add its section when it has none, and when the build's own section
  // for it is somewhere else — the end of the first tab, where an earlier build appended it, behind the Notes
  // section, in another form-column — MOVE that same section: its id, its control, anything a maker set on it
  // travel with it. An anchored grid ends DIRECTLY beside its anchor (anchoredPosition); a grid that names only a
  // tab (and column) is put at the end of that column and, once in it, left where it is.
  //
  // Only the grid moves. The fewest-moves planner the topology pass orders sections with (planOrderMoves) is NOT
  // used here because it moves whichever section is cheapest — and where the Notes section sits between the
  // anchor and a grid an older build appended after it, that is the authored section or the timeline, leaving the
  // Notes section in the middle of the form. What a placement never does: touch a grid in a section the build did
  // not create, or move one the spec does not place.
  const placeGridSection = async (formId, def, sg, groups, ctx) => {
    const form = await provision.getArtifact('form', formId) || {};
    const existing = findGridSection(form, sg.relationshipName);
    const dest = gridDestination(form, def, sg, ctx);
    const warn = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
    const shown = `the sub-grid for '${sg.targetEntity}'`;
    if (!dest) {
      // The tab or section the layout names is not on this form — the spec gate cannot see a deployed form. The
      // grid is still added where it always goes, so it is never lost to an unresolvable placement.
      const r = sg.placement.resolved;
      reportLayoutSkip(`form ${def.name}: ${shown} was not placed ${r.anchor ? `${r.anchor.side} section '${r.anchor.name}'` : `in tab '${(def.__subgridLayout[r.tabIndex] || {}).name}'`}`
        + ' — the deployed form has no such section or tab to place it by'
        + `${existing ? '; it stays where it is' : ', so it was added at the end of the first tab'}. Adjust the layout in the maker.`);
      if (existing) return;
      const sectionsPtr = firstColumnSectionsPointer(form);
      if (sectionsPtr) await provision.addElement('form', formId, sectionsPtr, subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label }));
      return;
    }
    const listPointer = `${dest.columnPointer}/sections`;
    const sectionCount = ((columnAtPointer(form, dest.columnPointer) || {}).sections || []).length;
    const resolved = sg.placement.resolved;
    const seq = dest.anchored ? gridSequence(def, resolved, groups) : null;
    const gridKey = String(sg.relationshipName).toLowerCase();
    const position = dest.anchored ? anchoredPosition(form, dest.columnPointer, seq, gridKey, ctx) : null;
    // The insertion point as the column stands now: beside the neighbour for an anchored grid, the end otherwise.
    const gap = position ? position.gap : sectionCount;
    const to = columnIndicesOf(dest.columnPointer);
    const where = `tab '${tabNameAt(form, to.ti)}' (form-column ${to.ci + 1})`;
    if (existing) {
      const name = existing.section.name || `#${existing.si + 1}`;
      const sameColumn = existing.listPointer === listPointer;
      // Already where the spec puts it — directly beside its neighbour, or in the tab (and form-column) it names:
      // nothing to write, and nothing to report either. The report below is advice for a grid that is NOT in place
      // ("move that section"); one that already is has nothing to move, and a notice that repeats on every rebuild
      // is one a maker learns to ignore.
      const inPlace = dest.anchored
        ? !!position && sameColumn && existing.si === (position.side === 'after' ? position.refIndex + 1 : position.refIndex - 1)
        : (dest.anyColumn ? existing.ti === dest.tabIndex : existing.columnPointer === dest.columnPointer);
      if (inPlace) return;
      if (!existing.engine) {
        reportLayoutSkip(`form ${def.name}: ${shown} sits in section '${name}', which this build did not create, `
          + 'so it was left there. Move that section in the maker, or delete it to let the build place a grid of its own.');
        return;
      }
      // moveElement removes the section before it inserts, so within one column an insertion point below the
      // section's own index is one lower once it has gone.
      const index = sameColumn && existing.si < gap ? gap - 1 : gap;
      await provision.moveElement('form', formId, existing.pointer, listPointer, { index });
      shiftSectionTargets(ctx && ctx.sectionTargets, existing.listPointer, existing.si, -1);
      shiftSectionTargets(ctx && ctx.sectionTargets, listPointer, index, 1);
      const from = `from tab '${tabNameAt(form, existing.ti)}' (form-column ${existing.ci + 1}) `;
      if (position) {
        const next = position.token.section !== undefined ? `section '${position.token.section}'`
          : `the sub-grid for '${((def.__subgrids || []).find((s) => String(s.relationshipName).toLowerCase() === position.token.grid) || {}).targetEntity || position.token.grid}'`;
        warn(`form ${def.name}: moved ${shown} (section '${name}') ${sameColumn ? '' : from}to sit directly ${position.side} ${next}, in ${where}, where subgrids[] places it.`);
      } else {
        warn(`form ${def.name}: moved ${shown} (section '${name}') ${from}to ${where}, where subgrids[] places it.`);
      }
      return;
    }
    const intent = subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label });
    if (!dest.anchored) {
      // The end of the column: appended, so no recorded section moves.
      await provision.addElement('form', formId, listPointer, intent);
      return;
    }
    await provision.addElement('form', formId, listPointer, intent, { position: { index: gap } });
    shiftSectionTargets(ctx && ctx.sectionTargets, listPointer, gap, 1);
  };

  // A quick-view's semantic identity is the lookup field it renders through (one quick-view per lookup).
  const hasQuickView = (formJson, lookupFieldName) => {
    for (const t of formJson.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const ctrl = c.control;
      if (ctrl && normClassId(ctrl.classId) === QUICK_VIEW_CLASS_ID && String(ctrl.fieldName || '').toLowerCase() === String(lookupFieldName).toLowerCase()) return true;
    }
    return false;
  };

  // Wire onload/onsave/onchange handlers into the form's root-bag <events> region. First build: the
  // region doesn't exist -> add it whole. Rebuild: MERGE (append only handlers not already present,
  // keyed by event+function+library) so a re-run never duplicates a handler or appends a second
  // <events> root. The adapter mints each handlerUniqueId at serialize (we omit it).
  const wireFormEvents = async (formId, events) => {
    const wanted = (events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
    if (!wanted.length) return false;
    const form = await provision.getArtifact('form', formId) || {};
    const bagC = (form.bag && form.bag.c) || [];
    const regionIdx = bagC.findIndex((e) => e && e.node && e.node.n === 'events');
    if (regionIdx < 0) {
      const nextI = bagC.reduce((m, e) => Math.max(m, e.i), -1) + 1;
      await provision.addElement('form', formId, '/bag/c', { i: nextI, node: formEventsRegionIntent(wanted) });
      return true;
    }
    // Existing region: append only handlers not already wired.
    const region = bagC[regionIdx].node;
    const attrOf = (node, key) => ((node.a || []).find((a) => a[0] === key) || [])[1];
    const existing = new Set();
    for (const evNode of region.c || []) {
      const handler = (((evNode.c || [])[0] || {}).c || [])[0];
      existing.add(`${attrOf(evNode, 'name')}|${handler && attrOf(handler, 'functionName')}|${handler && attrOf(handler, 'libraryName')}`);
    }
    let added = false;
    for (const ev of wanted) {
      if (existing.has(`${ev.event}|${ev.function}|${ev.library}`)) continue;
      await provision.addElement('form', formId, `/bag/c/${regionIdx}/node/c`, formEventsRegionIntent([ev]).c[0]);
      added = true;
    }
    return added;
  };

  // Fetch a just-created form before wiring its event handlers, tolerating the workspace-metadata
  // race. AB#6688905.
  //
  // `buildArtifact` resolves once the form ROW exists, but the SDK persists the workspace copy as two
  // files — `.maker-workspace/forms/<id>.json` and `.maker-workspace/.metadata/forms/<id>.meta.json`
  // — and `fetchArtifact` reads the metadata one. Under `mapLimit` several forms are written
  // concurrently, and the reporter hit the window between them:
  //   UNKNOWN: unknown error, open '...\.maker-workspace\.metadata\forms\<id>.meta.json'
  // with the sibling `.json` already on disk. `UNKNOWN` (not ENOENT) is what Windows reports for a
  // concurrent-access/sharing violation, which is why this matches on the PATH rather than the code
  // — matching only ENOENT would miss the shape that was actually observed.
  //
  // A retry is the correct remedy rather than a workaround: the reporter's second identical run
  // succeeded, so the state is transient by construction, and the build is idempotent. Bounded and
  // narrow on purpose — a form whose metadata never lands still fails, with a message that names the
  // race instead of the bare `UNKNOWN` the operator could do nothing with.
  //
  // ⚠ THE SDK NOW RETRIES TOO, and this is deliberately kept as a SECOND layer rather than deleted.
  // The vendored `WorkspaceManager` retries `EPERM`/`EACCES`/`EBUSY`/`UNKNOWN` on its own and treats a
  // file deleted between its `exists` probe and its open as absent. Two reasons this outer retry still
  // earns its place: the SDK's authors explicitly decline to call that fix MEASURED (a two-process
  // harness never reproduced the failure, so the trigger is environmental — an AV scanner or indexer
  // holding a handle), and an exhausted SDK budget rethrows the bare `UNKNOWN` unchanged, which is the
  // message the operator could do nothing with. The layering costs nothing on the happy path. Delete
  // this only against evidence that the SDK's budget is sufficient, not merely because it exists.
  const isWorkspaceMetadataRace = (err) => {
    const msg = (err && err.message) || String(err || '');
    return /[\\/]\.metadata[\\/]/.test(msg) && /\.meta\.json/.test(msg);
  };
  const fetchFormForWiring = async (id, f) => {
    const attempts = 4;
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await provision.fetchArtifact('form', id);
      } catch (err) {
        last = err;
        if (!isWorkspaceMetadataRace(err) || i === attempts - 1) break;
        // Linear, not exponential: the writer is a local file flush, so the wait needed is
        // milliseconds — a doubling backoff would spend seconds waiting for something already done.
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    if (isWorkspaceMetadataRace(last)) {
      throw refusal(`form ${f && (f.name || f.entity)}: the workspace metadata for this form was still not readable after ${attempts} attempts `
        + `(${(last && last.message) || last}). The form row itself was created — this is a local workspace write race, not a Dataverse failure. `
        + 'Re-run the same command: the build is idempotent and the metadata will exist on the next run.');
    }
    throw last;
  };

  // Reconcile an EXISTING form to the spec: fetch it, ADD any spec field/sub-grid not already placed
  // (semantic identity = bound fieldName / relationship, so a rebuild never duplicates), PRUNE fields
  // an explicit layout dropped, then push (halt on a 412 conflict), publish, and ensure it's a
  // solution component. This is what makes editing a deployed form actually land.

  // Re-assert `readOnly` / `hidden` on fields already placed on a deployed form.
  //
  // Only the ENABLED state is ever written (`isReadOnly: true`, `visible: false`) — never the
  // negation. A spec that omits the flag means "I am not expressing an opinion", not "make it
  // editable/visible", so blanking here would silently undo a lock or a hide a maker applied in the
  // designer on a field the spec merely happens to list.
  //
  // Consequence, documented rather than worked around: turning a flag back OFF through the spec is
  // not supported — remove the field and let the next build re-add it, or clear it in the designer.
  //
  // EVERY cell of the field is asserted, each on its own. A spec places a field once (the layout gate refuses a
  // second placement), but a deployed form is not bound by that gate: a maker can place the same field in a second
  // section, and a field the spec makes read-only or hidden is so wherever the form shows it. Patching only the
  // first cell left the second one editable or visible. The lookup-label repair walks a field's cells the same way
  // (lookup-cell-labels.js).
  //
  // "Wherever the form shows it" includes the form's HEADER and FOOTER and a tab's own `tabheader` and `tabfooter`, which the SDK does not
  // model: it keeps their XML in the bag of the form (or the tab) and writes it back as it read it (findFieldOuterCells). Those cells are
  // flagged by an edit of the one attribute — the control's `disabled`, the cell's `visible` — and nothing else of the node is touched.
  const applyFieldControlOptions = async (formId, def, want, wantCellByLogical) => {
    for (const logical of want) {
      const wantCell = wantCellByLogical[logical];
      if (!wantCell) continue;
      const wantReadOnly = !!(wantCell.control && wantCell.control.isReadOnly);
      const wantHidden = wantCell.visible === false;
      if (!wantReadOnly && !wantHidden) continue; // nothing asserted for this field
      let form = (await provision.getArtifact('form', formId)) || {};
      const cells = findFieldCellLocations(form, logical).length;
      for (let i = 0; i < cells; i++) {
        // Re-read before every cell after the first: each updateElement rewrites the artifact, and a stale pointer
        // would patch whatever now sits at that index. A patch of a cell's own control or visibility moves no cell,
        // so the i-th cell of the field is still the i-th after the earlier writes.
        if (i > 0) form = (await provision.getArtifact('form', formId)) || {};
        const loc = findFieldCellLocations(form, logical)[i];
        if (!loc) break;
        if (wantReadOnly) await provision.updateElement('form', formId, `${loc.cellPointer}/control`, { isReadOnly: true });
        if (wantHidden) await provision.updateElement('form', formId, loc.cellPointer, { visible: false });
      }
      // The header, the footer and each tab's own: found on the form as read (the body writes above leave the bags as they were), and
      // located again before each write, as the body cells are.
      const outerCells = findFieldOuterCells(form, logical).length;
      for (let i = 0; i < outerCells; i++) {
        form = (await provision.getArtifact('form', formId)) || {};
        const at = findFieldOuterCells(form, logical)[i];
        if (!at) break;
        if (wantReadOnly) await setRawAttribute(formId, at.controlPointer, at.control, 'disabled', 'true', /^(true|1)$/i);
        if (wantHidden) await setRawAttribute(formId, at.cellPointer, at.cell, 'visible', 'false', /^(false|0)$/i);
      }
    }
  };

  // Set one attribute of a RAW node of the form's bag — a header or footer cell or control, whose attributes are `a`, a list of
  // [name, value] pairs in document order (findFieldOuterCells). One the node carries is replaced where it stands, so the others
  // keep their order; one it does not is appended; one that already means the wanted state is not written at all (`already` is
  // every spelling of it: the schema's xs:boolean takes "true"/"1" and "false"/"0").
  // See: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/form-xml-schema
  const setRawAttribute = async (formId, pointer, node, name, value, already) => {
    const pairs = Array.isArray(node.a) ? node.a : null;
    const at = pairs ? pairs.findIndex((pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === name) : -1;
    if (at >= 0) {
      if (already.test(String(pairs[at][1]).trim())) return;
      await provision.updateElement('form', formId, `${pointer}/a/${at}`, [pairs[at][0], value]);
    } else if (pairs) {
      await provision.addElement('form', formId, `${pointer}/a`, [name, value]);
    } else {
      await provision.updateElement('form', formId, pointer, { a: [[name, value]] });
    }
  };

  // ADO 6691205 — repair, on a deployed form, the label an older build gave a lookup cell: only the
  // old default, and only when the spec sets no lookup.displayName (lib/lookup-cell-labels.js applies the rule).
  const repairLookupCellLabelsOn = (formId, def) => repairLookupCellLabels({
    provision, formId, entityLogical: def.entityLogicalName, spec, lookupLabels: dataModel.lookupLabels,
  });

  // Remove the rows a cell's departure left holding nothing: its own row, and the rows its row-span
  // covered. An empty `<row/>` renders as a blank line, and one would accumulate per pruned or
  // relocated field. `strandedRows` keeps a row that a row-spanning cell above still reserves (it is
  // occupied, not empty) and never looks at a row this departure did not touch, so an empty row that
  // was already on the form stays. Shared by the prune pass and both move paths.
  const removeStrandedRows = async (formId, sectionPointer, rowIndex, span) => {
    const form = await provision.getArtifact('form', formId) || {};
    const section = sectionAt(form, sectionPointer);
    if (!section) return;
    // Bottom-up, so each removal leaves the earlier indexes valid without a re-read.
    for (const i of strandedRows(section.rows || [], rowIndex, span)) {
      await provision.removeElement('form', formId, `${sectionPointer}/rows/${i}`);
    }
  };
  // The departing cell's rowspan, read BEFORE it leaves: once it is gone, the rows it covered can only
  // be found from this number.
  const departingSpan = (form, location) => Number((cellAt(form, location) || {}).rowspan) || 1;

  const applyFieldPositions = async (formId, def, vacated, newCells) => {
    const original = await provision.getArtifact('form', formId) || {};
    let planned = JSON.parse(JSON.stringify(original));
    const affected = new Set();
    const departed = new Set();
    const narrowed = [];
    const newFields = new Set();
    for (const queued of newCells) {
      // The section the cell was queued for, found again as it is now (see queuedSectionPointer). Were it gone the field
      // goes where a field with no section goes, rather than being lost — or halting the build on a pointer that
      // addresses nothing.
      let sectionPointer = queuedSectionPointer(planned, queued);
      if (!sectionPointer) {
        const rowsPointer = firstFieldSectionRowsPointer(planned);
        if (!rowsPointer) {
          reportLayoutSkip(`form ${def.name}: '${queued.logical}' was not added — the form has no section to put it in.`);
          continue;
        }
        sectionPointer = rowsPointer.slice(0, -'/rows'.length);
        reportLayoutSkip(`form ${def.name}: '${queued.logical}' was added to the first section of the form — the section the layout names for it was no longer there.`);
      }
      appendCellPacked(planned, sectionPointer, queued.cell);
      affected.add(sectionPointer);
      newFields.add(queued.logical);
    }
    const place = (logical, anchor, before = false) => {
      const move = planFieldAdjacent(planned, logical, anchor, def.name, before);
      if (move.warning) {
        reportLayoutSkip(move.warning);
        return false;
      }
      if (!move.affected) return true;
      planned = move.form;
      for (const pointer of move.affected) affected.add(pointer);
      if (move.departed) departed.add(move.departed);
      if (move.narrowed) narrowed.push({ logical, ...move.narrowed });
      return true;
    };
    if (def.__explicitLayout) placeNewFieldsByList(def, newFields, place);

    // An accepted adjacency can be broken when its anchor moves later: [area|code] [notes|name]
    // plus a new extra must settle code-after-area BEFORE notes-after-code, regardless of key order.
    const anchors = new Map(Object.entries(def.__fieldPositions || {}));
    const dependents = new Map();
    const pending = new Map();
    for (const [logical, anchor] of anchors) {
      pending.set(logical, anchors.has(anchor) ? 1 : 0);
      if (!dependents.has(anchor)) dependents.set(anchor, []);
      dependents.get(anchor).push(logical);
    }
    const order = [...anchors.keys()].filter((logical) => pending.get(logical) === 0);
    for (let i = 0; i < order.length; i += 1) {
      for (const child of dependents.get(order[i]) || []) {
        pending.set(child, pending.get(child) - 1);
        if (pending.get(child) === 0) order.push(child);
      }
    }
    const skipped = new Set([...anchors.keys()].filter((logical) => pending.get(logical) > 0));
    if (skipped.size) {
      // Validation rejects cycles; direct library callers still get a bounded, non-fatal refusal.
      reportLayoutSkip(`form ${def.name}: 'after' placements were skipped because their anchors contain a cycle: `
        + [...skipped].map((logical) => `'${logical}' after '${anchors.get(logical)}'`).join(', ') + '.');
    }
    for (const logical of order) {
      if (!place(logical, anchors.get(logical))) skipped.add(logical);
    }
    for (const [logical, anchor] of anchors) {
      if (skipped.has(logical)) continue;
      const from = findFieldCellLocation(planned, logical);
      const to = findFieldCellLocation(planned, anchor);
      if (!from || !to) continue;
      if (from.sectionPointer !== to.sectionPointer || from.flatIndex !== to.flatIndex + 1) {
        reportLayoutSkip(`form ${def.name}: placement of '${logical}' after '${anchor}' remains unsatisfied `
          + '- the fields are not adjacent in section-flat order. Adjust the layout in the maker.');
      }
    }
    if (!affected.size) return;

    // moveElement followed by row copies/trimming persisted [area|code|name] [name] on a failed
    // trim, with the SAME IDs twice. A single SDK mutation persists the complete plan or its prior
    // state. Cross-section moves replace /tabs once so source removal and destination insertion
    // cannot be interrupted separately. Existing cell/control IDs and opaque state are copied.
    if (affected.size === 1) {
      const [pointer] = affected;
      const section = sectionAt(planned, pointer);
      if (section) await provision.updateElement('form', formId, pointer + '/rows', section.rows);
    } else {
      await provision.updateElement('form', formId, '/tabs', planned.tabs);
    }
    for (const name of departed) vacated.add(name);
    for (const note of narrowed) warnNarrowedField(def.name, note.logical, note.destination, note.landing);
  };
  // One placement path keeps new listed fields and targeted anchors from disagreeing about
  // carried rowspan capacity.
  // SECTION-FLAT adjacency, not row-local: [count|name] [code] becomes [count|code] [name].
  // A splice into a full row must split its trailing cells immediately below, not append them at
  // the section's end. Plan against a copy first: a rowspan can make that split, or even a whole-row
  // move, unsafe. A declined layout nicety must leave no half-applied move or overflowing push.
  const planFieldAdjacent = (form, logical, anchor, formName, before = false) => {
    const from = findFieldCellLocation(form, logical);
    const to = findFieldCellLocation(form, anchor);
    // An absent anchor may simply be a column this layout does not place.
    if (!from || !to) return {};
    const alreadyPlaced = from.sectionPointer === to.sectionPointer && from.flatIndex === to.flatIndex + (before ? -1 : 1);
    const source = sectionAt(form, from.sectionPointer);
    const destination = sectionAt(form, to.sectionPointer);
    const span = departingSpan(form, from);
    const landing = landingSpans(cellAt(form, from), {}, undefined, destination);
    // Earlier releases could persist an adjacent but overfull row. Repair its width once without
    // moving the field; a valid adjacent layout remains a true no-op.
    if (alreadyPlaced && rowOccupancy(destination.rows)[from.rowIndex].used <= landing.gridWidth) return {};
    const skip = (reason) => ({ warning: `form ${formName}: placement of '${logical}' ${before ? 'before' : 'after'} '${anchor}' `
      + `was skipped - ${reason}. Adjust the layout in the maker.` });
    // A field is never placed into a section the engine owns — the Notes timeline's rows are spacers its cell
    // spans, and a sub-grid host holds nothing else. The anchor can only be here because a maker put a field
    // into the host; positioning another control beside it would put the engine's own section's layout in
    // the spec's hands.
    if (!alreadyPlaced && isEngineHostSection(destination)) {
      return skip('the anchor sits in a section the build owns (the Notes timeline or a sub-grid), which no field is placed into');
    }
    const fits = (candidate) => [from.sectionPointer, to.sectionPointer].every((pointer) => {
      const section = sectionAt(candidate, pointer);
      return fitsGrid(section.rows || [], Number(section.columns) || 1);
    });
    const project = () => {
      // getArtifact may return the stored tree itself; preflight must never mutate that live value.
      const candidate = JSON.parse(JSON.stringify(form));
      if (landing.narrowed) cellAt(candidate, from).colspan = landing.colspan;
      return candidate;
    };
    let rowMove = false;
    let index;
    let candidate;
    // A reserved source row must stay even after its cell leaves. Moving a row-spanning cell as a
    // whole row would also leave its formerly covered empty rows behind, so it uses the cell route.
    if (!alreadyPlaced && !before && from.rowCellCount === 1 && to.cellIndex === to.rowCellCount - 1 && span === 1
      && rowReservationAt(source.rows, from.rowIndex) === 0) {
      candidate = project();
      const sourceRows = sectionAt(candidate, from.sectionPointer).rows;
      const targetRows = sectionAt(candidate, to.sectionPointer).rows;
      index = to.rowIndex + 1;
      // The SDK removes first, then splices into the already-resolved target array.
      if (from.rowsPointer === to.rowsPointer && from.rowIndex < index) index -= 1;
      const [row] = sourceRows.splice(from.rowIndex, 1);
      targetRows.splice(index, 0, row);
      rowMove = fits(candidate);
    }
    if (!rowMove) {
      candidate = project();
      const sourceRows = sectionAt(candidate, from.sectionPointer).rows;
      const targetRows = sectionAt(candidate, to.sectionPointer).rows;
      if (!alreadyPlaced) {
        const [cell] = sourceRows[from.rowIndex].cells.splice(from.cellIndex, 1);
        index = to.cellIndex + (before ? 0 : 1);
        if (from.cellsPointer === to.cellsPointer && from.cellIndex < index) index -= 1;
        targetRows[to.rowIndex].cells.splice(index, 0, cell);
        if (from.rowPointer !== to.rowPointer) {
          for (const ri of strandedRows(sourceRows, from.rowIndex, span)) sourceRows.splice(ri, 1);
        }
      }
      const target = findFieldCellLocation(candidate, alreadyPlaced ? logical : anchor);
      const row = targetRows[target.rowIndex];
      const occupancy = rowOccupancy(targetRows)[target.rowIndex];
      if (occupancy.used > landing.gridWidth) {
        // rowsFromCells packs WIDTH only. Splitting under a carried span, or moving a cell that
        // follows a spanning one in this row, would lose the maker's reservation/spacer geometry.
        if (occupancy.reserved || reflowBreaksReservation([row])) {
          return skip('splitting the anchor row would disturb a row-spanning reservation');
        }
        const packed = rowsFromCells(row.cells, landing.gridWidth);
        targetRows.splice(target.rowIndex, 1, { ...row, cells: packed[0].cells }, ...packed.slice(1));
      }
      if (!fits(candidate)) {
        return skip('the resulting rows would overflow the section grid after counting colspans and row-spanning reservations');
      }
    }
    // A declined move must keep both the maker's span and the vacated-section sweep unchanged.
    return {
      form: candidate,
      affected: [from.sectionPointer, to.sectionPointer],
      departed: from.sectionPointer !== to.sectionPointer && source.name ? String(source.name).toLowerCase() : null,
      narrowed: landing.narrowed ? { destination: destination.name || to.sectionPointer, landing } : null,
    };
  };
  // Only cells CREATED by this reconcile take the listed position. Existing fields keep their
  // relative order. A leading run of new fields anchors before an established successor first;
  // anchoring its first cell to another appended new cell would leave the whole run at the end.
  const placeNewFieldsByList = (def, newFields, place) => {
    for (const tab of def.tabs || []) for (const column of tab.columns || []) for (const section of column.sections || []) {
      const fields = formFieldLogicals({ tabs: [{ columns: [{ sections: [section] }] }] });
      for (let i = 0; i < fields.length; i += 1) {
        const logical = fields[i];
        if (!newFields.has(logical)) continue;
        const previous = fields[i - 1];
        const next = fields.slice(i + 1).find((field) => !newFields.has(field)) || fields[i + 1];
        const anchor = previous || next;
        if (anchor) place(logical, anchor, !previous);
      }
    }
  };

  // Identity of a deployed tab/section across rebuilds, in descending order of confidence:
  //   1. NAME  — what the compiler emits, so a form this plugin created matches itself exactly.
  //   2. LABEL — what the author sees and types; survives a name this plugin did not choose
  //      (a form built in Maker, or by a much older version).
  //   3. POSITION — last resort, and the one that makes an AUTO -> EXPLICIT migration converge.
  //      The auto layout emits `tab_general`/`section_general`, while an explicit layout with no
  //      authored names emits `tab_0`/`section_0_0` — so name matching alone would append a second
  //      tab to every form this plugin had already built, on every single rebuild.
  // A container is CREATED only when all three miss, which is what stops a rebuild duplicating one.
  //
  // `claimed` carries the indices an EARLIER want already took. Without it every want is matched
  // independently, and because the compiler substitutes a DEFAULT label for an unlabeled container
  // ('General' for a tab, 'Details' for a section), an author who labels nothing produces several
  // wants with an identical label — the label pass then returns index 0 for all of them and the
  // whole layout collapses into one container. Position has the same failure with repeated indices.
  //
  // `skip` hides containers the weaker passes must not claim. Only NAME may match them, because a
  // name is positive evidence and a label/position is not.
  // Send only the keys that actually differ, so a rebuild that changes nothing issues no writes.
  const diffPatch = (live, want, keys) => {
    const patch = {};
    for (const k of keys) if (want[k] !== undefined && live[k] !== want[k]) patch[k] = want[k];
    return patch;
  };

  // Converge an EXISTING form's CONTAINER topology (tabs, form-columns, sections) onto the spec's
  // explicit layout, before any field is placed.
  //
  // Why this exists: the reconcile used to flatten an explicit layout entirely — every field was
  // appended to `firstSectionRowsPointer`, i.e. the first section of the first tab, and no tab or
  // section was ever created or reshaped. Because declaring explicit `tabs` ALSO switches pruning
  // on, an author who moved to an explicit two-column layout to reorganize a deployed form got the
  // old topology, minus any field they had not re-declared, and a successful build (#575).
  //
  // Containers are created EMPTY (`rows: []`) and every field is placed by the single pass that
  // follows. Adding a tab with its compiled cells intact would duplicate any field already on the
  // form elsewhere, and would leave two code paths that can each place a control.
  //
  // Existing containers are UPDATED IN PLACE rather than replaced, so ids — and any control a maker
  // added to a section by hand — survive. `updateElement` merges when both sides are objects, so
  // patching only the differing keys preserves everything else in the container.
  //
  // Returns the desired-section-name -> deployed-section locator map the field pass places through.
  // It cannot re-derive this by name: a position-matched section keeps its own deployed name (it is
  // deliberately NOT renamed, because form scripts and business rules can reference a section name).
  const reconcileFormTopology = async (formId, def) => {
    // An engine-owned section carries its rows INTACT when created: the field pass places only bound
    // fields, so a notes/timeline section created empty would deploy a visible section header
    // promising a control that nothing ever adds.
    const stripRows = (section) => (isEngineOwnedSection(section) ? Object.assign({}, section) : Object.assign({}, section, { rows: [] }));
    // Null-prototype, because this map is keyed by AUTHOR-CONTROLLED section names. On a plain
    // object a section legitimately named `__proto__` would mutate the prototype instead of becoming
    // an own enumerable property, so it would be invisible to `Object.values` — and the
    // vacated-section sweep would then treat a section the layout explicitly claimed as unclaimed.
    //
    // Only AUTHORED wants are recorded: the map routes the author's fields. The compiler's notes section
    // is also named `section_notes`, and an authored section may be too — recording the engine's want
    // after the author's replaced the author's target, and the field pass then poured the author's fields
    // into the timeline and the sweep removed the emptied authored section. An engine section routes no
    // field, and the sweep never removes a section that still holds its control.
    const sectionTargets = Object.create(null);
    const wantTabs = def.tabs || [];
    // The section names the AUTHOR declared, computed by the compiler from the spec with the same
    // function verify uses, so the label and position passes cannot hand one want's named section to
    // another (see claimedByAuthoredName) — and build and verify skip the same containers.
    const authoredSectionNames = new Set(def.__authoredSectionNames || []);
    // …and the subset the author NAMED. Only those are looked for across the form (see the form-wide
    // lookup below): a generated name encodes the section's place.
    const namedSectionNames = new Set(def.__namedSectionNames || []);
    // A section MOVE shifts its siblings: the ones after it in the source column slide up one. Every
    // recorded target pointer there is corrected, not only the name-less ones resolveSectionPointer
    // falls back to — the vacated-section sweep also treats recorded pointers as claims, and a stale
    // one would spare a section it should reclaim. Nothing recorded can sit at or after the INSERTION
    // point: the target column's own matches all precede it, and every other column's matches live in
    // that column (an authored name hit in another column is moved, never recorded in place; an engine
    // want, which is never moved, is never recorded at all).
    const shiftRecordedSectionPointers = (fromPointer) => {
      const split = (p) => { const m = /^(.*\/sections)\/(\d+)$/.exec(p || ''); return m ? { list: m[1], index: Number(m[2]) } : null; };
      const from = split(fromPointer);
      if (!from) return;
      for (const t of Object.values(sectionTargets)) {
        const at = t && split(t.pointer);
        if (at && at.list === from.list && at.index > from.index) t.pointer = at.list + '/' + (at.index - 1);
      }
    };
    // Indices already taken by an earlier want, so two wants can never converge on one container.
    const claimedTabs = new Set();
    const claimedSections = new Map(); // column pointer -> Set(index)
    const claimedIn = (key) => { if (!claimedSections.has(key)) claimedSections.set(key, new Set()); return claimedSections.get(key); };
    const warn = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
    // Every tab is matched — or created — before any section is touched, so that the tabs can be put in
    // the layout's order first: the section pass records section pointers under their tab's index, and
    // ordering the tabs after it would shift those.
    const tabIndexOf = []; // want index -> deployed tab index (a hole when the tab could not be placed)
    // A tab another tab of the layout claims by NAME is matched only by that name (claimedByAuthoredName)
    // — the rule sections follow, and verify's rule.
    const tabSkip = claimedByAuthoredName(new Set(def.__authoredTabNames || []));
    for (let ti = 0; ti < wantTabs.length; ti++) {
      const wantTab = wantTabs[ti];
      // Re-read before every mutation: addElement appends and shifts sibling indices, so a pointer
      // computed against an earlier snapshot can address the wrong container.
      const form = await provision.getArtifact('form', formId) || {};
      let tabMatch = matchContainer(form.tabs, wantTab, ti, { claimed: claimedTabs, skip: tabSkip });
      if (!tabMatch) {
        // A new tab is added with EMPTY form-columns, and its sections then go through the same
        // per-section pass as an existing tab's: a section the deployed form already carries elsewhere
        // is MOVED in, and only a genuinely new one is created. Adding the tab with its sections created
        // a same-named DUPLICATE of any section it relocated — the field pass then emptied the original,
        // which the vacated-section sweep spared for its claimed name.
        //
        // It goes where the layout places it — right after the furthest tab already matched, the rule a
        // new section follows — rather than last, where a tab declared mid-layout used to land for good.
        // Every tab matched so far sits before that index, so inserting there shifts none of them.
        const at = Math.min((form.tabs || []).length, claimedTabs.size ? Math.max(...claimedTabs) + 1 : 0);
        await provision.addElement('form', formId, '/tabs', Object.assign({}, wantTab, {
          columns: (wantTab.columns || []).map((c) => Object.assign({}, c, { sections: [] })),
        }), { position: { index: at } });
        const added = await provision.getArtifact('form', formId) || {};
        tabMatch = matchContainer(added.tabs, wantTab, at, { claimed: claimedTabs, skip: tabSkip });
        if (!tabMatch) continue; // defensive: the added tab could not be found again
      }
      claimedTabs.add(tabMatch.index);
      tabIndexOf[ti] = tabMatch.index;
      const tabPatch = diffPatch(tabMatch.item, wantTab, ['label', 'expanded', 'visible']);
      if (Object.keys(tabPatch).length) await provision.updateElement('form', formId, '/tabs/' + tabMatch.index, tabPatch);
    }
    // The tabs in the layout's order. The build used to leave every existing tab where it was, so a
    // reordered layout deployed in the old order, and verify — which checked no order — passed it.
    // Like a section's width or label, the spec wins over a tab a maker dragged: reported, never silent.
    const placedTabs = wantTabs.map((_, ti) => ti).filter((ti) => Number.isInteger(tabIndexOf[ti]));
    const tabPlan = planOrderMoves(placedTabs.map((ti) => tabIndexOf[ti]));
    if (tabPlan.moves.length) {
      for (const m of tabPlan.moves) await provision.moveElement('form', formId, '/tabs/' + m.from, '/tabs', { index: m.to });
      placedTabs.forEach((ti, k) => { tabIndexOf[ti] = tabPlan.positions[k]; });
      const ordered = await provision.getArtifact('form', formId) || {};
      const names = placedTabs.map((ti) => (((ordered.tabs || [])[tabIndexOf[ti]]) || {}).name || `#${tabIndexOf[ti] + 1}`);
      warn(`form ${def.name}: moved ${tabPlan.moves.length} tab(s) to put the tabs in the layout's order: ${names.join(', ')}.`);
    }
    for (let ti = 0; ti < wantTabs.length; ti++) {
      if (!Number.isInteger(tabIndexOf[ti])) continue;
      const wantTab = wantTabs[ti];
      const tabIndex = tabIndexOf[ti];
      const tabPointer = '/tabs/' + tabIndex;
      let form;

      const wantColumns = wantTab.columns || [];
      for (let ci = 0; ci < wantColumns.length; ci++) {
        form = await provision.getArtifact('form', formId) || {};
        let liveTab = (form.tabs || [])[tabIndex];
        if (!liveTab) break; // defensive: the tab vanished mid-reconcile
        if (ci >= (liveTab.columns || []).length) {
          // A tab that gained a form-column — e.g. a single-column form widened into two. Added EMPTY,
          // for the same reason as a new tab: its sections go through the per-section pass below.
          await provision.addElement('form', formId, tabPointer + '/columns', Object.assign({}, wantColumns[ci], { sections: [] }));
          form = await provision.getArtifact('form', formId) || {};
          liveTab = (form.tabs || [])[tabIndex];
          if (!liveTab || ci >= (liveTab.columns || []).length) break; // defensive: the add did not land
        }
        const liveColumns = liveTab.columns || [];
        if (wantColumns[ci].width && liveColumns[ci].width !== wantColumns[ci].width) {
          await provision.updateElement('form', formId, tabPointer + '/columns/' + ci, { width: wantColumns[ci].width });
        }
        const columnPointer = tabPointer + '/columns/' + ci;
        const wantSections = wantColumns[ci].sections || [];
        for (let si = 0; si < wantSections.length; si++) {
          const wantSection = wantSections[si];
          form = await provision.getArtifact('form', formId) || {};
          const liveSections = (((form.tabs || [])[tabIndex] || {}).columns || [])[ci];
          const claimedHere = claimedIn(columnPointer);
          // A section may have been dragged to a different tab in Maker, or the spec may now place it
          // somewhere else; either way it is still THAT section, so a form-wide name hit outranks a
          // positional one inside this column. A name hit INSIDE this column is preferred, so a pair of
          // same-named sections left by an older build resolves to the one already in place.
          const liveList = ((liveSections || {}).sections) || [];
          // An AUTHORED want never takes an engine HOST (the notes timeline, a sub-grid host, still under
          // the name the compiler gave it) by name, here or anywhere below. An authored section may legally
          // carry the name the engine gives its host — `section_notes` is a natural name for a section
          // holding a notes field — and taking the host MOVED it into the author's column and poured
          // authored fields into it. Such a host is simply not a candidate: the want is matched or created
          // like any other authored section — and a host a maker added a field to is still one, since it
          // still holds its control. A section a maker filled with a control but that carries an AUTHORED
          // name stays a candidate: the name is the evidence it is the author's (see isEngineHostSection). An ENGINE want, in turn, takes only a section holding its own control
          // (the notes timeline's class id): its name is shared with any authored `section_notes`, and taking
          // the author's section for its host meant an existing form never got its timeline (see
          // holdsControlOf).
          const authoredWant = !isEngineOwnedSection(wantSection);
          const engineHost = authoredWant ? null : holdsControlOf(wantSection);
          const candidate = (s) => (authoredWant ? !isEngineHostSection(s) : engineHost(s));
          const sameName = (s) => !!(s && s.name) && String(s.name).toLowerCase() === String(wantSection.name).toLowerCase() && candidate(s);
          const inColumn = wantSection.name ? liveList.findIndex((s, i) => !claimedHere.has(i) && sameName(s)) : -1;
          // The form-wide lookup is for a section the author NAMED — and for an engine want, whose host a
          // maker may have moved. A GENERATED name (`section_<tab>[_<column>]_<index>`) encodes the
          // section's place, so a section of that name elsewhere — dragged there in Maker, or another one
          // that carries it after a reorder — is not taken from there: as documented for a generated
          // section (app-spec-schema.md, "Moving a section"), it is created where the layout places it,
          // its fields follow, and the emptied original is removed. The in-column hit above still finds it
          // where it belongs, so an unchanged layout converges.
          const lookFormWide = !!wantSection.name && (!authoredWant || namedSectionNames.has(String(wantSection.name).toLowerCase()));
          let global = inColumn >= 0 ? { pointer: columnPointer + '/sections/' + inColumn, section: liveList[inColumn] }
            : (lookFormWide ? findSectionLocation(form, wantSection.name, candidate) : null);
          // A named section the spec places in THIS column but that lives elsewhere is MOVED here: the
          // same node, so its id, name, rows and any maker-set properties travel with it. It used to be
          // reused in place — its attributes patched, its location left alone — so the build reported
          // success, the section stayed in the wrong tab, and verify, which checks placement, failed.
          // It lands right after the furthest section this column has already matched — exactly the
          // sections the layout places before it here — so it follows all of them (or goes first when
          // there are none) and stays ahead of any sub-grid host appended after them.
          //
          // An ENGINE-owned want (the notes section, a sub-grid host) is never moved: the author did
          // not place it — the compiler appends it to the first tab — so a maker who moved the
          // timeline elsewhere keeps it there, and nothing verifies its placement either.
          if (global && !isEngineOwnedSection(wantSection) && !global.pointer.startsWith(columnPointer + '/sections/')) {
            const liveCount = liveList.length;
            const index = Math.min(liveCount, claimedHere.size ? Math.max(...claimedHere) + 1 : 0);
            // Named for the report before the move: after it, `global` addresses the new place.
            const fromTab = ((form.tabs || [])[global.tabIndex] || {}).name || `#${global.tabIndex + 1}`;
            const fromColumn = global.columnIndex + 1;
            // Source and target are different arrays here, so moveElement's remove-then-splice needs no
            // index compensation (it is only off by one within a single array).
            await provision.moveElement('form', formId, global.pointer, columnPointer + '/sections', { index });
            shiftRecordedSectionPointers(global.pointer);
            // Moving a section a maker may have dragged there on purpose is the spec winning, as it does
            // for a section's columns and label — so it is reported, never silent.
            if (typeof opts.warn === 'function') {
              opts.warn(`form ${def.name}: moved section '${wantSection.name}' from tab '${fromTab}' (form-column ${fromColumn}) `
                + `to tab '${liveTab.name || `#${tabIndex + 1}`}' (form-column ${ci + 1}), where the layout places it.`);
            }
            form = await provision.getArtifact('form', formId) || {};
            const moved = ((((form.tabs || [])[tabIndex] || {}).columns || [])[ci] || {}).sections || [];
            global = { pointer: columnPointer + '/sections/' + index, section: moved[index] || global.section };
          }
          // An ENGINE want has no label or position to go on: its evidence is its name and its own control,
          // both weighed above. Running it through the label and position passes let the notes section, when
          // no host qualified, take whatever maker section sat at its index — relabelled "Notes", re-flowed
          // to one column, and still no timeline.
          const local = (global || !authoredWant) ? null : matchContainer((liveSections || {}).sections, wantSection, si,
            { claimed: claimedHere, skip: (s) => isEngineOwnedSection(s) || isEngineHostSection(s) || claimedByAuthoredName(authoredSectionNames)(s), nameSkip: (s) => !candidate(s) });
          if (!global && !local) {
            // The Notes host carries the control id Dynamics renders a timeline under, so it is not added to a
            // form that already has a control by that id — a second `notescontrol` would be a duplicate.
            if (!authoredWant && timelineInSection(wantSection) && timelineCreationBlocked(form, def.name)) continue;
            // An authored section is created where the layout places it: right after the furthest section this
            // column has already matched, the index the move above uses. Appended, it landed after every
            // section still to come — a new one declared mid-column, or a generated one recreated after a
            // drag in Maker. Nothing recorded sits at or after that index, so no recorded pointer shifts.
            // An ENGINE want is still appended: the compiler puts the notes section last.
            const at = authoredWant ? Math.min(liveList.length, claimedHere.size ? Math.max(...claimedHere) + 1 : 0) : null;
            await provision.addElement('form', formId, columnPointer + '/sections', stripRows(wantSection), ...(at === null ? [] : [{ position: { index: at } }]));
            form = await provision.getArtifact('form', formId) || {};
            const addedList = ((((form.tabs || [])[tabIndex] || {}).columns || [])[ci] || {}).sections || [];
            const addedIdx = at === null ? addedList.length - 1 : at;
            claimedHere.add(addedIdx);
            if (authoredWant) sectionTargets[wantSection.name] = { pointer: columnPointer + '/sections/' + addedIdx, name: (addedList[addedIdx] || {}).name };
            continue;
          }
          if (local) claimedHere.add(local.index);
          else if (global && global.pointer.startsWith(columnPointer + '/sections/')) {
            // A form-wide NAME hit inside THIS column still consumes that index. Without this, a
            // later want in the same column could match the very section the name hit already took
            // (by label or position), routing two authored sections onto one deployed section.
            const idx = Number(global.pointer.slice((columnPointer + '/sections/').length));
            if (Number.isInteger(idx)) claimedHere.add(idx);
          }
          const pointer = global ? global.pointer : columnPointer + '/sections/' + local.index;
          const live = global ? global.section : local.item;
          if (authoredWant) sectionTargets[wantSection.name] = { pointer, name: live.name };
          // `columns` is the key that matters most: it is what makes a section render as two
          // columns rather than one, and it was previously unreachable on an existing form.
          const patch = diffPatch(live, wantSection, ['columns', 'label', 'showLabel', 'visible']);
          // The engine's own timeline host keeps the width a maker gave the timeline. The spec says nothing about it —
          // the compiler writes one column — so a maker who widened the timeline (a cell of `colspan` 2 in a
          // 2-column section, as the platform's Contact form has it) must not have the section narrowed under it: a
          // cell wider than its section is not a layout, and the re-flow that would clamp it never runs on a host
          // (repackSectionRows). A host whose cell still fits the one column is narrowed as before.
          if (!authoredWant && patch.columns !== undefined && !fitsGrid(live.rows || [], Number(patch.columns))) delete patch.columns;
          // NARROWING the grid overflows rows that no cell changed. Three unit-width cells sit
          // legally in a 4-column row and illegally in a 1-column one, so a width change alone can
          // invalidate the layout — and the span-change repack never fires, because no span changed.
          // Live-reproduced: occupancy 3 in width 1, on both applies.
          //
          // Only a NARROWING needs this. Widening cannot overflow a row that already fitted, and
          // re-packing on every widen would reflow rows the author never asked to touch.
          const narrowing = patch.columns !== undefined && Number(patch.columns) < Number(live.columns || 1);
          let reflow = narrowing;
          if (narrowing && reflowBreaksReservation(live.rows)) {
            // A reflow here would move a cell into a row-spanning cell's reservation, so it cannot
            // run — and the decision has to be made BEFORE the width is written. Writing the width
            // and then refusing the reflow left rows overflowing the new grid for good: the next
            // apply sees the width already applied and has nothing to do.
            const width = Number(patch.columns);
            reflow = false;
            if (!fitsGrid(live.rows || [], width)) {
              delete patch.columns;
              reportLayoutSkip(`form section '${live.name || pointer}' keeps its ${live.columns}-column grid: narrowing it `
                + `to ${width} would overflow rows that cannot be re-flowed without moving a cell into a row-spanning `
                + 'cell\'s reservation. Adjust the layout in the maker.');
            }
            // …otherwise every row already fits the narrower grid: the width is written and nothing
            // is moved, because a reflow would only reshuffle cells that are already valid.
          }
          if (Object.keys(patch).length) await provision.updateElement('form', formId, pointer, patch);
          if (reflow) await repackSectionRows(formId, pointer, Number(patch.columns));
        }
        // The authored sections of this form-column in the layout's order. Moves and creations above land
        // after the sections already matched, but a section that was ALREADY here in a different order
        // stayed there: a reordered layout deployed in the old order, and verify checked no order, so it
        // passed. Ordered once the column's sections are all matched and before any later column can take
        // a section from this one; only this column's recorded targets live in this array, so theirs are
        // the only pointers the moves shift. An ENGINE section is not the author's and keeps its place.
        const sectionListPointer = columnPointer + '/sections';
        const orderedWants = wantSections.filter((s) => !isEngineOwnedSection(s) && sectionTargets[s.name]
          && String(sectionTargets[s.name].pointer || '').startsWith(sectionListPointer + '/'));
        const sectionPlan = planOrderMoves(orderedWants.map((s) => Number(sectionTargets[s.name].pointer.slice(sectionListPointer.length + 1))));
        if (sectionPlan.moves.length) {
          for (const m of sectionPlan.moves) await provision.moveElement('form', formId, sectionListPointer + '/' + m.from, sectionListPointer, { index: m.to });
          orderedWants.forEach((s, k) => { sectionTargets[s.name].pointer = sectionListPointer + '/' + sectionPlan.positions[k]; });
          warn(`form ${def.name}: moved ${sectionPlan.moves.length} section(s) in tab '${liveTab.name || `#${tabIndex + 1}`}' (form-column ${ci + 1}) `
            + `to put them in the layout's order: ${orderedWants.map((s) => sectionTargets[s.name].name || s.name).join(', ')}.`);
        }
      }
    }
    // The deployed index each layout tab was matched to (a hole where one could not be placed), beside the section
    // targets: a sub-grid placed by `tab` is put in the tab the layout's tab resolved to, which is not its index in
    // the spec once a maker's own tab sits among them.
    return { sectionTargets, tabIndexOf };
  };

  // Resolve a section target recorded during the topology pass back to a live pointer.
  // Prefer the deployed NAME (stable across the row-level mutations the field pass makes) and fall
  // back to the recorded pointer for a section that carries no name at all.
  const resolveSectionPointer = (form, target) => {
    if (!target) return null;
    // The recorded pointer, when the section there still carries the recorded name, is EXACT — and
    // only it can tell two same-named sections apart (a real one and an empty twin an older build left
    // in another tab), where a name search always returns the first in document order. Section indices
    // do not move under the field pass (it mutates rows and cells; the topology pass corrects them
    // across its own section moves), so a mismatch means the pointer went stale, and the name decides.
    if (target.name && target.pointer) {
      const at = sectionAt(form, target.pointer);
      if (at && String(at.name || '').toLowerCase() === String(target.name).toLowerCase()) return target.pointer;
    }
    if (target.name) {
      const loc = findSectionLocation(form, target.name);
      if (loc) return loc.pointer;
    }
    return target.pointer || null;
  };

  const sectionAt = (form, pointer) => {
    const t = String(pointer || '').split('/').filter(Boolean);
    if (t.length !== 6) return null;
    const tab = (form.tabs || [])[Number(t[1])];
    const col = tab && (tab.columns || [])[Number(t[3])];
    return (col && (col.sections || [])[Number(t[5])]) || null;
  };

  // Where the section a field being ADDED was queued for is on the form NOW, or null when it is gone.
  //
  // A new field is not written when it is queued: it is held until every positioning step is done (see
  // appendCellPacked), and the sub-grids are placed in between. A grid section added to a column, taken out of it
  // or moved within it changes the index of every section behind it, so the pointer recorded when the field was
  // queued can address the grid's section by then — the field lands in the grid — or none at all. The section is
  // therefore found again by what it is: its id, the one identity a move leaves alone, else (a form whose sections
  // carry none) its recorded name and place, as every other recorded section is (resolveSectionPointer).
  const queuedSectionPointer = (form, queued) => {
    const byId = queued.sectionId ? findSectionById(form, queued.sectionId) : null;
    if (byId) return byId.pointer;
    const pointer = resolveSectionPointer(form, { pointer: queued.sectionPointer, name: queued.sectionName });
    return pointer && sectionAt(form, pointer) ? pointer : null;
  };

  // Reflow an ENTIRE section against a new grid width, using the create path's own packer so both
  // routes produce the same shape. Called when a section NARROWS: no cell changed, but rows that
  // fitted the old width can overrun the new one.
  //
  // The cells are re-laid in their existing reading order, so the author's field order survives, and
  // they are MOVED (written as cells arrays) rather than recreated, so ids and any maker-edited
  // control state survive with them. Rows beyond the new count are removed from the END backwards,
  // because removing by index shifts every later index.
  const repackSectionRows = async (formId, sectionPointer, width) => {
    const form = await provision.getArtifact('form', formId) || {};
    const section = sectionAt(form, sectionPointer);
    if (!section) return;
    // An engine host is never re-flowed. The timeline's rows are the empty rows its cell spans — which a
    // re-flow would delete as "beyond the new count" — and a host holds a single control, so there is
    // nothing for a narrower grid to re-pack.
    if (isEngineHostSection(section)) return;
    const liveRows = section.rows || [];
    // A ROWSPAN makes a row's cells positionally meaningful: the cell beneath a vertically spanning
    // one is a SPACER reserving the covered slot, and reading-order flattening moves it beside the
    // spanning cell instead of under it. Live shape, narrowed 4 -> 2, before this guard:
    //     [A rowspan=2] [spacer, B] [C, D]   became   [A rowspan=2, spacer] [B, C] [D]
    // i.e. B took the reserved position. `rowsFromCells` models width only, so it cannot express
    // that reservation — and the authored-rowspan restriction does not help, because the span
    // belongs to the fetched MAKER form, not to the spec.
    //
    // REFUSE rather than guess. Leaving a maker's valid arrangement alone is the recoverable
    // outcome; silently rearranging their form is not. The caller makes this decision BEFORE it
    // writes the new width (so the grid and its rows never disagree); this is the backstop for any
    // future caller that does not.
    if (reflowBreaksReservation(liveRows)) {
      reportLayoutSkip(`form section at ${sectionPointer}: its rows were left as they are rather than re-flowed to `
        + `${width} column(s) — re-flowing them would move a cell into a row-spanning cell's reservation. `
        + 'Adjust the layout in the maker if it no longer fits.');
      return;
    }
    const cells = liveRows.flatMap((r) => (r && r.cells) || []);
    if (!cells.length) return;
    const packed = rowsFromCells(cells, width);
    const live = liveRows;
    // Nothing to do only when the existing rows match the packing the new width implies — INCLUDING
    // each cell's span. Comparing field names alone discarded exactly the change this exists to make:
    // `rowsFromCells` clamps a too-wide cell without moving it, so a section narrowed to 1 while
    // holding a colspan-4 cell had identical row membership and was judged unchanged. The stale
    // width then survived, and a second apply issued no corrective write either.
    const shapeOf = (rows) => JSON.stringify((rows || []).map((r) => ((r && r.cells) || []).map((c) => [
      c.control && c.control.fieldName,
      Number(c.colspan) || 1,
      Number(c.rowspan) || 1,
    ])));
    if (shapeOf(packed) === shapeOf(live)) return;
    for (let i = 0; i < packed.length; i += 1) {
      if (i < live.length) {
        await provision.updateElement('form', formId, `${sectionPointer}/rows/${i}`, { cells: packed[i].cells });
      } else {
        await provision.addElement('form', formId, `${sectionPointer}/rows`, { cells: [] });
        await provision.updateElement('form', formId, `${sectionPointer}/rows/${i}`, { cells: packed[i].cells });
      }
    }
    for (let i = live.length - 1; i >= packed.length; i -= 1) {
      await provision.removeElement('form', formId, `${sectionPointer}/rows/${i}`);
    }
  };

  // Re-laying rows by reading order is unsafe exactly when a cell FOLLOWS a row-spanning one. That
  // later cell — or the empty spacer holding a covered slot — has a position only relative to the
  // span above it, and `rowsFromCells` models WIDTH only, so a reflow can move it into the reserved
  // slot. A section whose row spans are all TRAILING reflows safely: nothing comes after the span to
  // land in its reservation. Stock account and contact Main forms put `rowspan` on the last cell of
  // a section, so treating every rowspan as unsafe refused exactly the commonest real shape.
  //
  // Shared by grid/span reflow and field-position row splits. End-of-section placement separately
  // counts carried reservations when choosing a row, without flattening the maker's layout.
  const reflowBreaksReservation = (rows) => {
    let spanning = false;
    for (const r of rows || []) {
      for (const c of (r && r.cells) || []) {
        if (spanning) return true;
        if ((Number(c.rowspan) || 1) > 1) spanning = true;
      }
    }
    return false;
  };
  const rowWidth = (cells) => (cells || []).reduce((n, c) => n + (Number(c.colspan) || 1), 0);
  const maxRowspan = (rows) => Math.max(1, ...(rows || []).flatMap((r) => ((r && r.cells) || []).map((c) => Number(c.rowspan) || 1)));
  const rowReservationAt = (rows, rowIndex) => {
    const padded = (rows || []).slice();
    while (padded.length <= rowIndex) padded.push({ cells: [] });
    const occupancy = rowOccupancy(padded)[rowIndex];
    return occupancy ? occupancy.reserved : 0;
  };
  const fitsWithCellAtRow = (rows, rowIndex, cell, width) => {
    const row = ((rows || [])[rowIndex]) || { cells: [] };
    return cellFitsInRow(row, cell, width, rowReservationAt(rows, rowIndex));
  };
  const firstAppendRowThatFits = (rows, cell, width) => {
    const start = Math.max(0, (rows || []).length - 1);
    const limit = (rows || []).length + maxRowspan(rows);
    for (let rowIndex = start; rowIndex <= limit; rowIndex += 1) {
      if (fitsWithCellAtRow(rows, rowIndex, cell, width)) return rowIndex;
    }
    return Math.max(0, (rows || []).length);
  };
  // Whether any cell — a field or an empty spacer — comes after (rowIndex, cellIndex) in reading order.
  const cellFollows = (rows, rowIndex, cellIndex) => (rows || []).some((r, ri) => ri >= rowIndex
    && ((r && r.cells) || []).some((_, ci) => ri > rowIndex || ci > cellIndex));

  // A layout change the build declined to make. Reported, AND recorded on the result: a stderr line
  // alone is invisible to a non-interactive run, and `--verify` does not check every route — an
  // auto layout's topology is never verified, so a skipped `fieldOptions` span would pass silently.
  const reportLayoutSkip = (message) => {
    result.skipped.layout.push(message);
    if (typeof opts.warn === 'function') opts.warn(message);
  };

  // The span to WRITE for a cell landing in `liveSection`: the authored value when there is one,
  // else the compiled one, with `colspan` clamped to the LIVE grid. `undefined` means no opinion —
  // a span the author never declared is never written, so a maker's hand-widened cell survives.
  //
  // Clamped against the section the write actually lands in, NOT the one the compiler laid out. On
  // an existing form they can differ: an AUTO layout compiles a synthetic section of one column (two
  // once it holds more than six fields) while reconcile deliberately keeps the deployed geometry, so
  // the compiled clamp narrowed a maker's four-column cell. `rawSpan` is the authored value carried
  // past compilation for exactly this.
  // Used by BOTH the existing-cell route and the add route — the add route once used the compiled
  // span alone, so a newly added field landed narrow and was only widened by a second apply.
  const spanForLiveSection = (key, wantCell, rawSpan, liveSection) => {
    const raw = rawSpan && typeof rawSpan[key] === 'number' ? rawSpan[key] : undefined;
    const compiled = wantCell && wantCell[key];
    if (raw === undefined && compiled === undefined) return undefined;
    const value = raw === undefined ? compiled : raw;
    if (key !== 'colspan') return value; // only colspan is bounded by the grid
    return Math.min(value, Math.max(1, Math.min(4, Number(liveSection && liveSection.columns) || 1)));
  };

  // Write an authored `colspan`/`rowspan` onto a cell that is already on the form. Only a span the
  // author explicitly declared is sent, and only when the deployed value differs, so a rebuild that
  // changes nothing issues no writes.
  const convergeCellSpans = async (formId, form, location, wantCell, rawSpan) => {
    if (!location || !wantCell) return;
    const live = cellAt(form, location);
    if (!live) return;
    const liveSection = sectionAt(form, location.sectionPointer) || {};
    const patch = {};
    for (const key of ['colspan', 'rowspan']) {
      const want = spanForLiveSection(key, wantCell, rawSpan, liveSection);
      if (want === undefined) continue; // no opinion — never overwrite a maker's span
      const current = live[key] === undefined ? 1 : live[key];
      if (current !== want) patch[key] = want;
    }
    if (!Object.keys(patch).length) return;

    // A span change can require a REFLOW of its row, and a reflow by reading order cannot honour a
    // row-spanning cell's reservation. For example, on a maker form holding
    // `[A rowspan=2, B] / [spacer]`, widening `B` overflows the row, and `repackRowAt` splits it
    // by reading order — placing `B` in the row `A` reserves. Judged on the rows AS THEY WILL BE.
    const current = await provision.getArtifact('form', formId) || {};
    const sec = sectionAt(current, location.sectionPointer) || {};
    const rows = sec.rows || [];
    const field = (live.control && live.control.fieldName) || location.cellPointer;
    // A rowspan RAISED on a cell that other cells follow creates a reservation they must route
    // around: the next row's cells are displaced past the covered slot, so a full row beneath needs
    // more columns than its grid has — even when the patched row itself still fits, which the
    // overflow check below cannot see. The validator only allows an authored rowspan on the LAST
    // field of the spec's list, but the reconcile keeps a staying cell where the maker put it, so the
    // deployed order can differ. Only the rowspan is withheld; a colspan in the same patch proceeds.
    if (patch.rowspan !== undefined && patch.rowspan > (Number(live.rowspan) || 1)
      && cellFollows(rows, location.rowIndex, location.cellIndex)) {
      delete patch.rowspan;
      reportLayoutSkip(`form section at ${location.sectionPointer}: the rowspan on '${field}' was not applied — `
        + 'other cells follow it, and a row-spanning cell displaces the cells beneath it. Make it the last '
        + 'field of its section in the maker.');
      if (!Object.keys(patch).length) return;
    }
    const row = rows[location.rowIndex];
    const beforeCells = (row && row.cells) || [];
    const afterCells = beforeCells.map((c, i) => (i === location.cellIndex ? { ...c, ...patch } : c));
    const afterRows = rows.map((r, i) => (i === location.rowIndex ? { ...r, cells: afterCells } : r));
    const patchedCell = afterCells[location.cellIndex] || live;
    const occupiedUntil = location.rowIndex + Math.max(1, Number(patchedCell && patchedCell.rowspan) || 1) - 1;
    const paddedAfterRows = afterRows.slice();
    while (paddedAfterRows.length <= occupiedUntil) paddedAfterRows.push({ cells: [] });
    const occupancy = rowOccupancy(paddedAfterRows);
    const overflows = occupancy.slice(location.rowIndex, occupiedUntil + 1)
      .some((row) => row && row.used > (Number(sec.columns) || 1));
    const unsafe = reflowBreaksReservation(afterRows);
    if (overflows && unsafe) {
      if (rowWidth(afterCells) > rowWidth(beforeCells)) {
        // A WIDENING into an overflow: skipped whole, not half-applied. Applying it without the
        // reflow would leave an overflowing row — a shape `rowsFromCells` would never emit and
        // Dataverse renders unpredictably — which is worse than a form that does not match the spec.
        reportLayoutSkip(`form section at ${location.sectionPointer}: the span change on '${field}' was skipped — `
          + 'it would overflow the row, and re-flowing that row would move a cell into a row-spanning cell\'s '
          + 'reservation. Adjust the layout in the maker.');
        return;
      }
      // A narrowing inside a row that ALREADY overflowed is strictly an improvement, so it is
      // written — but the row is not re-flowed, for the same reason.
      await provision.updateElement('form', formId, location.cellPointer, patch);
      reportLayoutSkip(`form section at ${location.sectionPointer}: the span change on '${field}' was applied, `
        + 'but its row still overflows the grid and was NOT re-flowed — that would move a cell into a '
        + 'row-spanning cell\'s reservation. Adjust the layout in the maker.');
      return;
    }
    await provision.updateElement('form', formId, location.cellPointer, patch);
    // A WIDENED span can overflow the row it sits in: a 2-column section holding two colspan-1
    // cells becomes 2+1 = 3 columns of content the moment one is widened to 2. The create path
    // packs rows by WIDTH (`rowsFromCells`), but an in-place span change never re-ran that
    // packing, so the row was left overflowing — a shape `rowsFromCells` would never emit, and one
    // Dataverse renders unpredictably. Live-reproduced: widening a field left three columns of
    // content in a two-column row across two applies.
    await repackRowAt(formId, location);
  };

  // Re-pack the row a span change just overflowed, using the create path's own packer so both routes
  // produce the same shape. The displaced cells move DOWN into rows inserted immediately below,
  // rather than to the bottom of the section, so the author's field order survives.
  //
  // The cells are moved by `updateElement` (the same mechanism `appendCellPacked` uses to write a
  // cells array), and the new rows are created EMPTY first — an existing cell carries an `id`, and
  // handing one to `addElement` risks re-keying the node rather than moving it.
  const repackRowAt = async (formId, location) => {
    const form = await provision.getArtifact('form', formId) || {};
    const section = sectionAt(form, location.sectionPointer);
    const row = section && (section.rows || [])[location.rowIndex];
    if (!row) return;
    const packed = rowsFromCells(row.cells || [], section.columns);
    if (packed.length <= 1) return; // still fits — nothing to do
    for (let k = 1; k < packed.length; k += 1) {
      await provision.addElement('form', formId, location.sectionPointer + '/rows', { cells: [] },
        // The SDK's position resolver accepts `undefined | 'end' | 'start' | {index} | {before} |
        // {after}` and tests `'index' in position`, so a BARE NUMBER throws
        // "Cannot use 'in' operator to search for 'index' in 1".
        { position: { index: location.rowIndex + k } });
      await provision.updateElement('form', formId,
        `${location.sectionPointer}/rows/${location.rowIndex + k}`, { cells: packed[k].cells });
    }
    await provision.updateElement('form', formId,
      `${location.sectionPointer}/rows/${location.rowIndex}`, { cells: packed[0].cells });
  };

  // The live cell a findFieldCellLocation result points at.
  const cellAt = (form, location) => {
    const section = sectionAt(form, location.sectionPointer);
    const row = section && (section.rows || [])[location.rowIndex];
    return (row && (row.cells || [])[location.cellIndex]) || null;
  };

  // Place one field in the section the layout declares, whether it is absent or merely misplaced.
  //
  // A field whose declared section could not be resolved falls back to the form's first section —
  // exactly the pre-existing behavior. A layout the topology pass could not materialize must still
  // never lose a field.
  // Append a cell to a section, PACKING it the way the create path does.
  //
  // `rowsFromCells` fills a row until the section's grid width is used, so a 2-column section holds
  // two single-width fields per row. The reconcile path used to ignore that entirely — every ADDED
  // field became its own single-cell row and every MOVED field was appended to the last row whatever
  // its width — so the same spec deployed a different shape depending only on whether the form
  // already existed. The effective-capacity check below is the create path's width rule plus
  // any columns still reserved by row-spanning cells above the target row.
  //
  // Keep the add in copied rows until positioning finishes. Persisting it first would let a failed
  // insertion become an "existing" appended field that the next run deliberately never reorders.
  const appendCellPacked = (form, sectionPointer, wantCell) => {
    const section = sectionAt(form, sectionPointer) || {};
    const rows = section.rows || [];
    const rowIndex = firstAppendRowThatFits(rows, wantCell, section.columns);
    // This mutates only the copied plan: a failed new-field insertion must not leave an appended
    // control that the next build mistakes for an existing field and never positions.
    while (rows.length <= rowIndex) rows.push({ cells: [] });
    rows[rowIndex].cells.push(wantCell);
    section.rows = rows;
  };

  // The rows a field with no resolved section falls back to: the form's first section that is not one the
  // engine owns. A field must never land in the Notes host or a sub-grid host — in the timeline's section it
  // would sit under its spacer rows, or beside the timeline once a maker widened the grid — so a host that
  // happens to come first is passed over. Where every section is a host there is nowhere better to put the
  // field than the old fallback, which is kept so a field is never lost.
  const firstFieldSectionRowsPointer = (form) => {
    const tabs = form.tabs || [];
    for (let ti = 0; ti < tabs.length; ti += 1) {
      const columns = (tabs[ti] && tabs[ti].columns) || [];
      for (let ci = 0; ci < columns.length; ci += 1) {
        const sections = (columns[ci] && columns[ci].sections) || [];
        for (let si = 0; si < sections.length; si += 1) {
          if (!isEngineHostSection(sections[si])) return `/tabs/${ti}/columns/${ci}/sections/${si}/rows`;
        }
      }
    }
    return firstSectionRowsPointer(form);
  };

  const placeFieldInSection = async (formId, logical, wantCell, target, vacated, rawSpan, formName) => {
    let form = await provision.getArtifact('form', formId) || {};
    const targetPointer = resolveSectionPointer(form, target);
    const existing = findFieldCellLocation(form, logical);

    if (!existing) {
      const rowsPtr = targetPointer ? targetPointer + '/rows' : firstFieldSectionRowsPointer(form);
      if (!rowsPtr) return;
      const sectionPointer = rowsPtr.slice(0, -'/rows'.length);
      // Span the NEW cell for the section it is landing in, by the same rule as an existing one.
      // The compiled cell alone carried the compiler's clamp, which for an auto layout is a
      // synthetic one- or two-column section: a field added to a four-column maker form arrived
      // narrow and was only widened — and its row reflowed — by a SECOND apply of the same spec.
      const liveSection = sectionAt(form, sectionPointer) || {};
      const cell = { ...wantCell };
      for (const key of ['colspan', 'rowspan']) {
        const span = spanForLiveSection(key, wantCell, rawSpan, liveSection);
        if (span === undefined) delete cell[key]; else cell[key] = span;
      }
      // The section is queued by what it IS (its id, its name) as well as where it is: the cell is written only
      // once every positioning step is done, and addSubgrids runs in between and moves sections about (see
      // queuedSectionPointer).
      return { logical, sectionPointer, sectionId: liveSection.id, sectionName: liveSection.name, cell };
    }
    // Converge the cell SHAPE even when the cell is already where it belongs. `colspan`/`rowspan`
    // used to be create-only on an existing form: an author who widened a field to `colspan: 2` on a
    // deployed form got a green build and an unchanged cell.
    //
    // Only spans the author EXPLICITLY set are written. `fieldCellIntent` omits a span of 1, so an
    // absent span means "no opinion" and leaves a cell a maker widened by hand alone — the same rule
    // that keeps `isReadOnly: false` from ever being written.
    //
    // Converging BEFORE a relocation would clamp the span against the section the cell is LEAVING:
    // a `colspan: 4` bound for a 4-column destination was cut to the 2-column source's width and
    // then moved, arriving narrower than authored (and only widening on a second apply). So when the
    // cell is staying, converge here; when it is moving, converge in the DESTINATION after the move.
    const staying = !targetPointer || existing.sectionPointer === targetPointer;
    if (staying) {
      await convergeCellSpans(formId, form, existing, wantCell, rawSpan);
      // Already on the form and already in the right section (or we have no opinion) — leave it be,
      // so a rebuild converges instead of reshuffling the form on every run.
      return;
    }

    // Misplaced: relocate the CELL rather than delete-and-recreate it, so its id and any
    // adapter-derived or maker-edited control state survive the move.
    //
    // Record the section this cell is LEAVING. That is what makes the vacated-section sweep precise:
    // "empty" alone cannot distinguish a section this run emptied from one a maker created empty and
    // may reference from a form script.
    const sourceSection = sectionAt(form, existing.sectionPointer);
    if (vacated && sourceSection && sourceSection.name) vacated.add(String(sourceSection.name).toLowerCase());
    //
    // The destination ROW is chosen by the same packing rule the create path uses, not simply the
    // last one: appending every relocated field to `rows.length - 1` piled four fields into a single
    // row of a 2-column section, a shape `rowsFromCells` would never emit.
    const targetSection = sectionAt(form, targetPointer) || {};
    const targetRows = targetSection.rows || [];
    // Captured BEFORE the add below. `getArtifact` can hand back a live reference to the artifact
    // tree rather than a copy, so `targetRows` may be the very array `addElement` pushes into —
    // reading `.length` afterwards would yield the POST-add count and target a row one past the end,
    // which silently skips the move (the `if (!row) return` guard below).
    const priorRowCount = targetRows.length;
    // The row is sized for the cell being MOVED, as it will be in the destination — not for the
    // compiled one. A span the author did not declare is kept from the live cell, so the compiled cell
    // (no span: "no opinion") under-states it: a maker's colspan-2 field moved into a one-column
    // section was placed as if it were one column wide and then kept its colspan 2, overflowing that
    // section on every apply. A kept colspan wider than the destination grid is clamped to the grid —
    // a cell cannot be wider than the grid it sits in, and it is the clamp a grid narrowing applies
    // (`rowsFromCells`).
    const landing = landingSpans(cellAt(form, existing) || {}, wantCell, rawSpan, targetSection);
    let rowIndex = firstAppendRowThatFits(targetRows, { ...wantCell, colspan: landing.colspan, rowspan: landing.rowspan }, targetSection.columns);
    // Either the section this run just created has no row yet, or all existing rows whose carried
    // row-span reservations leave enough capacity are behind us. The SDK accepts a row with an empty
    // cells array and serializes it correctly, so seed rows until the chosen target exists. Counted
    // locally: whether `targetSection` aliases the stored artifact is the SDK's business, and
    // re-assigning its `rows` to track the count added a phantom row wherever it does.
    for (let rowCount = priorRowCount; rowCount <= rowIndex; rowCount += 1) {
      await provision.addElement('form', formId, targetPointer + '/rows', { cells: [] });
    }
    form = await provision.getArtifact('form', formId) || {};
    const from = findFieldCellLocation(form, logical);
    const liveTarget = resolveSectionPointer(form, target);
    if (!from || !liveTarget) return;
    const row = ((sectionAt(form, liveTarget) || {}).rows || [])[rowIndex];
    if (!row) return;
    const span = departingSpan(form, from);
    await provision.moveElement('form', formId, from.cellPointer, liveTarget + '/rows/' + rowIndex + '/cells', { index: (row.cells || []).length });
    // The rows the move left holding nothing go (see removeStrandedRows). Row indices are unchanged by
    // a cell move, so the source rows are still where they were.
    await removeStrandedRows(formId, from.sectionPointer, from.rowIndex, span);

    // Converge the span NOW, in the destination, so it is clamped and packed against the section the
    // cell actually landed in rather than the one it left. Re-resolve the location: the move (and a
    // possible stranded-row removal) invalidated every pointer computed above.
    const settledForm = await provision.getArtifact('form', formId) || {};
    const settled = findFieldCellLocation(settledForm, logical);
    if (!settled) return;
    if (landing.narrowed) {
      // Written through the span-convergence path as if declared, so it is applied exactly like an
      // authored narrowing (a narrowing never overflows its row). Reported: the build changed the
      // width of a cell whose width the spec leaves to the maker.
      await convergeCellSpans(formId, settledForm, settled, { ...wantCell, colspan: landing.colspan }, { ...(rawSpan || {}), colspan: landing.colspan });
      const destination = (sectionAt(settledForm, settled.sectionPointer) || {}).name || settled.sectionPointer;
      warnNarrowedField(formName, logical, destination, landing);
      return;
    }
    await convergeCellSpans(formId, settledForm, settled, wantCell, rawSpan);
  };

  // The spans a cell MOVING into `section` will have there: a span the author declared (clamped to
  // the section's grid, as spanForLiveSection clamps it), otherwise the one the live cell already
  // carries — with an undeclared colspan wider than the grid clamped to it. `narrowed` says the clamp
  // changed a width the spec did not declare, which the caller writes and reports.
  const landingSpans = (liveCell, wantCell, rawSpan, section) => {
    const gridWidth = Math.max(1, Math.min(4, Number(section && section.columns) || 1));
    const liveColspan = Math.max(1, Number(liveCell && liveCell.colspan) || 1);
    const liveRowspan = Math.max(1, Number(liveCell && liveCell.rowspan) || 1);
    const declaredColspan = spanForLiveSection('colspan', wantCell, rawSpan, section);
    const declaredRowspan = spanForLiveSection('rowspan', wantCell, rawSpan, section);
    const colspan = declaredColspan !== undefined ? declaredColspan : Math.min(liveColspan, gridWidth);
    return {
      colspan,
      rowspan: declaredRowspan !== undefined ? declaredRowspan : liveRowspan,
      liveColspan,
      gridWidth,
      narrowed: declaredColspan === undefined && colspan < liveColspan,
    };
  };

  const warnNarrowedField = (formName, logical, destination, landing) => {
    if (typeof opts.warn === 'function') {
      opts.warn(`form ${formName}: '${logical}' spanned ${landing.liveColspan} columns, wider than the ${landing.gridWidth}-column `
        + `section '${destination}' the layout moves it to, so it now spans ${landing.colspan}. Declare its colspan to choose the width.`);
    }
  };
  // A new Notes host carries the control id `notescontrol`, the one Dynamics renders a timeline under (see
  // lib/form-timeline.js). A form that already has a control by that id — a maker's own timeline, or a host an
  // older build wrote that was renamed since — must not get a second one: ids are names the platform's
  // designer and scripts address, so a duplicate is not a harmless extra. Reported on the build result, not
  // dropped: the spec asked for Notes.
  const timelineCreationBlocked = (form, formName) => {
    if (!controlIdTaken(form.tabs, TIMELINE_CONTROL_ID)) return false;
    reportLayoutSkip(`form ${formName}: no Notes section was added — a control on this form already uses the id '${TIMELINE_CONTROL_ID}', `
      + 'the only id Dynamics renders a timeline under, so a second one would duplicate it. Keep that control as the form\'s timeline, '
      + `or remove it in the maker, then run ${FULL_BUILD} to let the build add one.`);
    return true;
  };

  // An AUTO layout has no topology pass to add the Notes host, so one the form lacks is added here — unless the form
  // already has a control by `notescontrol` (timelineCreationBlocked). An explicit layout's pass already created the
  // host, or declined to. It runs BEFORE the sub-grids, so a host an auto form gains here sits where it does on a
  // new form: ahead of the grids appended after it.
  const addTimelineHost = async (formId, def) => {
    if (!def.__notes || def.__explicitLayout) return;
    const form = await provision.getArtifact('form', formId) || {};
    if (findSectionLocation(form, 'section_notes', (s) => !!timelineInSection(s))) return;
    const sectionsPointer = firstColumnSectionsPointer(form);
    if (!sectionsPointer || timelineCreationBlocked(form, def.name)) return;
    await provision.addElement('form', formId, sectionsPointer, notesSectionIntent(NOTES_CLASS_ID));
    if (typeof opts.warn === 'function') opts.warn(`form ${def.name}: added the Notes section (timeline) the spec asks for.`);
  };

  // Make the Notes section's timeline the shape Dynamics renders (lib/form-timeline.js): the control id
  // `notescontrol`, a tall cell with `auto="false"`, and the empty rows that cell spans. An older build wrote
  // the timeline as a generated-id control in a one-row cell, which is published and never shown (#680) — and
  // because that host is the engine's own section, a rebuild repairs it in place: same section, same position,
  // same cell and control identity, in ONE write so an interruption leaves either the old rows or the new.
  //
  // Only the engine's own host is touched: the section named `section_notes` that holds the timeline control. A
  // timeline a maker added elsewhere is never edited. Two shapes are left alone and reported (timelineRefusal):
  //  · a host that holds more than the timeline — a maker put a field in it, and the spacer rows the span needs
  //    would have to be inserted between the timeline and that field;
  //  · a host whose control id cannot be renamed because another control already uses `notescontrol`.
  // Both would leave a form that renders neither better nor worse than before, so the write is refused whole
  // rather than half-applied.
  //
  // It runs LAST of the passes that place fields — after the prune of a field the layout dropped and the moves that
  // put a field beside its `fieldOptions` anchor — because it rewrites only this section's rows, and because the
  // first of the two refusals is about what else the section holds. Run before those, it would refuse an old host
  // whose stray field the SAME build is about to take out: the maker would be told to delete the section while the
  // build prunes the field, and the form would stay in the old shape until a second build.
  //
  // `--verify` reads the form BEFORE these passes, so it predicts what they take out of the host (notesHostInspector in
  // verify-spec.js). A change to which fields a pass takes out has to be made there too; the cases in
  // form-timeline-real-bundle.test.js ("verify before the build and the build itself agree") are what keep the two from drifting.
  // Each of those passes acts on the FIRST cell it finds of a field, in the order the form is in by then — which the topology
  // pass has already changed — so verify predicts a field only while the form has one cell of it, and says it cannot tell otherwise.
  //
  // A host the maker already sized (a cell spanning more than one row) keeps its span: only a one-row cell is
  // not a working timeline, and the spec says nothing about how tall the timeline is. Platform forms differ in
  // height too — a cell of N rows with the N-1 rows under it, N being 5, 20, 23 on different forms — and in
  // whether the cell carries `auto="false"`, so a cell of ANY height with its rows is in shape and nothing is
  // written for it; `auto` goes in only with the conversion of an old cell (see timelineRepairPlan).
  const repairTimelineHost = async (formId, def) => {
    if (!def.__notes) return;
    const warn = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
    const form = await provision.getArtifact('form', formId) || {};
    const host = findSectionLocation(form, 'section_notes', (s) => !!timelineInSection(s));
    if (!host) return;
    const found = timelineInSection(host.section);
    const plan = timelineRepairPlan(found);
    if (!Object.keys(plan).length) return;
    const refusal = timelineRefusal(form.tabs, found);
    if (refusal === 'other-controls') {
      reportLayoutSkip(`form ${def.name}: the Notes section's timeline was left as it is — the section also holds other controls, so the rows `
        + 'its cell needs cannot be inserted without moving them. Move them out of it, or delete the section, in the maker, '
        + `then run ${FULL_BUILD} to get a timeline that renders.`);
      return;
    }
    if (refusal === 'id-taken') {
      reportLayoutSkip(`form ${def.name}: the Notes section's timeline was left as it is — its control id cannot become '${TIMELINE_CONTROL_ID}', `
        + 'the only id Dynamics renders a timeline under, because another control on the form already uses it. '
        + `Remove or rename one of the two in the maker, then run ${FULL_BUILD}.`);
      return;
    }
    // getArtifact can hand back the stored tree itself, so the repair is made on a copy.
    const rows = JSON.parse(JSON.stringify(host.section.rows || []));
    const cell = rows[found.rowIndex].cells[found.cellIndex];
    if (plan.id) cell.control.id = plan.id;
    if (plan.rowspan) cell.rowspan = plan.rowspan;
    if (plan.auto) {
      // `auto` is a cell attribute the typed cell does not model: it lives in the bag of own attributes.
      const pairs = ((cell.bag && cell.bag.a) || []).map((pair) => pair.slice());
      const at = pairs.findIndex((pair) => pair[0] === 'auto');
      if (at >= 0) pairs[at][1] = plan.auto; else pairs.push(['auto', plan.auto]);
      cell.bag = Object.assign({ c: [] }, cell.bag, { a: pairs });
    }
    for (let i = 0; i < (plan.addRows || 0); i += 1) rows.push({ cells: [] });
    await provision.updateElement('form', formId, host.rowsPointer, rows);
    warn(`form ${def.name}: repaired the Notes section's timeline in place to the shape Dynamics renders — control id '${TIMELINE_CONTROL_ID}', `
      + `a ${cell.rowspan}-row cell and ${rows.length - 1 - found.rowIndex} empty row(s) under it.`);
  };

  const reconcileForm = async (formId, def) => {
    await provision.fetchArtifact('form', formId);
    // The def's field cells are already push-ready ({ control: { fieldName, isRequired? } }); index by
    // logical so a missing field is re-added with the same intent the create path would emit.
    const wantCellByLogical = {};
    for (const t of def.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const fn = c.control && c.control.fieldName;
      if (fn) wantCellByLogical[String(fn).toLowerCase()] = c;
    }
    const want = formFieldLogicals(def);
    // An EXPLICIT layout is author-controlled topology, so converge the containers first and then
    // place every field into the section that layout names. An AUTO layout has exactly one section
    // and no authored structure to honor, so it keeps the additive first-section behavior —
    // reshaping a form a maker built by hand is not something an auto layout ever asked for.
    let declaredSection = {};
    // Null-prototype: keyed by AUTHOR-CONTROLLED section names, so a section legitimately named
    // `__proto__` must land as an own enumerable property. On a plain object that assignment mutates
    // the prototype instead, leaving the claimed-set lookup below blind to it — and the sweep then
    // deleted a section the layout had explicitly asked for.
    let sectionTargets = Object.create(null);
    // Sections this run EMPTIED, by deployed name. The vacated-section sweep considers only these:
    // "holds no cells" cannot tell a section we just emptied from one a maker created empty and may
    // show/hide from a form script, and deleting the latter is invisible to the destructive preflight.
    const vacatedSections = new Set();
    // What the topology pass resolved on an explicit layout, for placing sub-grids by it (none on an auto layout).
    let topology = null;
    if (def.__explicitLayout) {
      declaredSection = declaredSectionByField(def.tabs);
      topology = await reconcileFormTopology(formId, def);
      sectionTargets = topology.sectionTargets;
    }
    // RAW authored spans, kept off the compiled cells because a cell is pushed verbatim to the SDK.
    // Reconcile re-clamps them against the section it actually writes into: the compiled span is
    // clamped to the COMPILER's section, which for an auto layout is a synthetic one- or two-column
    // stand-in that reconcile never deploys.
    const rawSpans = def.__fieldSpans || {};
    const newCells = [];
    for (const logical of want) {
      const created = await placeFieldInSection(formId, logical, wantCellByLogical[logical], sectionTargets[declaredSection[logical]], vacatedSections, rawSpans[logical], def.name);
      if (created) newCells.push(created);
    }
    // The Notes timeline: added to an auto layout that has none. Before the sub-grids, so a host an auto form gains
    // here sits where it does on a new form: ahead of the grids appended after it. An older host's repair comes last
    // (repairTimelineHost), once the prune and the field moves have emptied it of fields.
    await addTimelineHost(formId, def);
    await addSubgrids(formId, def, { topology, sectionTargets });
    // Re-assert per-control attributes (read-only / hidden) on fields that were ALREADY on the form.
    // New cells already carry their compiled flags; existing ones need this assertion before the
    // combined layout plan. Without it an author who marks an
    // existing field `readOnly: true` gets a successful build and no change — the same
    // create-only blind spot that made an existing column's RequiredLevel unchangeable.
    //
    // updateElement MERGES when both sides are objects (`{...current, ...patch}`), so patching
    // `/…/control` with `{ isReadOnly: true }` preserves classId, label and every other adapter-derived
    // value. It does NOT mint ids, which is exactly right here — the cell already has one.
    await applyFieldControlOptions(formId, def, want, wantCellByLogical);
    await repairLookupCellLabelsOn(formId, def);
    // Reposition any field the spec anchors after another (`fieldOptions[x].after`). Runs AFTER the
    // attribute pass; new cells and all anchored moves then persist together in one artifact edit.
    await applyFieldPositions(formId, def, vacatedSections, newCells);
    // Prune fields the deployed form carries that the spec's EXPLICIT layout dropped, so editing a
    // form to REMOVE a field lands. Gated to an author-controlled layout (explicit `tabs`); an AUTO
    // layout stays additive (never strip a column a user added in Maker). Never remove the primary.
    // `prune: false` opts out entirely, so a subset of the form can be restyled or reordered without
    // re-declaring every other field just to keep it (ADO 6651439).
    // removeElement is non-idempotent and shifts sibling indices, so re-locate each cell pointer from
    // a fresh read before removing it.
    if (def.__explicitLayout && def.__prune !== false) {
      const wantSet = new Set(want);
      const primary = def.__primaryField ? String(def.__primaryField).toLowerCase() : null;
      const { fenced, authorized, normalizedFormId } = authorizedFormRemovalEntry(opts.authorizedFormRemovals, formId, createdFormsThisRun);
      for (const logical of formFieldLogicals(await provision.getArtifact('form', formId) || {})) {
        if (wantSet.has(logical) || logical === primary) continue;
        if (fenced && (!authorized || !authorized.has(logical))) {
          // The preflight gate records the exact live field list the maker approved before this run.
          // If a later form read sees more fields, deleting them would exceed that approval (another
          // maker may have added the field while this build was starting), so keep the field and make
          // the skipped destructive change visible on the build result.
          result.skipped.unauthorizedRemovals.push({ formId: normalizedFormId, form: def.name, field: logical });
          reportLayoutSkip(`form ${def.name}: kept field '${logical}' because it was not among the removals authorized when this run started. Another maker may have added it; re-run to review it.`);
          continue;
        }
        const pruneForm = await provision.getArtifact('form', formId) || {};
        const loc = findFieldCellLocation(pruneForm, logical);
        // Pruning can empty a section too, so it feeds the vacated set on the same terms as a move.
        if (loc) {
          const sec = sectionAt(pruneForm, loc.sectionPointer);
          if (sec && sec.name) vacatedSections.add(String(sec.name).toLowerCase());
        }
        const ptr = loc ? loc.cellPointer : findFieldCellPointer(pruneForm, logical);
        if (ptr) {
          // Read the span first: getArtifact can hand back the live artifact, so the cell is gone from
          // `pruneForm` once removeElement returns.
          const span = loc ? departingSpan(pruneForm, loc) : 1;
          await provision.removeElement('form', formId, ptr);
          // Pruning a field must not leave a blank line where it was (see removeStrandedRows).
          if (loc) await removeStrandedRows(formId, loc.sectionPointer, loc.rowIndex, span);
        }
      }
    }
    // Reclaim a section the layout VACATED (#581). A generated section name encodes position
    // (`section_<tab>[_<column>]_<index>`), so moving a section between form-columns or tabs under a
    // generated name changes its identity: the topology pass creates a new one and the old one is
    // never matched again. The field pass then empties it, leaving a deployed form with two sections
    // headed the same thing, one of them blank — stable across rebuilds and permanently wrong.
    //
    // Runs LAST, after the field placement and prune passes, because only then is a vacated section
    // actually empty. Four conditions, each load-bearing:
    //   · explicit layout + prune ON — the same gate the field prune uses. An `auto` layout has no
    //     authored shape to vacate, and `prune: false` means "leave what I did not re-declare".
    //   · THIS RUN emptied it. `vacatedSections` records every section a cell was moved or pruned
    //     out of. Without this the sweep deleted a section a maker had created empty and may
    //     show/hide from a form script — an unchanged layout would silently destroy it, and the
    //     destructive preflight cannot see it because that compares fields, not containers.
    //   · the section is NOT one the authored layout claimed — judged by the section each target
    //     RESOLVES to on the live form, not by name: two same-named sections (a real one and a copy an
    //     older build left in another tab) share a name, and a name test spared the emptied copy
    //     forever while the field pass had moved everything into the real one.
    //   · it holds NO cells at all — not merely no bound fields. A section can carry a spacer or a
    //     control this reader does not model, and an empty-LOOKING section is not an empty one.
    //
    // That last test is also what protects the ENGINE's own sections. An explicit
    // `isEngineOwnedSection` check was written here first and then removed as dead: that predicate is
    // `cells.length > 0 && every cell unbound`, so anything it calls engine-owned already has cells
    // and is spared above. Mutation testing proved it unkillable, and a guard that cannot fail
    // implies coverage that does not exist.
    if (def.__explicitLayout && def.__prune !== false) {
      // Collected from a single read and removed from the BACK, because removeElement shifts the
      // indices of later siblings — deleting front-first would silently target the wrong section.
      const orphans = [];
      const live = await provision.getArtifact('form', formId) || {};
      const claimedPointers = new Set();
      for (const t of Object.values(sectionTargets || {})) {
        const p = t && resolveSectionPointer(live, t);
        if (p) claimedPointers.add(p);
      }
      (live.tabs || []).forEach((tab, ti) => {
        (tab.columns || []).forEach((col, ci) => {
          (col.sections || []).forEach((sec, si) => {
            const pointer = `/tabs/${ti}/columns/${ci}/sections/${si}`;
            if (claimedPointers.has(pointer)) return;
            const secName = sec && sec.name ? String(sec.name).toLowerCase() : null;
            if (!secName || !vacatedSections.has(secName)) return;
            const cells = ((sec && sec.rows) || []).flatMap((r) => (r && r.cells) || []);
            if (cells.length) return;
            orphans.push({ pointer, name: (sec && sec.name) || '(unnamed)', label: (sec && sec.label) || '' });
          });
        });
      });
      for (const o of orphans.slice().reverse()) {
        await provision.removeElement('form', formId, o.pointer);
        if (typeof opts.warn === 'function') {
          // The naming hint helps only a GENERATED name (`section_<tab>[_<column>]_<index>`), which is
          // the one that loses its identity on a move; a named copy or a dropped section needs none. The
          // shape alone is not proof: an author may NAME a section `section_0_0`, and a copy of that
          // needs no advice to give it a name.
          const generated = /^section_\d+(?:_\d+)?_\d+$/.test(String(o.name)) && !(def.__namedSectionNames || []).includes(String(o.name).toLowerCase());
          opts.warn(`form ${def.name}: removed the now-empty section '${o.name}'${o.label ? ` ("${o.label}")` : ''} — the layout no longer places anything in it.${generated ? ' Give a section an explicit `name` if you intend to move it between tabs or form-columns.' : ''}`);
        }
      }
    }
    // The Notes timeline of an older build, repaired in place — LAST of the passes that change a form's fields and
    // sections, so a host the prune and the field moves have just emptied is the clean host the repair needs.
    // It edits the workspace copy only, so the check below sees it: a repaired form is pushed, an unchanged one is not.
    await repairTimelineHost(formId, def);
    // Push only when the copy holds an edit the server has not seen: an unchanged form would be sent back
    // as the document the server already holds (three version reads, a PATCH and a read-back). A copy an
    // earlier interrupted run left edited still differs from its snapshot, so it is pushed as before.
    if (await hasUnsyncedEdits(provision, 'form', formId)) {
      requireSuccessfulPush(await provision.pushArtifact('form', formId), `form ${def.name}`, opts.warn);
    }
    await publishReconciled('form', formId, def.entityLogicalName, `form ${def.name}`);
    await ensureInSolution(formId, COMPONENT_TYPE.form, def.entityLogicalName);
    return formId;
  };

  // Reconcile an EXISTING author view: fetch it, UNION its current columns with the spec's (so a
  // manual column add in Maker is preserved AND the spec's new lookup columns land), set, push when that
  // changed anything, publish. Editing a view's column set (e.g. to surface a parent lookup) now takes effect.
  const reconcileView = async (viewId, def, authoredQuery) => {
    await provision.fetchArtifact('view', viewId);
    const current = await provision.getArtifact('view', viewId) || {};
    const have = new Set((current.columns || []).map((c) => String(c.name).toLowerCase()));
    const merged = (current.columns || []).slice();
    for (const col of def.columns || []) {
      const n = String(col.name).toLowerCase();
      if (have.has(n)) continue;
      have.add(n);
      merged.push({ name: n, width: col.width || 100, order: merged.length });
    }
    await provision.updateElement('view', viewId, '/columns', merged);
    // Reconcile the maker-facing description too (#496). Without this, a view's description reached
    // Dataverse only on CREATE — and the most-read view on a table is the platform's auto-generated
    // "Active <Plural>", which already exists, so the build reconciles onto it and the authored
    // description was never written.
    //
    // Two guards, both load-bearing:
    //   * only when the spec EXPLICITLY sets one (`viewDef` emits `description: v.description || ''`,
    //     so an unset description is `''` — writing that would blank text a maker typed in the UI);
    //   * only when it DIFFERS, so an ordinary rebuild issues no extra write.
    // This rides the push below rather than a separate PATCH: the push rewrites `description` from
    // the artifact, so a standalone PATCH would be immediately overwritten by the stale fetched value.
    const wantDescription = typeof def.description === 'string' ? def.description.trim() : '';
    if (wantDescription && wantDescription !== String(current.description || '')) {
      await provision.updateElement('view', viewId, '/description', wantDescription);
    }
    // An EXISTING view's FetchXML (filters + sort) is not reapplied here — only columns and the
    // description converge. Silence made an authored filter edit look applied when it was not, so
    // the no-op is reported instead. It is a warning rather than a failure because the common way to
    // hit it is entirely benign: the build reconciles onto the platform's auto-generated
    // "Active <Plural>" view, which every table already has.
    //
    // `authoredQuery` is passed in rather than derived from `def`, because `viewDef` folds the
    // implicit `statecode eq 0` of `activeOnly` into the same `filters.conditions` array as the
    // author's own — so a non-empty array does not mean the author declared anything, and warning
    // off it would fire on every rebuild of every view. `--verify` proves the deployed fetchxml
    // separately and FAILS on a divergence; this explains what verification will report.
    if (authoredQuery && typeof opts.warn === 'function') {
      opts.warn(`view '${def.name}' already exists — its columns and description were updated, but authored filters/sort are NOT reapplied to an existing view. Rename the view to author a separate one, or adjust its filters in Maker.`);
    }
    // Push only when the copy holds an edit the server has not seen — a new column or description above, or
    // one an earlier interrupted run left in the workspace. The columns this build writes are the fetched ones
    // verbatim plus any the spec adds, so an ordinary rebuild changes nothing and issues no write here; this is
    // what the description guard above already promises.
    if (await hasUnsyncedEdits(provision, 'view', viewId)) {
      requireSuccessfulPush(await provision.pushArtifact('view', viewId), `view ${def.name}`, opts.warn);
    }
    await publishReconciled('view', viewId, def.entityLogicalName, `view ${def.name}`);
    await ensureInSolution(viewId, COMPONENT_TYPE.view, def.entityLogicalName);
    return viewId;
  };

  // Gap 2: mark our spec form the entity's DEFAULT main form so the app opens it, not the blank
  // stock "Information" form. Called ONLY for a table THIS build owns (a custom, publisher-prefixed
  // table — see the call-site guard), so it never touches a reused/system table's forms.
  //
  // By default we deliberately do NOT deactivate other main forms. That would be destructive: on a
  // shared system table it disables out-of-box forms env-wide, and on any table it kills legitimate
  // role-based / sibling author forms — and with concurrent form builds the winner is
  // nondeterministic. Marking ours `isdefault` is enough for the app to open it (the stock form
  // stays available in the form switcher). Best-effort — never fail the build over the flag.
  //
  // #6 (opt-in): when a form sets `deactivateOtherMainForms: true`, we ALSO deactivate every OTHER
  // active main form on the entity so only our form ships active (no blank "Information" form
  // competing in the switcher). This is gated to our OWN custom table (call-site) AND the explicit
  // flag, because it is destructive. Teardown's restoreStockMainForm reactivates a stock main form
  // before deleting ours so the table can be torn down — note that is a delete-enabler, NOT a perfect
  // restore of pre-build activation state (a form that was inactive before this build may be left
  // active after teardown).
  const promoteDefaultForm = async (formId, entityLogical, deactivateOthers, siblingFormIds = []) => {
    // Deactivating the OTHER main forms is only safe once OUR form is the entity default: if the
    // isdefault promote failed we must NOT deactivate the others, or the entity could be left with its
    // (now-deactivated) stock form still the default and no active default — a bricked form experience.
    let promoted = false;
    try {
      await provision.updateRecord('systemform', formId, { isdefault: true });
      promoted = true;
    } catch (err) {
      // Best-effort for the BUILD (leave promoted=false so the destructive deactivation below is
      // skipped), but no longer SILENT. Swallowing this outright let a build record a selected
      // default form it had not actually promoted, and report success — the exact silent-partial
      // class `--verify` exists to catch. Verification now proves `systemform.isdefault`
      // independently, so this warning is the signal that explains the failure it will report.
      const reason = (err && err.message) ? String(err.message).slice(0, 200) : 'unknown error';
      if (typeof opts.warn === 'function') opts.warn(`could not make form the default for '${entityLogical}': ${reason} — the table keeps its previous default form`);
    }
    if (!promoted) return promoted;
    if (typeof provision.queryRecords === 'function') {
      for (const siblingId of siblingFormIds || []) {
        if (!siblingId || String(siblingId) === String(formId)) continue;
        try {
          const rows = await provision.queryRecords('systemform', {
            select: ['formid', 'isdefault'],
            filter: `formid eq ${siblingId}`,
            top: 1,
          });
          const sibling = rows && rows[0];
          if (sibling && sibling.isdefault === true) {
            await provision.updateRecord('systemform', String(sibling.formid || siblingId), { isdefault: false });
          }
        } catch (err) {
          const reason = (err && err.message) ? String(err.message).slice(0, 200) : 'unknown error';
          if (typeof opts.warn === 'function') opts.warn(`could not clear the previous default Main form for '${entityLogical}': ${reason}`);
        }
      }
    }
    if (!deactivateOthers) return promoted;
    if (typeof provision.queryRecords !== 'function') return promoted;
    try {
      // Main forms only (systemform.type == 2). Every other ACTIVE main form is deactivated
      // (formactivationstate 1 -> 0); ours is skipped by id. A form already inactive
      // (formactivationstate === 0) is left alone to avoid a redundant write; a row without an
      // explicit state is presumed active and deactivated (the safe assumption).
      // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/systemform
      const forms = await provision.queryRecords('systemform', {
        select: ['formid', 'formactivationstate'],
        filter: `objecttypecode eq '${odataLit(entityLogical)}' and type eq 2`,
        top: 50,
      });
      for (const f of forms || []) {
        if (String(f.formid) === String(formId)) continue; // never deactivate our own form
        if (f.formactivationstate === 0) continue; // already inactive
        try {
          await provision.updateRecord('systemform', String(f.formid), { formactivationstate: 0 });
        } catch {
          /* best-effort per form */
        }
      }
    } catch {
      /* best-effort */
    }
    return promoted;
  };

  // AB#6736948 — write one table's Main Form Set order (lib/form-order.js has the platform model and
  // the measurements behind it).
  //
  // Only forms the spec declares are ever written. Where the spec orders the table — `mainFormOrder`,
  // an explicit `isDefault`, or any table the spec owns — its Main forms get Order 0..n-1 in the
  // planned order, skipping any already in place (a form the SDK just created has no Order, so it is
  // always written, the first of a table included). Elsewhere the order belongs to the
  // environment, and the build touches it only to put a Main form it CREATED in this run after the
  // table's other Main forms: a new form carries no Order, and where the platform serves a form with
  // none is not the build's choice, so it could come ahead of the form everyone opens today. (On a
  // table whose forms carry no order at all there is nothing to follow: it comes first, and the build
  // says so.) A table the author orders by hand (`securityRoles.order`) is left alone entirely.
  //
  // Best-effort like the promotion above: a failed read or write is reported (✗ and a warning) and
  // `--verify` fails on the order it reads back, but the build goes on.
  const canOrderForms = () => typeof provision.getFormSecurityRoles === 'function'
    && typeof provision.setFormSecurityRoles === 'function' && typeof provision.queryRecords === 'function';
  const writeFormOrder = async (formId, order, stored) => {
    // The SDK re-attaches an existing <DisplayConditions> and changes only the attributes it is given,
    // so the form's roles and fallback setting are kept. A form with no <DisplayConditions> has nothing
    // to attach an order to (the SDK refuses), so it gets the element a new form is created with —
    // offered to everyone, eligible as a fallback — which is what having none means.
    await provision.setFormSecurityRoles(formId, stored ? { order } : { everyone: true, fallbackForm: true, order });
  };
  // The table's ACTIVE Main forms other than `exceptIds`, each with its stored order (undefined: none).
  const otherMainForms = async (entityLogical, exceptIds) => {
    const rows = await provision.queryRecords('systemform', {
      select: ['formid', 'name'],
      filter: `objecttypecode eq '${odataLit(entityLogical)}' and type eq 2 and formactivationstate eq 1`,
      top: 250,
    });
    const out = [];
    for (const r of rows || []) {
      const id = normalizeFormId(r && r.formid);
      if (!id || exceptIds.has(id)) continue;
      const stored = await provision.getFormSecurityRoles(id);
      out.push({ id, name: String((r && r.name) || id), order: stored ? stored.order : undefined });
    }
    return out;
  };
  const applyMainFormOrder = async (entityLogical, idOfForm) => {
    const mains = declaredMainForms(spec, entityLogical);
    if (!mains.length || ordersByHand(spec, entityLogical)) return;
    const entityName = mains[0].entity;
    const q = (f) => `'${f.name || `${entityName} form`}'`;
    const warn = (m) => { if (typeof opts.warn === 'function') opts.warn(m); };
    const planned = plannedMainFormSequence(spec, entityLogical);
    if (!canOrderForms()) {
      runner.skip('forms', `form order for ${entityName} (this SDK cannot read or write a form's order)`);
      return;
    }
    if (planned) {
      const notBuilt = mains.filter((f) => !idOfForm.get(f));
      if (notBuilt.length) {
        runner.skip('forms', `form order for ${entityName} (${notBuilt.map(q).join(', ')} not built in this run)`);
        return;
      }
      const listed = listedMainForms(spec, entityLogical);
      const head = listed && listed.length ? listed : planned.slice(0, 1);
      const more = mains.length - head.length;
      await runBestEffort(runner, 'forms', `form order for ${entityName}: ${head.map(q).join(' > ')}${more ? `, then ${more} more` : ''}`, async () => {
        const stored = new Map();
        for (const f of mains) stored.set(f, await provision.getFormSecurityRoles(idOfForm.get(f)));
        const current = new Map(mains.map((f) => [f, stored.get(f) ? stored.get(f).order : undefined]));
        const sequence = plannedMainFormSequence(spec, entityLogical, current);
        for (let i = 0; i < sequence.length; i += 1) {
          if (current.get(sequence[i]) === i) continue;
          await writeFormOrder(idOfForm.get(sequence[i]), i, stored.get(sequence[i]));
        }
        // A form this spec does not declare is never written — but one whose order does not put it
        // after the first form can still be what the table opens with. Say so now; `--verify` checks
        // the order the platform actually serves. The order above is already written, so a table form
        // that cannot be read here (another publisher's, say) costs this warning, not the step.
        let others = [];
        try {
          others = await otherMainForms(entityLogical, new Set(mains.map((f) => normalizeFormId(idOfForm.get(f)))));
        } catch (err) {
          warn(`'${entityName}': could not read its other Main forms to check that none comes before ${q(sequence[0])} (${(err && err.message) || err}); \`--verify\` checks the order the platform serves.`);
        }
        for (const o of others.filter((x) => Number.isFinite(x.order) && x.order <= 0)) {
          warn(`'${entityName}': Main form '${o.name}', which this spec does not declare, has form order ${o.order} — not after ${q(sequence[0])} (0) — so the platform may open the table with it. Move it down in Maker (Form settings > Form order), or declare it in forms[] and list it in entities[].mainFormOrder.`);
        }
      }, opts.warn, `could not set the Main Form Set order of '${entityName}'`);
      return;
    }
    // A Main form this run CREATED on this table was created already after the table's other Main forms
    // (createInPlace, below): its order was part of the create. What is left is to say what that means.
    const created = mains.filter((f) => idOfForm.get(f) && createdFormsThisRun.has(normalizeFormId(idOfForm.get(f))));
    if (!created.length) {
      runner.skip('forms', `form order for ${entityName} (no new Main form — its order is left as it is)`);
      return;
    }
    await runBestEffort(runner, 'forms', `form order for ${entityName} (${created.map(q).join(', ')} after its other Main forms)`, async () => {
      const list = created.map(q).join(', ');
      const plural = created.length > 1;
      const snapshot = await appendSnapshotFor(entityLogical);
      if (snapshot.error) {
        warn(`'${entityName}': could not read its other Main forms (${(snapshot.error && snapshot.error.message) || snapshot.error}), so ${list} ${plural ? 'were' : 'was'} created at the end of the form order (order ${APPEND_FALLBACK_ORDER} and up). Check the order in Maker (Form settings > Form order).`);
        return;
      }
      const unplaced = created.filter((f) => !createdInPlace.has(f));
      if (unplaced.length) {
        warn(`'${entityName}': ${unplaced.map(q).join(', ')} ${unplaced.length > 1 ? 'were' : 'was'} created without a form order the build could set, so ${unplaced.length > 1 ? 'they' : 'it'} may come first. Set the order in Maker (Form settings > Form order), or declare the table's order with entities[].mainFormOrder.`);
      }
      if (snapshot.base < 0) {
        warn(`'${entityName}': none of its other Main forms has a form order, so ${list} now come${plural ? '' : 's'} first — users without a remembered form open the table with ${q(created[0])}. To keep the form it opened with, set forms[].isDefault or entities[].mainFormOrder, or set the order in Maker (Form settings > Form order).`);
        return;
      }
      // A form with no order at all is served after every form that has one, so the new form(s) come before
      // it — and a user whose roles do not offer them an ordered form, and who therefore opened that one,
      // now opens the new form instead.
      const unranked = snapshot.others.filter((o) => !Number.isFinite(o.order));
      if (unranked.length) {
        warn(`'${entityName}': ${list} now come${plural ? '' : 's'} before ${unranked.map((o) => `'${o.name}'`).join(', ')}, which ${unranked.length > 1 ? 'have' : 'has'} no form order (a form without one is served after every form that has one) — so a user who opened ${unranked.length > 1 ? 'one of them' : 'it'} may now open ${q(created[0])}. To keep ${unranked.length > 1 ? 'their' : 'its'} place, give ${unranked.length > 1 ? 'them' : 'it'} an order in Maker (Form settings > Form order), or declare the table's order with entities[].mainFormOrder.`);
      }
    }, opts.warn, `could not check the place of the new Main form(s) of '${entityName}'`);
  };

  // AB#6736948 — a Main form the build CREATES on a table whose order it does not set is created already
  // after the table's other Main forms. Its order is written into the new form's own <DisplayConditions>
  // (the SDK gives every new form one, with no Order, in its root bag) BEFORE the first push, so the order
  // is part of the create: no interrupted run and no later failure can leave the form without one, which
  // can put it ahead of the form the table opens with. A separate write after the create, as first tried,
  // left exactly that on any failure between the two — and a later build cannot tell the form is new.
  //
  // The place is (highest order among the table's other Main forms) + 1 + (the form's index among the
  // spec's Main forms of that table), so several new forms keep spec order without coordinating (the
  // gaps are harmless: the order only sorts). The other forms are read ONCE per table, and every creator
  // awaits that one read before its own push, so no form this run creates is in it.
  const APPEND_FALLBACK_ORDER = 100000;
  const appendSnapshots = new Map(); // entity -> Promise<{ others, base } | { error }>
  const appendSnapshotFor = (entityLogical) => {
    if (!appendSnapshots.has(entityLogical)) {
      appendSnapshots.set(entityLogical, otherMainForms(entityLogical, new Set()).then(
        (others) => {
          const orders = others.map((o) => o.order).filter(Number.isFinite);
          return { others, base: orders.length ? Math.max(...orders) : -1 };
        },
        (error) => ({ error })
      ));
    }
    return appendSnapshots.get(entityLogical);
  };
  const createdInPlace = new Set(); // spec form entries whose create carried their order
  const createInPlace = async (formId, specForm) => {
    if (!specForm || !isMainForm(specForm) || !canOrderForms()) return;
    const entityLogical = String(specForm.entity || '').toLowerCase();
    if (plannedMainFormSequence(spec, entityLogical) || ordersByHand(spec, entityLogical)) return;
    const snapshot = await appendSnapshotFor(entityLogical);
    const idx = Math.max(0, declaredMainForms(spec, entityLogical).indexOf(specForm));
    // Unreadable neighbours: put it past any order Maker assigns (the step says so).
    const order = snapshot.error ? APPEND_FALLBACK_ORDER + idx : snapshot.base + 1 + idx;
    // The root bag of a new form, as the SDK builds it (abridged):
    //   { "c": [ { "i": 1, "node": { "n": "header", … } }, { "i": 2, "node": { "n": "footer", … } },
    //            { "i": 3, "node": { "n": "DisplayConditions", "a": [["FallbackForm", "true"]],
    //                                "c": [{ "n": "Everyone", "a": [], "c": [] }] } } ] }
    // Only the Order attribute is added; the node is replaced whole through the generic surface, as the
    // form-events region is (wireFormEvents).
    const art = await provision.getArtifact('form', formId);
    const bag = (art && art.bag && Array.isArray(art.bag.c)) ? art.bag.c : [];
    const at = bag.findIndex((e) => e && e.node && e.node.n === 'DisplayConditions');
    if (at < 0) return;
    const entry = JSON.parse(JSON.stringify(bag[at]));
    const attrs = Array.isArray(entry.node.a) ? entry.node.a : [];
    // The SDK gives a new form no Order, so it is added first, as Maker's own file has it. A node that already
    // carries one (an earlier SDK gave every new form Order "0") has it replaced, not repeated.
    const has = attrs.some((p) => Array.isArray(p) && p[0] === 'Order');
    entry.node.a = has ? attrs.map((p) => (Array.isArray(p) && p[0] === 'Order' ? ['Order', String(order)] : p)) : [['Order', String(order)], ...attrs];
    await provision.updateElement('form', formId, `/bag/c/${at}`, entry);
    createdInPlace.add(specForm);
  };
  const buildArtifact = (type, def, meta) => runner.run(`${type}s`, `${type} "${def.name}"`, async () => {
    // Update-in-place: editing a deployed spec must land, so a form is reconciled (fields +
    // sub-grids) and a view has its columns reconciled, instead of the artifact being reused
    // unchanged (the old behavior silently dropped every edit while still reporting success).
    if (type === 'form') {
      // Reconcile onto our OWN spec-named form (create it on first build, update it on re-runs) —
      // never onto the entity's stock "Information" form. The stock form can't be deleted (every
      // table must keep one main form), so reconciling onto it would attach the spec's subgrids +
      // parent lookups to an un-deletable form and strand references that block teardown. Gap 2 is
      // instead handled by making our form the entity's default (see promoteDefaultForm below).
      const existingId = await resolveExistingFormId(provision, def);
      if (existingId) return await reconcileForm(existingId, def);
    } else if (type === 'view') {
      const existingId = await provision.findArtifact('view', { name: def.name, entity: def.entityLogicalName });
      if (existingId) return await reconcileView(existingId, def, !!(meta && meta.authoredQuery));
    }
    // A form cannot be created from a full authored definition (the adapter's createDefault
    // serializes authored tabs BEFORE minting ids and throws on the id-less cells); build its body
    // through the generic surface instead (createFormShell), then place sub-grids. Other artifact
    // types (view/chart/command/dashboard/app) still serialize unchanged from a full createArtifact.
    let id;
    if (type === 'form') {
      id = await createFormShell(def);
      createdFormsThisRun.add(normalizeFormId(id));
      // AB#6736948: on a table whose order the build does not set, the form is created in its place.
      await createInPlace(id, meta && meta.specForm);
      await addSubgrids(id, def, null);
    } else {
      id = (await provision.createArtifact(type, def)).id;
    }
    const pushed = requireSuccessfulPush(await provision.pushArtifact(type, id), `${type} ${def.name}`, opts.warn);
    noteSaved(def.entityLogicalName, `${type} ${def.name}`);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const labelResolution = await resolveViewLabelsOrHalt(spec, provision, sayViewLabel, preflightResolved);
    const ids = await runner.mapLimit(spec.views || [], concurrency, (v) => buildArtifact('view', viewDef(spec, v, labelResolution), { authoredQuery: !!((v.filters || []).length || (v.sort || []).length) }));
    // Key by `entity|name` (matching identityOf.view + the snapshot canonical id). View names are unique
    // only PER ENTITY, so a name-only key lets a same-named view on another entity OVERWRITE this id and
    // cross-wire dashboards / sub-grids / AI-summaries to the wrong entity's view.
    (spec.views || []).forEach((v, i) => { result.created.views[`${v.entity.toLowerCase()}|${v.name}`] = ids[i]; });
  }

  // 4b. Enrich the auto-generated default "Active/Inactive <Entity>" system views (Dataverse ships
  // them with only the primary column). One step per enrichable entity; opt out per-entity with
  // enrichDefaultViews:false. Author-declared views (also querytype 0) are excluded by id; the SDK
  // owns the default-view resolution + fetch/setViewColumns/push/publish mechanics.
  //
  // When this build publishes at the end (phase 8), the enrichment's own publish is deferred to that
  // phase's single envelope: every enriched table used to be published twice, and each PublishXml
  // costs ~2-2.5 s even with nothing pending (measured by the SDK). The deferred call returns the
  // views whose saves still owe that publish (`pendingPublish`), and a call that fails part-way
  // carries the same record on its error. Without --publish nothing is deferred: the SDK publishes
  // the enrichment itself, as before. What is still owed when a phase halts leaves with the halt
  // (runSdkBuild), and the caller publishes it once no retry follows (settleOwedPublishes).
  //
  // The saved default views are named in the table's owed record, whether the enrichment makes the record or
  // joins one an authored view's reconcile already made (oweTablePublish): the SDK reports a view as pending only
  // when its push SAVED, so the name is there whenever the enrichment saved, which the SDK does on every build (an
  // unchanged rebuild re-sends both generated views with identical content), and a failed publish then says that the
  // generated Active/Inactive pair is not live either.
  const deferDefaultViewPublish = publishInPhase8;
  const recordOwed = (logical, record) => {
    for (const pending of (record && record.pendingPublish) || []) {
      const first = (pending.artifacts || [])[0];
      if (first && first.id) oweTablePublish(logical, first.type || 'view', first.id, `default views of ${logical}`);
    }
  };
  if (has('views')) {
    const authorViewIds = Object.values(result.created.views || {}).filter(Boolean);
    for (const e of spec.entities || []) {
      if (!enrichesDefaultViews(spec, e)) continue;
      const logical = e.schemaName.toLowerCase();
      const cols = defaultViewColumns(spec, e);
      await runner.run('views', `enrich default views for ${logical}`, async () => {
        if (!deferDefaultViewPublish) {
          const { updated } = await provision.enrichDefaultViews(logical, cols, { excludeViewIds: authorViewIds });
          return updated;
        }
        try {
          const record = await provision.enrichDefaultViews(logical, cols, { excludeViewIds: authorViewIds, publish: false });
          recordOwed(logical, record);
          // A view whose push was REFUSED — the SDK answers a concurrent edit's 412 by value, not with a
          // throw — saved nothing, so it fails the step as any other refused push does, rather than leave
          // the table looking enriched. That is also what lets the CLI treat a completed publish phase as
          // paying an earlier attempt's debt (`owedPaid`): every attempt that gets past this step has saved
          // each table's default views again, so it owes, and publishes, the same tables. Without --publish
          // the SDK publishes the enrichment itself and reports no per-view results, so a refusal there
          // stays as silent as it always was.
          for (const pushed of record.results || []) requireSuccessfulPush(pushed, `default view ${pushed && pushed.id} of ${logical}`);
          return record.updated;
        } catch (err) {
          recordOwed(logical, partialEnrichment(err));
          throw err;
        }
      });
    }
  }

  // 5. Charts (independent -> parallel; built before forms so a form could reference one).
  // Chart DEFINITION edits are not applied in place on a rebuild (there is no SDK chart-update
  // path yet), so an existing chart is skipped WITH A REASON rather than silently reported as
  // (re)built — recreate the chart to change it. New charts are created + added to the solution.
  //
  // Charts whose ENTITY should be published at the end. Keyed by entity so one publish covers it,
  // and holding the artifact id because `publishArtifact` requires the artifact to be
  // WORKSPACE-RESIDENT: it goes readRaw -> readLocal, which throws ArtifactNotFoundError rather
  // than lazily fetching. `findArtifact` does NOT populate the workspace, so an existing chart is
  // only publishable once something has created or fetched it. Recording it here — at the two
  // points that actually put it in the workspace — is what keeps phase 8 from handing publish an
  // id it cannot resolve. It is also the right SEMANTICS: publish exactly the entities whose charts
  // this run changed.
  const chartsToPublish = new Map();
  if (has('charts')) {
    const charts = spec.charts || [];
    const ids = await runner.mapLimit(charts, concurrency, async (c) => {
      const def = chartDef(spec, c);
      const existingId = await provision.findArtifact('chart', { name: def.name, entity: def.entityLogicalName });
      if (existingId) {
        // The chart DEFINITION is still not reconciled — but its description is (#496), because a
        // description is the one thing an AI agent inspecting this app later reads, and it reached
        // Dataverse only on create.
        //
        // Written with a direct column PATCH rather than fetch -> updateElement -> pushArtifact,
        // which is what views use. The difference is deliberate: `reconcileView` already pushes an
        // existing view (for columns), so that round trip is proven in production, whereas the chart
        // phase has NEVER pushed an existing chart. A push regenerates `datadescription` and
        // `presentationdescription` from the deserialized model, so it would newly expose every
        // maker-customized chart to a serialize round trip — the same class of risk as #478. A
        // single-column PATCH cannot disturb the chart definition at all.
        //
        // Same two guards as views: only when the spec EXPLICITLY sets a description (chartDef emits
        // `|| ''`, and writing that would blank a maker's text), and only when it DIFFERS.
        const wantDescription = typeof def.description === 'string' ? def.description.trim() : '';
        let reconciled = false;
        if (wantDescription && typeof provision.updateRecord === 'function') {
          try {
            // Read through the SDK's artifact surface, NOT `queryRecords`. Measured live: a chart
            // description PATCH lands on the UNPUBLISHED layer, while a plain/filtered GET returns
            // the PUBLISHED row. Reading the published value would compare across layers — the guard
            // would see a difference on every rebuild and re-issue the identical PATCH forever, which
            // is non-convergence, not a blank. `chartApi.get` uses
            // `Microsoft.Dynamics.CRM.RetrieveUnpublished()`, which is exactly the layer the PATCH
            // writes to. Verified on a live org:
            //   PATCH description -> plain GET: old value | RetrieveUnpublished(): new value
            // fetchArtifact only READS (it populates the local workspace); the chart is still never
            // pushed, so its definition is not exposed to a serialize round trip.
            await provision.fetchArtifact('chart', existingId);
            const current = await provision.getArtifact('chart', existingId) || {};
            if (String(current.description || '') !== wantDescription) {
              await provision.updateRecord('savedqueryvisualization', existingId, { description: wantDescription });
              reconciled = true;
              // The PATCH writes the UNPUBLISHED layer, so the entity must be published for the new
              // text to be served. Safe to queue only here: the fetch above has put the chart in the
              // workspace, which publishArtifact requires.
              chartsToPublish.set(String(def.entityLogicalName || '').toLowerCase(), existingId);
              noteSaved(def.entityLogicalName, `chart ${def.name}`);
              noteDescribed(def.entityLogicalName, def.name);
            }
          } catch (err) {
            // Best-effort — a description is an inspection aid and must not fail a build. But it must
            // not be SILENT either: the skip line below says "chart edits aren't applied on rebuild",
            // so an operator whose write was rejected would read that as expected and never look.
            // Silence here would recreate the exact non-convergence #496 exists to remove, one layer
            // down.
            if (typeof opts.warn === 'function') {
              opts.warn(`chart "${def.name}": could not reconcile its description (${(err && err.message) || err}); the deployed chart keeps its previous description.`);
            }
          }
        }
        // The label reports what actually happened, so "description written" and "nothing to do" are
        // not the same line.
        runner.skip('charts', `chart "${def.name}" (exists — ${reconciled ? 'description reconciled; other ' : ''}chart edits aren't applied on rebuild; recreate to change)`);
        // An existing chart the spec claims is still a component of this solution — otherwise it is
        // absent from the exported solution. (It was always visible to TEARDOWN, which resolves
        // charts by name from `spec.charts` rather than by solution membership.) Previously this
        // branch returned without adding it; the create path below and reconcileView both add theirs.
        try {
          await ensureInSolution(existingId, COMPONENT_TYPE.chart, def.entityLogicalName);
        } catch { /* already a component, or not ours to add — never fail a build over it */ }
        return existingId;
      }
      return runner.run('charts', `chart "${def.name}"`, async () => {
        const art = await provision.createArtifact('chart', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('chart', art.id), `chart ${def.name}`, opts.warn);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.chart, solutionUniqueName: sol.uniqueName });
        // Created here, so it IS workspace-resident and publishable.
        chartsToPublish.set(String(def.entityLogicalName || '').toLowerCase(), pushed.id);
        noteSaved(def.entityLogicalName, `chart ${def.name}`);
        return pushed.id;
      });
    });
    charts.forEach((c, i) => { result.created.charts[`${String(c.entity).toLowerCase()}|${c.name}`] = ids[i]; });
  }

  // 6. Forms (independent -> parallel; sub-grids reference the child view ids built above).
  //    A form with `events[]` then gets its JS handlers wired: fetch the pushed form (to
  //    retain its formxml), inject onload/onsave/onchange handlers, push + publish.
  if (has('forms')) {
    const defs = await Promise.all((spec.forms || []).map(async (f) => {
      const def = compileFormIntent(spec, f, { notesClassId: NOTES_CLASS_ID });
      const subs = [];
      // The tabs, form-columns and sections this form declares — what a sub-grid's placement is resolved against.
      const layoutNames = formLayoutNames(f);
      // Gap 7: opt-in auto sub-grids. `forms[].autoSubgrids: true` adds a sub-grid for every child
      // relationship of this form's entity (1:N where it's the parent + N:N) that isn't already
      // declared in subgrids[], so a hub table's form lists its children without hand-authoring each.
      const subgridSpecs = [...(f.subgrids || [])];
      if (f.autoSubgrids) {
        const declared = new Set(subgridSpecs.map((s) => String(s.childEntity).toLowerCase()));
        for (const c of childRelationshipsFor(spec, f.entity)) {
          if (!declared.has(c.childEntity)) subgridSpecs.push({ childEntity: c.childEntity });
        }
      }
      for (const sg of subgridSpecs) {
        // A sub-grid can hang off a 1:N (child has the lookup) or an N:N (intersect) relationship.
        const relationshipName = subgridRelationshipName(spec, f.entity, sg.childEntity);
        if (!relationshipName) continue;
        const childLogical = sg.childEntity.toLowerCase();
        const viewId = await subgridViewId(provision, result.created.views, spec, sg, childLogical);
        // Every sub-grid needs a concrete view id (the SDK embeds it in the control XML). If the
        // child entity has neither an explicit nor a built view AND no default public view can be
        // found, skip the sub-grid rather than crash the whole forms phase.
        if (!viewId) { runner.skip('forms', `sub-grid ${sg.label || sg.childEntity} on ${f.entity} (no resolvable view — skipped)`); continue; }
        // #5: title the sub-grid with the child's display name, not its logical name. Shared pure
        // helper (subgridLabel) so the eval harness grades the same title the engine writes.
        const gridLabel = subgridLabel(spec, sg);
        const entry = { targetEntity: childLogical, relationshipName, viewId, label: gridLabel };
        // Where the entry places its grid (tab / column / after / before), resolved against the layout this form
        // declares. A key-less entry carries no `placement` at all, which is what keeps it on the original path.
        const raw = placementOf(sg);
        if (raw) {
          const resolved = resolvePlacement(layoutNames, raw);
          if (resolved.ok) entry.placement = { raw, resolved };
          else reportLayoutSkip(`form ${f.name || f.entity}: the placement of the sub-grid for '${childLogical}' was ignored — the layout does not declare what it names, so the grid goes where it always does.`);
        }
        subs.push(entry);
      }
      def.__subgrids = subs;
      def.__subgridLayout = layoutNames;
      return { f, def };
    }));
    const ids = await runner.mapLimit(defs, concurrency, async (d) => {
      const id = await buildArtifact('form', d.def, { specForm: d.f });
      const wantedEvents = (d.f.events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
      if (wantedEvents.length) {
        await runner.run('forms', `wire ${wantedEvents.length} event handler(s) on ${d.f.entity}`, async () => {
          await fetchFormForWiring(id, d.f);
          // Merge into the root-bag <events> region (idempotent — a rebuild only pushes if a NEW
          // handler was appended, so re-runs don't duplicate a handler or a second <events> root).
          if (await wireFormEvents(id, wantedEvents)) {
            requireSuccessfulPush(await provision.pushArtifact('form', id), `form ${d.f.name || d.f.entity} events`, opts.warn);
            await publishReconciled('form', id, d.f.entity, `form ${d.f.name || d.f.entity} events`);
          }
        });
      }
      return id;
    });
    // Key the entity's MAIN form by entity (the app wires one form per entity below); quick-create
    // / quick-view forms are still built + added to the solution, just not the entity's app form.
    //
    // AB#6686426 — default-form promotion, ONCE per entity, AFTER every form exists.
    //
    // This used to run inside the concurrent per-form build above, so on a table with several Main
    // forms every one of them promoted itself and the LAST to finish won. Which form a table opened
    // with therefore depended on completion order — an alternate read-only or OnSave-blocked form
    // could silently become the default, changing normal app behaviour.
    //
    // Selection is explicit first (`forms[].isDefault`, then the first entry of
    // `entities[].mainFormOrder`), then a documented stable fallback: the FIRST Main form in spec
    // order. All are order-independent, which is the property that was missing. The FALLBACK is still
    // guarded to a table THIS build owns — re-pointing the default form of a system or reused table is
    // an environment-wide side effect nobody asked for — but an explicit choice is applied on any
    // table (AB#6736948: an `isDefault` on an existing table used to be dropped without a word).
    // `lib/form-order.js` holds the rule, shared with the spec gate and verify.
    const promotedEntities = new Set();
    const mainByEntity = new Map(); // entity -> { id, f } chosen for promotion
    const mainIdsByEntity = new Map(); // entity -> spec-declared Main form ids for sibling demotion
    const idOfForm = new Map(); // spec form entry -> the id this run built or reconciled
    defs.forEach((d, i) => {
      if (ids[i]) idOfForm.set(d.f, ids[i]);
      if ((d.f.formType || 'Main') !== 'Main') return;
      const key = d.f.entity.toLowerCase();
      if (!mainIdsByEntity.has(key)) mainIdsByEntity.set(key, []);
      if (ids[i]) mainIdsByEntity.get(key).push(ids[i]);
    });
    for (const entityLogical of mainIdsByEntity.keys()) {
      const chosen = selectDefaultForm(spec, entityLogical);
      const chosenId = chosen && idOfForm.get(chosen.form);
      if (!chosenId) continue;
      mainByEntity.set(entityLogical, { id: chosenId, f: chosen.form });
      // Serialized deliberately: two promotions racing is the bug being fixed. `promoted` gates the
      // bookkeeping below — a build that could not set the flag must not report a default form it
      // did not set, which is what `result.created.defaultForms` claims. Deactivating the other Main
      // forms stays limited to a table this build owns, whatever the spec says: it is destructive.
      const deactivateOthers = chosen.form.deactivateOtherMainForms === true && isOwnCustomTable(spec, entityLogical);
      const promoted = await promoteDefaultForm(chosenId, entityLogical, deactivateOthers, mainIdsByEntity.get(entityLogical) || []);
      if (promoted) promotedEntities.add(entityLogical);
    }
    if (promotedEntities.size) result.created.defaultForms = Object.fromEntries(
      [...mainByEntity].filter(([k]) => promotedEntities.has(k)).map(([k, v]) => [k, v.id])
    );

    // AB#6736948 — the Main Form Set order. `isdefault` alone does not decide what a table opens with:
    // the order does (see lib/form-order.js for the measurements), so the default form is also put
    // first. Once per table, after every form exists and after the promotion above.
    for (const entityLogical of mainIdsByEntity.keys()) {
      await applyMainFormOrder(entityLogical, idOfForm);
    }

    // overwrites the first. That is correct for what the map is for — the app shell wires one form
    // per entity — but it is invisible to a consumer reading the emitted JSON, who reasonably
    // concludes the other ids were lost. `created.formIds` below is keyed by the (entity, formType,
    // name) triple and normally holds them all.
    //
    // The warning deliberately does NOT promise that `formIds` is complete: `formIdentityKey` omits
    // `formId`, which the App Spec supports precisely so two forms can share an entity, type and
    // name. Two such pinned forms collide in `formIds` as well, and claiming otherwise would send
    // the reader to a map that cannot answer them either.
    const mainFormSeen = new Map(); // entity -> { shownName, identityKey } for the first Main form, in spec order
    defs.forEach((d, i) => {
      if ((d.f.formType || 'Main') !== 'Main') return;
      const key = d.f.entity.toLowerCase();
      // `name` is optional on a form and is compiled to "<entity> form"; using the raw spec value
      // here would print "undefined" for exactly the forms the author did not name.
      const shownName = d.f.name || (d.def && d.def.name) || `${key} form`;
      if (!mainFormSeen.has(key)) {
        mainFormSeen.set(key, { shownName, identityKey: formIdentityKey(d.f) });
      } else if (typeof opts.warn === 'function') {
        const first = mainFormSeen.get(key);
        // Compared on the stored IDENTITY KEY of the earlier form, not on a key rebuilt from its
        // DISPLAY name. Those differ for an UNNAMED form: `formIdentityKey` uses `f.name || ''`
        // while `shownName` falls back to "<entity> form", so rebuilding from the display name made
        // two unnamed Main forms look distinct when they actually collide in `created.formIds` —
        // and the warning then pointed the reader at a map that could not separate them either.
        const distinct = formIdentityKey(d.f) !== first.identityKey;
        opts.warn(`entity ${key} has more than one Main form ("${first.shownName}" and "${shownName}"); `
          + `created.forms keeps ONE id per entity for the app shell, so it now reports "${shownName}". `
          + (distinct
            ? 'The other ids are in created.formIds, keyed "entity|formType|name" — read that map rather than re-querying systemform.'
            : 'These two share an entity, type and name, so created.formIds cannot separate them either — give them distinct names.'));
      }
      result.created.forms[key] = ids[i];
    });
    // Every form, addressable individually. `created.forms` is keyed by ENTITY and holds only the
    // Main form, which is all the app shell needs — but `forms[].securityRoles` is applied in the
    // SECURITY phase (roles do not exist until then), by which time the forms phase is long over and
    // a non-Main form would be unreachable. Keyed on the same (entity, formType, name) triple the
    // spec uses to identify a form, so the lookup cannot silently bind to a same-named sibling.
    defs.forEach((d, i) => {
      result.created.formIds[formIdentityKey(d.f)] = ids[i];
    });
    // Quick-view placement: embed a built QuickView form onto a host form via a lookup column,
    // added as a canonical quick-view control cell (semantic identity = the lookup field, so a
    // rebuild doesn't duplicate it). Runs after ALL forms are built so a host can reference a
    // QuickView form created concurrently. Placed in the host's first FIELD section: a sub-grid placed ahead of the
    // form's own sections, or the Notes section, is a section the engine owns and holds nothing else.
    const formIdByEntityName = {};
    // Only QuickView forms are quick-view targets. Keying ALL forms by (entity, name) let a same-named
    // Main form on the SAME entity OVERWRITE the QuickView entry (order-dependent), embedding the wrong
    // form id — so key QuickView forms only.
    defs.forEach((d, i) => { if (d.f.name && (d.f.formType || 'Main') === 'QuickView') formIdByEntityName[`${String(d.f.entity).toLowerCase()}|${d.f.name}`] = ids[i]; });
    for (let i = 0; i < defs.length; i++) {
      const f = defs[i].f;
      const qvs = (f.quickViews || []).filter((q) => q && q.lookup && q.targetEntity && q.form);
      if (!qvs.length) continue;
      const hostId = ids[i];
      await runner.run('forms', `place ${qvs.length} quick-view(s) on ${f.entity}`, async () => {
        await provision.fetchArtifact('form', hostId);
        let changed = false;
        for (const qv of qvs) {
          // A quick-view embeds a QuickView form OF THE TARGET ENTITY — key by (targetEntity, name), not a
          // global name, so two entities with same-named QuickView forms don't cross-wire.
          const qvFormId = formIdByEntityName[`${String(qv.targetEntity).toLowerCase()}|${qv.form}`];
          if (!qvFormId) throw refusal(`form "${f.name || f.entity}" quick-view references form '${qv.form}' on '${qv.targetEntity}' which wasn't built — declare it in forms[] with formType: "QuickView", entity "${qv.targetEntity}", and a matching name`);
          const lookup = String(qv.lookup).toLowerCase();
          if (hasQuickView(await provision.getArtifact('form', hostId) || {}, lookup)) continue; // idempotent
          const rowsPtr = firstFieldSectionRowsPointer(await provision.getArtifact('form', hostId) || {});
          if (!rowsPtr) continue;
          await provision.addElement('form', hostId, rowsPtr, { cells: [quickViewCellIntent({ quickViewClassId: QUICK_VIEW_CLASS_ID, lookupFieldName: lookup, targetEntity: String(qv.targetEntity).toLowerCase(), quickViewFormId: qvFormId, label: qv.label })] });
          changed = true;
        }
        if (changed) {
          requireSuccessfulPush(await provision.pushArtifact('form', hostId), `form ${f.name || f.entity} quick-views`, opts.warn);
          await publishReconciled('form', hostId, f.entity, `form ${f.name || f.entity} quick-views`);
        }
      });
    }
  }

  // 6b. Commands (modern command-bar buttons). One command artifact per entity; a button with a
  //     library+function gets a functional JS on-click action bound to the created web resource.
  //     Pushed via the workspace-owning `provision` client (the appaction lands in the Default
  //     solution — it's not a standard solution-component type — but is entity-scoped so it shows
  //     on the entity's command bar in the app regardless).
  // 6b-pre. Business rules. Additive discover-reconcile like charts/commands: a rule is identified by
  // (entity, name), and re-pushing on every rebuild would stack duplicate rules on the table.
  //
  // The SDK writes rules ONLY through the bound `CreateProcessWithWfomJson` member — the same one the
  // modern business-rule designer uses. It used to compile a client-side WWF XAML fallback when that
  // member faulted; that fallback was DELETED upstream because it covered only 4 of the 7 action
  // types and one clause, so it silently narrowed a rule into something the platform would accept but
  // that did not say what the author wrote.
  //
  // The consequence is environment-visible and is handled below: an environment that does not declare
  // the member cannot host business rules AT ALL.
  //
  // MEASURED across a broad sample of environments: only a small minority declare the member, so the
  // gate is the COMMON case, not an edge case. Note also that declaring the member is NOT the same as
  // it working — some environments answer a real push with a server-side `MissingMethodException`,
  // which is a platform defect there rather than anything about the rule. See the
  // `businessRuleApiUnavailable` handling.
  if (has('business-rules')) {
    // Warn ONCE per build, not once per rule: on an environment without the member every rule skips,
    // and N copies of the same paragraph buries the rest of the build output.
    let businessRuleApiWarned = false;
    // The two ways a rule is refused "for this environment", and what they allow. `created` counts the rules THIS build created: the
    // switched-off answer (isConfirmedBusinessRuleRefusal) is read as "this environment does not host rules" only while it is the
    // answer to the first create. After a rule was created the environment plainly hosts them, and the same answer is a failure to halt on.
    // A rule that already existed is not a create — it proves nothing about what the member does now.
    let businessRulesCreated = 0;
    let businessRulesSwitchedOff = false;
    // A rule is skipped only for this ONE reason; anything else still halts. Matching is on the
    // SDK's documented `code`, never on `err.name` — the bundle is minified, so the class name is a
    // rebuild-unstable string (`Xe`, which is really the base SdkError), and matching it would
    // silently disarm this guard the next time the bundle is rebuilt.
    //
    // The code is looked for along the whole CAUSE CHAIN, not just on the error handed to us,
    // because the SDK signals this condition two different ways and both mean the same thing:
    //   * it THROWS the SdkError (older bundles), which arrives here directly; or
    //   * `pushArtifact` RESOLVES with `{ saved: false, error }` — the preview rollout is a reported
    //     no-op rather than a failure — and `requireSuccessfulPush` wraps that into a BuildHalt
    //     whose `cause` is the SdkError.
    // Reading only `err.code` matched the first and missed the second, so once the SDK moved this to
    // a return, every build on an environment without the member HALTED instead of skipping — and
    // AGENTS.md records that such environments are the common case, not the edge case.
    const businessRuleApiUnavailable = (err) => {
      const codes = errorCodeChain(err);
      // `BUSINESS_RULE_LEFT_DEACTIVATED` must NEVER collapse into this skip. It means a write failed
      // AND the SDK could not put the rule back into the Activated state it found it in, so a live
      // rule is sitting Draft on the server — reporting that as "this environment cannot host rules"
      // tells the operator the opposite of what they need to act on. The SDK raises it as a distinct
      // code for exactly this reason; honour the distinction here.
      if (codes.includes('BUSINESS_RULE_LEFT_DEACTIVATED')) return false;
      return codes.includes('BUSINESS_RULE_API_UNAVAILABLE') ? 'unsupported in this environment' : false;
    };
    for (const rule of spec.businessRules || []) {
      const entityLogical = String(rule.entity).toLowerCase();
      const existing = await provision.queryRecords('workflow', {
        select: ['workflowid', 'statecode', 'createdon'],
        // Definition rows only — see businessRuleFilter. Scoped to the entity as well as the name so
        // a same-named rule on a DIFFERENT table is not mistaken for this one.
        filter: businessRuleFilter(rule.name, entityLogical),
        // Oldest-first keeps reuse deterministic. Read every matching definition so the warning
        // names all pre-existing same-name rows; their names do not make them disposable.
        orderBy: 'createdon asc',
        paginate: true,
      });
      const existingId = existing && existing[0] && existing[0].workflowid;
      if (existingId) {
        for (const extra of (existing || []).slice(1)) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business rule "${rule.name}" on ${entityLogical}: kept pre-existing same-name rule ${extra.workflowid}; not attributable to this run. Review any desired cleanup separately.`);
          }
        }
        // Reuse — but a rule that EXISTS is not necessarily a rule that RUNS. A deployed rule left in
        // Draft (statecode 0) is inert, and "exists, so skip" would report success over an app whose
        // logic silently does nothing. Live-hit: a rule deactivated out-of-band stayed Draft across a
        // rebuild. So reconcile the one thing that is cheap and safe to converge — its state.
        const wantActive = (rule.status || 'Active') === 'Active';
        const isActive = existing[0].statecode === 1;
        if (wantActive !== isActive) {
          // Converge in BOTH directions. Activating a Draft rule was handled from the start; the
          // reverse was not, so a spec changed to `status: "Draft"` left the deployed rule ACTIVE and
          // still firing — a rebuild that silently ignores the one property it claims to reconcile.
          //
          // Best-effort, NOT a build halt. A rule can be wedged in a state where the platform refuses
          // both activation and deletion ("Invalid operation - You cannot activate or deactivate this
          // business rule") — live-observed on a row the SDK's bound member left behind after faulting
          // during UiData generation (#482). Failing the phase there would make one broken pre-existing
          // rule block the whole app from building, which is worse than an inert rule. The warning
          // says so, and `--verify` reports the rule's real state (see the business-rule block in
          // verify-spec.js).
          const target = wantActive ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 };
          const verb = wantActive ? 'activated' : 'deactivated';
          try {
            await provision.updateRecord('workflow', existingId, target);
            runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (existed in the wrong state — ${verb})`);
          } catch (e) {
            if (typeof opts.warn === 'function') {
              opts.warn(`business rule "${rule.name}" on ${rule.entity} exists but could not be ${verb} (${e && e.message}). It is ${isActive ? 'still running' : 'inert'}. Delete it and rebuild to recreate it cleanly.`);
            }
            runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (exists but could not be ${verb})`);
          }
        } else {
          runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (exists — reuse; rule edits aren't applied on rebuild, recreate to change)`);
        }
        result.created.businessRules[`${entityLogical}|${rule.name}`] = existingId;
        // Reconcile solution membership on the REUSE path too, for the same reason the BPF phase
        // does. `addSolutionComponent` is otherwise only reached by the create branch, so a run
        // where the rule was written but the component add failed — or a rule created by an earlier
        // build of a DIFFERENT solution — is reused forever and never joins this one, leaving it out
        // of export/import with nothing in the output saying so. The SDK treats an already-present
        // component as success, so re-issuing it every build is safe; the membership read
        // (solution-membership.js) spares the write when the solution is proven to hold the rule.
        //
        // A failure here warns rather than halts: the rule itself is correct and running, and
        // blocking an otherwise-good build over solution bookkeeping would be the worse outcome.
        try {
          await ensureInSolution(existingId, COMPONENT_TYPE.workflow);
        } catch (e) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business rule "${rule.name}" on ${rule.entity} exists but could not be added to solution '${sol.uniqueName}' (${e && e.message}). The rule works, but it will not travel on solution export until it is added.`);
          }
        }
        continue;
      }
      if (businessRulesSwitchedOff) {
        // The first create showed this environment does not host rules: the rest are not sent (each would be refused the same way).
        result.skipped.businessRules.push(`${entityLogical}|${rule.name}`);
        runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (unsupported in this environment)`);
        continue;
      }
      await runner.run('business-rules', `business rule "${rule.name}" on ${rule.entity}`, async () => {
        const def = businessRuleDef(rule);
        const art = await provision.createArtifact('businessRule', def);
        // The condition tree is a nested object, so it goes on through the generic element surface
        // rather than the create payload — mirroring how the SDK's own workflow test authors one.
        await provision.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
        // The push USED to be unable to tell you a rule was wrong: a mis-shaped condition tree was
        // MERGED onto the node, ignored by the serializer, and written as a rule with no clauses and
        // no actions — HTTP 204, activated, and it never fired.
        //
        // That trap is CLOSED at the source as of the injected-storage re-vendor. The SDK now runs
        // the business-rule designer's own completeness validator internally on EVERY save — create
        // and update, Active and Draft — so an incomplete or mis-shaped rule is REFUSED by
        // `pushArtifact` below, naming the offending clause, and nothing reaches the wire.
        // Measured and pinned in sdk-uptake-contract.test.js ("a wrongly-shaped condition is now
        // REFUSED at push, closing the empty-rule trap"), which asserts both the refusal and that no
        // request was made.
        //
        // ⚠ The explicit validation call that used to sit HERE is therefore gone, and its removal is
        // a TIGHTENING rather than a loss of coverage. It invoked the SDK's old business-rule
        // validator method, which no longer exists. The old call was best-effort by design (a bundle
        // without the method must not block a build it cannot judge), so it silently degraded to NO
        // validation whenever the vendored bundle predated it. Re-adding a defensive
        // `typeof ... === 'function'` block would now be dead code that never runs and implies
        // coverage living elsewhere.
        //
        // NOTE: the method name is deliberately NOT written in call form anywhere in this file.
        // `sdk-surface-contract.test.js` scans engine source for `sdk.<method>(` and would read a
        // mention in prose as a live call, then demand it back on the vendored bundle.
        // Verify discovery before the push; a malformed workflow id set must not be treated as
        // empty. workflows returns { "workflowid": "<id>" }. This read grants no cleanup authority.
        const beforeCreate = await provision.queryRecords('workflow', {
          select: ['workflowid'], filter: businessRuleFilter(rule.name, entityLogical), paginate: true,
        });
        if (!Array.isArray(beforeCreate) || beforeCreate.some((w) => !w || typeof w.workflowid !== 'string' || !w.workflowid.trim())) {
          throw refusal(`business rule "${rule.name}" on ${entityLogical}: before-create id snapshot is unreadable — refusing to push or delete rules without a complete id set`);
        }
        const pushed = requireSuccessfulPush(await provision.pushArtifact('businessRule', art.id), `business rule ${rule.name}`, opts.warn);
        result.created.businessRules[`${entityLogical}|${rule.name}`] = pushed.id;
        businessRulesCreated += 1;
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
        // The SDK returns the primary saved id, which is kept. It supplies no receipts for other
        // definitions, so a before/after delta cannot distinguish its retries from concurrent creates.
        const dupes = await provision.queryRecords('workflow', {
          select: ['workflowid', 'statecode'],
          filter: businessRuleFilter(rule.name, entityLogical),
          paginate: true,
        });
        const extras = (dupes || []).filter((w) => String(w.workflowid).toLowerCase() !== String(pushed.id).toLowerCase());
        for (const extra of extras) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business rule "${rule.name}" on ${entityLogical}: kept same-name rule ${extra.workflowid}; not attributable to this run. Review any desired cleanup separately.`);
          }
        }
      }, {
        // An environment that does not declare the bound member cannot host business rules at all.
        // Halting here would abandon a build that has ALREADY created the solution, tables, columns,
        // forms, views and the app — leaving a half-built app and an error 90% of the way through a
        // run, for a cause the operator can do nothing about from here.
        //
        // So this degrades the way `app.newLook` already does for its tenant-gated setting: skip the
        // artifact, say so loudly and specifically, and let the rest of the app build. Nothing wrong
        // is written — the alternative the SDK deleted (compiling a narrowed rule) is precisely what
        // must not happen. The skip is recorded on the result so `--verify` and the run summary can
        // report it rather than implying the rules exist.
        skipIf: (err) => {
          let reason = businessRuleApiUnavailable(err);
          let notCreated = `this environment does not expose the '${BUSINESS_RULE_MEMBER}' member that the modern business-rule designer uses, so there is no supported way to author them here.`;
          let remedy = 'Re-run against an environment that exposes the member, or drop businessRules[] from the spec.';
          if (!reason && businessRulesCreated === 0 && isConfirmedBusinessRuleRefusal(err)) {
            // The member is declared but switched off, and the refusal is the definitive answer to the first send of the create.
            reason = 'unsupported in this environment';
            businessRulesSwitchedOff = true;
            notCreated = `this environment answered HTTP 400 ${BUSINESS_RULE_SWITCHED_OFF_CODE} ("An unexpected error occurred") to the '${BUSINESS_RULE_MEMBER}' member, which means business-rule creation is not available on it. That is a platform limit, commonly on production environments, not a fault in the rule; the first rule was refused and the remaining rules were not sent.`;
            remedy = 'Use an environment where business-rule creation is available, or drop businessRules[] from the spec.';
          }
          if (!reason) return false;
          result.skipped.businessRules.push(`${entityLogical}|${rule.name}`);
          if (!businessRuleApiWarned && typeof opts.warn === 'function') {
            businessRuleApiWarned = true;
            opts.warn(`business rules were NOT created: ${notCreated} Everything else in the app was built normally. ${remedy} Detail: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 300)}`);
          }
          return reason;
        },
      });
    }
  }

  // 6b-post. Business process flows. Additive discover-reconcile, exactly like business rules and for
  // the same reasons: a flow is identified by (entity, name), and pushing unconditionally on every
  // rebuild would stack duplicate processes on the table. Unlike a rule, a BPF goes through the SDK's
  // GENERIC artifact surface (createArtifact -> pushArtifact) — there is no bound member and no
  // fallback path, so there is no double-write hazard to sweep up after. A flow that EXISTS has its
  // Active/Draft state converged and its stages and steps compared with the spec's: an edit that
  // leaves every deployed stage where it is in the process is applied in place, and one that would
  // remove or move a stage or a step is refused (see lib/bpf-stages.js for which, and why).
  if (has('business-process-flows')) {
    for (const flow of spec.businessProcessFlows || []) {
      const entityLogical = String(flow.entity).toLowerCase();
      const key = `${entityLogical}|${flow.name}`;
      const existing = await provision.queryRecords('workflow', {
        // `uniquename` is selected, not derived. Activation creates the flow's backing TABLE with
        // exactly this name, and the security phase grants privileges on that table. For a flow this
        // build created, `bpfUniqueName(flow.name)` IS the deployed value — but a REUSED flow may
        // have been authored in Maker or by another tool under any unique name at all, and a
        // later display-name rename does not follow it. Deriving instead of reading would then grant
        // on a table that either does not exist or, worse, belongs to something else entirely.
        // See https://learn.microsoft.com/en-us/power-automate/developer/business-process-flows-code
        select: ['workflowid', 'statecode', 'createdon', 'uniquename'],
        // Definition rows only, and BusinessFlow only — see bpfFilter.
        filter: bpfFilter(flow.name, entityLogical),
        // Ordered and > 1 for the same reason as business rules: `top: 1` unordered adopts an
        // ARBITRARY row, and seeing more than one is the only way to report a pre-existing duplicate.
        orderBy: 'createdon asc',
        top: 50,
      });
      const existingId = existing && existing[0] && existing[0].workflowid;
      if (existingId) {
        if ((existing || []).length > 1 && typeof opts.warn === 'function') {
          opts.warn(`business process flow "${flow.name}" on ${flow.entity}: ${existing.length} definitions exist with this name — the oldest is being reused. Remove the extras in Maker so users are not offered the same process twice.`);
        }
        // Exists, but a flow left in Draft is invisible on the form — "exists, so skip" would report
        // success over a process nobody can run. Converge the one property that is cheap and safe to
        // reconcile, in BOTH directions, exactly as the business-rule phase does.
        const flowLabel = `business process flow "${flow.name}" on ${flow.entity}`;
        const warnFlow = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
        const wantActive = (flow.status || 'Active') === 'Active';
        const isActive = existing[0].statecode === 1;
        const verb = wantActive ? 'activated' : 'deactivated';
        // Resolves true (converged), false (the platform refused, and it was warned about) or null
        // (nothing to do). statecode 1 / statuscode 2 = Activated; 0 / 1 = Draft. Best-effort, NOT a
        // build halt: a process the platform refuses to toggle should not block an otherwise-good
        // app, and `--verify` reports the real deployed state.
        const convergeState = async () => {
          if (wantActive === isActive) return null;
          try {
            await provision.updateRecord('workflow', existingId, wantActive ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 });
            return true;
          } catch (e) {
            warnFlow(`${flowLabel} exists but could not be ${verb} (${e && e.message}). It is ${isActive ? 'still running' : 'inert'}. Delete it and rebuild to recreate it cleanly.`);
            return false;
          }
        };
        // Its stages and steps (lib/bpf-stages.js): an edit that leaves every deployed stage where it
        // is in the process is applied in place, in one push; one that removes or moves a stage or a
        // step is refused, and no stage or step edit of the flow is then applied (its Active/Draft
        // state is still converged below, on its own).
        const stageCheck = await inspectBpfStages(provision, flow, existingId);
        if (stageCheck.kind === 'edit') {
          // The state follows the edit and never precedes it: the SDK conditions the push on the
          // row's version, and a state change in between would move that version (a 412).
          await runner.run('business-process-flows', `${flowLabel} (exists — applying ${describeBpfEdit(stageCheck.plan)} in place${wantActive === isActive ? '' : `, then ${wantActive ? 'activating' : 'deactivating'}`})`, async () => {
            await applyBpfStages(provision, flow, existingId, stageCheck.plan, opts);
          }, {
            // An edit the SDK refuses before it writes anything leaves the flow's definition as it was: say so and
            // go on, as for a flow that cannot be compared. Anything else may have half-applied a live
            // flow and halts the build.
            skipIf: (err) => {
              if (!BPF_EDIT_NOT_WRITTEN.has(err && err.code)) return false;
              warnFlow(`${flowLabel}: its stage edits were NOT applied — ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 300)}. No stage or step edits were applied; the requested Active/Draft state is handled independently. Make the change in Maker (the SDK cannot make this edit to a flow with branches or other advanced constructs), or put the spec back in line with the flow.`);
              return 'NOT applied: the SDK cannot edit this flow — see the warning';
            },
          });
          await convergeState();
        } else {
          let note = '';
          if (stageCheck.kind === 'refused') {
            warnFlow(bpfRefusalWarning(flow, stageCheck.plan.refusals));
            note = 'its stages and steps were NOT changed: see the warning';
          } else if (stageCheck.kind === 'unchecked') {
            warnFlow(`${flowLabel}: its stages could not be compared with the spec (${stageCheck.reason}); it was left as it is.`);
            note = 'its stages could not be compared: see the warning';
          }
          const converged = await convergeState();
          const state = converged === true ? `existed in the wrong state — ${verb}` : converged === false ? `exists but could not be ${verb}` : 'exists — reuse';
          runner.skip('business-process-flows', `${flowLabel} (${state}${note ? `; ${note}` : ''})`);
        }
        result.created.businessProcessFlows[key] = existingId;
        // The DEPLOYED backing-table name, read back rather than derived (see the select above). A
        // row with no `uniquename` (an older projection, or a double that does not model the field)
        // falls back to the derivation, which is still the right answer for anything this tool made.
        result.created.bpfBackingTables[key] = String(existing[0].uniquename || bpfUniqueName(flow.name)).toLowerCase();
        // Reconcile solution membership on the REUSE path too. `addSolutionComponent` is otherwise
        // only reached by the create branch, so a run where the flow was created but the component
        // add failed (or a flow created by an earlier build of a different solution) would be reused
        // forever and never join this solution — leaving it out of export/import with nothing in the
        // output saying so. The SDK treats an already-present component as success, so this is safe
        // to re-issue every build, and the membership read (solution-membership.js) spares the write when the
        // solution is proven to hold the flow. A failure here is a warning, not a halt, because the flow itself
        // is correct and blocking the build over solution bookkeeping would be worse than reporting it.
        try {
          await ensureInSolution(existingId, COMPONENT_TYPE.workflow);
        } catch (e) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business process flow "${flow.name}" on ${flow.entity} exists but could not be added to solution '${sol.uniqueName}' (${e && e.message}). The flow works, but it will not travel on solution export until it is added.`);
          }
        }
        continue;
      }
      const stageCount = (flow.stages || []).length;
      await runner.run('business-process-flows', `business process flow "${flow.name}" on ${flow.entity} (${stageCount} stage${stageCount === 1 ? '' : 's'})`, async () => {
        // The reuse query above keys on (name, entity). The SERVER key does not: it is the DERIVED
        // unique name, which strips case and punctuation and ignores the table entirely. So two
        // situations are invisible to that query and fail inside the create instead:
        //   * a RENAME that preserves the derived name — "Ticket Handling" -> "ticket-handling";
        //   * a flow with the same derived name on a DIFFERENT table, including one this spec did
        //     not author.
        // Both then fail with a platform error about a backing TABLE the author never mentioned,
        // because activation creates an org-owned table with that logical name. Naming the real
        // conflict here is the difference between a two-minute rename and an afternoon.
        //
        // The in-spec cases (two flows colliding, or a flow colliding with a declared table) are
        // rejected at the plan gate; this covers only what the spec cannot see.
        //
        // Best-effort: a DIAGNOSTIC must never be the thing that breaks a build, so a query that
        // fails or is unsupported proceeds and lets the platform speak for itself.
        const unique = bpfUniqueName(flow.name);
        let clash = null;
        try {
          const rows = await provision.queryRecords('workflow', {
            select: ['workflowid', 'name', 'primaryentity'],
            filter: `uniquename eq '${odataLit(unique)}'`,
            top: 5,
          });
          const row = (rows || [])[0];
          if (row) clash = `the flow "${row.name}"${row.primaryentity ? ` on ${row.primaryentity}` : ''}`;
        } catch { /* diagnostic only — fall through to the create */ }
        // A flow is only ONE of the things that can own that name. Activation creates a real TABLE
        // called `unique`, so an unrelated table already holding that logical name blocks the flow
        // just as surely — and that table need not have come from any flow at all. Checking only
        // `workflows` left the commonest environment-side collision undetected.
        //
        // `findTables` is the SDK's only table-existence surface and takes no server-side filter, so
        // the match is made here. It runs ONLY on the create path (never on reuse), and the SDK
        // caches the metadata read, so this does not add a per-build enumeration.
        //
        // The list is read through lib/maker-sdk.js, which refuses an answer that is no list of tables (a sign-in or proxy
        // page, `{}`, `null`) instead of reading it as "no table owns this name" — the one answer of the three ("owns it",
        // "owns nothing", "could not be asked") the check must not draw a conclusion from. The check stays a diagnostic: the
        // create below goes ahead, and the platform rejects a real collision itself. What changes is that it says so when it
        // could not be made.
        if (!clash && typeof provision.findTables === 'function') {
          try {
            const tables = await provision.findTables();
            const owner = (tables || []).find((t) => t && String(t.logicalName || '').toLowerCase() === unique);
            if (owner) clash = `the table '${owner.logicalName}'`;
          } catch (e) {
            // The first sentence of the failure says what was read; the rest advises a script that stopped, and this build goes on.
            if (unreadableAnswer(e) && typeof opts.warn === 'function') {
              opts.warn(`business process flow "${flow.name}" on ${flow.entity}: could not check whether a table already holds the name '${unique}' it derives — ${String(e.message).split('. ')[0]}. The flow is created anyway; if the create fails over a name already in use, rename the flow.`);
            }
          }
        }
        if (clash) {
          throw new BuildHalt(
            `business process flow "${flow.name}" on ${flow.entity} cannot be created: the Dataverse unique name it derives ('${unique}') is already used by ${clash}. The derivation lower-cases the name, strips punctuation and always uses the 'new_' prefix, so two differently-spelled names can collide — and activation creates a backing TABLE with that name, so only one owner can exist. Rename this flow, or remove the existing one.`,
            { phase: 'business-process-flows', code: 'bpf-unique-name-conflict', recoverable: false, retry: RETRY.NEVER });
        }
        // The whole flow — including its stages and steps — is carried on the CREATE payload. The
        // adapter normalizes and id-stamps the stage/step tree there, so unlike a business rule's
        // condition tree there is no element-surface follow-up to make.
        const art = await provision.createArtifact('bpf', bpfDef(flow));
        const pushed = requireSuccessfulPush(await provision.pushArtifact('bpf', art.id), `business process flow ${flow.name}`, opts.warn);
        result.created.businessProcessFlows[key] = pushed.id;
        // On the CREATE path the derivation is authoritative: the build supplied `flow.name`, the
        // adapter derived `uniquename` from it, and `unique` above is that same derivation — already
        // proven collision-free by the clash checks. Recorded explicitly so the security phase reads
        // ONE map regardless of which branch produced the flow.
        result.created.bpfBackingTables[key] = unique;
        // componentType 29 (workflow) — a BPF is a workflow row, so it ships in the solution the same
        // way a business rule does. Without this the process is left out of the solution and does not
        // travel on export/import.
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
      });
    }
  }

  if (has('commands')) {
    for (const [entityLogical, cmds] of Object.entries(commandsByEntity(spec))) {
      // Additive discover-reconcile (design §14): one command artifact per entity (identity = entity).
      // Re-pushing the appaction on every rebuild risks a duplicate command bar on the entity, so
      // discover-then-skip like charts/dashboards. Discovery is `resolveArtifact('command', { entity })`
      // (findArtifact has no command kind; the vendored resolveArtifact — what teardown uses to find a
      // per-entity command — does). Button EDITS are not reapplied on a rebuild — recreate to change.
      // Never removes buttons (additive only).
      const existing = await provision.resolveArtifact('command', { entity: entityLogical });
      const existingId = existing && existing[0] && existing[0].id;
      if (existingId) {
        runner.skip('commands', `command bar for ${entityLogical} (exists — reuse; button edits aren't applied on rebuild, recreate to change)`);
        result.created.commands[entityLogical] = existingId;
        continue;
      }
      await runner.run('commands', `command bar for ${entityLogical} (${cmds.length} button(s))`, async () => {
        const def = commandDef(entityLogical, cmds, result.created.webResources);
        const art = await provision.createArtifact('command', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('command', art.id), `command ${entityLogical}`, opts.warn);
        result.created.commands[entityLogical] = pushed.id;
      });
    }
  }

  // 6c. Dashboards. createArtifact('dashboard') seeds a dashboard; each chart/list/iframe/webresource
  //     tile is added as a canonical component via addElement('/components') (referencing the
  //     views/charts already built), then push + add to the solution (systemform, component type 60).
  //     Global (no entity); placement in the app sitemap is manual for now.
  if (has('dashboards')) {
    // The dashboards an earlier run of this build created and did not see join the solution (lib/dashboard-creation-records.js), read at first use. One
    // per run of the phases, so the build's own re-run of a halt reads what the attempt before it recorded. Bound to this app and solution as the spec
    // names them: a new app has no id yet, and its unique name is the spec's.
    const creations = openDashboardCreations({ workspaceDir: opts.workspaceDir, environment: opts.env, appUniqueName: spec.app ? appUniqueName(spec) : '', solutionUniqueName: sol && sol.uniqueName, warn: opts.warn });
    for (const dash of spec.dashboards || []) {
      // AB#6726727: a DOWNLOADED dashboard is bound by the id it was read from before anything is tried
      // by name. Renamed in the designer since, its spec name finds nothing — and the name path below
      // would then create a second dashboard under the old name and point the nav entry at that.
      const pinned = dash.dashboardId ? await findPinnedDashboard(provision, dash.dashboardId) : null;
      if (pinned) {
        if (dashboardNameKey(pinned.name) !== dashboardNameKey(dash.name) && typeof opts.warn === 'function') {
          opts.warn(`dashboard "${dash.name}": the dashboard this spec was downloaded from (${pinned.id}) is now named '${pinned.name}'. It is reused under that name — a build does not rename an existing dashboard — so set the spec's name to '${pinned.name}' to match.`);
        }
        runner.skip('dashboards', `dashboard "${dash.name}" (exists — reuse by its dashboardId; tile edits aren't applied on rebuild, recreate to change)`);
        result.created.dashboards[dash.name] = pinned.id;
        continue;
      }
      // A dashboard an earlier run created and stopped before adding to the solution is settled by the id that run recorded, BEFORE the name lookup
      // below: a row created and never published is in no plain read, so the lookup would create a second one, and a published one it would reuse
      // outside the solution (recoverRecordedDashboard). With nothing recorded for the name this costs nothing — no request.
      const recordedIds = creations.idsOf(dash.name);
      if (recordedIds) {
        const recovered = await recoverRecordedDashboard(provision, { dash, ids: recordedIds, sol, runner, creations });
        if (recovered) {
          result.created.dashboards[dash.name] = recovered;
          continue;
        }
      }
      // Additive discover-reconcile (design §14): a dashboard is global (identity = name), so a rebuild
      // or retry must REUSE the existing one instead of createArtifact-ing a duplicate every run (the old
      // behavior). Discovery is `resolveArtifact('dashboard', { name })` — findArtifact does NOT support
      // the dashboard kind (only view/chart/form/app), but the vendored bundle's resolveArtifact does (it
      // is what the teardown engine uses to find dashboards, sdk-teardown.js). Like charts, dashboard TILE
      // EDITS are not reapplied on a rebuild — recreate the dashboard to change it. Never removes tiles.
      const existing = await findDashboardsByName(provision, dash.name);
      let existingId = existing[0] && existing[0].id;
      // A name lookup can return several dashboards — names are not unique, and the lookup ignores
      // case, most accents and trailing spaces — and reusing the first one returned bound this app to
      // an arbitrary one, possibly another app's. The app's own is the one its solution holds; when
      // that does not single one out, halt with the names to fix rather than guess.
      if (existing.length > 1) {
        let ours = null;
        let unreadable = '';
        try {
          const members = await dashboardsInSolution(provision, sol.uniqueName, existing.map((e) => e.id));
          ours = members ? existing.filter((e) => members.has(String(e.id).replace(/[{}]/g, '').toLowerCase())) : null;
        } catch (err) {
          unreadable = ` (${(err && err.message) || err})`;
        }
        if (ours && ours.length === 1) {
          existingId = ours[0].id;
        } else {
          const reason = ours === null
            ? `and this app's solution cannot say which is its own${unreadable}`
            : `and ${ours.length ? `${ours.length} of them are` : 'none of them is'} in this app's solution '${sol.uniqueName}'`;
          await runner.run('dashboards', `dashboard "${dash.name}"`, async () => {
            throw refusal(`${existing.length} dashboards in this environment match the name '${dash.name}' (Dataverse compares names ignoring case, most accents and trailing spaces) ${reason}, so the build cannot tell which one to reuse. Rename or delete the extra ones in Maker, or give this dashboard a different name.`);
          });
        }
      } else if (existing.length === 1 && typeof opts.warn === 'function') {
        // A LONE match is reused without that proof. A downloaded app's dashboard may never have joined
        // the solution the download recovered — the one holding the APP; a dashboard made in Maker outside
        // it stays in Default — and refusing or duplicating it would break that rebuild. It is not ADDED to
        // the solution either (only a dashboard the build creates is), so teardown, which deletes solution
        // members only, keeps it. But a lone match outside the solution may be another app's namesake, and
        // this app is then bound to it with nothing to tell — so the build says so. A read that fails
        // proves nothing either way and is no reason to fail the step: the reuse is today's behaviour.
        let members = null;
        try {
          members = await dashboardsInSolution(provision, sol.uniqueName, [existing[0].id]);
        } catch {
          members = null;
        }
        if (members && !members.has(String(existing[0].id).replace(/[{}]/g, '').toLowerCase())) {
          opts.warn(`dashboard "${dash.name}": the one dashboard with this name is not in this app's solution '${sol.uniqueName}', so nothing proves it is this app's. It is reused; teardown will keep it, and a solution export will leave it out. If it is this app's, add it to the solution in Maker; if it is another app's, give this dashboard a different name.`);
        }
      }
      if (existingId) {
        runner.skip('dashboards', `dashboard "${dash.name}" (exists — reuse; tile edits aren't applied on rebuild, recreate to change)`);
        result.created.dashboards[dash.name] = existingId;
        continue;
      }
      await runner.run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = await provision.createArtifact('dashboard', { name: dash.name, ...(dash.description ? { description: dash.description } : {}) });
        // for..of, not forEach: addElement is async, and a forEach callback would fire the adds
        // without awaiting them — the push below could then race an unfinished tile insert.
        const tiles = dash.tiles || [];
        for (let ti = 0; ti < tiles.length; ti++) {
          await provision.addElement('dashboard', art.id, '/components', dashboardComponent(dashboardTileOpts(spec, tiles[ti], result), ti));
        }
        // Recorded BEFORE the push: the SDK sends this id as the row's key (`systemform.formid`), so if the run stops anywhere after the create is
        // sent — killed, its answer lost, the add below and its undo both failing — the next run still knows which row it made, which no name and no
        // plain read can tell it (lib/dashboard-creation-records.js). A record that cannot be written is one warning, and the build goes on as it did
        // before there was a record: refusing to create the dashboard would turn a local bookkeeping failure into a failed build for every dashboard,
        // to guard against a crash in the moment between two requests.
        creations.note(dash.name, art.id);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('dashboard', art.id), `dashboard ${dash.name}`, opts.warn);
        // The SDK prefers the id the service's answer names over the one it sent, and moves its copy there. When they differ, both are kept: the next
        // run reads both, and neither is confirmed on the other's word.
        const bareId = (id) => String(id).replace(/[{}]/g, '').toLowerCase();
        if (bareId(pushed.id) !== bareId(art.id)) creations.observe(dash.name, pushed.id);
        try {
          await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        } catch (err) {
          // The app's solution is the only proof, to a later rebuild or teardown, that this dashboard is
          // the app's (names are not unique — see dashboardsInSolution). Left outside it, a rebuild would
          // reuse it as a lone name match without ever adding it, and teardown would keep it as "not
          // created by this build" while its tiles blocked the chart and view deletes. So undo the push
          // — a re-run then simply creates it again — and when that fails too, say what is left behind.
          const why = (err && err.message) || String(err);
          let undoErr = null;
          try {
            await provision.deleteRemoteArtifact('dashboard', pushed.id);
          } catch (e) {
            undoErr = e;
          }
          // Proven removed only when the delete answered: the record goes with the row. When it did not, the record stays whatever the read below
          // finds — that read answers the PUBLISHED layer, where a dashboard nobody has published is not, so it cannot prove the row gone; the next run
          // reads the saved layer (recoverRecordedDashboard).
          if (!undoErr) creations.clear(dash.name);
          // deleteRemoteArtifact removes the row and THEN the local workspace copy, so a failure can come
          // from either half. Only a row that is still there is left outside the solution; when that
          // cannot be read either, assume it is.
          let stranded = false;
          if (undoErr) {
            stranded = true;
            try {
              const still = await provision.queryRecords('systemform', { select: ['formid'], filter: `formid eq ${String(pushed.id).replace(/[{}]/g, '')}`, top: 1 });
              stranded = !!(still && still.length);
            } catch { /* cannot tell — keep assuming it is still there */ }
          }
          if (stranded) {
            // Never auto-retried (isTransientHalt, build-model-app.js): the add and its undo were both refused just now, which is a person's to look
            // at, whatever transient text the causes quoted above carry — and a dashboard the record does not hold would be reused by a retry as a lone
            // name match without being added. One the record holds is added by the next run, so the halt says that instead of asking for Maker.
            const recorded = (creations.idsOf(dash.name) || []).includes(bareId(pushed.id));
            const remedy = recorded
              ? 'this build recorded it, so running the build again adds it to the solution and reuses it; or delete it in Maker before running it again, and it is created afresh'
              : "add it to the solution or delete it in Maker before re-running, or teardown will not recognise it as this app's";
            throw refusal(`dashboard "${dash.name}" was created (${pushed.id}) but could not be added to solution '${sol.uniqueName}' (${why}), and removing it again failed (${(undoErr && undoErr.message) || undoErr}) — ${remedy}`, { cause: err });
          }
          // Nothing is left behind, so a retry is safe — when the SERVICE said it may be: the cause's HTTP
          // status (a 429/503 is still auto-retried as it was before the undo existed) and its own words
          // decide, and the message, which quotes the dashboard's name and the solution's, does not.
          throw serviceFailure(`dashboard "${dash.name}" could not be added to solution '${sol.uniqueName}' (${why}), so it was removed again — re-run to create it afresh`, {
            status: err && (err.statusCode || err.status), words: judgeFailure(err).text, cause: err,
          });
        }
        // Proven in the solution: nothing is left to recover.
        creations.clear(dash.name);
        result.created.dashboards[dash.name] = pushed.id;
      });
    }
  }

  // Tracks whether the app-shell phase REUSED an already-deployed app (edit flow / retry) vs created a
  // fresh one. The pages phase needs this for two reasons: (1) the destructive-removal gate must run for
  // an EXISTING app even when the new spec has zero pages (an existing app may still reference live pages
  // the spec dropped); (2) for an existing app the sitemap write is DEFERRED entirely to the pages
  // finalizer (below), so the finalizer must run for an existing app regardless of page subareas.
  let appWasExisting = false;
  let mainFormsP;
  const resolvedMainForms = () => mainFormsP || (mainFormsP = resolveMainForms(provision.dataverse, spec, result.created.formIds));
  // Set by the app step when it leaves the create of a NEW app to the pages phase, because the app's navigation holds only page entries
  // (pagesFirstRule): the pages are created first, and this makes the app with them already in its first navigation.
  let createAppWithPages = null;

  // 7. App module + sitemap. When the app has generative-page subareas, create it WITHOUT them
  //    (they can't resolve until pages upload); the pages phase then rewrites the sitemap.
  //    A NEW app whose navigation holds ONLY page entries cannot be created that way — its first sitemap would hold no
  //    entry, which Dataverse refuses to create — so its create is left to the pages phase, which makes it once the pages
  //    exist (`createAppWithPages`), with the pages in its first navigation.
  //    For an app that ALREADY exists (edit flow / retry), its sitemap + components are write-once
  //    on create, so a plain reuse would silently drop requested subarea add/rename/reorder edits.
  //    Fetch it into this session's workspace (also required before push/publish on a cross-session
  //    edit) and rewrite the sitemap + components from the current spec so edits land idempotently.
  if (has('app-shell')) {
    // Resolve authored membership before any app write, so a typo cannot leave a partial app. Form ids
    // are now available; partial/changed-only runs resolve undeclared forms from the active Main catalog.
    const mainFormsByTable = await resolvedMainForms();
    const appTables = (spec.app && spec.app.tables) || [];
    const refs = appTables.length ? await tableRefs(provision.dataverse, appTables) : null;
    const pinTables = async (appId, alreadyPublished) => {
      if (!refs) return;
      const pinned = await pinAppTables(provision.dataverse, appId, appTables, { refs });
      if (pinned.added.length && alreadyPublished) await appWriters.publishPinned(appId);
    };
    // Self-contained app-tile icon: a web resource IN this solution (default generated, or the
    // author's spec.app.icon). Resolved BEFORE appDef so the id is embedded at create time — the
    // reliable path (an appmodule's webresourceid is effectively write-once). This replaces the
    // SDK's arbitrary external/managed icon fallback that broke import into a fresh environment.
    const iconWebResourceId = await ensureAppIcon(spec, result.created, { provision, sol, runner, unconfirmed: unconfirmedWebResources });
    const def = appDef(spec, result.created, { omitUnbuiltPages: true, iconWebResourceId, mainFormsByTable });
    // The create of a NEW app, made below — or, for a navigation of pages only, at the end of the pages phase (createAppWithPages): the
    // same writes in the same order either way.
    // Create: the full def (siteMap + explicit components + iconWebResourceId) serializes unchanged
    // through createArtifact, and push emits appmodule -> sitemap -> AddAppComponents -> publish.
    // The def leaves `published` unset on purpose, so that push publishes the app. The SDK can
    // create a never-published draft (`published: false`) for the final publish to cover — one publish
    // round trip less — but a draft answers 404 by id and is missing from the PUBLISHED projection that
    // every probe here reads (findArtifact('app'), the collision gate, the sitemap/navigation reads of
    // the pages phase that follows, verify, download). A failed first build would leave an app its own
    // re-run cannot see (it would POST the same unique name again), the pages phase would find no sitemap
    // and halt, and a build without --publish would never publish it. Pinned in sdk-opt-ins.test.js.
    const createApp = async (createDef) => {
      const pushed = requireSuccessfulPush(await explainAppPushWarnings(provision.dataverse, await appWriters.create(createDef), createDef.name), `app ${createDef.name}`, opts.warn);
      // Join the solution straight after the push, before the hidden-table pin, its read-back and the
      // publish that follows it can fail. A re-run finds the app and takes this step's reuse branch, which
      // re-asserts the membership too, so a create interrupted here never leaves a solution without its app.
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.app, solutionUniqueName: sol.uniqueName });
      // The app module and its sitemap are DISTINCT solution components — adding the appmodule does
      // NOT pull the sitemap in (it lands only in the Default solution), so export/import from the
      // app's own solution would be incomplete. Add the sitemap (componenttype 62) explicitly.
      await ensureSitemapInSolution(provision, sol, createDef.uniqueName);
      await pinTables(pushed.id, true);
      return pushed.id;
    };
    // Whether a NEW app is created after its pages: decided from the spec and the run here, and from whether the app exists by the read
    // the step makes next — the same read that decides create or reuse for every app, right before the write.
    const pagesFirst = navigationIsPagesOnly(spec) && pagesFirstRule(spec, phases, opts.changedOnly).newAppPagesFirst;
    // What the step throws to hand the create on. The runner then reports the step as SKIPPED, with the reason, rather than done (makeRunner
    // `skipIf`, entity-provision.js): an app that does not exist yet is not one this step made, and a ✓ would say it was. It is taken back by
    // identity and never leaves the step; it is a refusal (retry-policy.js) so that, were it ever to, it would say a run again changes nothing.
    const createdAfterItsPages = refusal('the app is created after its pages, by the pages phase');
    result.created.app = await runner.run('app-shell', `app "${def.name}"`, async () => {
      // Whether the app exists says whether its components can be read to prove which tables it holds forms or charts of (publishTablesBeforeApp), so it is looked up first.
      const existingId = await provision.findArtifact('app', { uniqueName: def.uniqueName });
      // Before anything below publishes the app: see publishTablesBeforeApp and publishReconciledTables. This step makes the request for the whole build, whether or not it writes the app
      // itself (it also pays the publishes the reconciles deferred), and says whether the app is pushed by a write it is sure to make, and that write sends the spec's navigation: a new app is
      // (its create), an existing one by the sitemap write of this step or of the finalizer (existingAppSitemapIsWritten). A push that is not certain — the routing description's, made only when the
      // description differs — or not planned — the placement of a default view — asks for its own tables when it is made (appWriters), from the navigation IT sends, which is not the spec's:
      // it never names a table for a write that does not happen, nor one that write does not add forms of.
      const writesSpecNavigation = !existingId || existingAppSitemapIsWritten(spec, phases, opts.changedOnly);
      await publishTablesBeforeApp(existingId, writesSpecNavigation ? { addedTables: () => appWriteTables(spec, mainFormsByTable) } : undefined);
      if (existingId) {
        appWasExisting = true;
        await provision.fetchArtifact('app', existingId);
        // Refused here, before anything is applied, whenever this run pushes the app: the finalizer (every
        // pages-phase run that rewrites the sitemap), or the app-shell pushes below (refuseUnpushedAppCopy).
        const routingSet = typeof (spec.app && spec.app.aiDescription) === 'string' && !!spec.app.aiDescription.trim();
        const pushesApp = has('pages')
          ? !(opts.changedOnly && opts.changedOnly.skipSitemapFinalize)
          : (!appHasPageSubareas(spec) || routingSet);
        if (pushesApp) await refuseUnpushedAppCopy(provision, existingId, def.name);
        // Re-assert the app module's own solution membership on every reuse, as the page manifest's is. A
        // create that failed after its push (a pin, its read-back, a publish) left the app outside the
        // solution, and a re-run lands here: without this add, a later green build exported a solution
        // without its app. Adding a component that is already a member is a no-op, so it is skipped when the
        // solution is proven to hold it (solution-membership.js). Teardown deletes the app by its unique name,
        // never by this membership, so the add changes nothing it removes.
        await ensureInSolution(existingId, COMPONENT_TYPE.app);
        // Existing-app app-shell often makes NO SDK push: its sitemap commit is in the pages finalizer.
        // Pin now, independently, and let that normal publish make the proven current layer live.
        await pinTables(existingId, false);
        // #583: the routing description rides an app push this run ALREADY makes — never a second push from
        // the same fetch (the push is If-Match). With the pages phase in the run — every CLI apply, since
        // --apply refuses a partial range that includes app-shell — the finalizer is the sole existing-app
        // sitemap writer, and applies it there, after its own re-fetch and after the removal gate. Pushing
        // the fetched app HERE would re-send the LIVE sitemap, which the SDK validates reference by
        // reference, so a subarea whose page or table was deleted in Maker would halt the run before the
        // pages phase could drop it. Without the pages phase it is applied below, right before the push
        // that carries it — after the live-page gate, so a gate that halts leaves no unrecorded edit in
        // the workspace copy for the re-run's plain fetch to refuse.
        // Update the nav tree via the generic surface. On push the adapter re-derives the app's
        // ENTITY + DashBoard components from the sitemap, so a sitemap edit's tables and dashboards
        // stay pinned. Explicit authored forms/views/charts are applied at CREATE only (below); the
        // Main-form directive is separately re-applied through root addElement after every fetch.
        // This is acceptable because a table's forms/views are auto-available once
        // the table is in the app, and every chart is independently added to the SOLUTION
        // (charts-phase addSolutionComponent) and shows on its table's chart pane. Preview limitation:
        // a NEW chart added to an ALREADY-DEPLOYED app on an edit rebuild is NOT re-pinned as an
        // explicit app component (rebuild the app fresh, or add the chart via a dashboard/sitemap, if
        // it must be an explicit component). See docs/app-builder-capabilities.md.
        // Removal-gate safety and page-backed deferral: write the existing app's sitemap here
        // ONLY when the pages phase will NOT run (so there is no removal gate to bypass) AND the spec has
        // no page subareas (a page-backed sitemap is always resolved in the finalizer). When has('pages')
        // is true, DEFER entirely: writing the omitUnbuiltPages sitemap now would strip every live GenPage
        // SubArea BEFORE the pages phase's destructive-removal gate can inspect it, silently orphaning
        // pages the spec dropped. The finalizer then becomes the sole existing-app sitemap writer and runs
        // AFTER the removal + shared-page gates. For an app-shell-only run (pages excluded) of a page-less
        // app, keep today's behavior so a nav/subarea edit still lands (design §7).
        if (!has('pages') && !appHasPageSubareas(spec)) {
          // Defense-in-depth: when the pages phase is EXCLUDED and the spec is
          // page-less, there is no pages-phase removal gate. If the LIVE existing app still has generative
          // pages, writing this omitUnbuiltPages sitemap would DETACH them (orphan records, broken nav) —
          // the exact destructive action the removal gate guards. Enforce the gate here too, fail-closed, unless
          // --allow-destructive. (A page-less app with NO live genpages writes normally. The CLI --apply
          // path is already blocked from partial phase ranges by the partial-apply guard, but runSdkBuild must be safe
          // on its own.)
          const liveSm = await fetchSitemap(provision, appUniqueName(spec));
          if (!liveSm.ok) throw new BuildHalt(`cannot verify the existing app's live generative pages before rewriting its sitemap (${liveSm.reason}) — refusing to proceed (would risk orphaning pages)`, { phase: 'app-shell', code: 'pages-sitemap-read-failed', recoverable: true, ...retryFrom(liveSm.cause, liveSm.detail) });
          if (liveSm.ids.length && opts.allowDestructive !== true) throw new BuildHalt(`refusing to rewrite a page-less sitemap over an existing app that still has ${liveSm.ids.length} live generative page(s) (would orphan them: ${liveSm.ids.join(', ')}). Include the pages phase to reconcile them, or re-run with --allow-destructive to detach.`, { phase: 'app-shell', code: 'pages-removed', recoverable: false, retry: RETRY.NEVER });
          await assertAuthorizedSitemapRewrite(provision, existingId, def.siteMap, opts.authorizedSitemapRemovals, 'app-shell');
          await provision.updateElement('app', existingId, '/siteMap', await siteMapOverLive(provision, existingId, def.siteMap, opts, result.created));
          // The header — its text (name, description) and its routing description — rides this one push, as the sitemap does.
          const header = await applyAppHeader(provision, spec, existingId, { warn: opts.warn });
          requireSuccessfulPush(await appWriters.push(existingId, def.name, header), `app ${def.name}`, opts.warn);
          reportPartialPush(await appWriters.publish(existingId), `app ${def.name}`, opts.warn);
        } else if (!has('pages') && typeof (spec.app && spec.app.aiDescription) === 'string' && spec.app.aiDescription.trim()) {
          // Reached only WITHOUT the pages phase (a programmatic partial run — the CLI refuses one on
          // --apply): a page-backed app's sitemap is not written on this run, so the routing description
          // needs its own push. That push re-sends the workspace copy's sitemap, which the SDK validates —
          // and which is the live one only because a copy holding an earlier run's unpushed edits was
          // refused above (refuseUnpushedAppCopy): replaying a stale sitemap rewrite detached live pages
          // with no gate and no --allow-destructive, and the copy's routing description may be this very
          // edit, left unpushed, so "unchanged" against it would skip the push the server still needs. A changed name or
          // description is written with it, on the same push. A run with no routing description does not push the app at all
          // here, so a partial run of that kind leaves the header's text to the pages phase, which writes the navigation and
          // the header together.
          const current = await provision.getArtifact('app', existingId) || {};
          await assertAuthorizedSitemapRewrite(provision, existingId, current.siteMap || {}, opts.authorizedSitemapRemovals, 'app-shell');
          const header = await applyAppHeader(provision, spec, existingId, { warn: opts.warn });
          if (header.changed) {
            // Nothing wrote the spec's navigation into the copy, so the push sends the copy's own (`resendsCopy`): the tables whose Main forms it adds are that navigation's.
            requireSuccessfulPush(await appWriters.push(existingId, def.name, header, { resendsCopy: true }), `app ${def.name} routing description`, opts.warn);
            reportPartialPush(await appWriters.publish(existingId), `app ${def.name}`, opts.warn);
          }
        }
        await ensureSitemapInSolution(provision, sol, def.uniqueName, solutionMembers);
        // The icon is written at create only: a spec that names one the app does not have is told so, not left reading as done.
        await warnAppIconNotApplied(provision, spec, iconWebResourceId, opts.warn);
        return existingId;
      }
      if (pagesFirst) {
        // A NEW app whose navigation holds only page entries: created with `def` it would have no entry at all (its pages do not
        // exist yet), and Dataverse refuses to create such a sitemap. So the pages phase creates the pages first and then the app,
        // through this, with the WHOLE navigation — appDef without `omitUnbuiltPages`, over `result.created.pages`, which by then
        // holds every page's id. Everything this step does before a create has been done above: the icon, the Main-form list, the
        // `app.tables` refs and the one request that publishes the tables before the app, which nothing in the pages phase undoes
        // (it writes pages and the manifest, no table, view or form).
        createAppWithPages = async () => {
          result.created.app = await createApp(appDef(spec, result.created, { iconWebResourceId, mainFormsByTable }));
          return result.created.app;
        };
        throw createdAfterItsPages;
      }
      return createApp(def);
    }, { skipIf: (err) => err === createdAfterItsPages && 'created after its pages: its navigation holds only page entries' });
  }

  // 7b. Pages (generative pages). The app now exists — or, for a NEW app whose navigation holds only page entries, it is created at the
  //     end of this phase, once its pages exist (`createAppWithPages`); implement the full §9 protocol: structural scan/parity
  //     BEFORE any write (fail-closed) → create-absent-first for nav targets (persist manifest after EVERY
  //     create, crash-safety) → resolve nav pagerefs into run-scoped staging (never mutate canonical source)
  //     → upload-once with UPDATE-identity guard → sitemap finalize. All under a single-machine advisory
  //     lockfile (courtesy, not a correctness guarantee — convergence spine is the safety guarantee).
  // Run the pages phase when the phase is enabled AND there is page work to do: the spec declares pages,
  // OR the app already existed (an existing app may still reference live pages the new spec dropped;
  // the destructive-removal gate below must run even when spec.pages is now empty), OR the app is still to be
  // created here. A FRESH app with no spec pages has nothing to build and no pre-existing pages to remove, so it
  // is correctly skipped (this also avoids spinning up genpage enumeration for every page-less app build).
  if (has('pages') && ((spec.pages || []).length || appWasExisting || createAppWithPages)) {
    // The page backend: the SDK on a throwaway workspace of its own, removed in the finally below (never the app folder's, whose copies of a
    // page would be stale the moment anyone saved it). `opts.genpage` is a seam for the tests, and is the caller's to dispose. The run's throttle budget
    // (`opts.throttle`) is handed to it, so the HTTP client it makes draws its waits for a throttled read or publish from the same five minutes as the page writes do.
    const ownGenpage = !opts.genpage;
    const genpage = opts.genpage || makeGenpageSdk(opts.env, { throttle: opts.throttle });
    const appUnique = appUniqueName(spec);
    // Recovery guard: the app id is only populated by app-shell (this run). If pages runs without it
    // (e.g. --from pages), there is nothing to upload against — HALT and require a FULL rerun. An app the app step left to this
    // phase to create has no id yet, by design: it is made below, once the pages exist.
    if (!result.created.app && !createAppWithPages) throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false, retry: RETRY.NEVER });
    const wsDir = applyWorkspaceOf(opts);
    // Advisory lease: acquired OUTSIDE the try so a failed acquire (pages-locked HALT) never triggers the
    // finally that would release a lease we never held. Correctness rests on the convergence spine, not this.
    // A lock a killed build left behind is released by this call, and `opts.warn` says so.
    const lease = acquireAppPagesLease(wsDir, appUnique, { warn: opts.warn });
    try {
      // ── THREE AUTHORITIES (Identity · Existence · Membership) ─────────────────────────────────────
      // EXISTENCE (the environment-wide page list, drafts included) drives create-vs-reuse. Fail-closed: a failed
      // listing must NOT look like "no pages" (that would recreate everything). This is NOT the sitemap —
      // a page created + manifested but not yet finalized into the sitemap is still in EXISTENCE, so a
      // crash-after-create converges to REUSE, not a duplicate.
      const enumd = await genpage.enumerateEnv();
      // The listing failed: what a run again may do follows the service's answer in `enumd.error` (the listing names no page of the maker's).
      if (!enumd.ok) throw new BuildHalt(`generative-page existence enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error}`, { phase: 'pages', code: 'pages-existence-failed', recoverable: true, ...retryFrom(enumd.cause, enumd.error) });

      // MEMBERSHIP (this app's live sitemap) — fail-closed & discriminated. Fetched BEFORE
      // reconcile because reconcile's provenance guard needs the sitemap id set (a spec pageId may bind
      // only when it is a proven member of THIS app). A page-bearing build has just created or is editing
      // the app, so the sitemap MUST be readable; ok:false is a real failure, never "empty". A fresh app's
      // sitemap is validly empty of genpages here → ids:[] (correct). Reused below for the removal gate.
      // An app this phase is still to create (`createAppWithPages`) has no sitemap: the app step's read found no app a moment ago, so
      // nothing is a member of it and nothing is read. Its answer is the one fetchSitemap gives for an app that does not exist, which the
      // conflict advice below (navigationProof) reads the same way. That proves no page: an id binds only through the creation receipt
      // a build of this app wrote for it (reconcilePageIds) — the rule that already binds a page made by a build that stopped before its
      // finalizer — and the removal gate has no live page of this app to protect.
      const membership = createAppWithPages ? { ok: false, reason: 'app-not-found' } : await fetchSitemap(provision, appUnique);
      if (!membership.ok && !createAppWithPages) throw new BuildHalt(`could not read the app sitemap (${membership.reason}) — refusing to proceed without verifying the app's page set`, { phase: 'pages', code: 'pages-sitemap-read-failed', recoverable: true, ...retryFrom(membership.cause, membership.detail) });
      const sitemapIds = membership.ok ? membership.ids : [];

      // IDENTITY (the durable manifest, discriminated read). A PRESENT-but-unparseable manifest is CORRUPT
      // and must HALT fail-closed BEFORE reconcile — reconciling it as "no identity" would recreate the
      // app's existing pages as orphans. An ABSENT manifest (present:false) is normal for a fresh app.
      const { id: readId, manifest, text, present } = await readPageManifest(provision, appUnique);
      const recordedManifestId = unconfirmedWebResources.idOf(manifestResourceName(appUnique));
      assertUnconfirmedWebResourceIdentity(manifestResourceName(appUnique), recordedManifestId, readId);
      if (recordedManifestId && !readId) await checkRecordedWebResourceName(provision, manifestResourceName(appUnique), recordedManifestId);
      if (present && !manifest) throw new BuildHalt(`the page manifest ${manifestResourceName(appUnique)} exists but is corrupt/unparseable — refusing to proceed (would risk recreating existing pages as orphans). Fix or delete the web resource and rebuild.`, { phase: 'pages', code: 'pages-manifest-corrupt', recoverable: false, retry: RETRY.NEVER });
      let manifestId = readId;
      let lastManifestContent = text;

      // Reconcile by EXISTENCE (create-vs-reuse) + MEMBERSHIP (spec-pageId provenance). Conflicts (a
      // spec pageId that is not a GUID, a spec/manifest disagreement where both ids are live, or two keys
      // → one live id) HALT — refusing to overwrite/misbind an arbitrary page.
      const live = new Set(enumd.ids.map((id) => String(id).toLowerCase()));
      const declaredKeys = new Set((spec.pages || []).map((p) => p.key || p.name));
      // Ownership proof for an UPDATE is this app's PUBLISHED navigation or a local creation receipt. A page
      // that is only in the app's saved but unpublished navigation is not bound by this build: it halts as
      // unproven, with advice to publish first (navigationProof reads the saved layer for that message). The
      // shared-page scan below reads OTHER apps' saved navigation as well as their published navigation, so a
      // page another app has saved into its navigation is caught there before it is updated.
      const placed = new Set(sitemapIds.map((id) => String(id).toLowerCase()));
      let ownership;
      try { ownership = readPageOwnership(opts.workspaceDir, appUnique, opts.env); } catch (e) {
        // `retry: NEVER`: a record on the maker's disk that cannot be read; its path — in the maker's folder — is in the message and in the error beneath, and nothing a run again does reads it.
        throw new BuildHalt(`could not read local page creation receipts (${e.message}); refusing to bind off-sitemap ids`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false, retry: RETRY.NEVER });
      }
      // The page list holds each page's name exactly as its own row has it, drafts included — so a page that was written and never published (a create
      // that stopped between its write and its publish) is found by it, where a read of the PUBLISHED rows would not see it at all.
      const listedNames = new Map((enumd.pages || []).map((p) => [String(p.pageId).toLowerCase(), p.name]));

      // PENDING CREATIONS. Every create is recorded (recordPagePending) under the id it will use, with the name and the source it sends, BEFORE it is sent. A create whose
      // answer never arrived, and whose page could not be read back either, leaves the page in the environment with nothing local that names it: the page list shows it,
      // nothing links it to its spec entry, and this build would create ANOTHER page for the entry. So each record is settled here, before anything is created:
      //   the page is there, and holds what a create under the id sent — its name and its source  -> ADOPTED. The id was minted by this build and the page holds what this build
      //                                                          sent under it, so a creation receipt is written (the same proof a create that was answered leaves),
      //                                                          the record is consumed, and the page is updated like any page this build created — which is also how
      //                                                          what an earlier create sent (another model or name, say) is brought to what this build asks for.
      //   the page is there, and holds something else                                              -> a CONFLICT. A pending record is intent, not ownership: it authorizes nothing — not
      //                                                          an update, not a delete — and a page that no create under the id sent (it is named otherwise, or its
      //                                                          source is not one that was sent) is not adopted.
      //   the page is not there                                                                    -> the create is sent again under the SAME id: a send that is still in flight
      //                                                          collides on it, so one page can result. If the key is bound to another page by the time it is
      //                                                          reconciled, nothing is created — and the record is KEPT (see below).
      const resumeIds = new Map();
      const resumeSent = new Map();
      const adoptedPending = [];
      const pendingConflicts = [];
      let pendingByKey;
      try { pendingByKey = readPendingCreations(opts.workspaceDir, appUnique, opts.env); } catch (e) {
        throw new BuildHalt(`could not read local records of page creations that were started (${e.message}); refusing to create pages past a record this build cannot read`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false, retry: RETRY.NEVER });
      }
      for (const [key, pendingRecords] of pendingByKey) {
        // A key this spec does not declare is another build's, or an earlier spec's: left as it is, and it keeps blocking `--clear-workspace` until settled.
        if (!declaredKeys.has(key)) continue;
        // A record whose create was ACKNOWLEDGED — this workspace holds the creation receipt for the same key and id — is what is left of a removal that failed: recordCreate writes the receipt
        // first and consumes the record after, and a record it could not remove (a scanner holding the file) is a warning, not a halt. The receipt is the stronger evidence, so the record
        // is consumed here, before any proof by name and source. That proof is the wrong one for such a page: it fails as soon as the page was changed since its create — a maker's save, or a
        // navigation target created with PAGEREF_ tokens and then rewritten with its links resolved, in the same build — and would halt the build as a conflict over a page this build made and recorded.
        const records = [];
        for (const record of pendingRecords) {
          if (!ownership.created.some((r) => r.key === key && r.pageId === record.pageId)) { records.push(record); continue; }
          try { completePendingCreations(opts.workspaceDir, appUnique, [record.pageId], opts.env); } catch (e) {
            if (typeof opts.warn === 'function') opts.warn(`page "${key}": the record of its create (${record.pageId}) could not be removed although the page was recorded as created (${e.message}); a later build removes it`);
          }
        }
        if (!records.length) continue;
        if (records.length > 1) { pendingConflicts.push({ key, reason: 'multiple-pending-creations', pageIds: records.map((r) => r.pageId) }); continue; }
        const [record] = records;
        const resume = () => { resumeIds.set(key, record.pageId); resumeSent.set(key, record.sent); };
        if (!live.has(record.pageId)) { resume(); continue; }
        // The page is there: its name is in the listing, and its source — the other half of what a create under the id sent — is read.
        let page;
        try { page = await genpage.read(record.pageId); } catch (e) {
          // Gone since the listing: it is not there now, which settles nothing (see below), so it is resumed like any page that was not listed.
          if (e && e.code === 'GENPAGE_NOT_FOUND') { resume(); continue; }
          // A read the service throttled and the run's budget had no room to wait for says nothing of the page (genpage-sdk.js reports it as the throttle's own error, which is not marked final): it is not a conflict that the maker has to settle by
          // deleting a record, but a stop for a later run. The record stays, so the run that can read the page proves it and adopts it. A read that failed any other way is final (`transient: false`) and is the conflict it always was.
          const judged = judgeFailure(e);
          if (!judged.never && judged.transientStatus) {
            throw new BuildHalt(`could not read page ${record.pageId}, which an earlier build started creating for "${key}", because the service throttled the read (${(e && e.message) || e}) — nothing was changed; the record of that create is kept, so a later run reads the page and settles it`, { phase: 'pages', code: 'pages-read-throttled', recoverable: true, ...retryFrom(e) });
          }
          pendingConflicts.push({ key, reason: 'pending-create-unreadable', pageId: record.pageId, error: String((e && e.message) || e) });
          continue;
        }
        if (!holdsWhatWasSent(record.sent, page)) {
          pendingConflicts.push({ key, reason: 'pending-create-unproven', pageId: record.pageId, why: describeDivergence(record.sent, page) });
          continue;
        }
        try {
          ownership.created.push(recordPageCreation(opts.workspaceDir, appUnique, key, record.pageId, page.name, opts.env));
          completePendingCreations(opts.workspaceDir, appUnique, [record.pageId], opts.env);
          adoptedPending.push({ key, pageId: record.pageId, name: page.name });
        } catch (e) {
          // `transient: false`, as for any creation receipt that cannot be saved: the build's re-run of a halt it takes for transient must not run on.
          throw new BuildHalt(`page "${page.name}" was found as ${record.pageId} (a create an earlier build started), but its local receipt could not be saved (${e.message}); stopping before manifest or sitemap changes`, { phase: 'pages', code: 'pages-creation-receipt-failed', recoverable: false, retry: RETRY.NEVER });
        }
      }
      if (pendingConflicts.length) {
        const why = pendingConflicts.map((c) => {
          if (c.reason === 'multiple-pending-creations') return `page "${c.key}" has ${c.pageIds.length} unfinished creations (${c.pageIds.join(', ')}), and this build cannot tell which one is its page`;
          if (c.reason === 'pending-create-unreadable') return `page ${c.pageId} exists under the id an earlier build minted for "${c.key}", but it could not be read to tell whether it is a page that build sent (${c.error}), so it is neither adopted nor updated`;
          return `page ${c.pageId} exists under the id an earlier build minted for "${c.key}", but it is not a page that build sent: ${c.why} — so it is neither adopted nor updated`;
        });
        throw new BuildHalt(`generative-page creation(s) that an earlier build started cannot be settled: ${why.join('; ')}. Look at the page(s) in the environment: delete the one that is not yours, or delete the "pending" record(s) named in ${path.join(path.resolve(opts.workspaceDir || '.'), 'page-ownership.pending.*.json')} for a page you have confirmed is not this app's, and re-run.`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false, retry: RETRY.NEVER });
      }
      const createdIds = creationIds(ownership);
      const storedNames = new Map();
      const nameReadErrors = [];
      const nameCandidates = [
        ...((manifest && manifest.pages) || []),
        ...(spec.pages || []).map((p) => ({ key: p.key || p.name, pageId: p.pageId })),
        ...ownership.created,
      ];
      // The STORED name of an interrupted, unplaced create is what corroborates its creation receipt: manifest and spec labels are not proof
      // (`listedNames`, above). `unescapePacName` gives the name a page an earlier release created was given (pac stored `"` as `\"`).
      const nameReads = new Set();
      for (const mp of nameCandidates) {
        const id = String(mp.pageId || '').toLowerCase();
        if (!declaredKeys.has(mp.key) || !live.has(id) || placed.has(id) || nameReads.has(id)) continue;
        nameReads.add(id);
        const listed = listedNames.get(id);
        if (typeof listed === 'string' && listed) storedNames.set(id, unescapePacName(listed));
        else nameReadErrors.push(`${id}: stored page name is unreadable`);
      }
      // A page adopted from a pending record is tied to its key by more than a receipt and a stored name: it holds a name and a source that a create under its id sent. Its stored
      // name may be an older one than the spec's now — the spec renamed the page since the create that left it — which the receipt rule below would read as "not corroborated" and
      // refuse, though the page is provably this entry's. It is the name this build gave the page, so it stands in for the spec's, and the update that follows renames the page.
      for (const adopted of adoptedPending) {
        const entry = (spec.pages || []).find((p) => (p.key || p.name) === adopted.key);
        if (entry) storedNames.set(adopted.pageId, entry.name);
      }
      const { keyToId, conflicts } = reconcilePageIds(spec.pages, manifest, enumd.ids, sitemapIds, storedNames, createdIds);
      if (conflicts.length) {
        const unproven = conflicts.filter((c) => c.reason === 'unproven-manifest-id');
        // Say WHY each one is unproven. "Add it to the app's navigation" is no help for a page the maker has
        // already saved there without publishing, so read the saved layer and name that case.
        const saved = unproven.length ? await navigationProof(provision, appUnique, membership, unproven.map((c) => c.manifestId)) : null;
        const savedNav = saved && saved.currentNavigation;
        const inSavedNav = new Set(savedNav && savedNav.ok ? savedNav.ids.map((id) => String(id).toLowerCase()) : []);
        const unreadDraft = savedNav && !savedNav.ok
          ? ` (its saved but unpublished navigation could not be read: ${savedNav.reason} — re-run)`
          : '';
        const recovery = unproven.map((c) => {
          const name = JSON.stringify(c.storedName || c.requestedName || '(unreadable name)');
          // The page verbs of scripts/genpage.js, ready to run: this app's id is known by now (the pages phase halts without the app — but for an app this
          // phase is still to create, whose advice is its own, below), and the environment is the one the build runs in.
          const place = genpageCommand('add-to-app', { env: opts.env, pageId: c.manifestId, app: { id: result.created.app, note: "this app's id" } });
          if (inSavedNav.has(String(c.manifestId).toLowerCase())) {
            return `page ${c.manifestId} (${name}) is only in this app's saved but unpublished navigation: publish the app — ${place} publishes it, since the page is already in its saved navigation — then re-run. The build updates a page only when the app's published navigation or a local creation record proves it is this app's, so that other apps' navigation is checked before an update`;
          }
          const proofText = c.hasCreationReceipt
            ? 'its local creation record does not corroborate the stored name'
            : 'this workspace holds no record that this app created it in this environment';
          const removal = genpageCommand('delete', { env: opts.env, pageId: c.manifestId, flags: ' --allow-destructive' });
          // An app this phase is still to create has no navigation to add the page to, so the record is the only proof there can be: the
          // workspace that created the page holds it (a build run from there adopts the page and creates the app with it).
          if (createAppWithPages) {
            return `page ${c.manifestId} (${name}) is in no navigation of this app — the app does not exist yet: its navigation holds only page entries, so the build creates it once its pages exist — and ${proofText}: if it is this app's page, run the build from the workspace that created it, which holds that record; if not, remove the stale id from the manifest/spec (or delete the page, after asking the user — it is permanent: ${removal}) and re-run`;
          }
          return `page ${c.manifestId} (${name}) is not in this app's navigation${unreadDraft} and ${proofText}: if it is this app's page, add it to the app's navigation with ${place} (it publishes the app and proves the page in what runs) and re-run; if not, remove the stale id from the manifest/spec (or delete the page, after asking the user — it is permanent: ${removal}) and re-run`;
        });
        throw new BuildHalt(`generative-page identity conflict(s): ${JSON.stringify(conflicts)}${nameReadErrors.length ? `; stored-name reads failed: ${nameReadErrors.join('; ')}` : ''} — refusing to overwrite/misbind a page. ${recovery.length ? recovery.join('; ') : 'Resolve the duplicate/mismatched id(s) in the spec/manifest and rebuild.'}`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false, retry: RETRY.NEVER });
      }
      // A key that is bound to a page does not create one, so a creation an earlier build left pending for it is not resumed. What becomes of its record is decided by what is KNOWN
      // about its page, never by one listing:
      //   the page was there (adopted above)  -> if the key is bound to ANOTHER page, this one is an unused page this build made: reported, with its id. It has a creation receipt now,
      //                                           so teardown finds it and deletes it; nothing else here touches it.
      //   the page is not there               -> the record is KEPT, and said so. An absence is one snapshot, not proof that the request which would make the page cannot still
      //                                           land; if it lands later it would be a page with no key, no receipt and no record — nothing to find it by, teardown included. The
      //                                           record is that trace: a later build adopts the page if it appears (or reports it, if the key is bound elsewhere), teardown deletes
      //                                           it, and `--clear-workspace` waits for it. Deleting the record by hand, once the page is known not to exist, is the explicit way out.
      const warnPending = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
      for (const adopted of adoptedPending) {
        const bound = keyToId.get(adopted.key);
        if (bound === undefined || String(bound).toLowerCase() === adopted.pageId) continue;
        warnPending(`page ${JSON.stringify(adopted.name)} (${adopted.pageId}) was created by an earlier build for "${adopted.key}" — its answer was lost — and is not used: "${adopted.key}" is bound to ${bound}. It is recorded as a page this app created, so teardown deletes it; or delete it in Maker.`);
      }
      for (const [key, pendingId] of resumeIds) {
        if (!keyToId.has(key)) continue;
        warnPending(`page "${key}" is bound to ${keyToId.get(key)}, so the create an earlier build started under ${pendingId} is not resumed. No such page is in the environment now, but a request still in flight can create it later, so its record is kept: a later build adopts the page if it appears, teardown deletes it, and --clear-workspace waits for it. Delete the "pending" record(s) in ${path.join(path.resolve(opts.workspaceDir || '.'), 'page-ownership.pending.*.json')} for ${pendingId} only once you have confirmed that no such page exists, in Maker too.`);
      }

      // DUPLICATE-NAME MATERIALIZATION GATE (post-reconciliation). validateAppSpec TOLERATES a duplicate
      // page name only when every colliding page is PRE-EXISTING (carries a pageId) — but a spec pageId is a
      // CLAIM, not proof of live existence. reconcilePageIds is the authority: a stale/unprovenanced id (e.g.
      // a page deleted in Maker since this snapshot was downloaded) is NOT bound into keyToId, so the upload
      // loop below would CREATE it fresh and re-materialize the duplicate the app-spec rule meant to prevent.
      // A dup-name group is safe ONLY when EVERY member reconciled to a live id (all id-matched UPDATEs). If
      // any member is unbound (would be created), HALT before any write — matching the validation rule's
      // intent (never CREATE a duplicate name) rather than creating it and only catching it in verify after
      // the pages/manifest/sitemap were already written.
      const pagesByLowerName = new Map();
      for (const p of spec.pages || []) {
        if (!p || !p.name) continue;
        const nl = String(p.name).toLowerCase();
        const arr = pagesByLowerName.get(nl) || [];
        arr.push(p);
        pagesByLowerName.set(nl, arr);
      }
      for (const group of pagesByLowerName.values()) {
        if (group.length < 2) continue;
        const unbound = group.filter((p) => !keyToId.has(p.key || p.name));
        if (unbound.length) {
          throw new BuildHalt(`refusing to CREATE a duplicate-named generative page: ${unbound.length} of ${group.length} pages named '${group[0].name}' are NOT bound to an existing deployed page (their pageId is absent/stale — e.g. the page was deleted in Maker since this spec was downloaded), so this build would re-materialize the duplicate. Re-download the app for fresh page ids, or rename/remove the stale page(s) in the spec.`, { phase: 'pages', code: 'pages-duplicate-name-create', recoverable: false, retry: RETRY.NEVER });
        }
      }

      // ── DESTRUCTIVE-REMOVAL GATE. Runs even when spec.pages is empty, and BEFORE any sitemap write
      // (the app-shell existing-app write is now deferred to the finalizer below, so nothing has stripped
      // the live pages yet). The app's CONFIRMED live page set is MEMBERSHIP ∩ EXISTENCE — sitemap ids that
      // still exist env-wide (a stale SubArea whose page was deleted in Maker is dropped, so it is never
      // mis-flagged as "removed"). keptIds are the CONFIRMED reconciled ids (keyToId), NOT raw spec pageIds
      // (an unprovenanced spec pageId is not bound, so it cannot mask a real removal). A live page the spec
      // no longer keeps would be orphaned by the rebuild → HALT with a report, UNLESS --allow-destructive,
      // in which case the scope is DETACH-only: the finalizer omits the page's SubArea (no page-record
      // delete). New (absent) pages aren't in the live set, so they are never flagged.
      const existenceLower = new Set(enumd.ids.map((id) => String(id).toLowerCase()));
      const keptIds = new Set(Array.from(keyToId.values()).map((id) => String(id).toLowerCase()));
      const liveAppIds = sitemapIds.filter((id) => existenceLower.has(String(id).toLowerCase()));
      const removedIds = liveAppIds.filter((id) => !keptIds.has(String(id).toLowerCase()));
      if (removedIds.length && opts.allowDestructive !== true) throw new BuildHalt(`refusing to orphan ${removedIds.length} generative page(s) the spec removed but the app still references: ${removedIds.join(', ')}. Re-run with --allow-destructive to detach them (the page records are LEFT deployed; only the app's nav SubAreas are removed), or restore them to the spec.`, { phase: 'pages', code: 'pages-removed', recoverable: false, retry: RETRY.NEVER });

      // ── SHARED-PAGE DETECTION (report-only, FAIL-CLOSED). A page we are about to UPDATE (a reused
      // id in keyToId) that ALSO belongs to ANOTHER app's sitemap is shared (added to a second app in Maker) — updating
      // its content would mutate a page another app uses. GROUNDED (live probe): a genpage has NO
      // appmodulecomponent row, so the ONLY membership signal is the sitemap XML; there is no direct
      // genpage→apps join, so we scan every OTHER app's sitemap (fetchAppsForPages; `excludeAppUnique` self-
      // skips, so a single-app env reads zero other sitemaps). BOTH layers count: an app's published sitemap
      // and its saved (current, unpublished) one — a page another app has saved into its navigation but not
      // yet published is still that app's, and publishes at any moment. An app that was NEVER published has no
      // published layer and no row in the published app list, so the scan lists those too (one request; a
      // single-app env pays that one request and nothing more). The saved layer of all other apps is
      // one extra request. FAIL-CLOSED: an env-scan failure (the saved read included) OR any app
      // whose sitemap we cannot read HALTs — an unreadable app could be the one that shares the page, so we
      // cannot prove non-sharing. On positive detection (id in ≥1 other app) → HALT (never auto-modify);
      // --allow-destructive does NOT authorize cross-app mutation (this HALT has no escape by design).
      //
      // The scan is a snapshot, and another maker can add a page to another app's navigation while this build runs: no lease reaches
      // another app (the one above is this workspace's), Dataverse offers no write conditional on another app's sitemap, and the update
      // itself goes through `pac`, which takes no precondition. So a build that writes a page in place takes the same scan twice more
      // (sharedPagesNow, in the upload loop below): right before the first page is written in place, which halts on a page that became
      // shared while pages were created and navigation resolved; and after the last — or after the loop stops early — which REPORTS a page
      // that became shared while the uploads ran: written by then, so it names the app rather than claim a protection it could not give.
      // A page this run created is left out of both: it was not there to share when the build began. Each scan reads every other app's
      // navigation (three requests per other app, and three more), so it is taken those two times, not before every page.
      const scanShared = async (ids) => {
        const scan = await fetchAppsForPages(provision, ids, { excludeAppUnique: appUnique });
        if (!scan.ok || scan.unreadable.length) return { scan, entries: null };
        // An app that has the page ONLY in its saved navigation is named as such: nothing in its published app shows the page yet. `detach` is the command that takes the page out of each app that holds it.
        return { scan, entries: Array.from(scan.byId, ([id, apps]) => {
          const savedOnly = (scan.savedOnly && scan.savedOnly.get(id)) || [];
          return {
            id,
            published: apps.some((app) => !savedOnly.includes(app)),
            text: `${id} (also in ${apps.map((app) => (savedOnly.includes(app) ? `${app} [saved, not published]` : app)).join(', ')})`,
            detach: apps.map((app) => genpageCommand('remove-from-app', { env: opts.env, pageId: id, app: { id: scan.appIds && scan.appIds.get(String(app).toLowerCase()), note: `id of app ${app}` } })),
          };
        }) };
      };
      const sharedPagesNow = async (ids) => {
        const { scan, entries } = await scanShared(ids);
        if (!scan.ok) throw new BuildHalt(`could not scan the environment for pages shared across apps (${scan.error}) — refusing to UPDATE a page without verifying it is not shared. Re-run to retry.`, { phase: 'pages', code: 'pages-shared-check-failed', recoverable: true, ...retryFrom(scan.cause, scan.error) });
        // `retry: NEVER`: an app whose sitemap cannot be read is one a maker has to fix or remove; the message names other apps, which are theirs.
        if (scan.unreadable.length) throw new BuildHalt(`cannot verify pages are not shared across apps — ${scan.unreadable.length} app(s) had an unreadable sitemap (${scan.unreadable.join(', ')}); one of them could share a page we are about to UPDATE. Fix or remove the unreadable app(s), then rebuild.`, { phase: 'pages', code: 'pages-shared-check-failed', recoverable: true, retry: RETRY.NEVER });
        return entries;
      };
      const updateIds = Array.from(keyToId.values());
      if (updateIds.length) {
        const shared = await sharedPagesNow(updateIds);
        if (shared.length) {
          throw new BuildHalt(`generative page(s) shared across apps: ${shared.map((s) => s.text).join('; ')} — refusing to UPDATE a page another app's sitemap references (a rebuild would mutate shared content). ${detachAdvice(shared.flatMap((s) => s.detach))}`, { phase: 'pages', code: 'pages-shared-across-apps', recoverable: false, retry: RETRY.NEVER });
        }
      }

      // A write the SDK could not confirm leaves the manifest's row under the error's id: kept, so that this run's next persist writes it again by that id,
      // and the record gives the next run the id to write it by where its published copy is not what that run wants (where it is, that run keeps it) —
      // never a second create of the name (persistPageManifest).
      const persistNow = async () => {
        let pr;
        try { pr = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent, solutionMembers, unconfirmedWebResources); } catch (e) {
          if (isUnconfirmedWrite(e)) manifestId = e.id;
          throw e;
        }
        manifestId = pr.id;
        lastManifestContent = pr.content;
      };
      const recordCreate = (p, id) => {
        // No workspace means no durable creation authority. Normal CLI builds always supply one.
        if (!opts.workspaceDir) {
          if (typeof opts.warn === 'function') opts.warn(`page "${p.name}" created as ${id}, but no workspace was supplied; an off-sitemap retry will require explicit resolution.`);
          return;
        }
        try { recordPageCreation(opts.workspaceDir, appUnique, p.key || p.name, id, p.name, opts.env); } catch (e) {
          // `transient: false`: the page exists and nothing records it, so the build's own re-run of a halt it takes for transient (isTransientHalt, build-model-app.js — which reads this
          // message, and so the page's name: "SQL Timeouts" would match) would create a second one beside it.
          throw new BuildHalt(`page "${p.name}" was created as ${id}, but its local receipt could not be saved (${e.message}); stopping before manifest or sitemap changes`, { phase: 'pages', code: 'pages-creation-receipt-failed', recoverable: false, retry: RETRY.NEVER });
        }
        // The receipt is what the page's creation is now known by; the record that stood for it while it was not is consumed after it, never before. One that cannot be
        // removed is harmless — the next build finds the receipt for the same key and id when it settles the pending records (above), and consumes the record without proving the page again — so it is not a halt.
        // The record is consumed even when an earlier send of this create is still in flight (the first of two that got no answer, with the resend acknowledged): the page exists, so a late send collides on its id
        // and makes nothing. What this does not cover is that send landing after the page was DELETED — it would make the page again, and nothing would name it. Accepted, for the reason AGENTS.md gives next
        // to the pending records: no client can cancel a request it gave up on or know when it can no longer arrive, so a record kept until then could never be consumed.
        try { completePendingCreations(opts.workspaceDir, appUnique, [id], opts.env); } catch (e) {
          if (typeof opts.warn === 'function') opts.warn(`page "${p.name}": the record of its create (${id}) could not be removed after the page was recorded (${e.message}); a later build removes it`);
        }
      };

      const keyOf = (p) => p.key || p.name;
      const canonicalPath = (p) => resolveAppSource(opts.appDir, normalizePageSource(p).codeFile);
      // One create, with its identity written down FIRST. The id the page is created under is recorded (recordPagePending) before the first request is sent, with the name and the
      // source it sends, so a create whose answer never arrives — and whose page cannot be read back either — is not forgotten: the next build finds the record (above) and adopts the
      // page if it holds what was sent, or sends the create again under the same id. `resumeIds` holds the id an earlier build minted for this key when its page is not in the
      // environment, and `resumeSent` what that build (and any after it) sent under it: the backend treats such a create as one with an earlier send still open, and recognises a page that
      // appears under the id by them.
      // The record is settled here too: acknowledged — recordCreate writes the receipt and consumes it — or known to have written nothing, which leaves nothing that
      // could land, so it is consumed; an outcome that is not known keeps it. No workspace, no record (recordCreate says so).
      const createPage = async (p, fields) => {
        const key = keyOf(p);
        let sentUnder = null;
        try {
          return await genpage.create({
            ...fields,
            caller: 'build',
            // The hash of the compiled output the draft holds when the page is published, for the publish record: what is certified is the runtime, not only the source (`provedVersions`).
            runtimeEvidence: true,
            // The budget of waiting a throttle costs this run: one for every page, and for the build's own waits (lib/throttle-budget.js). Absent when the engine is run with none, and the write then has one of its own.
            ...(opts.throttle ? { throttle: opts.throttle } : {}),
            ...(resumeIds.has(key) ? { pageId: resumeIds.get(key), sentBefore: resumeSent.get(key) } : {}),
            beforeSend: async (id, sent) => {
              sentUnder = id;
              if (opts.workspaceDir) recordPagePending(opts.workspaceDir, appUnique, key, id, sent.name, opts.env, sent.sourceSha256);
            },
          });
        } catch (e) {
          // A page found under the id that no create under it sent: the conflict a page listed under a pending id is, said the same way. Nothing was adopted, published or updated.
          if (e && e.code === 'GENPAGE_CREATE_DIVERGED') throw new BuildHalt(e.message, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false, cause: e, retry: RETRY.NEVER });
          // Only for a create this build started itself. A resumed one may share its id with a request an earlier build sent that has still not arrived, which a refusal of THIS send says nothing about.
          if (sentUnder && opts.workspaceDir && e && e.outcome === 'nothing' && !resumeIds.has(key)) {
            try { completePendingCreations(opts.workspaceDir, appUnique, [sentUnder], opts.env); } catch { /* the record of a create that wrote nothing: the next build resumes it, or keeps it while the key is bound to another page — not a reason to halt */ }
          }
          throw e;
        }
      };
      const implemented = [];
      // `spec.pages || []` — the phase can run with no spec pages (a removal-only / detach run reaches here
      // for the removal gate + sitemap finalize), so never assume spec.pages is an array.
      for (const p of spec.pages || []) {
        const src = normalizePageSource(p);
        if (src && src.kind === 'tsx' && src.codeFile) implemented.push(p);
        else runner.skip('pages', `page "${p.name}" (no tsx source)`);
      }

      // A page that SUPPLIES an empty prompt or agent message would otherwise have generated text
      // deployed in its place. Checked here, before ANY upload, so a bad spec fails whole rather than
      // leaving half the pages deployed. Absent keys are untouched — only a present-but-blank value is
      // an authoring mistake. Same rule as the standalone CLI, via the same predicate.
      for (const p of implemented) {
        for (const [field, value] of [['prompt', p.prompt], ['agentMessage', p.agentMessage]]) {
          if (suppliedButBlank(value)) {
            throw new BuildHalt(`page "${p.name || keyOf(p)}": ${field} is present but blank — refusing to deploy generated text in its place. Give it real content or remove the key.`, { phase: 'pages', code: 'pages-blank-provenance', recoverable: false, retry: RETRY.NEVER });
          }
        }
      }
      // (1) STRUCTURAL SCAN of every implemented canonical source BEFORE any write, via the single
      //     nav oracle (extractNavTargets). Reject a malformed (non-canonical) nav PAGEREF and enforce EXACT
      //     parity between declared navigatesTo targetKeys and the keys the source references at REAL nav
      //     call sites — a decoy "PAGEREF_" string or a stray GUID in a comment can never pass.
      //     It also rejects `dynamic` (variable/expression) and `literal`
      //     (hardcoded GUID) nav pageIds — a nav target must always be a declared "PAGEREF_<key>" symbol.
      //     The Griffel check (AB#6691124) rides the same scan: a `makeStyles` key Griffel drops at runtime ships a page
      //     without its border, colour or reset, and nothing else on the way to the service notices — so a page that would
      //     ship one is refused here, with the file, line, column and longhands, whoever wrote it and whatever instructions
      //     they followed (scripts/check-griffel-styles.js is the same check, run earlier for quicker feedback).
      // Which pages THIS run uploads: the Griffel check is held only against those. A changed-only run uploads its selected keys and
      // mints an absent navigation target, and nothing else; a page it does not upload is not shipped, so it is not refused for a defect
      // it is not shipping (the rest of this scan still covers every page, because navigation resolves across all of them).
      const navTargets = new Set();
      for (const p of implemented) for (const n of p.navigatesTo || []) navTargets.add(n.targetKey);
      const selectedKeys = opts.changedOnly && Array.isArray(opts.changedOnly.selectedKeys) ? new Set(opts.changedOnly.selectedKeys) : null;
      const uploadedThisRun = (p) => !selectedKeys || selectedKeys.has(keyOf(p)) || (navTargets.has(keyOf(p)) && !keyToId.has(keyOf(p)));
      // …and of those, which would ship something NEW. A full build re-sends every page, and a page deployed by an earlier version of the plugin can already carry a key
      // Griffel drops (its only guard was a grep for `borderWidth`, so `borderColor` under `:hover` passed). Re-sending the same bytes ships nothing new, and refusing it would stop
      // a rebuild after a change to a view — over a page nobody touched, with earlier phases already written — whose only way through is to edit the page, and switching to
      // longhands changes how it renders. So the page's standing decides, without a download per page (the build holds no copy of what is deployed):
      //   'new'        no deployed page (it is created): held to the check.
      //   'changed'    the page exists and its source is not the one the last recorded apply sent — last-applied.json (written by every apply and download, for this app in
      //                this environment only: opts.baselineSpec) records each page's `__contentSha`, the changed-only flow's own measure of "this page changed": held to the check.
      //   'unchanged'  its source hashes to that record: it ships nothing new, so it is warned about.
      //   'unrecorded' the page exists, but there is no record for it (a workspace that is new, moved or cleared, or an apply that predates the record): the build cannot tell, and
      //                warns. This fails OPEN, on purpose — a release that predates this check built such pages (the key silently dropped), and a build that stops them now
      //                regresses a rebuild it used to complete; the cost is that an edit that ADDS a key to such a page is warned about, not stopped, until a recorded apply exists.
      const griffelStanding = (p, sourceSha) => {
        if (!keyToId.has(keyOf(p))) return 'new';
        const recorded = recordedContentSha(opts.baselineSpec, keyOf(p));
        if (recorded === null) return 'unrecorded';
        return recorded === sourceSha ? 'unchanged' : 'changed';
      };
      const griffelWarnings = [];
      const sourceByKey = new Map();
      // The hash of each page's source as this scan READ it — what every check below is made on, and so what the apply may record as the source it sent (`created.pageSourceShas`, below).
      // The baseline (deployed-baseline.js) used to hash the files again when the build ENDED, so a page saved while the build ran was recorded as applied: the next build then found the
      // source it was about to send "unchanged" and let a key it never checked through with a warning.
      const scannedSha = new Map();
      // What every check below is made on, and what is written to the page, is the TEXT of the bytes this scan read — `sourceByKey` — never
      // a new read of the canonical file, which may have been saved again since: the checks, the hash recorded for the page and the page's
      // content are then about exactly the same text. It is the file's bytes as they are, bar one leading BOM (the maker stores none); a file
      // that is not UTF-8 stops the build here, before anything is written — the page is stored as UTF-8 text, so a decode that replaced a
      // byte would deploy something nobody checked.
      for (const p of implemented) {
        const bytes = fs.readFileSync(canonicalPath(p));
        const sourceSha = sha256(bytes);
        scannedSha.set(keyOf(p), sourceSha);
        let code;
        try { code = sourceText(bytes); } catch (e) {
          throw new BuildHalt(`page "${p.name}" cannot be deployed: ${e.message}`, { phase: 'pages', code: 'pages-source-not-utf8', recoverable: false, retry: RETRY.NEVER });
        }
        sourceByKey.set(keyOf(p), code);
        const malformed = navMalformedRefs(code);
        if (malformed.length) throw new BuildHalt(`page "${p.name}" has malformed navigation reference(s): ${malformed.join(', ')} — a cross-page link must be a double-quoted "PAGEREF_<key>" pageId literal, alone or followed only by casts such as \`as const\`; ${PAGEREF_RULE}`, { phase: 'pages', code: 'pages-malformed-navref', recoverable: false, retry: RETRY.NEVER });
        const { declaredNotReferenced, referencedNotDeclared } = navTargetParity((p.navigatesTo || []).map((n) => n.targetKey), navReferencedKeys(code));
        // A declared call can be absent only because the lexer cannot see it (it read a regex or a comment over it), and "declared-but-absent"
        // alone sends the author looking for a call that is plainly there: when the page has a guess, the halt names it.
        const hidden = declaredNotReferenced.length ? frontierNote(code) : '';
        if (declaredNotReferenced.length || referencedNotDeclared.length) throw new BuildHalt(`page "${p.name}" navigation parity mismatch — declared-but-absent: [${declaredNotReferenced.join(', ')}], referenced-but-undeclared: [${referencedNotDeclared.join(', ')}]${hidden ? ` — ${hidden}` : ''}`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false, retry: RETRY.NEVER });
        // Fail-closed: a nav pageId must be a DECLARED "PAGEREF_<key>" — never a dynamic
        // expression (unverifiable target) or a hardcoded GUID literal in CANONICAL source (breaks cross-env
        // recreate and ships nav the design never declared). extractNavTargets classifies each nav call site's
        // pageId; 'pageref'-not-declared is already caught by navTargetParity, so here reject 'dynamic' + 'literal'.
        const badNav = extractNavTargets(code).filter((t) => t.kind === 'dynamic' || t.kind === 'literal');
        if (badNav.length) throw new BuildHalt(`page "${p.name}" has ${badNav.length} undeclared/non-symbolic navigation target(s) (dynamic expression or hardcoded page GUID) — cross-page navigation must use a double-quoted "PAGEREF_<key>" pageId declared via navigatesTo`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false, retry: RETRY.NEVER });
        // A PAGEREF_ token nothing resolves (anywhere but the canonical pageId of a call the checker trusts — no comment is exempt) would ship as the literal
        // string — a dead link — so it halts here, before any page is created, naming the page and where the token is.
        const stray = strayPageRefs(code);
        if (stray.length) throw new BuildHalt(`page "${p.name}" has PAGEREF_ token(s) that no navigation rewrite will resolve, so they would ship as literal text: ${describePageRefLocations(stray)} — ${pageRefAdvice(stray)}`, { phase: 'pages', code: 'pages-stray-pageref', recoverable: false, retry: RETRY.NEVER });
        // The Griffel check, last, so a page's navigation problems — which a style fix does not touch — are reported first. The file named is the canonical source, as the spec gives it.
        // A page that is created, or whose source changed since the last recorded apply, is held to it; one that is sent again as it is gets a warning (griffelStanding above).
        if (uploadedThisRun(p)) {
          const problems = griffelStyleProblems(code).problems;
          if (problems.length) {
            const standing = griffelStanding(p, sourceSha);
            const words = { surface: 'build', subject: `page "${p.name}"`, command: 'node scripts/check-griffel-styles.js --file <page.tsx>' };
            const file = normalizePageSource(p).codeFile;
            if (standing === 'new' || standing === 'changed') {
              const note = standing === 'changed' ? 'Its source changed since the last build recorded for it, so it is held to the check as a new page is; left as it was, it would only be warned about.' : '';
              // `transient: false`, as for the receipt halt: this refuses the page's own source, before anything in the pages phase is written, so running the build again cannot change
              // the answer — but isTransientHalt (build-model-app.js) reads the halt's TEXT, which opens with the page's name, and a page called "SQL Timeout Report" would read as a
              // transient error: three more runs of every earlier phase, and a log that blames the service.
              throw new BuildHalt(describeGriffelRefusal(problems, file, { ...words, note }), { phase: 'pages', code: 'pages-griffel-shorthand', recoverable: false, retry: RETRY.NEVER });
            }
            griffelWarnings.push(describeGriffelWarning(problems, file, { ...words, standing }));
          }
        }
      }
      // The navigation targets this run MAKES (absent: `keyToId` holds no id for them) whose bindings the check before writing did not judge, because the run was told the page is deployed
      // (bindingCheckScope, `changedOnly.deployedKeys`) — one deleted in Maker since the last apply. The create sends the page's spec entry, bindings and all, so they are judged now, before the
      // first page is written, by the same verdict and with the same halt as that check (`preflight`: nothing is written yet — such a run writes nothing before its pages phase), and by what the
      // attempt has already read (bindingReadsOfAttempt): a name that check read is not read again, so a read here can neither add a request for it nor, failing, undo what that read proved. A
      // refused throttle wait stops the run here, as it does after that check. A run that was told nothing has none: every target was checked before it wrote anything.
      const madeUnchecked = pagesMadeUnchecked(spec, { changedOnly: bindingCheckScope(phases, opts.changedOnly), made: new Set(implemented.filter((p) => navTargets.has(keyOf(p)) && !keyToId.has(keyOf(p))).map(keyOf)) });
      if (madeUnchecked.length) {
        haltOnPageBindingConflicts(await judgePageBindings(provision, madeUnchecked, bindingReadsOfAttempt), opts.warn);
        runner.stopIfRefused('preflight');
      }
      // After the whole scan, so a build that halts on a later page says only why it halted. Nothing has been written yet, and the pages that are warned about are sent as they are.
      if (typeof opts.warn === 'function') for (const warning of griffelWarnings) opts.warn(warning);

      // THE SOLUTION HOLDS THE PAGES TOO (AB#6443257). Every other component the build makes joins the spec's solution, but a page joins one only when it is added
      // explicitly — the add of the app brings its sitemap, never the pages its navigation opens (lib/page-solution.js) — so a build made "in" a solution left
      // its pages out of it, and the solution exported an app whose navigation opens pages the target environment does not have. A page this run CREATES is
      // added as soon as it is made; one it UPDATES is re-asserted, as every component the build reuses is (lib/solution-membership.js): a page an earlier build
      // made outside the solution, or whose add failed, joins it now, and one the solution is proven to hold costs a read and no write. A page the run KEEPS without
      // writing it — a changed-only run leaves the pages it did not select as they are — is re-asserted the same way once the pages are written (the page manifest
      // step, below). The add brings the page's file rows with it (AddRequiredComponents). The page table's component type is the environment's: read HERE, before
      // the first page is written, so an environment that cannot say it halts the phase with nothing in it written. A system solution holds every component already
      // and is not added to.
      const pagesJoinSolution = !!(sol && sol.uniqueName) && !isRestrictedSolution(sol.uniqueName) && implemented.some(uploadedThisRun)
        // An SDK with no raw client to read with is a test double, as everywhere in this file: the real one always has it, so there is no type to read and no page is added.
        && !!(provision.dataverse && typeof provision.dataverse.get === 'function');
      let pageComponentType = null;
      let pageMembers = null;
      const pagesInSolution = new Set();
      if (pagesJoinSolution) {
        try {
          pageComponentType = await readPageComponentType(provision.dataverse);
        } catch (e) {
          throw new BuildHalt(`could not read the solution component type of a generative page, so the pages cannot join solution ${sol.uniqueName} — nothing in the pages phase was written: ${(e && e.message) || e}`, { phase: 'pages', code: 'pages-solution-type-unreadable', recoverable: true, ...retryFrom(e) });
        }
        pageMembers = createSolutionMembership({ read: provision, solutionUniqueName: sol.uniqueName, componentTypes: [pageComponentType] });
      }
      // `created`: a page this run has just made cannot already be a member, so it is added without the membership read.
      const pageIntoSolution = async (pageId, { created }) => {
        if (!pagesJoinSolution) return;
        const id = String(pageId).toLowerCase();
        if (pagesInSolution.has(id)) return;
        if (created || !(await pageMembers.has(id, pageComponentType))) {
          await provision.addSolutionComponent(pageComponent(id, pageComponentType, sol.uniqueName));
          pageMembers.note(id, pageComponentType);
        }
        pagesInSolution.add(id);
      };

      const mintedKeys = new Set();
      const deployment = new Map(); // key -> resolved code (nav sources only)
      // What a page write answered. The SDK's warnings, and a publish it could not prove, go to the build's log; a page that was SAVED but could not be
      // published is a halt — the page exists (the caller has recorded it by now), the runtime still serves the copy it had, and a re-run reuses the page
      // and publishes it (a page that already holds its content is published, not written again — unless this workspace recorded that this very content was
      // published, below, and that record is only ever written after a publish that was seen to take effect).
      const afterWrite = async (p, verb, written, fields) => {
        if (typeof opts.warn === 'function') for (const w of written.warnings || []) opts.warn(`page "${p.name}": ${w}`);
        if (written.publish && written.publish.kind === 'failed') {
          // The halt quotes the page's name, and in the parentheses the service's own words. What decides whether a run again can help is the FAILURE the backend caught — its status, its type, whether it
          // is a file error on the maker's machine — so the backend passes that error on (`publish.cause`) and the halt wraps it: a 429 or a 503 is run again, a file error, a refusal or an error that
          // says it must never be retried is not, and a page called "SQL Timeout Report" has no say. A backend that reports only the words (`detail`) gets those words read as the service's.
          throw new BuildHalt(`page "${p.name}" was ${verb} as ${written.pageId} and saved, but publishing it failed (${written.publish.detail}) — the runtime still serves the previously published copy. Re-run the build once the cause is cleared: the page is reused, not created again`, { phase: 'pages', code: 'pages-publish-failed', recoverable: true, ...retryFrom(written.publish.cause, String(written.publish.detail || '')) });
        }
        await rememberPublished(written, p, fields);
      };

      // WHICH PAGES ARE KNOWN TO BE PUBLISHED. A page that already holds what the spec asks for is not written, but the backend publishes it unless it is told that exactly this content was
      // published already (`publishedFingerprint`, genpage.update): the server cannot say whether an earlier run's publish of a page finished, and a page whose publish did not finish has to be
      // published by the next run. Without a record of its own that would publish EVERY unchanged page on EVERY rebuild — one PublishXml of several seconds each, ten pages ten publishes. So the build keeps the
      // record (lib/page-publish-records.js), written once a publish was SEEN to take effect (`verified`) and never otherwise: per page the hash of the content it was published with, and the versionnumber
      // of each of its file rows and of its own row, taken only from a published copy that was read back and found to hold that content and the compiled output the draft held at the publish (`provedVersions`, below).
      // The hash says what this workspace SENT; it cannot say that nobody has published anything else since — another workspace, another machine or Maker publishing other content and then leaving the
      // draft equal to the file would match it. The rows' versions are what moves (measured: publishing new content, or a draft-only save, moves the version of each file row it changes; an unchanged row
      // keeps its own; the page's own row moves with a write to it, a rename), so the hash is handed to `update` only while the versions read NOW are exactly the recorded ones (`publishesStillStanding`, below). A page that is not in the record, is there with
      // other content, has no versions (an earlier record, or a read that failed), or whose rows were added, removed or moved — new, changed since, saved by a run whose publish failed or was not proven,
      // changed from elsewhere, renamed, or a workspace that is new or cleared — is "not known to be published", and is published. A page a changed-only run leaves alone keeps its entry; the entry of a page the spec
      // no longer binds is dropped when the next is written. A full rebuild of the release before pages went through the SDK re-uploaded and re-published every page; this is what spares an unchanged
      // page that, and what it cannot see is spelled out in the record's header.
      const publishedPages = readPublishedPages(opts.workspaceDir, appUnique, opts.env);
      let publishRecordWarned = false;
      // The versions of every row a page's record vouches for, as one Map<row id, version> per page: its file rows (genpage.fileVersions) and its OWN row, keyed by the page's id (genpage.projectVersions). The name is in the
      // page's row and in none of its files, so a page renamed from elsewhere moves no file's version — the row's has to be read beside them. Map<page id, Map<row id, version> | null>: a page whose files or row could not be taken
      // as one known set is `null`. A backend that cannot read the row's version at all, or a read that fails, is `{ ok: false }`: nothing is certified, or found to stand, on rows that could not be read.
      const readRowVersions = async (ids) => {
        if (typeof genpage.fileVersions !== 'function' || typeof genpage.projectVersions !== 'function') return { ok: false, error: 'the page backend cannot read them' };
        const files = await genpage.fileVersions(ids);
        if (!files.ok) return files;
        const rows = await genpage.projectVersions(ids);
        if (!rows.ok) return rows;
        const versions = new Map();
        for (const id of ids) {
          const own = files.versions.get(id);
          const row = rows.versions.get(id);
          versions.set(id, own instanceof Map && typeof row === 'string' ? new Map([...own, [id, row]]) : null);
        }
        return { ok: true, versions };
      };
      // The versions of a page's rows that may go into the record: Map<row id, version>, or null — "no versions", which costs the next build a publish and nothing else. The versions only mean "the published
      // copy held this content while the files read so" when they belong to such a copy, and a read of them taken AFTER the SDK saw the publish take effect does not say that: a writer that published other content and
      // put this content back as a draft in between left the versions of ITS publication, with this build's hash beside them, and every rebuild then trusted the pair. So they are proved, in the order that proves them: the
      // versions, then the page's PUBLISHED copy read back and compared with the content that was sent (`publishedDiffers`) AND with the compiled output the draft held when it was published (`runtimeSha256`: the runtime is
      // what is certified, and the source does not say what runs), then the versions again. They are recorded only when both reads of the versions are one
      // consistent set and the same set — nothing moved while the copy was read, the page's own row (its name) included — and the copy held the content: the versions are then those of a published copy that holds it, whoever published it. A copy that differs
      // was published over from elsewhere and is said so; a read that fails, a set that moved, a publish that gave no evidence of the compiled output, or a backend that cannot read the copy or the row back says nothing and records none, as a failed read of the versions never said anything.
      const provedVersions = async (p, pageId, fields, fingerprint, runtimeSha256) => {
        try {
          if (!fields || typeof runtimeSha256 !== 'string' || typeof genpage.publishedDiffers !== 'function') return null;
          const first = await readRowVersions([pageId]);
          const before = first.ok ? first.versions.get(pageId) : null;
          if (!before) return null;
          const copy = await genpage.publishedDiffers(pageId, { ...fields, specBindings: true }, { runtimeSha256 });
          // `fingerprint` is the hash of the content the copy was compared with: it must be the hash the record keeps, or the answer is about other content.
          if (!copy.ok || copy.fingerprint !== fingerprint) return null;
          if (copy.differing.length) {
            if (typeof opts.warn === 'function') opts.warn(`page "${p.name}": its published copy, read back right after the publish, differs from what this build sent in its ${copy.differing.join(', ')} — it was published again from elsewhere — so it is not recorded as published, and the next build publishes it again`);
            return null;
          }
          // The answer must carry the compiled output it read, and it must be the one the draft held: an answer that says nothing of it — a backend that did not compare the runtime — certifies nothing.
          if (copy.runtimeSha256 !== runtimeSha256) return null;
          const second = await readRowVersions([pageId]);
          return second.ok && sameFileVersions(before, second.versions.get(pageId)) ? before : null;
        } catch { return null; }
      };
      const rememberPublished = async (written, p, fields) => {
        if (!opts.workspaceDir || typeof written.fingerprint !== 'string') return;
        const pageId = String(written.pageId).toLowerCase();
        if (written.receiptUpgraded) {
          // The record of an earlier publish was made before the spec stated the page's binding lists, and the update found that it stands for them too (it read the published copy and it holds them): the page was not written
          // and not published, so there is nothing new to prove — the record is renewed to the hash of what the spec states now, with the versions it already holds, which `publishesStillStanding` has just found to be the page's.
          const standing = publishedPages.get(pageId);
          if (!standing || !standing.files) return;
          publishedPages.set(pageId, { fingerprint: written.fingerprint, files: standing.files });
        } else {
          if (!written.publish || written.publish.kind !== 'verified') return;
          const files = await provedVersions(p, pageId, fields, written.fingerprint, written.runtimeSha256);
          publishedPages.set(pageId, { fingerprint: written.fingerprint, files });
        }
        const bound = new Set(Array.from(keyToId.values(), (id) => String(id).toLowerCase()));
        try {
          writePublishedPages(opts.workspaceDir, appUnique, opts.env, new Map([...publishedPages].filter(([id]) => bound.has(id))));
        } catch (e) {
          // Only a cache: the next build publishes the pages again, which is what it did before there was one. Said once, not once per page.
          if (!publishRecordWarned && typeof opts.warn === 'function') {
            publishRecordWarned = true;
            opts.warn(`could not save which pages this build published (${(e && e.message) || e}), so the next build publishes them again`);
          }
        }
      };
      // The recorded publishes that still stand: Map<page id, fingerprint> for each page whose rows read now — its files' and its own — are exactly the recorded set with the recorded versions. ONE read for all of the pages
      // that have a record with versions. Anything else is absent from the map and costs the page a publish: a page with no versions in its record, a read that fails (said once), a page whose rows
      // cannot be read as one consistent set, a row added, removed or moved, a page renamed. The read is the plain one both here and when the versions were recorded (readRowVersions): see the record's header.
      const publishesStillStanding = async () => {
        const standing = new Map();
        const recorded = Array.from(keyToId.values(), (id) => String(id).toLowerCase()).filter((id) => publishedPages.has(id) && publishedPages.get(id).files);
        if (!recorded.length) return standing;
        let read;
        try {
          read = await readRowVersions(recorded);
        } catch (e) {
          read = { ok: false, error: String((e && e.message) || e) };
        }
        if (!read.ok) {
          if (typeof opts.warn === 'function') opts.warn(`could not read the versions of the pages' files and rows (${read.error}), so the pages are published again, as they are when nothing is recorded`);
          return standing;
        }
        for (const id of recorded) {
          const entry = publishedPages.get(id);
          if (sameFileVersions(entry.files, read.versions.get(id))) standing.set(id, entry.fingerprint);
        }
        return standing;
      };

      // (2+3) Inside ONE "resolve cross-page navigation" step: create-absent-first for ABSENT nav TARGETS
      //       (upload symbolic source to mint an id; persist the manifest IMMEDIATELY after EVERY create for
      //       crash-safety), then RESOLVE the graph once every referenced target has an id (fail-closed
      //       on a dangling target).
      if (appHasCrossPageNav(spec)) {
        await runner.run('pages', 'resolve cross-page navigation', async () => {
          for (const p of implemented) {
            const key = keyOf(p);
            if (keyToId.has(key) || !navTargets.has(key)) continue; // only ABSENT targets need pre-minting
            const fields = { name: p.name, source: sourceByKey.get(key), prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources || [], model: p.model, ...statedPageBindings(p) };
            const up = await createPage(p, fields);
            recordCreate(p, up.pageId);
            keyToId.set(key, up.pageId);
            result.created.pages[key] = up.pageId;
            result.created.pageSourceShas[key] = scannedSha.get(key);
            mintedKeys.add(key);
            await persistNow();
            await afterWrite(p, 'created', up, fields);
            await pageIntoSolution(up.pageId, { created: true });
          }
          const navSources = new Map();
          for (const p of implemented) if ((p.navigatesTo || []).length) navSources.set(keyOf(p), { code: sourceByKey.get(keyOf(p)) });
          const { deployment: dep, unresolved, residual } = resolvePageRefs(navSources, keyToId);
          if (unresolved.length) throw new BuildHalt(`unresolved cross-page navigation target(s): ${unresolved.join(', ')} — a page navigates to a key that isn't a built page`, { phase: 'pages', code: 'pages-dangling-navref', recoverable: false, retry: RETRY.NEVER });
          // The resolved copy is checked again, because the lexer can read it differently from the source: each token became a longer page id,
          // which can move a `(` out of the lexer's look-behind (see lexNavigation in pageref-resolver.js). The check is a plain scan of the text
          // with no exemption: ANY PAGEREF_ token left in it, in a comment too, would ship as literal text, so the page halts here — after the
          // targets were minted, which the copy needs, but before any page is updated with it.
          if (residual.length) {
            const left = residual.filter((r) => r.page === residual[0].page);
            const owner = implemented.find((p) => keyOf(p) === residual[0].page);
            throw new BuildHalt(`page "${owner ? owner.name : residual[0].page}" has PAGEREF_ token(s) left once its navigation links were resolved, so they would ship as literal text: ${describePageRefLocations(left)} (line and column are in the resolved copy) — ${pageRefAdvice(left)}`, { phase: 'pages', code: 'pages-stray-pageref', recoverable: false, retry: RETRY.NEVER });
          }
          for (const [k, code] of dep) deployment.set(k, code);
          return `${deployment.size} navigation source(s)`;
        });
      }

      // (4) UPLOAD-ONCE — exactly one runner.run/skip per page. A non-nav page already minted in step 2 is
      //     final (skip). Every UPDATE asserts the returned id matches the requested id. Persist the
      //     manifest immediately after each create.
      //
      // #changed-only selectedKeysOnly: on a pages-only fast apply, upload ONLY the changed page keys — the
      // whole-app scan/reconcile/removal/shared checks above still run over ALL pages (safety), but
      // re-uploading an UNCHANGED page would clobber an out-of-band Maker edit to it (data loss).
      // keyToId already holds every existing page's live id (reconciled from the manifest/enumerate), so a
      // changed page that navigates to an unchanged page still resolves its target without re-uploading it.
      // (`selectedKeys` is the one read above, ahead of the scan.)
      //
      // The pages the loop writes IN PLACE — a page id the build began with, which it now overwrites; never one this run created (step 2's
      // navigation targets included), which no other app could have held when the build began — are checked for sharing once more right
      // before the first of them is written, and once after the last (see "The scan is a snapshot" above). A halt there comes before any page
      // the build began with is written in place, so it says so. `transient: false`: another app's navigation still holds the page, so the build's own re-run of a
      // halt it takes for transient (isTransientHalt, build-model-app.js, which reads the message) would only halt again — marked outright,
      // since the message quotes other apps' names, which no transient pattern should ever be able to turn into a re-run.
      const writesInPlace = new Set(implemented.filter((p) => {
        const key = keyOf(p);
        if (selectedKeys && !selectedKeys.has(key)) return false;
        return keyToId.has(key) && !mintedKeys.has(key);
      }).map(keyOf));
      let checkedBeforeWritingInPlace = false;
      const updatedInPlace = new Map();
      // The last scan: a page another app took in while the uploads ran has been written all the same, so it is reported, with the app it is
      // in; one only SAVED there shows the new content once that app is published. It runs when the loop stops early too, since what it wrote
      // before stopping is written. It never throws: the pages are written, nothing is left to refuse, and the halt that stopped the loop
      // must reach the caller as it was.
      const reportSharedAfterWrites = async () => {
        if (!updatedInPlace.size) return;
        const report = (message) => { if (typeof opts.warn === 'function') opts.warn(message); };
        let checked;
        try { checked = await scanShared(Array.from(updatedInPlace.keys())); } catch (e) { checked = { scan: withCause({ ok: false, error: String((e && e.message) || e) }, e) }; }
        const { scan, entries } = checked;
        if (!entries) {
          const why = !scan.ok ? scan.error : `${scan.unreadable.length} app(s) had an unreadable sitemap (${scan.unreadable.join(', ')})`;
          report(`could not check again, once they were written, that the ${updatedInPlace.size} page(s) this build updated in place are not shared with another app: ${why}`);
          return;
        }
        for (const s of entries) {
          report(`generative page "${updatedInPlace.get(String(s.id).toLowerCase()) || s.id}" ${s.text} was taken into another app's navigation while this build was updating it, so its new content ${s.published ? 'shows there too' : 'will show there once that app is published'}. ${detachAdvice(s.detach)}`);
        }
      };
      // Read once, here: the pages the loop below updates are the ones `keyToId` holds, and the cross-page navigation step above has minted its targets by now.
      const standingPublishes = await publishesStillStanding();
      try {
        for (const p of implemented) {
          const key = keyOf(p);
          if (selectedKeys && !selectedKeys.has(key)) { runner.skip('pages', `page "${p.name}" (unchanged — changed-only)`); continue; }
          const isNav = (p.navigatesTo || []).length > 0;
          if (!isNav && mintedKeys.has(key)) { runner.skip('pages', `page "${p.name}" (created)`); continue; }
          // Taken here, ahead of the page's step rather than inside it, so a halt reaches the caller as raised: a scan that fails stays recoverable,
          // as it is at the first scan, and the message is its own.
          if (writesInPlace.has(key) && !checkedBeforeWritingInPlace) {
            checkedBeforeWritingInPlace = true;
            const shared = await sharedPagesNow(Array.from(writesInPlace, (k) => keyToId.get(k)));
            if (shared.length) {
              throw new BuildHalt(`generative page(s) became shared across apps while this build ran: ${shared.map((s) => s.text).join('; ')} — refusing to UPDATE a page another app's sitemap references (a rebuild would mutate shared content); no page this build began with has been updated in place. ${detachAdvice(shared.flatMap((s) => s.detach))}`, { phase: 'pages', code: 'pages-shared-across-apps', recoverable: false, retry: RETRY.NEVER });
            }
          }
          await runner.run('pages', `page "${p.name}"`, async () => {
            const requestedId = keyToId.get(key);
            // The EXACT text we write, so the caller can record a MEASURED deployedSha (a nav source's deployed text differs from
            // its canonical source — PAGEREF_ is resolved to GUIDs — so deployedSha must never be assumed equal to the source hash).
            // For a non-nav page it is the text the scan read and checked — not a new read of the canonical file, saved again maybe.
            const deployedBytes = isNav ? deployment.get(key) : sourceByKey.get(key);
            // The spec's data sources are authoritative, as they always were: a page that lists none is bound to none. The model and name ride along
            // too, but the page's own are kept when the spec has none (the SDK writes only what differs; pac stored whatever `--model` it was
            // sent, so a re-upload without one used to wipe a deployed page's model id to ""). A downloaded spec carries the model (pages[].model).
            // The connector and Custom API bindings go the same way, and only when the page states them: one it leaves out is the deployed page's own, and a list it states — `[]` too — replaces it. They are the spec's, which
            // states each entry by the properties it can carry (lib/page-bindings.js), so the update reads them against the page's own entries (`specBindings`): a page that already holds what the spec states is not
            // written, and an entry that is changed keeps what the spec could not state of it.
            // `caller: 'build'` words the advice for an UPDATE that may have landed: the build keeps no base marker, and reads every page again when it runs.
            const fields = { name: p.name, source: deployedBytes, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources || [], model: p.model, ...statedPageBindings(p) };
            // `publishedFingerprint` is what this workspace recorded about the page's last publish, handed over only while the page's files still read as they did right after it (`publishesStillStanding`):
            // a page that already holds this very content, and was not touched from elsewhere since, is not published again.
            const up = requestedId ? await genpage.update(requestedId, { ...fields, caller: 'build', runtimeEvidence: true, specBindings: true, publishedFingerprint: standingPublishes.get(String(requestedId).toLowerCase()), ...(opts.throttle ? { throttle: opts.throttle } : {}) }) : await createPage(p, fields);
            if (!requestedId) recordCreate(p, up.pageId);
            // An UPDATE (requestedId set) must return the SAME id, else a resolved sibling could point at
            // a stale target. Case-insensitive (Dataverse may echo a differently-cased GUID).
            if (requestedId && String(up.pageId).toLowerCase() !== String(requestedId).toLowerCase()) throw new BuildHalt(`page "${p.name}" UPDATE returned a different id (${up.pageId} != ${requestedId}) — refusing to finalize with an inconsistent target`, { phase: 'pages', code: 'pages-update-identity-mismatch', recoverable: false, retry: RETRY.NEVER });
            if (requestedId && writesInPlace.has(key)) updatedInPlace.set(String(requestedId).toLowerCase(), p.name);
            // Key by the STABLE key (p.key||p.name): appDef resolves result.pages[s.page] where s.page is the
            // migrated KEY (:506). Keying by name left v2 key-referenced subareas unresolved.
            keyToId.set(key, up.pageId);
            result.created.pages[key] = up.pageId;
            result.created.pageDeployedShas[key] = sha256(deployedBytes);
            // The source this send was judged on, which is the one the baseline records for the page (see `scannedSha`).
            result.created.pageSourceShas[key] = scannedSha.get(key);
            await persistNow(); // manifest carries this id BEFORE the next create (crash-safety, design §9)
            await afterWrite(p, requestedId ? 'updated' : 'created', up, fields);
            await pageIntoSolution(up.pageId, { created: !requestedId });
            return up.pageId;
          });
        }
      } finally {
        await reportSharedAfterWrites();
      }

      // (5) Persist the FINAL manifest (deduped no-op after per-create persists). Skipped for a page-less
      //     (removal-only / detach) run — there is no page identity to record, and writing an empty manifest
      //     would needlessly create/update the web resource. The scan/create/upload steps above are already
      //     no-ops when spec.pages is empty (they iterate over spec.pages / implemented).
      //     The solution holds every page the manifest binds, not only the pages this run wrote (AB#6443257). A changed-only run writes the pages it selected
      //     and leaves the rest as they are — their content is the maker's to keep — but not out of the solution: a navigation target an earlier attempt of the
      //     run made, and whose add was refused or never sent, is bound by its creation receipt now and not written again, so nothing else would add it, and the
      //     build's retry, which keeps the selection, would succeed with that page outside the solution. Each such page is asserted as a page the run updates is
      //     (pageIntoSolution): the one read of the solution's pages answers all of them, and only a page the solution is not proven to hold is added, as a full
      //     build adds it. A page this run wrote was asserted then, and costs nothing here; a run that writes no page asserts none.
      if ((spec.pages || []).length) {
        await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => {
          await persistNow();
          for (const p of implemented) if (keyToId.has(keyOf(p))) await pageIntoSolution(keyToId.get(keyOf(p)), { created: false });
          return manifestResourceName(appUnique);
        });
      }
      // (6) Finalize the sitemap (the true commit point — only after all resolved uploads succeed). For a
      //     page-backed app this writes the resolved GenPage SubAreas. For an EXISTING app the app-shell
      //     write was deferred, so this is the SOLE existing-app sitemap write — including the intentionally
      //     page-less sitemap on an authorized removal/detach (result.created.pages is empty, so appDef emits
      //     no GenPage SubAreas). A FRESH page-less app already had its sitemap written by the app-shell
      //     create path, so it needs no finalize here.
      // #changed-only (pages-only content re-upload): the finalize below rebuilds the WHOLE sitemap via
      // appDef(spec, result.created) and rewrites /siteMap + components. In a pages-only apply result.created
      // holds only app+pages, so appDef would THROW on any dashboard subarea (:610-611, result.dashboards
      // empty) and STRIP the app's form/view/chart component registrations (:635). A pure content re-upload
      // leaves the key→pageId map unchanged, so the sitemap needs no rewrite — skip the finalize in that
      // submode. Any sitemap-changing apply (and every full build) still finalizes.
      // A NEW app whose navigation holds only page entries does not exist yet: the app step left its create to this step, so the step
      // CREATES it, with the whole navigation — every page now has its id — in its first sitemap (createAppWithPages). There is no live
      // sitemap to fence or rewrite and no header to compare: the create writes the spec's name, description and routing description
      // itself, as the app step's create does. It is the app step's work, so it is reported, and fails, in that phase.
      const skipSitemapFinalize = !!(opts.changedOnly && opts.changedOnly.skipSitemapFinalize);
      if (createAppWithPages) {
        await runner.run('app-shell', `app "${spec.app.name}" (created with its pages)`, () => createAppWithPages());
      } else if (!skipSitemapFinalize && (appHasPageSubareas(spec) || appWasExisting)) {
        await runner.run('pages', 'finalize sitemap (genpage subareas)', async () => {
          await provision.fetchArtifact('app', result.created.app);
          const mainFormsByTable = await resolvedMainForms();
          const full = appDef(spec, result.created, { mainFormsByTable });
          await assertAuthorizedSitemapRewrite(provision, result.created.app, full.siteMap, opts.authorizedSitemapRemovals, 'pages');
          await provision.updateElement('app', result.created.app, '/siteMap', await siteMapOverLive(provision, result.created.app, full.siteMap, opts, result.created));
          // #583: the header — its routing description, and the app's name and description — rides THIS push whenever the pages
          // phase runs (the app-shell branch defers it here). An app this run created already carries its name and description from
          // that create, so only the routing description is looked at there, as before.
          const header = await applyAppHeader(provision, spec, result.created.app, { text: appWasExisting, warn: opts.warn });
          const appName = (spec.app && spec.app.name) || result.created.app;
          requireSuccessfulPush(await appWriters.push(result.created.app, appName, header), 'app sitemap finalize', opts.warn);
          reportPartialPush(await appWriters.publish(result.created.app), `app ${appName}`, opts.warn);
          return result.created.app;
        });
      } else {
        // planFor budgets this step for every pages-phase run, so consume the slot even when there is
        // nothing to write — otherwise the remaining steps renumber past the advertised total.
        runner.skip('pages', `finalize sitemap (genpage subareas) (${skipSitemapFinalize ? 'content-only re-upload — sitemap unchanged' : 'no sitemap change'})`);
      }

      // Pin the default public view of each table the pages written in this run read. The maker's "/" picker lists a page's tables from the app's components,
      // pac pinned each table's default view into the app on EVERY upload — this build's included — and the SDK's page write does not. One app operation does it
      // for all of them: the backend's placeInApp with no page to place and only the tables, the call the standalone upload makes (the logic is that call's, not a
      // second copy). It runs once the pages are written and recorded, and the sitemap is final: it reads the app's CURRENT layer and writes nothing when every
      // view is already pinned, so a rebuild that changed no page's tables costs one read. A page works without its views, so a failure to pin is a warning, not a halt.
      // It adds those views and NOTHING else of the app's components. The SDK's app push, which carries the pin, would also add every active Main form, public view and chart of each table the
      // navigation opens — undoing this build's own `app.mainForms` list, and putting back what the app's maker took out of the app — so the backend limits it to the views it pins
      // (lib/app-component-scope.js). The sitemap push above is the build's own — it owns the whole app, and carries `mainFormsByTable` — and is not limited.
      // When it does write — a view the app lost is pinned again — it pushes and publishes the app inside the backend, which is the one writer of the app that a changed-only re-upload
      // of a page has (it runs this phase alone, with no app step and no finalizer), so it is handed the request to send before it writes (appWriters.placeViews). It pushes the app as the
      // server holds it and not the spec's navigation, so the request is made for the tables of THAT navigation, which the backend reports to it.
      // `result.created.pages` holds the pages this run wrote (a page it left alone — changed-only — is not in it).
      const writtenTables = [...new Set(implemented.filter((p) => result.created.pages[keyOf(p)] !== undefined).flatMap((p) => p.dataSources || []))];
      if (writtenTables.length && typeof genpage.placeInApp === 'function') {
        // The app is edited in the authoring language this build made it in (the SDK refuses to push an artifact fetched in another one, and a label is written in it).
        const pinLanguage = opts.preResolvedLanguageCode || opts.languageCode;
        try {
          const placed = await appWriters.placeViews(genpage, result.created.app, { pages: [], dataSources: writtenTables, ...(pinLanguage ? { languageCode: pinLanguage } : {}) });
          if (typeof opts.warn === 'function') for (const w of (placed && placed.warnings) || []) opts.warn(`default views of the pages' tables: ${w}`);
        } catch (e) {
          if (typeof opts.warn === 'function') opts.warn(`the pages were written, but their tables' default views could not be added to the app's components, so the maker's "/" picker may not list them (${(e && e.message) || e})`);
        }
      }
    } finally {
      // Always release the advisory lease, and remove the backend's throwaway workspace (it holds every page's source). The backend is disposed only once the
      // storage calls it had under way have settled (an operation can still be running when a phase halts), so this waits for that before the lease is released.
      // A folder it could not remove (`{ left }`) still holds page source, so the build says so: a success that left it there would be silent about it.
      if (ownGenpage && typeof genpage.dispose === 'function') {
        try {
          const leftOnDisk = leftOnDiskWarning(await genpage.dispose());
          if (leftOnDisk && typeof opts.warn === 'function') opts.warn(leftOnDisk);
        } catch { /* best-effort */ }
      }
      lease.release();
    }
  } else if (has('pages')) {
    // The pages phase was selected but the block above did not open: a FRESH app with a page-less
    // spec has nothing to build and no pre-existing pages to remove, and its sitemap was already
    // written by the app-shell create path. planFor still budgeted the finalize step (it cannot see
    // that the app is fresh), so consume the slot here rather than leaving the run one short of its
    // advertised total.
    runner.skip('pages', 'finalize sitemap (genpage subareas) (fresh page-less app — sitemap written on create)');
  }

  // 7b-ii. Modern ("new look") shell — opt-in via `app.newLook`.
  //
  // This is a per-app SETTING, not an appmodule column: `navigationtype` (the only nav-ish column the
  // SDK writes) is Single/Multi *session* and unrelated. Of the several new-look definitions Dataverse
  // ships, `NewLookAlwaysOn` is the one worth writing — its own description says it "enables the new
  // look and hides the user switch", and that when it is on the user-facing "New look for model driven
  // apps" preference "will have no effect". The alternatives (`NewLookOptOut`,
  // `NewLookModernExperienceOct2023`) both DEFAULT to true and are per-user toggles, so writing them
  // would give a result the app author cannot actually depend on.
  //
  // Runs in the app-shell phase, right after the app exists, and is scoped to the app + solution so it
  // travels on export/import. Best-effort by design: a tenant where the definition is absent (it is a
  // platform feature that rolls out) must not fail an otherwise-good build, so a failure is reported
  // and the build continues — the app is fully functional, just on the classic shell.
  if (has('app-shell') && spec.app && spec.app.newLook === true && result.created.app) {
    // Deliberately NOT inside runner.run: that helper turns any throw into a BuildHalt, and failing
    // an otherwise-good app build because a rolling-out preview setting is unavailable in this tenant
    // is the wrong trade. But a silent ✓ would be worse — reporting success for something that did not
    // happen is the exact failure mode this build has had to fix elsewhere. So: warn, record the real
    // outcome, and let the caller see `newLook: false` rather than infer it.
    try {
      await provision.saveSettingValue(NEW_LOOK_SETTING, 'true', {
        appUniqueName: appUniqueName(spec),
        solutionUniqueName: spec.solution && spec.solution.uniqueName,
      });
      result.created.newLook = true;
    } catch (err) {
      result.created.newLook = false;
      const detail = (err && err.message) || String(err);
      if (typeof opts.warn === 'function') {
        opts.warn(`could not enable the new look (${NEW_LOOK_SETTING}): ${detail} — the app is fully built and functional, but stays on the classic shell. This setting is a platform feature that rolls out by tenant.`);
      }
    }
  }

  // 7b-iii. Wave 2 header + navigation refresh — stated via `app.headerNavigationRefresh`.
  // Deliberately not called "opt-in": the platform default is ON (see below), so this field exists
  // as much to turn the feature OFF as on. Absent means "no opinion" and touches nothing.
  //
  // DISTINCT from `newLook` above, and both can be set independently. `NewLookAlwaysOn` is the
  // new-look shell toggle; `HeaderAndNavigationRefresh` is the Wave 2 header/navigation redesign
  // (public preview). They are separate `settingdefinition` rows and enabling one does not enable
  // the other.
  //
  // Written through the SDK's dedicated `setHeaderAndNavigationRefresh` rather than a raw setting
  // write, because the encoding is a trap: this is a `datatype = 0` (Number) TRI-STATE where ON is
  // '2', not '1'. The SDK's own note records that of the nine Number settings with rows in a live
  // org, eight use '1' for on and only this one uses '2' — and that writing '1' is ACCEPTED by the
  // API and then silently fails to enable the feature. Hand-rolling this is how you ship a green
  // build with the feature off.
  //
  // Same best-effort contract as the new look: this is a rolling-out preview, so a tenant without
  // the definition gets a warning and the real outcome, never a silent success and never a failed
  // build. The SDK throws a plain Error (not an SdkError subclass) when the definition is absent, so
  // this catches broadly on purpose.
  //
  // BOTH values are honoured, and that is not symmetry for its own sake. Verified against the real
  // vendored bundle (offline, by capturing the writes a push issues): the SDK
  // defaults the app artifact's `headerAndNavigationRefresh` to TRUE, and pushing a new app writes
  // the setting to '2' (ON) unprompted. So the platform default is ON, not off — and treating
  // `false` as "do nothing" would silently leave it ON for an author who explicitly asked for it to
  // be off. `false` therefore has to be an active write of the OFF value, not a skip.
  if (has('app-shell') && spec.app && typeof spec.app.headerNavigationRefresh === 'boolean' && result.created.app) {
    const wanted = spec.app.headerNavigationRefresh;
    try {
      const outcome = await provision.setHeaderAndNavigationRefresh(result.created.app, wanted);
      // AppSettingWriteOutcome is 'created' | 'updated' | 'unchanged' — all three mean the row now
      // holds the requested value, so all three are success. Recorded verbatim so a caller can tell
      // a fresh write from a no-op re-run.
      result.created.headerNavigationRefresh = wanted;
      result.created.headerNavigationRefreshOutcome = outcome;
    } catch (err) {
      // Report what actually happened, NOT what was asked for. On failure the row keeps whatever it
      // had — which for a newly created app is the SDK's ON default, so reporting `false` here would
      // be as wrong as reporting success.
      result.created.headerNavigationRefresh = 'unknown';
      const detail = (err && err.message) || String(err);
      if (typeof opts.warn === 'function') {
        opts.warn(`could not ${wanted ? 'enable' : 'disable'} the header and navigation refresh (${HEADER_NAV_SETTING}): ${detail} — the app is fully built and functional, but the header and navigation setting is whatever the platform defaulted it to. This setting is a public-preview feature that rolls out by tenant.`);
      }
    }
  }

  // 7c. AI features (opt-in via spec.ai). Enable app-level agents + configure per-table row
  //     summaries. `setAppAiFeatures` never throws — every outcome arrives as data in a bucket.
  // Features the SDK did not put in `applied`, deferred for a post-publish re-issue (see inside the
  // ai-features phase for why the verdict cannot honestly be decided at write time).
  const pendingAiReconfirm = [];
  // Set by the publish phase when it published the app: an override the SDK saved in the app's unpublished layer
  // (`pendingPublish`) is then in force, and only needs proving (8b), not writing again.
  let appPublishedByPublishPhase = false;

  if (has('ai-features') && specOptsIntoAi(spec)) {
    const solutionUniqueName = spec.solution && spec.solution.uniqueName;
    const appUnique = appUniqueName(spec);
    const flags = resolveAiFlags(spec);
    // NOTE: an app-scope setting write lands in the app's UNPUBLISHED layer, and does nothing until the
    // app is published. The SDK proves it where it is and reports it `applied` with `pendingPublish`
    // (rebucketPendingPublish moves that to a bucket of its own; before the SDK could read that layer, the
    // same write came back `notPersisted`). This phase runs moments after `app-shell` created the app, and
    // the `publish` phase is later and opt-in — so what is not in force yet is put there after publish by
    // the block at the end of this function: a saved override only needs the publish (which the publish
    // phase has already done, when it ran) and is then PROVED, while one the SDK did not save at all is
    // re-issued by the fetch → publish → write sequence measured to work live. An ALREADY-published app —
    // the common case on a rebuild/edit — applies immediately and needs neither.
    await runner.run('ai-features', 'enable app AI features', async () => {
      // The SDK confirms each app-scope write by polling for its `appsettings` override row, keyed by
      // appmoduleid. That id is normally resolved from the app's unique NAME — but a freshly created
      // appmodule is not readable until it is PUBLISHED (Dataverse omits it from list queries and 404s
      // the by-id retrieve), and this phase runs moments after `app-shell` created it. The by-name
      // lookup is the ONLY piece that fails pre-publish; the `appsettings` proof query itself works
      // fine. Passing the id we already hold skips the lookup entirely and lets the write be proven
      // here, in the same phase that made it.
      //
      // The SDK still re-checks the id against the published app when the app IS readable, so a stale
      // or wrong id is rejected rather than silently used to configure another app.
      //
      // A modest retry budget still helps: on an established app the override row is queryable ~580ms
      // after the write (measured live), so the SDK's 4-attempt/500ms default is tight but the budget
      // is only ever spent when the row is genuinely absent.
      const encodedFlags = encodeAiFlags(flags);
      const r = rebucketPendingPublish(rebucketNonEnablingSkips(await provision.setAppAiFeatures(appUnique, encodedFlags, {
        solutionUniqueName,
        appModuleId: result.created.app || undefined,
        verifyAttempts: 8,
        verifyDelayMs: 1000,
      }), encodedFlags));
      result.created.ai.appFeatures = r;
      // `applied` is the SDK's ONLY success bucket: a feature reaches it only when the APP-SCOPE
      // override row is proven present holding the requested value. Every other bucket is a
      // non-success the build must surface, because reporting them as plain success was the
      // false-PASS half of ADO 6603383 (features were pushed onto `applied` while writing nothing):
      //   pendingPublish — the plugin's own bucket (rebucketPendingPublish): the SDK proved the row in
      //                  the app's UNPUBLISHED layer, so it is saved and takes effect once the app is
      //                  published. Deferred like the rest: the publish phase puts it in force when the
      //                  build publishes, and otherwise the post-publish pass publishes the app — it is
      //                  not written again, its row is already saved.
      //   notPersisted — the write returned 204 but no override was observed for the whole retry
      //                  budget; Dataverse can accept an app-scope write and store nothing.
      //   skipped      — as notPersisted, PLUS the feature's org readiness gate reads off, which is
      //                  offered as the explanation. Since AB#6688904 the SDK ATTEMPTS every write
      //                  and reads the gate only afterwards, to explain a failure that happened —
      //                  it no longer pre-empts the write, so this bucket is now evidence, not a
      //                  prediction. Only a request that turns the feature ON keeps this bucket:
      //                  rebucketNonEnablingSkips moves any other to notPersisted (the SDK's own
      //                  test for "turns on" is wrong for grid search and M365).
      //   unverified   — the write was issued but the proof could not be READ (no access to
      //                  appsettings/settingdefinitions/appmodules, or a transport error).
      //   failed       — the write threw. The SDK keeps going so the rest of the batch still
      //                  reports, so this arrives as data, never as an exception.
      //
      // RE-CONFIRMATION (safety net): with `appModuleId` supplied above, the SDK can prove the
      // override row here, pre-publish, so the normal path decides the verdict in this phase. The
      // deferral below remains for the residual cases the proof genuinely cannot settle yet — a
      // transient read failure, or a row that has not materialized inside the retry budget. Deciding
      // "NOT PERSISTED" on those would print a scary and WRONG verdict that `--verify` then
      // contradicts in the same run, so the buckets are recorded and re-proved after publish (see
      // `reconfirmAiFeatures` below) against the identical override-row oracle the verifier uses.
      // The re-proof can only ever UPGRADE a feature, never hide a real failure.
      //
      // `skipped` is deferred WITH the rest, and that is the plugin half of AB#6688904. On a freshly
      // created app NO app-scope write persists until the app is published, so the SDK's post-write
      // gate read fires for every feature — and for the ones that happen to have a distinct org gate
      // (`nlSearch`, `nlChart`, `formFillSmartPaste`) an org-wide `false` then labels them `skipped`.
      // Treating that as a final answer would abandon them before the one sequence measured to work,
      // and `--verify` would then fail on an override row the build gave up on writing. The reported
      // environment ran a working app at `NLGridSearchSetting = 2` with `EnableNLGridSearch` off, so
      // a gate reading off is not proof the app-scope write cannot land — only the retry can settle
      // it. Anything still `skipped` after the retry is reported as an admin action, not a defect.
      //
      // Derive the non-success buckets from the RESULT, not a fixed list: a bucket added by a future
      // SDK revision is then reported verbatim rather than silently dropped (which is the very bug
      // class this phase exists to remove). `outcomes` is per-feature detail, not a bucket.
      const problemKeys = Object.keys(r || {}).filter((k) => k !== 'applied' && k !== 'outcomes' && Array.isArray(r[k]) && r[k].length);
      for (const key of problemKeys) {
        for (const feature of r[key]) {
          const outcome = (r.outcomes || []).find((o) => o && o.feature === feature);
          pendingAiReconfirm.push({ feature, bucket: key, reason: outcome && outcome.reason });
        }
      }
      const parts = [];
      if (r.applied && r.applied.length) parts.push(`applied: ${r.applied.join(', ')}`);
      if (pendingAiReconfirm.length) parts.push(`retrying after publish: ${pendingAiReconfirm.map((p) => p.feature).join(', ')}`);
      return parts.length ? parts.join('; ') : '(none)';
    });
    // Same rule as the plan: `selectSummaryTables` owns the default-vs-override decision, so calling
    // it unconditionally is what lets `default: 'off'` + `tables[x].enabled: true` opt a single table
    // back in. Short-circuiting here made the plan and the execution agree only by both being wrong.
    const tables = selectSummaryTables(spec);
    // Row summaries are an AI Builder / Copilot-LICENSED capability, gated per environment
    // INDEPENDENTLY of the `EnableFormInsights` org setting: an environment can report the feature
    // "on" and still refuse the publish. Live-observed on an environment whose gate reads on:
    //   HTTP 403 from .../api/data/v9.0/AIModelPublish
    //   {"operationStatus":"Error","error":{"type":"Error","code":"ModelNotSupported",
    //     "message":"This scenario is not supported in this environment.",
    //     "properties":{"exceptionStackTrace":"   at Microsoft.PowerAI...LicenseChecker..."}}}
    // — i.e. a licence check, reported as a 6 KB .NET stack trace the operator can do nothing with.
    //
    // Halting there abandons a build that already created the solution, tables, columns, views, the
    // app and its AI feature settings, for a reason no change to the spec can fix. So degrade the way
    // business rules and `app.newLook` already do: skip the artifact, say so specifically, and let the
    // rest of the build finish. Nothing wrong is written — the summary simply does not exist, and the
    // skip is recorded on the result so the run summary reports it instead of implying it was created.
    let aiSummaryGateWarned = false;
    const pendingAiSummaryReports = [];
    // `tables` keys are documented as entity schemaNames matched CASE-INSENSITIVELY, and
    // `selectSummaryTables` honours that when deciding what to build. Looking the override back up by
    // exact (or merely lower-cased) key therefore selected the table but dropped its `instruction` and
    // `columns` whenever the author's spelling differed from the entity's — silently substituting the
    // generated default prompt for the one they wrote. Build the same case-folded index the selector
    // uses so the two agree.
    const summaryOverrides = new Map();
    for (const [key, val] of Object.entries((spec.ai.summaries && spec.ai.summaries.tables) || {})) {
      summaryOverrides.set(String(key).toLowerCase(), val);
    }
    const DUPLICATE_MODEL_REASON = 'a model with this name already exists';
    // An org without the AI template a row summary is built from. The SDK reads the template before its first write and refuses with its own
    // code (`configureRowSummary`: ROW_SUMMARY_TEMPLATE_NOT_FOUND, "Nothing was written"), where it used to publish a model that named no template and let the
    // platform answer. It is the same kind of environment gate as the licence refusal below — nothing in the spec can fix it — so it skips the same way.
    // The code is the SDK's word for an EMPTY template list and for nothing else (cds-maker-sdk 9a0c9f03):
    //   GET /msdyn_aitemplates?$select=msdyn_aitemplateid&$filter=msdyn_uniquename eq 'GptPowerPrompt'&$top=1   ->   { "value": [] }    the org has no template: this code
    // Every other answer it cannot read as a template — no `value` list, a first row that is no row (`[ null ]`), a row without a GUID `msdyn_aitemplateid` (`[ {} ]`) — is a
    // ConnectionError, which stops the build like any read that failed (and is run again when it was the service that failed it, lib/retry-policy.js). So the code needs no
    // confirming read of the build's own: before that SDK it was raised for `[ {} ]` and `[ null ]` as well, and 2.16.0 read the list a second time to tell them apart.
    const NO_TEMPLATE_REASON = 'no row-summary AI template in this environment';
    const aiSummaryUnsupported = (err) => {
      if (err && err.code === 'ROW_SUMMARY_TEMPLATE_NOT_FOUND') return NO_TEMPLATE_REASON;
      const detail = `${(err && err.message) || ''} ${JSON.stringify((err && err.cause) || '')}`;
      // Match the platform's own error CODE, not the prose: the message is localized and the status
      // alone (403/400) is also what a plain privilege or validation failure returns, which must
      // still halt. `err.cause` carries the parsed error BODY (where `code` lives) while `err.message`
      // carries only the localized text, so both are searched — on a non-English org the code is
      // reachable only through `cause`.
      //
      // `DuplicateRecordKey` is in this set for a specific, measured reason. `configureRowSummary`
      // CREATES the `msdyn_aimodel` row and THEN publishes it, so on a gated environment the licence
      // check fails at publish with the row already committed:
      //   HTTP 400 ... "code":"DuplicateRecordKey" ... Cannot insert duplicate key row in object
      //   'dbo.msdyn_AIModelBase' with unique index 'ndx_Uniquename'. The duplicate key value is
      //   (<table> row summary, ...)
      // on the NEXT build. Without this, skipping the licence gate would make the first build pass
      // and every rebuild fail. A same-name model is reported below, never deleted by name.
      //
      // The two are reported as DIFFERENT reasons: telling an operator their environment is
      // unlicensed when the real cause is a leftover row sends them to the wrong place entirely.
      if (/DuplicateRecordKey/i.test(detail)) return DUPLICATE_MODEL_REASON;
      return /ModelNotSupported|not supported in this environment/i.test(detail)
        ? 'unsupported in this environment'
        : false;
    };
    // configureRowSummary can return an existing configuration, and a refused publish throws
    // without returning its new model id. The SDK's own post-publish rollback uses the exact id
    // it created; this caller has no such receipt after a throw, so matching names only justify
    // a read-only report. A remaining model is recoverable; deleting an unproven one is not.
    const reportKeptSummaryModels = async (logical) => {
      const modelName = `${String(logical).toLowerCase()} row summary`;
      try {
        const rows = await provision.queryRecords('msdyn_aimodel', {
          select: ['msdyn_aimodelid', 'msdyn_name'],
          filter: `msdyn_name eq '${odataLit(modelName)}'`,
          paginate: true,
        });
        for (const row of rows || []) {
          if (typeof opts.warn === 'function') opts.warn(`row summary for ${logical}: kept same-name AI model ${row.msdyn_aimodelid}; this attempt returned no created-model id, so cleanup cannot be attributed to this run.`);
        }
        if (!(rows && rows.length) && typeof opts.warn === 'function') opts.warn(`row summary for ${logical}: no created-model id was returned; model cleanup was not attempted.`);
      } catch (e) {
        if (typeof opts.warn === 'function') opts.warn(`row summary for ${logical}: could not list same-name AI models (${(e && e.message) || e}); no model was deleted because this attempt returned no created-model id.`);
      }
    };
    try {
      for (const logical of tables) {
        const ent = (spec.entities || []).find((e) => String(e.schemaName).toLowerCase() === String(logical).toLowerCase());
        if (!ent) continue;
        const override = summaryOverrides.get(String(logical).toLowerCase());
        await runner.run('ai-features', `row summary for ${logical}`, async () => {
          const promptSpec = buildPromptSpec(ent, { spec, override });
          const res = await provision.configureRowSummary(promptSpec, { solutionUniqueName });
          result.created.ai.summaries[logical] = res;
          return res.modelId;
        }, {
          skipIf: (err) => {
            const reason = aiSummaryUnsupported(err);
            if (!reason) return false;
            result.skipped.aiSummaries.push(logical);
            // Nothing was written for a table the SDK refused before its first write, so there is no model to look for.
            if (reason !== NO_TEMPLATE_REASON) pendingAiSummaryReports.push(logical);
            // Warn ONCE per build: on a gated environment every table skips for the same reason, and
            // N copies of the same paragraph buries the rest of the output.
            if (!aiSummaryGateWarned && typeof opts.warn === 'function') {
              aiSummaryGateWarned = true;
              if (reason === DUPLICATE_MODEL_REASON) {
                opts.warn(`AI row summaries were NOT created: an AI model named "<table> row summary" already exists for a table in this spec, so the platform refused to create another (duplicate key on 'ndx_Uniquename'). Same-name models are kept because this attempt returned no created-model id. Review the reported ids before any separate cleanup. Everything else in the app was built normally.`);
              } else if (reason === NO_TEMPLATE_REASON) {
                opts.warn(`AI row summaries were NOT created: this environment has no 'GptPowerPrompt' AI template, which a row summary is built from (AI Builder provides it), so none can be authored here, and nothing was written for them. Everything else in the app was built normally. Re-run once the environment has the template, or set ai.summaries.default to "off" (with no per-table enabled:true) to stop requesting them.`);
              } else {
                opts.warn(`AI row summaries were NOT created: this environment does not license the row-summary (AI Builder) capability, so there is no supported way to author them here — the org's 'EnableFormInsights' setting can read ON and the publish still be refused. Everything else in the app was built normally. Re-run against a licensed environment, or set ai.summaries.default to "off" (with no per-table enabled:true) to stop requesting them.`);
              }
            }
            return reason;
          },
        });
      }
    } finally {
      // Report earlier skipped tables even if a later one halts. skipIf is synchronous, so its
      // read-only inventory must be awaited outside that callback.
      for (const logical of pendingAiSummaryReports) await reportKeptSummaryModels(logical);
    }
  }

  // 7c. Security (persona roles). Author ONE security role per persona (role name = persona), sized to
  //     the UNION of every job's declared entity access; the SDK converges the privilege set via
  //     ReplacePrivilegesRole, so this is idempotent and a re-run REMOVES a privilege dropped from the
  //     spec. Runs AFTER app-shell so the app module exists to be (a) read via the injected appmodule
  //     privilege and (b) associated to the role so the app opens for the persona. All writes go through
  //     the header-less `provision` client and role solution membership is added explicitly (same
  //     pattern as app/forms/views), because — like appmodule/savedquery creates — a create carrying the
  //     MSCRM.SolutionUniqueName header is rejected; the role lands in the default solution and is then
  //     moved into the app's solution.
  if (has('security')) {
    const appId = result.created.app; // null when app-shell is excluded from this run (partial phases)
    for (const persona of spec.personas || []) {
      const roleSpec = personaRoleSpecFor(persona);
      const roleName = canonicalPersonaName(persona); // trimmed identity — matches the SDK + teardown/verify
      await runner.run('security', `security role "${roleName}"`, async () => {
        let rr;
        try {
          rr = await provision.createPersonaRole(roleSpec);
        } catch (err) {
          // Fail-closed on any SDK security error: a SEC-1 conflict (a hand-built or managed same-name
          // role the SDK refuses to adopt) or an apply-time metadata guard (an entity that does not
          // support a requested access, or the shared-privilege same-scope rule). Halt with the SDK's
          // message rather than leave a half-authored access model behind.
          // The halt follows the SDK's failure (cause): a typed refusal is final, a failure of the service is run again. The persona's name in the message is the maker's, and decides nothing.
          throw new BuildHalt(`security role "${roleName}" could not be authored: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'security-role-failed', recoverable: false, cause: err, retry: retryPolicyFor(err) });
        }
        result.created.roles[roleName] = rr;
        // Ensure the role is in the app's solution on EVERY run so an export/import carries it.
        // AddSolutionComponent is idempotent server-side (re-adding an existing component returns 200 —
        // live-verified), so this ALSO repairs a role that missed membership on a prior run
        // (created, then the add failed, then reused — a `!reused` gate would skip the repair forever).
        // NOT swallowed: a real failure means the exported solution would omit the role and silently break
        // access in the target env, so it fails the phase fail-closed — same as the app/sitemap adds.
        // A role the SDK just created cannot be a member yet, so only a REUSED one consults the membership read.
        if (sol && sol.uniqueName) {
          if (rr.reused) await ensureInSolution(rr.roleId, COMPONENT_TYPE.role);
          else await provision.addSolutionComponent({ componentId: rr.roleId, componentType: COMPONENT_TYPE.role, solutionUniqueName: sol.uniqueName });
        }
        // Reconcile app availability to match `appAccess`: associate so the app appears for the persona
        // (default), or DISSOCIATE when the persona opted out — otherwise a role flipped true->false would
        // keep surfacing the app (the read privilege is converged away, but the association is grant-only).
        if (appId) {
          if (persona.appAccess !== false) await ensureAppAvailableToRole(provision, appId, rr.roleId);
          else await ensureAppNotAvailableToRole(provision, appId, rr.roleId);
        }
        const priv = (rr.appliedPrivileges || []).length;
        const assigned = (rr.assignedTeams || []).length + (rr.assignedUsers || []).length;
        return `${rr.reused ? 'reused' : 'created'} — ${priv} privilege${priv === 1 ? '' : 's'}${appId && persona.appAccess !== false ? ', app access' : ''}${assigned ? `, ${assigned} assignment(s)` : ''}`;
      });
    }

    // 7a-bis. Role grants (`roleGrants[]`) — ADD privileges for a table to a PRE-EXISTING role. AB#6686429.
    //
    // The scenario this exists for: a table is added to an app whose solution already ships four data
    // roles. Before this, the table, its forms and its nav deployed while every non-admin persona still
    // had no access to it, and nothing said so.
    //
    // ADDITIVE, never converging. `addEntityPrivilegesToRole` compiles to `AddPrivilegesRole`, so a
    // privilege the role already holds is re-asserted and every privilege the spec does NOT mention is
    // left alone. That is what makes it safe to point at a role somebody else owns — and it is also why
    // this surface cannot REVOKE (documented in references/app-spec-schema-advanced.md).
    //
    // Idempotency comes from Dataverse, not from a read-compare here: re-POSTing a grant the role already
    // holds at the same depth succeeds and changes nothing. Re-POSTing at a HIGHER depth raises it. We do
    // not pre-read the role's privileges, because a read-then-write would be racy and the write is
    // already the converged operation.
    //
    // Runs AFTER the persona loop so that, if a future change ever allowed both to touch one role, the
    // additive grant lands last rather than being converged away. Today validation rejects that overlap
    // outright (see validateRoleGrants).
    const roleGrantBuCache = {}; // memoize the root-BU lookup across grants in this build
    // Resolved-id guards. The static validator can only compare NAMES, so a `roleId` pinned at a role
    // a persona also authors, or a name-and-id pair aliasing one role, both slip past it. Both are
    // caught here on the identity that actually matters — the resolved Dataverse role id:
    //   * persona overlap would let ReplacePrivilegesRole converge the grant away on the next build,
    //     and a failure BETWEEN the two passes leaves the access removed;
    //   * two grants on one role split a depth conflict across two SDK calls, where the SDK's
    //     "entities sharing one privilege must request one depth" check cannot see it and the later
    //     write silently wins.
    const personaRoleIds = new Map(); // lowercased roleId -> persona name, from the loop above
    for (const [name, rr] of Object.entries(result.created.roles || {})) {
      if (rr && rr.roleId) personaRoleIds.set(String(rr.roleId).toLowerCase(), name);
    }
    const grantedRoleIds = new Map(); // lowercased roleId -> the label of the grant that claimed it
    // TWO PASSES, deliberately. Resolving and guarding EVERY grant before applying ANY is what makes
    // the identity guards below worth having: with resolve-guard-apply interleaved per grant, a spec
    // whose second entry aliases the first applied grant #1 and only then halted, leaving one role
    // changed and one not, with nothing in the output saying which. Every guard here rejects a spec
    // that is wrong independently of the environment, so it costs nothing to learn that first.
    const resolvedGrants = [];
    for (const grant of spec.roleGrants || []) {
      const label = roleGrantLabel(grant);
      let target;
      try {
        target = await resolveRoleGrantTarget(provision, grant, roleGrantBuCache);
      } catch (err) {
        // Fail-closed: an unresolvable or ambiguous role means we do not know what we would be granting
        // on. Halting is better than skipping, because a skipped grant reads as a successful build whose
        // users still cannot open the table — the exact failure this feature was filed for.
        // The resolver's own refusals (no such role, several, no business unit) are marked; a failure of the service while it asked (a 503 on the read) is run again.
        throw new BuildHalt(`roleGrant ${label} could not be resolved: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'role-grant-unresolved', recoverable: false, cause: err, retry: retryPolicyFor(err) });
      }
      const idKey = String(target.roleId).toLowerCase();
      if (personaRoleIds.has(idKey)) {
        throw new BuildHalt(
          `roleGrant ${label} resolves to role ${target.roleId}, which is also persona "${personaRoleIds.get(idKey)}" in this spec. `
          + 'The build CONVERGES a persona\'s role (privileges not declared on the persona are removed), so this grant would be '
          + 'undone on the next build — declare these privileges on that persona\'s job instead.',
          { phase: 'security', code: 'role-grant-persona-overlap', recoverable: false, retry: RETRY.NEVER },
        );
      }
      if (grantedRoleIds.has(idKey)) {
        throw new BuildHalt(
          `roleGrant ${label} resolves to role ${target.roleId}, which roleGrant ${grantedRoleIds.get(idKey)} already targets. `
          + 'Merge them into one entry: two entries can request conflicting depths for one shared Dataverse privilege, and the '
          + 'SDK only detects that within a single call, so the later write would silently win.',
          { phase: 'security', code: 'role-grant-duplicate-target', recoverable: false, retry: RETRY.NEVER },
        );
      }
      grantedRoleIds.set(idKey, label);
      resolvedGrants.push({ grant, label, target });
    }
    for (const { grant, label, target } of resolvedGrants) {
      await runner.run('security', `grant privileges to existing role ${label}`, async () => {
        let applied;
        try {
          applied = await provision.addEntityPrivilegesToRole(target.roleId, grant.privileges);
        } catch (err) {
          // Apply-time metadata guards live here: a table that exposes no such access, and the SDK's
          // shared-privilege rule (two tables aliasing to one prv* must request one depth). Both are
          // author errors that only live metadata can detect, so they surface with the SDK's own message.
          throw new BuildHalt(`roleGrant ${label} could not be applied: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'role-grant-failed', recoverable: false, cause: err, retry: retryPolicyFor(err) });
        }
        const n = Array.isArray(applied) ? applied.length : 0;
        // Keyed on the resolved ROLE ID, with the display name carried in the value. Keying on
        // `target.name` collapsed two DIFFERENT roles that share a display name — which the spec
        // gate deliberately allows, because a role is identified by (name, business unit) and the
        // same name in two BUs is two roles. The second grant then overwrote the first in this map,
        // so `--json` consumers saw one grant where two were applied. The id is the identity the
        // apply itself guards on, so it cannot collide.
        result.created.roleGrants[target.roleId] = { roleId: target.roleId, name: target.name, managed: target.managed, privileges: applied || [] };
        // The role is NOT added to the app's solution. A persona role is ours to place; a pre-existing role
        // already lives wherever its owner put it, and adding a foreign (possibly managed) role to this
        // solution would take an ownership decision the author did not ask for. If the role is already a
        // component of this solution, its updated privileges export with it either way.
        return `${n} privilege${n === 1 ? '' : 's'} granted on ${target.name || target.roleId}${target.managed ? ' (managed role)' : ''}`;
      });
    }

    // 7b-bis. Business process flow role grants (`businessProcessFlows[].securityRoles`). #513.
    //
    // Runs in SECURITY, not in the flow phase, for the same reason `forms[].securityRoles` does: a
    // persona's role does not exist until the loop above has run.
    //
    // The target is the flow's BACKING TABLE, not the flow row. Activating a flow makes the platform
    // create an org-owned table, and holding privileges on THAT is what lets a persona run the
    // process. Two things were measured live before this was written (see validateBpfSecurityRoles):
    // the table is organization-owned and every privilege is Global-only, so there is no scope to
    // author; and the public `addEntityPrivilegesToRole` grants on it (the SDK's internal BPF role
    // helper is not on its public surface).
    //
    // The table NAME is taken from `created.bpfBackingTables`, which the flow phase read back from
    // the deployed `workflow.uniquename`. It is only DERIVED from the display name as a last resort:
    // a flow authored elsewhere, or renamed after creation, keeps its original unique name, and
    // granting on the derivation would target a table that does not exist — or one that belongs to
    // something else. The fallback still covers the doubles and older projections that do not carry
    // the field, where the derivation is the correct answer anyway.
    const flowsWithRoles = (spec.businessProcessFlows || []).filter((f) => f && f.securityRoles);
    for (const f of flowsWithRoles) {
      const flowKey = `${String(f.entity).toLowerCase()}|${f.name}`;
      const backingTable = result.created.bpfBackingTables[flowKey] || bpfUniqueName(f.name);
      const label = `flow "${f.name}" (backing table ${backingTable})`;
      // The flow must have been built in THIS invocation, or its backing table may not exist —
      // ACTIVATION is what creates it. Checked BEFORE runner.run and reported through runner.skip,
      // because a value returned from runner.run is not emitted: a silent skip would report a clean
      // build in which nobody can run the process, which is the failure #513 exists to fix.
      // The key mirrors the flow phase's own `${entityLogical}|${flow.name}`.
      const built = result.created.businessProcessFlows[flowKey];
      if (!built) {
        runner.skip('security', `flow roles for ${f.name} (the business-process-flows phase did not run in this invocation, so the backing table may not exist yet)`);
        continue;
      }
      await runner.run('security', `flow roles for ${f.name}`, async () => {
        const personas = (f.securityRoles.personas || []);
        // Case-INSENSITIVE, exactly like the form path immediately below — and for the same reason.
        // `validateBpfSecurityRoles` resolves the persona reference against a LOWERCASED set, so a
        // spec naming "dispatcher" for a persona declared as "Dispatcher" validates clean. A
        // case-sensitive lookup here would then halt at the near-last phase, with a message claiming
        // the persona "has no role in this build" — which is false; it was declared and its role was
        // created. Late halt, wrong diagnosis, half-built app.
        const roleByLower = new Map(Object.entries(result.created.roles || {})
          .map(([name, rr]) => [String(name).trim().toLowerCase(), rr]));
        const roleIds = personas.map((p) => {
          const rr = roleByLower.get(String(canonicalPersonaName({ persona: p }) || '').toLowerCase());
          if (!rr || !rr.roleId) throw new BuildHalt(`${label}: persona '${p}' has no role in this build`, { phase: 'security', code: 'bpf-role-unresolved', recoverable: false, retry: RETRY.NEVER });
          return { persona: p, roleId: rr.roleId };
        });
        for (const { persona, roleId } of roleIds) {
          try {
            // Organization scope is not a choice: the backing table is org-owned and its privileges
            // report CanBeGlobal only, so any other depth is rejected by the platform.
            await provision.addEntityPrivilegesToRole(roleId, [{ entity: backingTable, access: BPF_ROLE_ACCESS, scope: 'organization' }]);
          } catch (err) {
            throw new BuildHalt(`${label}: could not grant to persona '${persona}': ${err && err.message ? err.message : err}`, { phase: 'security', code: 'bpf-role-grant-failed', recoverable: false, cause: err, retry: retryPolicyFor(err) });
          }
        }
        result.created.bpfRoleGrants[f.name] = { backingTable, personas };
        return `${roleIds.length} persona(s) granted ${BPF_ROLE_ACCESS.join('/')} on ${backingTable}`;
      });
    }

    // 7b. Offer forms to specific security roles (`forms[].securityRoles`). AB#6648526.
    //
    // This runs in the SECURITY phase, not the forms phase, because a persona's role does not exist
    // until the loop above has run — `forms[]` is built at phase 6, `personas[]` at phase 13.
    //
    // The roles do NOT live in a relationship. MEASURED against a live environment: `systemform`
    // declares no many-to-many relationships and reports
    // `CanBeInManyToMany: { Value: false, CanBeChanged: false }`, there is no `systemformrole`
    // entity, and `role`'s six N:N partners are systemuser / privilege / appmodule / team /
    // application / applicationuser — none of them forms. They live INSIDE `formxml`, as a
    // `<DisplayConditions>` child of `<form>`, which is why only the SDK's dedicated call can write
    // them and why no `associateRecords` shape ever worked.
    //
    // A form with NO DisplayConditions is offered to every role, so this is a RESTRICTION: declaring
    // `securityRoles` narrows a form that was previously universal.
    const formsWithRoles = (spec.forms || []).filter((f) => f && f.securityRoles);
    for (const f of formsWithRoles) {
      const label = `${f.name || f.formType || 'Main'} on ${f.entity}`;
      const formId = result.created.formIds[formIdentityKey(f)];
      if (!formId) {
        // The forms phase did not run in this invocation (`--phases security`, or a --changed-only
        // apply). Skipping is right — silently doing nothing is not, because the author asked for a
        // restriction and its absence is a security-relevant difference.
        runner.skip('security', `form roles for ${label} (form not built in this run — re-run with the forms phase)`);
        continue;
      }
      await runner.run('security', `form roles for ${label}`, async () => {
        const sr = f.securityRoles;
        const opts2 = {};
        if (sr.everyone === true) opts2.everyone = true;
        else {
          // Personas, not GUIDs: the spec names roles the way an author does, and the build resolves
          // them against the roles it just created. An unresolved name is a HALT, not a warning — a
          // typo would otherwise silently produce a form offered to nobody.
          //
          // Matched CASE-INSENSITIVELY, because the spec gate that pre-checks these names is
          // case-insensitive. A case-sensitive lookup here made `personas: ["dispatcher"]` against a
          // declared `"Dispatcher"` pass validation and then halt in phase 7b — the LAST thing the
          // build does, after every table, form, view, chart, dashboard, page and role already
          // exists. That is precisely the half-built outcome the business-rule skip exists to avoid,
          // and it also falsified this function's own promise that a bad name is caught at the gate.
          //
          // This index is only UNAMBIGUOUS because `personas[]` already rejects two names differing
          // solely by case — a rule that lives elsewhere in app-spec.js and was written for an
          // unrelated reason. Nothing links the two, so form-security-roles.test.js pins it: relax
          // that rule and one of the two roles would silently win here, offering a form to the wrong
          // one with every other test still green.
          const roleByLower = new Map(Object.entries(result.created.roles || {})
            .map(([name, rr]) => [String(name).trim().toLowerCase(), rr]));
          opts2.roleIds = (sr.personas || []).map((p) => {
            const rr = roleByLower.get(String(canonicalPersonaName({ persona: p }) || '').toLowerCase());
            if (!rr || !rr.roleId) {
              throw refusal(`securityRoles names persona "${p}", which this build did not create a role for. Declare it in personas[], or use "everyone": true.`);
            }
            return rr.roleId;
          });
        }
        // Both are PRESERVED by the SDK when omitted, so only send what the author actually set —
        // sending `undefined` would be indistinguishable from "reset it" if that ever changes.
        if (sr.fallbackForm !== undefined) opts2.fallbackForm = sr.fallbackForm;
        if (sr.order !== undefined) opts2.order = sr.order;
        await provision.setFormSecurityRoles(formId, opts2);
        return sr.everyone === true ? 'every role' : `${opts2.roleIds.length} role(s)`;
      });
    }
  }

  // 8. Publish (opt-in). Publish ONE artifact per entity (covers that entity's customizations)
  //    + the app — far fewer PublishXml round-trips than publishing every artifact. Every reconcile
  //    publish deferred to this phase (`publishInPhase8`) names its table in `owed.tables`, read below.
  if (publishInPhase8) {
    await runner.run('publish', 'publish customizations', async () => {
      const seen = new Set();
      const perEntity = []; // [type, id, names?] — first artifact found per entity
      // The table's target carries the names of what its one publish ships: what was deferred onto it (its reconciled views
      // and forms, its enriched default views — oweTablePublish), then what this run created or wrote there (savedOnTable,
      // sorted because artifacts are created concurrently), each name once. A failure of THIS publish then says which saved
      // changes are not live — a first build's included — instead of naming only the artifact that carries the request.
      const forTable = (k, [type, id]) => {
        const names = [...new Set([...((owed.tables.get(k) || [])[2] || []), ...[...(savedOnTable.get(k) || [])].sort()])];
        return names.length ? [type, id, names] : [type, id];
      };
      for (const f of spec.forms || []) {
        const k = f.entity.toLowerCase();
        // Prefer the entity's Main form (what `created.forms` holds), but fall back to THIS form's
        // own id. A `securityRoles` assignment lands on the UNPUBLISHED layer — live-measured: the
        // published row still read `<Everyone />` until PublishXml ran — so an entity whose only
        // annotated form is, say, a QuickCreate would otherwise never be published and the
        // restriction would silently not take effect. Publishing is per-ENTITY, so any one of its
        // forms covers the rest.
        const id = result.created.forms[k] || result.created.formIds[formIdentityKey(f)];
        if (id && !seen.has(k)) { seen.add(k); perEntity.push(forTable(k, ['form', id])); }
      }
      for (const v of spec.views || []) { const k = v.entity.toLowerCase(); const vid = result.created.views[`${k}|${v.name}`]; if (vid && !seen.has(k)) { seen.add(k); perEntity.push(forTable(k, ['view', vid])); } }
      // Charts too — but ONLY the ones this run created or fetched. `publishArtifact` requires the
      // artifact to be workspace-resident (readRaw -> readLocal throws ArtifactNotFoundError rather
      // than lazily fetching), and `findArtifact` does not populate the workspace. Deriving the id
      // from `result.created.charts` would therefore hand publish an id it cannot resolve for an
      // existing chart with no description to reconcile, and the throw escapes publishArtifact and
      // halts the phase. `chartsToPublish` is populated at exactly the two points that put a chart in
      // the workspace, and keyed by entity because publishing is per-entity.
      for (const [k, cid] of chartsToPublish) { if (cid && !seen.has(k)) { seen.add(k); perEntity.push(forTable(k, ['chart', cid])); } }
      // Tables whose publish was deferred to this phase — the enriched default views (4b) and the existing
      // views and forms the reconcile paths touched — when nothing above names them.
      for (const [k, target] of owed.tables) { if (!seen.has(k)) { seen.add(k); perEntity.push(forTable(k, target)); } }
      const appTarget = result.created.app ? ['app', result.created.app, `app ${(spec.app && spec.app.name) || result.created.app}`] : null;
      // The app is published in the same envelope as the tables the build has artifacts of, so it is not ahead of them. It also ships the forms of tables the build did not touch, which the
      // request before the app publishes — and a run can reach this phase without the app step having made it (a run that does not write the app but publishes it): a publish alone adds no form.
      if (appTarget) await publishTablesBeforeApp(result.created.app);
      const publishedTargets = await publishTargets(provision, runner, concurrency, perEntity, appTarget, opts.warn);
      appPublishedByPublishPhase = publishedTargets.appPublished;
    });
    // Paid. A target that failed to publish was reported above, and the build is idempotent, so its
    // re-run publishes it; a halt from here on owes nothing more, nor does an earlier attempt's.
    owed.paid = true;
    owed.tables.clear();
  }

  // 8b. AI feature re-issue + re-confirmation. An app-scope setting write lands in the app's UNPUBLISHED
  //     layer, which the published `appsettings` projection cannot show: measured live on two different
  //     apps, the write used to come back `notPersisted` with no override row at ALL, while fetching +
  //     publishing that same app and re-issuing the identical call produced every feature `applied` with
  //     real rows holding the requested values. The SDK now reads the unpublished layer and calls a
  //     saved-but-unpublished feature `applied` with `pendingPublish`; rebucketPendingPublish files it as
  //     the plugin's own `pendingPublish` bucket, because it is not in force until a publish. Such a
  //     feature needs the PUBLISH, not a second write, so it is published here unless the publish phase
  //     already did that. Anything the SDK did not save at all is RE-ISSUED after the publish, as before.
  //     Then the override row is PROVED for whatever is left. A re-issue's own `pendingPublish` is filed
  //     the same way: a publish that failed, or could not be confirmed, leaves the row in the unpublished
  //     layer, and that is not "applied". This pass can only ever UPGRADE a feature, never hide a real
  //     failure.
  if (pendingAiReconfirm.length) {
    const flags = resolveAiFlags(spec);
    const appUnique = appUniqueName(spec);
    const BUCKET_LABELS = {
      notPersisted: ['NOT PERSISTED', 'Dataverse accepted the write but no app-scope override holding the requested value was observed'],
      // Distinct wording from NOT PERSISTED on purpose: both mean the override row is absent, but
      // `skipped` carries a diagnosis the operator can ACT on — an environment admin has to turn the
      // feature on before any app can. The SDK's own per-feature `reason` names the gate and its
      // value, and it is preferred over this text wherever it is present.
      skipped: ['ADMIN GATE OFF', 'the write was issued, no app-scope override appeared, and the feature\u2019s org readiness gate reads off \u2014 an environment admin must enable it first'],
      unverified: ['UNVERIFIED', 'the write was issued but could not be confirmed \u2014 verify manually before relying on it'],
      failed: ['FAILED', 'the write threw'],
      // The SDK proved the row, in the app's unpublished layer; this is what is left to say when no publish
      // has since put it in force (or its publish could not be confirmed by reading the row back).
      pendingPublish: ['NOT YET PUBLISHED', 'the override is saved but not in force: it takes effect once the app is published, and the published row could not be read back'],
    };
    // Replicate the sequence proven to work live, in order: fetch the app (so the workspace holds the
    // server's copy), publish it, then write. Each step is best-effort — a failure here must not fail
    // the build, it just leaves the original non-success verdict standing and reported.
    //
    // A feature the SDK SAVED but flagged `pendingPublish` is not written again: its row is already in the
    // unpublished layer, so a second write would only save it again. It needs the publish — and not even that
    // when the publish phase has published the app this run. The proof below reads the row where the runtime
    // does, so whatever the publish did not put in force is reported, never claimed.
    const retryApplied = new Set();
    // Features whose re-issue the SDK saved in the unpublished layer only, with its reason for saying so.
    const retryPending = new Map();
    if (result.created.app) {
      const retryFlags = {};
      let owesPublish = false;
      for (const p of pendingAiReconfirm) {
        if (p.bucket === 'pendingPublish') {
          if (!appPublishedByPublishPhase) owesPublish = true;
          continue;
        }
        if (flags && Object.prototype.hasOwnProperty.call(flags, p.feature)) retryFlags[p.feature] = flags[p.feature];
      }
      const rewrite = Object.keys(retryFlags).length > 0;
      if (rewrite || owesPublish) {
        try {
          await provision.fetchArtifact('app', result.created.app);
          reportPartialPush(await appWriters.publish(result.created.app), `app ${(spec.app && spec.app.name) || result.created.app}`, opts.warn);
          if (rewrite) {
            // Filed like the first write: after a publish that failed or could not be confirmed, the SDK proves
            // this write only in the unpublished layer and answers `applied` + `pendingPublish`.
            const retry = rebucketPendingPublish(await provision.setAppAiFeatures(appUnique, encodeAiFlags(retryFlags), {
              solutionUniqueName: spec.solution && spec.solution.uniqueName,
              appModuleId: result.created.app,
              verifyAttempts: 6,
              verifyDelayMs: 1000,
            }));
            for (const f of (retry && retry.applied) || []) retryApplied.add(f);
            for (const o of (retry && retry.outcomes) || []) if (o && o.status === 'pendingPublish') retryPending.set(o.feature, o.reason);
          }
        } catch { /* leave the original verdict standing; it is reported below */ }
      }
    }
    const app = await resolveAppModuleId(provision, appUnique);
    const stillBad = [];
    const reproven = [];
    // Saved in the unpublished layer by the re-issue though the first write said otherwise (`notPersisted`, say).
    const movedToPending = [];
    // Track HOW each feature was recovered so the reported reason is true for that path. Claiming a
    // re-issue applied something the proof merely found is the same "report what you did not verify"
    // failure this whole phase exists to remove.
    const reprovenBy = new Map();
    for (const p of pendingAiReconfirm) {
      if (retryApplied.has(p.feature)) {
        reproven.push(p.feature);
        reprovenBy.set(p.feature, 'applied by the post-publish re-issue (an app-scope write is a no-op before the app is published)');
        continue;
      }
      const setting = AI_APP_SETTING[p.feature];
      let proof = { error: app.error };
      // The same reads, as many and as far apart, as `--verify` makes (proofBudget): the publish can answer before the
      // published row is readable, and a single read reported that lag as NOT YET PUBLISHED in a run whose own verify passed.
      if (!app.error && setting) proof = await proveAppOverride(provision, app.appModuleId, setting, proofBudget(opts));
      if (!proof.error && proof.exists && sameSettingValue(proof.value, featureWantValue(flags && flags[p.feature], p.feature), p.feature)) {
        reproven.push(p.feature);
        reprovenBy.set(p.feature, 'confirmed present after publish by the build\u2019s own override-row proof');
        continue;
      }
      // What the re-issue found supersedes what the first write said: the row IS saved, it is just not in force.
      const savedUnpublished = retryPending.has(p.feature);
      const bucket = savedUnpublished ? 'pendingPublish' : p.bucket;
      if (savedUnpublished && p.bucket !== 'pendingPublish') movedToPending.push(p.feature);
      const [label, why] = BUCKET_LABELS[bucket] || [String(bucket).toUpperCase(), 'reported by the SDK as a non-success outcome'];
      // A check that could not run says so FIRST: the verdict that stands is then the one from before it, and a reader who
      // sees only that verdict takes the check for having looked. What the SDK said (prefer its OWN per-feature reason: it
      // carries the real error text for `failed`, which a canned bucket description throws away) follows it.
      const said = savedUnpublished ? retryPending.get(p.feature) : p.reason;
      const checkFailed = proof.error ? `the check after the publish could not run: ${proof.error}` : null;
      stillBad.push({ feature: p.feature, label, why: [checkFailed, said].filter(Boolean).join(' \u2014 ') || why });
    }
    // Reflect the corrected verdict in the machine-readable result too, so a caller reading
    // `created.ai.appFeatures` is not told a feature failed when it demonstrably did not.
    const af = result.created.ai && result.created.ai.appFeatures;
    if (af && reproven.length) {
      af.applied = [...(af.applied || []), ...reproven];
      // `skipped` is cleaned up like every other non-success bucket. It used to be exempt, back when
      // the SDK pre-empted a gated write and `skipped` therefore meant "never attempted" — a state
      // no retry could change. Since AB#6688904 the write IS attempted, so a feature can genuinely
      // move from `skipped` to `applied`, and leaving it listed in both would make
      // `created.ai.appFeatures` contradict itself for any `--json` consumer.
      for (const key of Object.keys(af)) if (Array.isArray(af[key]) && key !== 'applied' && key !== 'outcomes') af[key] = af[key].filter((f) => !reproven.includes(f));
      for (const o of af.outcomes || []) if (reproven.includes(o.feature)) { o.status = 'applied'; o.appOverrideExists = true; o.reason = reprovenBy.get(o.feature); delete o.pendingPublish; }
    }
    // ...and the same for a feature the re-issue saved but could not put in force: it leaves the bucket the first
    // write put it in, for `pendingPublish`, so the result says what the warning below does.
    if (af && movedToPending.length) {
      for (const key of Object.keys(af)) if (Array.isArray(af[key]) && key !== 'applied' && key !== 'outcomes') af[key] = af[key].filter((f) => !movedToPending.includes(f));
      af.pendingPublish = [...(af.pendingPublish || []), ...movedToPending];
      for (const o of af.outcomes || []) if (movedToPending.includes(o.feature)) { o.status = 'pendingPublish'; o.appOverrideExists = true; o.pendingPublish = true; o.reason = retryPending.get(o.feature); }
    }
    // `runner.skip` renders as `⊘ <label>` — the closest thing the narrator has to a warning — and
    // advances the step counter correctly, which a hand-built `runner.emit` did not.
    const byLabel = new Map();
    for (const b of stillBad) {
      if (!byLabel.has(b.label)) byLabel.set(b.label, { names: [], why: b.why });
      byLabel.get(b.label).names.push(b.feature);
    }
    for (const [label, info] of byLabel) runner.skip('ai-features', `${label}: ${info.names.join(', ')} \u2014 ${info.why}`);
  }

  return result;
}

module.exports = { runSdkBuild, publishTargets, partialEnrichment, settleOwedPublishes, collectOwedPublishes, settleOwedLengths, normalizeFormId, planFor, annotateLivePlan, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, defaultViewColumns, subgridLabel, enrichesDefaultViews, dashboardsInSolution, findDashboardsByName, findPinnedDashboard, artifactIdentityQuery, resolveExistingFormId, FORM_TYPE_CODE, chartDef, dashboardTileOpts, dashboardComponent, compileFormIntent, formFieldLogicals, appDef, appUniqueName, applyAppAiDescription, haltOnUnpublishedAppHeader, pushAppHeader, commandsByEntity, commandDef, businessRuleDef, businessRuleFilter, bpfDef, bpfFilter, webResourceOpts, webResourceContentState, WEB_RESOURCE_KINDS, FORM_EVENTS, acquireAppPagesLease, personaRoleSpecFor, resolveRoleBusinessUnit, roleBuClause, roleGrantLabel, resolveRoleGrantTarget, existingAppSitemapIsWritten, pagesFirstRule, applyAppHeader, applyAppHeaderText, warnAppIconNotApplied, inspectBpfStages, applyBpfStages, refuseUnpushedAppCopy, assertAuthorizedSitemapRewrite, reconciledPublishHalt };
