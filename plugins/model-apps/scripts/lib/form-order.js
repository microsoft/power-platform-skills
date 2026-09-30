'use strict';
// Main Form Set order (AB#6736948): which Main form a table opens with, and the order its form
// switcher lists them in. Shared by the spec gate (app-spec.js), the build (sdk-build.js) and verify
// (verify-spec.js), so the three cannot disagree about which forms are ordered, or how.
//
// The platform keeps the order on each FORM, not on the table. A Main form's formxml carries
//   <DisplayConditions Order="1" FallbackForm="true"><Everyone /></DisplayConditions>
// and a user is served the forms they may open sorted by that `Order`. MEASURED live, on a throwaway
// table with three Main forms:
//   - changing only the three `Order` values reversed the order the public RetrieveFilteredForms
//     function returns (the forms a given user may open, first to last);
//   - moving `systemform.isdefault` to another form did not reorder it;
//   - forms with an EQUAL `Order` are put in an order the platform chooses, which `isdefault` does not
//     decide: three new forms, all at the `Order="0"` a new form carries, were served with the
//     `isdefault` form LAST — so a table whose Main forms the build had just created did NOT open with
//     the form the build marked as the default;
//   - a form with no <DisplayConditions> at all is served after every form that has one.
// So the order is plain formxml, written through the same supported call that sets a form's security
// roles (the SDK's setFormSecurityRoles) — the private messages behind Maker's "Form order" dialog are
// not needed. What a user actually opens also depends on two things this module does not control: the
// form they last switched to for that table (remembered per user, and opened first while they may
// still open it), and which forms their security roles allow.
// See: https://learn.microsoft.com/power-apps/maker/model-driven-apps/assign-form-order
//      https://learn.microsoft.com/power-apps/maker/model-driven-apps/control-access-forms
//      https://learn.microsoft.com/power-apps/developer/model-driven-apps/form-xml-schema (FormDisplayConditionsType)
//      https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrievefilteredforms

const lower = (s) => String(s === undefined || s === null ? '' : s).toLowerCase();

/** A `forms[]` entry that is a Main form (`formType` omitted means Main). */
const isMainForm = (f) => !!f && typeof f === 'object' && (f.formType === undefined || f.formType === 'Main');

function entitySpecFor(spec, entityLogical) {
  const key = lower(entityLogical);
  return ((spec && spec.entities) || []).find((e) => e && lower(e.schemaName) === key) || null;
}

/**
 * True for a table this spec creates and owns: declared, not `existing`, and named with the spec's
 * publisher prefix. Only there does the build make an IMPLICIT choice about what the table opens with
 * — re-pointing a reused or system table is an environment-wide change the author did not ask for. An
 * explicit `isDefault` or `mainFormOrder` is applied on any table.
 */
function isOwnCustomTable(spec, entityLogical) {
  const entSpec = entitySpecFor(spec, entityLogical);
  const prefix = spec && spec.solution && spec.solution.publisherPrefix;
  return !!(entSpec && entSpec.existing !== true && prefix
    && lower(entSpec.schemaName).startsWith(lower(prefix) + '_'));
}

/** The spec's Main forms for a table, in spec order. */
function declaredMainForms(spec, entityLogical) {
  const key = lower(entityLogical);
  return ((spec && spec.forms) || []).filter((f) => isMainForm(f) && lower(f.entity) === key);
}

/**
 * The table's `entities[].mainFormOrder`, resolved to its Main form entries, or null when it declares
 * none. A name that resolves to nothing, or a repeat, is left out here — the spec gate rejects both.
 */
function listedMainForms(spec, entityLogical) {
  const entSpec = entitySpecFor(spec, entityLogical);
  if (!entSpec || !Array.isArray(entSpec.mainFormOrder)) return null;
  const mains = declaredMainForms(spec, entityLogical);
  const out = [];
  for (const name of entSpec.mainFormOrder) {
    const f = mains.find((m) => m.name === name);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * The Main form a table opens with, as the spec declares it: `{ form, explicit }`, or null.
 * `forms[].isDefault` first, then the first entry of `entities[].mainFormOrder` (the spec gate makes
 * the two agree); both apply on any table. Failing both, and only on a table the spec owns, the first
 * Main form in spec order (AB#6686426's fallback).
 */
function selectDefaultForm(spec, entityLogical) {
  const mains = declaredMainForms(spec, entityLogical);
  const flagged = mains.find((f) => f.isDefault === true);
  if (flagged) return { form: flagged, explicit: true };
  const listed = listedMainForms(spec, entityLogical);
  if (listed && listed.length) return { form: listed[0], explicit: true };
  if (mains.length && isOwnCustomTable(spec, entityLogical)) return { form: mains[0], explicit: false };
  return null;
}

/**
 * True when a Main form of the table sets `securityRoles.order`. That writes the same `Order`
 * attribute, so the author is ordering these forms by hand and the build leaves the order to them.
 */
function ordersByHand(spec, entityLogical) {
  return declaredMainForms(spec, entityLogical)
    .some((f) => f.securityRoles && typeof f.securityRoles === 'object' && f.securityRoles.order !== undefined);
}

/**
 * The spec's Main forms of a table in the order the build gives them, first to last, or null when the
 * build orders none of them. `current` maps a form entry to its stored `Order` (a number, or undefined
 * when the form has no <DisplayConditions>).
 *
 * The forms `mainFormOrder` lists come first, in that order; without a list, the default form alone
 * comes first. The spec's other Main forms follow in their CURRENT relative order (ties, and forms with
 * no `Order`, in spec order), so an order a maker set in Maker is kept for every form the spec says
 * nothing about. Forms the spec does not declare are never in the result: the build does not write them.
 */
function plannedMainFormSequence(spec, entityLogical, current = new Map()) {
  if (ordersByHand(spec, entityLogical)) return null;
  const listed = listedMainForms(spec, entityLogical);
  let head = listed && listed.length ? listed : null;
  if (!head) {
    const chosen = selectDefaultForm(spec, entityLogical);
    if (!chosen) return null;
    head = [chosen.form];
  }
  const rank = (f) => { const o = current.get(f); return Number.isFinite(o) ? o : Infinity; };
  const rest = declaredMainForms(spec, entityLogical)
    .filter((f) => !head.includes(f))
    .map((f, i) => ({ f, i }))
    // Infinity - Infinity is NaN, which is falsy, so two forms without an Order fall through to spec order.
    .sort((a, b) => (rank(a.f) - rank(b.f)) || (a.i - b.i))
    .map((x) => x.f);
  return [...head, ...rest];
}

/**
 * A form's `<DisplayConditions>` as stored in its formxml: `{ present, order }`. Shapes seen live:
 *   <DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions>
 *   <DisplayConditions FallbackForm="true" Order="3"><Everyone /></DisplayConditions>
 *   <DisplayConditions Order="2" FallbackForm="false"><Role Id="{GUID}" /></DisplayConditions>
 * Attribute order varies, so `Order` is read by name from the start tag (which may also be
 * self-closing). `order` is undefined when the attribute is absent or is not an integer.
 */
function displayConditionsOrder(formxml) {
  const tag = /<DisplayConditions\b([^>]*?)\/?>/.exec(String(formxml || ''));
  if (!tag) return { present: false, order: undefined };
  const attr = /\sOrder\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[1]);
  const raw = attr ? (attr[1] !== undefined ? attr[1] : attr[2]) : undefined;
  return { present: true, order: raw !== undefined && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : undefined };
}

/**
 * Compare the order a user is served (form ids, first to last) with the build's order for the spec's
 * forms (`planned`: `[{ name, id }]`, first to last). Returns one of:
 *   { ok: true }
 *   { ok: false, reason: 'order', before, after } — `before` is served ahead of `after`, which the spec
 *                                                    puts first
 *   { ok: false, reason: 'ahead', aheadId }        — a form the spec does not put first is served first
 *   { ok: null, reason: 'first-not-served' }       — this user may not open the first planned form, so
 *                                                    what users open cannot be judged from their answer
 * and, always, `missing`: the planned forms this user is not served (their security roles), which the
 * served order cannot place.
 */
function compareServedOrder(planned, served) {
  const norm = (id) => lower(String(id === undefined || id === null ? '' : id).replace(/[{}]/g, '').trim());
  const servedIds = (served || []).map(norm);
  const pos = new Map();
  servedIds.forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
  const missing = planned.filter((p) => !pos.has(norm(p.id))).map((p) => p.name);
  const offered = planned.filter((p) => pos.has(norm(p.id)));
  for (let i = 1; i < offered.length; i += 1) {
    if (pos.get(norm(offered[i].id)) < pos.get(norm(offered[i - 1].id))) {
      return { ok: false, reason: 'order', before: offered[i].name, after: offered[i - 1].name, missing };
    }
  }
  if (!planned.length || !pos.has(norm(planned[0].id))) return { ok: null, reason: 'first-not-served', missing };
  if (servedIds[0] !== norm(planned[0].id)) return { ok: false, reason: 'ahead', aheadId: servedIds[0], missing };
  return { ok: true, missing };
}

module.exports = {
  isMainForm,
  isOwnCustomTable,
  declaredMainForms,
  listedMainForms,
  selectDefaultForm,
  ordersByHand,
  plannedMainFormSequence,
  displayConditionsOrder,
  compareServedOrder,
};
