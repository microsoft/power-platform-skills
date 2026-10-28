'use strict';
// The plugin's OWN publishes — the `PublishXml` requests it sends itself, beside the ones the SDK sends — go out through here, and only here.
//
// The HTTP client sends a publish once (lib/sdk-http-client.js, `publishOnce`): a publish the customization lock refused is not shown to have
// changed nothing, and an accepted re-send of one was measured publishing old content. What IS re-sent is a publish SQL chose as a deadlock
// victim — its transaction was rolled back, so it did nothing — and exactly ONE layer re-sends it on each path, so that the layers never
// multiply: the SDK's own publishXml (its resendDeadlockVictim) for every publish the SDK makes, and this function for the plugin's. Both wait
// 1 s, 2 s and 4 s, at most three re-sends.
//
// The request (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/publishxml):
//   POST /PublishXml  { "ParameterXml": "<importexportxml><entities><entity>contoso_task</entity></entities></importexportxml>" }
// `dataverse` is the SDK's Dataverse client (an SDK's `dataverse`), whose `post` answers `{ status, headers, body }` with the body parsed and
// throws only for a failure of the transport — which is not re-sent here either: a publish that got no answer may still be running.
// A deadlock victim is HTTP 500 whose answer ENDS in the platform's signature (SQL_DEADLOCK_VICTIM: the last SQL number it gives is 1205):
//   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205"}}
const { DEADLOCK_RESENDS, isSqlDeadlockVictim } = require('./sdk-http-client.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send `{ ParameterXml: parameterXml }` to PublishXml, again while SQL rolls it back as a deadlock victim. Answers the last answer, as it came. */
async function postPublishXml(dataverse, parameterXml, { sleep = wait } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await dataverse.post('/PublishXml', { ParameterXml: parameterXml });
    const lost = Boolean(answer) && isSqlDeadlockVictim({ statusCode: answer.status, body: answer.body });
    if (!lost || attempt >= DEADLOCK_RESENDS) return answer;
    await sleep(1000 * 2 ** attempt);
  }
}

module.exports = { postPublishXml };
