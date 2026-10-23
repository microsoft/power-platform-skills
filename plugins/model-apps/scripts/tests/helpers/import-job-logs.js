'use strict';
// Import-job logs and rows, in the shapes the platform was measured to write them — made up here, not copied: every name is `contoso_…` and nothing in
// a log is an environment's. `importjobs(<id>)` has a `data` column holding the import's log, an XML document the platform writes as the import goes:
//
//   running      <importexportxml><solutionManifests><solutionManifest languagecode="1033"> … <results /> …    (no attribute on the root, no `processed` anywhere,
//                                                                                                           `completedon` null)
//   finished     <importexportxml start=… stop=… progress=… processed="true" errorcode="0" succeeded="success" status=""> … every node processed="true" …
//   refused      <importexportxml … processed="true" errorcode="-2147020463" succeeded="failure" status="Cannot start another [Import] because there is a previous
//                [Import] running at this moment. …"> — `errorcode` is 0x80071151 as a signed 32-bit integer — with `solutionManifest` and every component
//                processed="false" and only the package's own checks (`upgradeHandler`, `validateHandler`) processed="true": the import stopped at the lock
//                before it applied anything
//   failed       the same root with errorcode="-2147188685" (0x80048033) and `solutionManifest processed="true"`: an import that failed AFTER it began
//
// Used by tests/import-job-proof.test.js (the rule), tests/solution-settings.test.js and tests/solution-settings-real-bundle.test.js (the resend).

const LOCK_ERRORCODE = '-2147020463';
const FAILED_AFTER_START_ERRORCODE = '-2147188685';
const REFUSAL_STATUS = 'Cannot start another [Import] because there is a previous [Import] running at this moment. Use Solution History for more details. -- The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.';

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// ` name="value"` for every attribute that is set: an attribute left `undefined` is not written, which is how a log that has not got to it yet looks.
const attrs = (values) => Object.entries(values || {}).filter(([, value]) => value !== undefined).map(([name, value]) => ` ${name}="${esc(value)}"`).join('');
const node = (name, values, inner) => (inner === undefined ? `<${name}${attrs(values)} />` : `<${name}${attrs(values)}>${inner}</${name}>`);

// What the platform writes under a node it has applied.
const STEP = '<result result="success" errorcode="0" errortext="" datetime="12:00:00.00" datetimeticks="639000000000000000" />';

function manifestNode(processed, finished) {
  return node('solutionManifest', { languagecode: '1033', id: 'contoso_sol', LocalizedName: 'Contoso solution', processed },
    '<UniqueName>contoso_sol</UniqueName><LocalizedNames><LocalizedName description="Contoso solution" languagecode="1033" /></LocalizedNames>'
    + '<Descriptions><Description description="A solution" languagecode="1033" /></Descriptions><Version>1.0.0.0</Version><Managed>0</Managed>'
    + '<Publisher><UniqueName>contoso</UniqueName><LocalizedNames><LocalizedName description="Contoso" languagecode="1033" /></LocalizedNames><EMailAddress /><SupportingWebsiteUrl />'
    + '<Addresses><Address><City /><Country /><Line1 /><Line2 /><PostalCode /><StateOrProvince /><Telephone1 /></Address></Addresses></Publisher>'
    + (finished ? `<results>${STEP}</results>` : '<results />'));
}

/**
 * The log of an import, as text.
 *   root        the attributes of `<importexportxml>`; `null` for the bare element of a running import
 *   manifest    `processed` of `<solutionManifest>` (`undefined`: the attribute is not written)
 *   components  `processed` of every table and of what is imported with it (`savedQuery`, `formXml`, `entityRibbon`, `rootComponent`, `dependency`, …);
 *               `undefined` for the skeleton of a running import, which lists the tables and nothing else
 *   handlers    `processed` of the package's own checks — `upgradeHandler` ×5 and `validateHandler` — or `null` when they have not run yet
 *   finished    write a `<result>` under the manifest and each component, as an import that applied them does
 *   tables      how many tables the package holds
 *   extra       XML added at the end of the root element
 */
function importLog({ root = null, manifest, components, handlers = null, finished = false, tables = 3, extra = '' } = {}) {
  const ids = Array.from({ length: tables }, (_, i) => `contoso_alpha${i + 1}`);
  const under = finished ? STEP : '';
  const named = (name, id) => node(name, { LocalizedName: `Alpha ${id}`, ExistingLocalizedName: `Alpha ${id}`, OriginalName: `Alpha ${id}`, Description: 'A table', id, processed: components }, under);
  const entities = ids.map((id) => named('entity', id)).join('');
  const subhandlers = ids.map((id) => ['savedQuery', 'formXml', 'entityRibbon'].map((name) => named(name, id)).join('')).join('');
  const checks = handlers === null ? ''
    : `<upgradeHandlers>${['UpdateRolesDepthLevel', 'RemoveContactParentContactRelationship', 'RemoveParentContactIdAttribute', 'RemoveParentContactMissingDependencyNode', 'UpdateMacrosCategoryAttribute']
      .map((id) => node('upgradeHandler', { id, LocalizedName: 'Transform Package', Description: 'Transform Package', processed: handlers }, STEP)).join('')}</upgradeHandlers>`
      + `<skuHandlers /><validateHandlers>${node('validateHandler', { id: 'XSDValidationHandler', LocalizedName: 'Package Validation', Description: 'Validates solution package schema.', processed: handlers }, STEP)}</validateHandlers>`;
  const inner = `<solutionManifests>${manifestNode(manifest, finished)}</solutionManifests>`
    + '<upgradeSolutionPackageInformation><upgradeRequired>1</upgradeRequired><upgradeValid>1</upgradeValid><fileVersion>9.2.0.0</fileVersion><currentVersion>9.2.1.1</currentVersion></upgradeSolutionPackageInformation>'
    + `<entities>${entities}</entities><AppModules /><AppModuleSiteMaps /><workflows /><webResources /><customControls /><reports /><languages><language /></languages>`
    + (components === undefined ? '' : `<entitySubhandlers>${subhandlers}</entitySubhandlers>`
      + `<rootComponents>${node('rootComponent', { processed: components }, finished ? STEP : undefined)}</rootComponents>`
      + `<dependencies>${node('dependency', { processed: components }, finished ? STEP : undefined)}</dependencies>`
      + `<workflowAndStepActivations>${node('workflowAndStepActivation', { processed: components }, finished ? STEP : undefined)}</workflowAndStepActivations>`)
    + checks + extra;
  return node('importexportxml', root || undefined, inner);
}

const rootOf = ({ errorcode, succeeded, status, progress = '17.1428571428571', processed = 'true' }) => ({ start: '639280238592671053', stop: '639280238604238275', progress, processed, errorcode, succeeded, status });

// Each kind of state the measurement captured, as a log.
const LOGS = {
  // The skeleton a running import starts with: nothing is processed, and the root has no attribute.
  running: (options) => importLog({ tables: 1, ...options }),
  // An import that applied the package: everything processed, the root says it succeeded.
  succeeded: (options) => importLog({ root: rootOf({ errorcode: '0', succeeded: 'success', status: '', progress: '100' }), manifest: 'true', components: 'true', handlers: 'true', finished: true, ...options }),
  // An import the platform refused at its customization lock before it applied anything: what the rule accepts.
  refused: (options) => importLog({ root: rootOf({ errorcode: LOCK_ERRORCODE, succeeded: 'failure', status: REFUSAL_STATUS }), manifest: 'false', components: 'false', handlers: 'true', ...options }),
  // An import that failed after it began (a managed package over an unmanaged solution, a missing dependency): the manifest was processed.
  failedAfterStart: (options) => importLog({ root: rootOf({ errorcode: FAILED_AFTER_START_ERRORCODE, succeeded: 'failure', status: 'The import failed.', progress: '43.75' }), manifest: 'true', components: 'false', handlers: 'true', ...options }),
  // A log caught between two writes: the row is complete but the root has not been given its verdict yet.
  unfinishedRoot: (options) => importLog({ root: { start: '639280238592671053', stop: '639280238604238275', progress: '17.1428571428571', processed: 'true' }, manifest: 'false', components: 'false', handlers: 'true', ...options }),
};

const COMPLETED_ON = '2026-01-01T12:00:03Z';
const ORIGIN = 'https://contoso.crm.dynamics.com';
/**
 * The answer of `GET importjobs(<id>)?$select=importjobid,completedon,data` for a log: `completedon` is set when the job is `completed` (the default) and null while it runs.
 * Anything else of the row is overridden by what is passed.
 */
function jobRow(data, { id = '44444444-4444-4444-8444-444444444444', completed = true, ...rest } = {}) {
  return {
    '@odata.context': `${ORIGIN}/api/data/v9.2/$metadata#importjobs(importjobid,completedon,data)/$entity`,
    importjobid: id,
    completedon: completed ? COMPLETED_ON : null,
    data,
    ...rest,
  };
}
// A Web API answer — what a transport returns and the platform fake's `jobLogAnswer` is — carrying a row.
const jobAnswer = (row, statusCode = 200) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) });

/**
 * The 347 states of an import job's row that the measurement captured — twenty imports, each read every 250–500 ms until nothing changed — as fourteen kinds. `count` is how many of
 * the 347 were of the kind, `completed` whether the row had `completedon` set, and `group` which of the measurement's five groups it belongs to:
 *   running-or-early-success  308  a running import's skeleton, and a finished one's row between two writes
 *   success-final              17  an import that applied the package, final row
 *   refused-early               9  a refused import's row before its final write (the platform had not answered yet)
 *   failed-after-start          5  an import that began and failed (a managed package over an unmanaged solution, a missing dependency)
 *   refused-final               8  a refused import's FINAL row: the only states the rule may accept
 */
const CAPTURED_STATES = [
  { name: 'a running import of a 6-table package: the skeleton', count: 190, completed: false, group: 'running-or-early-success', data: () => LOGS.running({ tables: 6 }) },
  { name: 'a running import of a 1-table package: the skeleton', count: 117, completed: false, group: 'running-or-early-success', data: () => LOGS.running({ tables: 1 }) },
  { name: 'an import of a 1-table package that applied it: the final row', count: 10, completed: true, group: 'success-final', data: () => LOGS.succeeded({ tables: 1 }) },
  { name: 'an import of a 6-table package that applied it: the final row', count: 7, completed: true, group: 'success-final', data: () => LOGS.succeeded({ tables: 6 }) },
  { name: 'a refused import of a 6-table package, read before its final write', count: 5, completed: false, group: 'refused-early', data: () => LOGS.running({ tables: 6 }) },
  { name: 'a refused import of a 6-table package: the FINAL row', count: 5, completed: true, group: 'refused-final', data: () => LOGS.refused({ tables: 6 }) },
  { name: 'a refused import of a 1-table package, read before its final write', count: 3, completed: false, group: 'refused-early', data: () => LOGS.running({ tables: 1 }) },
  { name: 'a refused import of a 1-table package: the FINAL row', count: 3, completed: true, group: 'refused-final', data: () => LOGS.refused({ tables: 1 }) },
  { name: 'a managed package over an unmanaged solution, early', count: 2, completed: false, group: 'failed-after-start', data: () => LOGS.running({ tables: 1 }) },
  { name: 'a managed package over an unmanaged solution: the final row', count: 1, completed: true, group: 'failed-after-start', data: () => LOGS.failedAfterStart({ tables: 1 }) },
  { name: 'a package with a missing dependency, early', count: 1, completed: false, group: 'failed-after-start', data: () => LOGS.running({ tables: 1 }) },
  { name: 'a package with a missing dependency: the final row', count: 1, completed: true, group: 'failed-after-start', data: () => LOGS.failedAfterStart({ tables: 1 }) },
  { name: 'an import that applied a package, row complete but its root not yet written', count: 1, completed: true, group: 'running-or-early-success', data: () => LOGS.unfinishedRoot({ manifest: 'true', components: 'true', finished: true, tables: 1 }) },
  { name: 'a refused import, row complete but its root not yet written', count: 1, completed: true, group: 'refused-early', data: () => LOGS.unfinishedRoot({ tables: 6 }) },
];

module.exports = { importLog, LOGS, rootOf, jobRow, jobAnswer, CAPTURED_STATES, LOCK_ERRORCODE, FAILED_AFTER_START_ERRORCODE, REFUSAL_STATUS, COMPLETED_ON, ORIGIN };
