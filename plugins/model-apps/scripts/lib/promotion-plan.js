'use strict';
// Promotion PLANNING only (`scripts/plan-app-promotion.js`): asks the TARGET environment's SDK to plan promoting an app
// from a SOURCE environment's solution package, and reports what the plan says — ready, refused or unknown, every
// refusal, every requirement, how each piece of the app would get there. Nothing is applied: this module never calls
// `promote`, never imports a solution, and never falls back to a plain import when the plan is refused. A plan is not
// written out for a later apply either — the SDK binds an apply to the instance that issued the plan, so a plan on disk
// would read as a promise this release cannot keep.
//
// Both SDKs sit on a transport that refuses every method but GET before it is sent (lib/readonly-operations.js), on
// top of the SDK's own read-only planning client, so a write attempt is refused twice and reported, never sent.
//
// Confidential inputs stay out of the result: environment-variable values and connection ids are counted, never echoed;
// the package's bytes are hashed by the SDK and never printed.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { readOnlyHttpClient, isNonEmptyString } = require('./readonly-operations.js');

class PromotionPlanInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromotionPlanInputError';
    this.code = 'PROMOTION_PLAN_INPUT_INVALID';
  }
}

// The host codec the SDK asks for (types/promotion.ts PromotionCodec): raw DEFLATE that stops at the SDK's bound, and
// SHA-256 as 64 lowercase hex. `maxOutputLength` makes zlib refuse past the bound rather than allocate it.
// See: https://nodejs.org/api/zlib.html#class-options
const NODE_CODEC = Object.freeze({
  inflateRaw: (input, maxOutputBytes) => new Uint8Array(zlib.inflateRawSync(input, { maxOutputLength: Math.max(1, maxOutputBytes) })),
  sha256: (input) => crypto.createHash('sha256').update(input).digest('hex'),
});

// A Power Platform deployment settings file (the shape `pac solution create-settings` writes), e.g.
//   { "EnvironmentVariables": [ { "SchemaName": "contoso_ApiBase", "Value": "https://api.contoso.com" } ],
//     "ConnectionReferences": [ { "LogicalName": "contoso_sharedsql", "ConnectionId": "<id>", "ConnectorId": "/providers/..." } ] }
// See: https://learn.microsoft.com/en-us/power-platform/alm/conn-ref-env-variables-build-tools#deployment-settings-file
// An entry with an empty value or connection id is kept out: the SDK then reports the value or mapping as missing,
// which is the truth, rather than planning an empty one.
function deploymentSettingsOf(settings) {
  if (settings === undefined || settings === null) return { values: [], connections: [] };
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new PromotionPlanInputError('The deployment settings must be a JSON object.');
  const list = (key) => {
    const value = settings[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new PromotionPlanInputError(`The deployment settings' ${key} must be an array.`);
    return value;
  };
  const values = list('EnvironmentVariables').filter((e) => e && isNonEmptyString(e.SchemaName) && typeof e.Value === 'string' && e.Value !== '')
    .map((e) => ({ schemaName: e.SchemaName, value: e.Value }));
  const connections = list('ConnectionReferences').filter((e) => e && isNonEmptyString(e.LogicalName) && isNonEmptyString(e.ConnectionId))
    .map((e) => ({ logicalName: e.LogicalName, connectionId: e.ConnectionId }));
  return { values, connections };
}

/**
 * The SDK's PlanPromotionInput from the maker's choices. Every switch is explicit: `acknowledgeNonAtomicImport` is
 * true ONLY when the maker granted it (the SDK refuses a ready plan without it, which is the point — the native import
 * is not a compare-and-swap).
 */
function promotionInputOf({ packageBytes, appUniqueName, mode, settings, requirements, overwriteUnmanagedCustomizations, publishWorkflows, acknowledgeNonAtomicImport, publishApp, limits }) {
  if (!Buffer.isBuffer(packageBytes) || packageBytes.length === 0) throw new PromotionPlanInputError('The solution package must be a non-empty file.');
  if (!isNonEmptyString(appUniqueName)) throw new PromotionPlanInputError('The app unique name is required.');
  if (mode !== undefined && mode !== 'managed' && mode !== 'unmanaged') throw new PromotionPlanInputError('The mode must be managed or unmanaged.');
  if (requirements !== undefined && !Array.isArray(requirements)) throw new PromotionPlanInputError('The requirements must be an array.');
  const { values, connections } = deploymentSettingsOf(settings);
  return {
    packageBase64: packageBytes.toString('base64'),
    appUniqueName,
    ...(mode ? { mode } : {}),
    values,
    connections,
    requirements: requirements || [],
    overwriteUnmanagedCustomizations: overwriteUnmanagedCustomizations === true,
    publishWorkflows: publishWorkflows === true,
    acknowledgeNonAtomicImport: acknowledgeNonAtomicImport === true,
    publishApp: publishApp === true,
    codec: NODE_CODEC,
    ...(limits ? { limits } : {}),
  };
}

const countBy = (items, key) => items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});

// A problem as the SDK documents it — fixed text, never a server message, package content or a value
// (types/promotion.ts PromotionProblem) — so it can be printed whole.
const problemOf = (p) => ({ code: p.code, phase: p.phase, blocking: p.blocking === true, message: p.message, ...(p.subject ? { subject: p.subject } : {}), ...(p.stepId ? { stepId: p.stepId } : {}), ...(p.httpStatus !== undefined ? { httpStatus: p.httpStatus } : {}) });

/** What the plan says, without its confidential parts. */
function describePlan(plan) {
  const coverage = plan.coverage || [];
  const requirements = (plan.intent && plan.intent.requirements) || [];
  return {
    outcome: plan.outcome,
    ready: plan.outcome === 'ready',
    importKind: plan.importKind,
    planDigest: plan.planDigest,
    package: plan.package,
    intent: plan.intent && {
      appUniqueName: plan.intent.appUniqueName,
      mode: plan.intent.mode,
      values: plan.intent.values.length,
      connections: plan.intent.connections.length,
      settingOverrides: plan.intent.settingOverrides.length,
      overwriteUnmanagedCustomizations: plan.intent.overwriteUnmanagedCustomizations,
      publishWorkflows: plan.intent.publishWorkflows,
      acknowledgeNonAtomicImport: plan.intent.acknowledgeNonAtomicImport,
      publishApp: plan.intent.publishApp,
    },
    refusals: (plan.problems || []).filter((p) => p.blocking).map(problemOf),
    warnings: (plan.problems || []).filter((p) => !p.blocking).map(problemOf),
    requirements: requirements.map((r) => ({ id: r.id, kind: r.kind, requiredBefore: r.requiredBefore })),
    coverage: {
      byDelivery: countBy(coverage, 'delivery'),
      refused: coverage.filter((c) => c.delivery === 'refused').map((c) => c.subject),
      incomplete: coverage.filter((c) => c.required && !c.complete).length,
    },
    steps: (plan.steps || []).map((s) => ({ id: s.id, kind: s.kind })),
    reads: plan.reads,
  };
}

/**
 * Plans an app promotion, read-only. Never applies it.
 * @param {object} args
 * @param {object} args.sourceHttpClient - the source environment's SDK HttpClient
 * @param {object} args.targetHttpClient - the target environment's SDK HttpClient
 * @param {(httpClient: object, side: 'source'|'target') => object} args.makeSdk - a Maker SDK over the given client
 * @param {object} args.input - see promotionInputOf
 * @returns {Promise<object>} `{ok, applied:false, plan?, error?, gets, writeAttempts}`; `ok` only for a ready plan
 */
async function planAppPromotion({ sourceHttpClient, targetHttpClient, makeSdk, input }) {
  const sdkInput = promotionInputOf(input);
  const source = readOnlyHttpClient(sourceHttpClient);
  const target = readOnlyHttpClient(targetHttpClient);
  const traffic = () => ({ gets: source.stats.gets + target.stats.gets, writeAttempts: source.stats.refusedWrites + target.stats.refusedWrites });
  const common = { applied: false, applyAvailable: false, fallbackImport: false };
  let plan;
  try {
    plan = await makeSdk(target.client, 'target').planPromotion(makeSdk(source.client, 'source'), sdkInput);
  } catch (err) {
    // PromotionError carries a fixed-text problem; anything else is reported by code and type only.
    const problem = err && err.problem ? problemOf(err.problem) : undefined;
    return { ok: false, ...common, error: { code: (err && err.code) || 'PROMOTION_PLAN_FAILED', ...(problem ? { problem } : { message: 'The promotion could not be planned.' }) }, ...traffic() };
  }
  const described = describePlan(plan);
  const t = traffic();
  // A write attempt — refused before it was sent — makes the plan untrustworthy, whatever it says.
  return { ok: described.ready && t.writeAttempts === 0, ...common, plan: described, ...t };
}

module.exports = { NODE_CODEC, PromotionPlanInputError, deploymentSettingsOf, promotionInputOf, describePlan, planAppPromotion };
