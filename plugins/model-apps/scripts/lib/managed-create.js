'use strict';
// The create bridge the declared managed kinds (web resources, process flows, dashboards, forms, business rules) use on top of
// reconcile-common.js:createThroughPort, which stays exactly as the declared views, charts and commands use it.
//
// Why a bridge at all: the creation port answers one envelope for a create whose `execute` ran,
//   { outcome: 'created' | 'matched', id, childIds, result, evidence }      (an `ids` alias may ride along)
// where `matched` means the SDK itself answered a native exact match for the row it was asked to create
// (evidence 'sdk-adopted-exact'). createThroughPort predates that answer and classifies every outcome other than
// created / adopted / refused as unknown, which is right for it: it never treats an unrecognised envelope as
// success. A managed kind must still be able to tell an authoritative native match from an unknown outcome, and
// must never confuse it with a creation (no creation ownership, no created count) or with createThroughPort's
// 'adopted' (that one means execute was NOT called). So this wraps the port once, keeps the envelope it answered,
// and maps ONLY a validated matched envelope to `status: 'matched'`. Everything else is createThroughPort's verdict,
// unchanged: a throw, a malformed envelope, a failed port and a callback that saved while the port failed all stay
// refused or unknown — a callback's own success never rescues the port's answer.

const { createThroughPort, normalizeGuid } = require('./reconcile-common.js');

/**
 * Run one create through `ctx.creates.run` (via createThroughPort) and classify it.
 * `execute({id, childIds})` must answer the pushChecked shape ({ outcome: 'saved'|'refused'|'unknown', code }) and catch
 * its own post-send failures: createThroughPort answers a THROW from execute as a local refusal (nothing sent).
 * @returns {Promise<{ status: 'created'|'matched'|'adopted'|'refused'|'unknown', id?: string, childIds?: object,
 *   code: string, rules?: string[], evidence?: string, result?: any, executed: boolean }>}
 */
async function runManagedCreate(ctx, request, execute) {
  let envelope;
  let executed = false;
  let answered;
  const port = ctx && ctx.creates && typeof ctx.creates.run === 'function'
    ? {
      // One delegation, one envelope: the scoped facade keeps what the port answered and passes it on untouched.
      run: async (req, exec) => {
        envelope = await ctx.creates.run(req, exec);
        return envelope;
      },
    }
    : null;
  const scoped = port ? { ...ctx, creates: port } : ctx;
  const out = await createThroughPort(scoped, request, async (ids) => {
    executed = true;
    answered = await execute(ids);
    return answered;
  });
  const result = { ...out, executed };
  if (envelope && envelope.result !== undefined) result.result = envelope.result;
  if (envelope && typeof envelope.evidence === 'string') result.evidence = envelope.evidence;
  if (out.status === 'created') {
    // A created answer must name a root id the consumer can read back; anything else is not a receipt.
    if (!normalizeGuid(out.id)) return { ...result, status: 'unknown', code: 'creation-settlement-disagreed' };
    return result;
  }
  if (out.status === 'unknown' && envelope && envelope.outcome === 'matched') {
    const valid = executed
      && answered && answered.outcome === 'saved'
      && envelope.evidence === 'sdk-adopted-exact'
      && normalizeGuid(envelope.id)
      && (envelope.childIds === undefined || (envelope.childIds && typeof envelope.childIds === 'object'));
    if (valid) {
      return { ...result, status: 'matched', id: String(envelope.id), childIds: envelope.childIds || {}, code: 'creation-matched' };
    }
  }
  return result;
}

module.exports = { runManagedCreate };
