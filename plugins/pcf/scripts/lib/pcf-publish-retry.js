'use strict';
// A bounded re-send of the ONE request `pac pcf push` lost to a SQL deadlock: its final publish of all customizations.
//
// `pac pcf push` builds, imports a temporary solution and then publishes all customizations, in one process. On a shared environment the
// publish can be chosen as a SQL Server deadlock victim (error 1205) when another import or publish runs at the same time. pac prints
// (observed on a live push, on stdout, after the import had succeeded):
//   Importing the temporary solution wrapper into the current org: done.
//   Publishing All Customizations...
//   Error:  Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205
// A deadlock victim's transaction is rolled back, so that publish did nothing and sending it again is safe. Re-running the whole push would
// rebuild and re-import as well, so only the publish is sent again here, as the documented unbound PublishAllXml action — the same
// request pac makes for that step:
//   POST <envUrl>/api/data/v9.2/PublishAllXml  {}
// See: https://learn.microsoft.com/sql/relational-databases/errors-events/mssqlserver-1205-database-engine-error
//      https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/publishallxml
//
// Nothing else is re-sent: a failure before the publish step, any other error, and an answer that never arrived (the transport failed or
// timed out, so the publish may still be running) all stop at once. The HTTP client sends a publish exactly once (sdk-http-client.js,
// `publishOnce`), so this loop is the only layer that re-sends it and the attempts never multiply.
const { SQL_DEADLOCK_VICTIM, isSqlDeadlockVictim } = require('./sdk-http-client.js');

// pac's progress line for its publish step. Only a deadlock reported AFTER it is the publish's own; a 1205 during the import is not retried.
const PUBLISH_STEP_MARKER = 'Publishing All Customizations';
// At most two re-sends after pac's own attempt, waiting longer each time so the competing import or publish can finish.
const PUBLISH_RETRY_DELAYS_MS = Object.freeze([5000, 15000]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when a failed `pac pcf push` result shows its publish-all step lost a SQL deadlock: pac's publish line is present and the last
 * SQL number after it is 1205 (SQL_DEADLOCK_VICTIM reads the LAST `Sql Number:` so a quoted 1205 inside another SQL error does not count).
 * A spawn error, a timeout or a success is never one.
 */
function isPublishStepDeadlock(result) {
  if (!result || result.error || (result.status || 0) === 0) return false;
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const at = text.lastIndexOf(PUBLISH_STEP_MARKER);
  return at !== -1 && SQL_DEADLOCK_VICTIM.test(text.slice(at));
}

/**
 * Send PublishAllXml again, at most `delays.length` times, while each answer is a SQL deadlock victim.
 * `dataverse` is the SDK's Dataverse client, whose `post` answers `{ status, headers, body }` and throws only when the transport fails.
 * Answers `{ published, retries, outcome, reason? }`: outcome is `published`, `deadlock` (every re-send lost a deadlock too), `error`
 * (another answer, not re-sent) or `indeterminate` (no answer arrived, not re-sent).
 */
async function retryPublishAll(dataverse, { sleep = wait, delays = PUBLISH_RETRY_DELAYS_MS } = {}) {
  let retries = 0;
  for (const delay of delays) {
    await sleep(delay);
    retries += 1;
    let answer;
    try {
      answer = await dataverse.post('/PublishAllXml', {});
    } catch (err) {
      return { published: false, retries, outcome: 'indeterminate', reason: errorText(err) };
    }
    if (!answer) return { published: false, retries, outcome: 'indeterminate', reason: 'PublishAllXml returned no answer' };
    if (answer.status >= 200 && answer.status < 300) return { published: true, retries, outcome: 'published' };
    if (!isSqlDeadlockVictim({ statusCode: answer.status, body: answer.body })) {
      return { published: false, retries, outcome: 'error', reason: answerText(answer) };
    }
  }
  return { published: false, retries, outcome: 'deadlock' };
}

function errorText(err) {
  return (err && err.message ? String(err.message) : String(err)).slice(0, 300);
}

// Dataverse errors arrive as { error: { code, message } }; some surfaces capitalize the envelope as { Error: { message } }.
function answerText(answer) {
  const body = answer.body;
  const envelope = body && (body.error || body.Error);
  const message = envelope && envelope.message ? envelope.message : (typeof body === 'string' ? body : '');
  return `HTTP ${answer.status}${message ? `: ${String(message).trim().slice(0, 300)}` : ''}`;
}

module.exports = { PUBLISH_STEP_MARKER, PUBLISH_RETRY_DELAYS_MS, isPublishStepDeadlock, retryPublishAll };
