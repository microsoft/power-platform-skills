'use strict';
// What the import JOB of an import the platform REFUSED to start says about whether that import applied anything: the proof solution-settings.js needs before it sends a refused import again.
//
// The platform answers an import that meets another import or a publish with HTTP 429 and the Dataverse error code 0x80071151 (SolutionConcurrencyFailure):
//   { "error": { "code": "0x80071151", "message": "Cannot start another [Import] because there is a previous [Import] running at this moment. Use Solution History for more details. -- The solution
//     installation or removal failed due to the installation or removal of another solution at the same time. Please try again later." } }
// ("Cannot start the requested operation [Import] because there is another [Publish] running …" when a publish holds the lock). The code does not say that nothing started — its documented text says an
// installation or removal FAILED — so the import's own job decides. It is read ONCE and AT ONCE: the row of a refused send is final by the time the answer is in hand, and it is not written again. Measured on a
// Public-cloud environment (Dataverse 9.2), a refused send's `importjobs(<id>)` is one of two things:
//   - it never exists (HTTP 404, at once and for as long as it was read: hours) — the refusal came at the FIRST lock check, before the platform made a job. An import that was refused for another reason
//     before it started (an invalid package, HTTP 400) has no job either;
//   - it exists, finished, and says so — the refusal came at the SECOND lock check, when two imports started together. Its row has `completedon` set and a `data` column that is the import's log:
//       <importexportxml start="…" stop="…" progress="17.1428571428571" processed="true" errorcode="-2147020463" succeeded="failure" status="Cannot start another [Import] …">
//         <solutionManifests><solutionManifest languagecode="1033" id="contoso_sol" LocalizedName="…" processed="false"> … <results /></solutionManifest></solutionManifests>
//         <entities><entity … id="contoso_alpha1" processed="false"></entity> …</entities>
//         <entitySubhandlers><savedQuery … processed="false"></savedQuery><formXml … processed="false"></formXml><entityRibbon … processed="false"></entityRibbon> …</entitySubhandlers>
//         <rootComponents><rootComponent processed="false" /></rootComponents> <dependencies><dependency processed="false" /></dependencies> <workflowAndStepActivations> …
//         <upgradeHandlers><upgradeHandler id="…" … processed="true"><result result="success" errorcode="0" errortext="" datetime="…" datetimeticks="…" /></upgradeHandler> …</upgradeHandlers>
//         <validateHandlers><validateHandler id="XSDValidationHandler" … processed="true"><result result="success" … /></validateHandler></validateHandlers>
//       </importexportxml>
//     `-2147020463` is 0x80071151 read as a signed 32-bit integer. The only nodes marked processed="true" are the package's own checks (the in-memory transform of the package and the XSD validation), which
//     run before the lock is asked for the second time; nothing of the package — the solution manifest, a table, a view, a form — was applied.
// What a job that is NOT such a refusal looks like, for contrast: a running import has `completedon` null and a log that is the bare `<importexportxml>` with no attribute on the root and no `processed` on any
// node; an import that applied the package has `succeeded="success"` and every node processed="true"; one that FAILED AFTER it began (a managed package over an unmanaged solution, a missing dependency; HTTP 500
// 0x80048033) has the root's `errorcode="-2147188685"` and `solutionManifest processed="true"`. `solutionManifest processed="false"` means nothing was applied because the platform writes the manifest FIRST: in all
// 17 imports that completed, its result time is 2.6–6.1 s before the first component's.
//
// THE RULE (a refused send's job proves that nothing of the package was applied, so a second send cannot meet a half-applied first one, when ALL of this holds):
//   - `completedon` is set (a running job proves nothing);
//   - `data` is ONE XML document whose root is `importexportxml` with `succeeded="failure"` and `errorcode="-2147020463"`, exactly;
//   - there is at least one `solutionManifest`, and every one is `processed="false"`;
//   - no other element but the package's own checks (`upgradeHandler`, `validateHandler`) is marked anything but "false".
// Or the job does not exist (HTTP 404). Anything else — a job still running, one that failed after it began, a log that is not what is described, a read that failed — is NOT PROVEN: the import is not sent again.
// Not looked at, because the measurement shows they do not tell a refusal from a running import: `progress` (a running import passes through 17.14 and 40 too), `solutionid` (set even for a solution that was never
// made), `importcontext`, and the VALUE of any timestamp.
//
// WHY A READER AND NOT A PATTERN. The log is an undocumented internal format, and this is a decision that must not be wrong in the dangerous direction: a wrong "nothing was applied" sends a second copy of an import
// that the platform may be running. A pattern over the text finds `processed="true"` only where it expects a tag to end — and a ">" is legal in an attribute value — and finds the attributes it looks for in a comment, a
// CDATA section or another attribute's value. So the log goes through lib/strict-xml.js, which reads exactly one well-formed document and answers with no element at all for anything else, and every doubt is "not
// proven": a value that is not exactly the one measured ("Failure", " failure", "-2147020463.0", "True"), a duplicate attribute, a DOCTYPE, a log longer than MAX_JOB_LOG_CHARS.
//
// Only fixed words and numbers are ever put in a `reason` — never a text the platform wrote — because a reason is shown in a message beside the settings file's values.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/importsolution ("the ID of the import job that will be created to perform the import"),
//      https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/importjob (`completedon`, `data`),
//      https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes (0x80071151).
const { readXmlElements } = require('./strict-xml.js');

// 0x80071151 as the signed 32-bit integer the log writes (0x80071151 | 0).
const CONCURRENCY_ERRORCODE = '-2147020463';
// A refused import's log lists every component of the package as unprocessed, about a hundred bytes each, so even a package of tens of thousands of components fits. The limit only bounds the work of the reader
// (linear in the text, plus one look at the text for each kind of element): a log past it is not read.
const MAX_JOB_LOG_CHARS = 8 * 1024 * 1024;
const LOG_LIMIT_TEXT = `${MAX_JOB_LOG_CHARS / (1024 * 1024)} MiB`;
// The package's own checks: they run — in memory, on the package alone — before the second lock check, so a refused import has them processed.
const PACKAGE_CHECKS = new Set(['upgradeHandler', 'validateHandler']);

// How a job was proven: it does not exist, or its log says the import was refused before it applied anything.
const PROOF_ABSENT = 'job-absent';
const PROOF_LOG = 'job-refused-before-any-component';

// What each way of failing the rule says, in fixed words. `why` is the key; `reason` completes "…, but <reason>, so it is not proven that the refused send applied nothing of the package".
const REASONS = Object.freeze({
  'no-log': 'its import job has no log to read',
  unfinished: 'its import job is not finished (completedon is empty)',
  'log-too-large': `the log of its import job is longer than ${LOG_LIMIT_TEXT}, which this script does not read`,
  'log-unreadable': 'the log of its import job is not an XML document this script can read',
  'not-an-import-log': 'the log of its import job is not an importexportxml document',
  'not-a-failure': 'the log of its import job does not say that the import failed',
  'no-manifest': 'the log of its import job has no solution manifest',
  'manifest-processed': 'the log of its import job shows that the import began to apply the package (its solution manifest is processed)',
  'manifest-unmarked': 'the log of its import job does not say that its solution manifest was left unprocessed',
  'component-processed': 'the log of its import job shows that the import began to apply components of the package',
  'component-unmarked': 'the log of its import job marks a component in a way this script does not recognise',
  'no-answer': 'the read of its import job got no answer',
});

const notProven = (why, reason = REASONS[why]) => ({ proven: false, why, reason });

// The error code of a log that failed with another: `errorcode` is a signed 32-bit integer as text ("-2147188685"), and the platform spells codes in hex (0x80048033), so a code that is exactly such a number is
// shown that way — numbers only, nothing the platform wrote.
function otherError(errorcode) {
  if (errorcode === undefined) return notProven('other-error', 'the log of its import job does not give the error code the import failed with');
  const canonical = /^(?:0|-?[1-9]\d{0,9})$/.test(errorcode) ? Number(errorcode) : NaN;
  if (!Number.isInteger(canonical) || canonical < -(2 ** 31) || canonical > 2 ** 31 - 1) return notProven('other-error', 'the log of its import job gives an error code this script does not recognise');
  return notProven('other-error', `the log of its import job says the import failed with error 0x${(canonical >>> 0).toString(16).toUpperCase()}, not with 0x80071151`);
}

/**
 * Whether the row of a refused send's job — `GET importjobs(<id>)?$select=importjobid,completedon,data`, as the client parsed it — proves that the import applied nothing (THE RULE, above).
 * `{ proven: true }`, or `{ proven: false, why, reason }`: `why` is a key (`REASONS`, `other-error`), `reason` the words that say it. Never throws, whatever it is given.
 */
function refusedBeforeAnyComponent(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return notProven('no-log');
    const { completedon, data } = row;
    if (typeof completedon !== 'string' || completedon.trim() === '') return notProven('unfinished');
    if (typeof data !== 'string' || data === '') return notProven('no-log');
    if (data.length > MAX_JOB_LOG_CHARS) return notProven('log-too-large');
    // Every element is wanted: the rule is about ALL of them (none but the package's own checks may be processed).
    const read = readXmlElements(data, () => true);
    if (!read.ok) return notProven('log-unreadable');
    // The one element with no ancestor is the root: a nested element of the same name is an ordinary element.
    const root = read.elements.find((element) => element.path === '');
    if (!root || root.name !== 'importexportxml') return notProven('not-an-import-log');
    if (root.attrs.succeeded !== 'failure') return notProven('not-a-failure');
    if (root.attrs.errorcode !== CONCURRENCY_ERRORCODE) return otherError(root.attrs.errorcode);
    const manifests = read.elements.filter((element) => element.name === 'solutionManifest');
    if (manifests.length === 0) return notProven('no-manifest');
    for (const manifest of manifests) {
      if (manifest.attrs.processed === 'true') return notProven('manifest-processed');
      if (manifest.attrs.processed !== 'false') return notProven('manifest-unmarked');
    }
    for (const element of read.elements) {
      if (element === root || element.name === 'solutionManifest' || PACKAGE_CHECKS.has(element.name)) continue;
      const processed = element.attrs.processed;
      if (processed === undefined || processed === 'false') continue;
      return notProven(processed === 'true' ? 'component-processed' : 'component-unmarked');
    }
    return { proven: true };
  } catch {
    // Not reachable for what the client hands over (parsed JSON), and the answer to anything that does throw is the one answer that is always safe.
    return notProven('no-log');
  }
}

/**
 * What the answer to the read of a refused send's job proves: `{ proven: true, proof }` — PROOF_ABSENT for a 404, PROOF_LOG for a 200 whose row proves it (refusedBeforeAnyComponent) — or `{ proven: false, why, reason }`.
 * `answer` is `{ status, body }` as the client gives it, or null when the read got no answer. A 404 is proof whatever its body says: the job does not exist, so nothing was done under it; any other status
 * than 200 (the job's row), a 401, a 403, a throttle, a 5xx, is no proof, because it says nothing of the job.
 */
function proveRefusedImport(answer) {
  if (!answer || typeof answer !== 'object' || !Number.isInteger(answer.status)) return notProven('no-answer');
  if (answer.status === 404) return { proven: true, proof: PROOF_ABSENT };
  if (answer.status !== 200) return notProven('unreadable', `the read of its import job answered HTTP ${answer.status}, which is neither the job nor a 404`);
  const verdict = refusedBeforeAnyComponent(answer.body);
  return verdict.proven ? { proven: true, proof: PROOF_LOG } : verdict;
}

module.exports = { refusedBeforeAnyComponent, proveRefusedImport, MAX_JOB_LOG_CHARS, CONCURRENCY_ERRORCODE, PROOF_ABSENT, PROOF_LOG, REASONS };
