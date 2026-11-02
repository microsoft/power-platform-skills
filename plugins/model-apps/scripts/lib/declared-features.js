'use strict';
// The enable flags of the declared-artifact features whose build wiring ships in steps: the dispatch, grammar and docs land first
// with the flag OFF, and the verify, download and approval wiring lands with the commit that turns it ON. A feature is
// maker-visible only when its flag is on. While it is off:
//   - validation refuses `reconcile` on that kind exactly as before (app-spec.js), so a spec cannot reach the build with it;
//   - the build never calls the feature's helper (sdk-build.js), so every spec sends the requests it always sent.
// One object, read at call time by both gates, so the two can never disagree. Tests that pin the dispatch before the flag is on
// set the property for the duration of one test and restore it; production code never writes it.
const DECLARED_FEATURES = {
  // forms[].reconcile: "declared" — the managed form layout (lib/form-layout-reconcile.js reconcileDeclaredForm). On: the build, verify
  // (verify-spec.js verifyManagedForm), the explicit managed download (lib/declared-form-io.js) and the typed approvals are wired.
  forms: true,
  // dashboards[].reconcile: "declared" — a managed global Standard dashboard (lib/dashboard-reconcile.js settleDeclaredDashboard). On:
  // the build, verify (verify-spec.js verifyManagedDashboard), the explicit managed download (lib/declared-dashboard-io.js) and the
  // typed approvals are wired.
  dashboards: true,
  // businessRules[].reconcile: "declared" — a business rule managed whole as one workflow (lib/rule-settlement.js settleDeclaredRule):
  // created Draft under a stable id, then activated by a conditional write; an existing rule's body or state is never edited. On: the
  // build, verify (verify-spec.js verifyManagedRule), the explicit managed download (lib/declared-rule-io.js) and the typed approval
  // (adopt:rule:<table>/<name>) are wired.
  rules: true,
  // businessProcessFlows[].reconcile: "declared" — a business process flow managed whole as one workflow
  // (lib/bpf-settlement.js settleDeclaredBpf): its stage and step ids come from explicit keys and stay stable on retry; a new flow
  // is created Draft, then activated by a conditional write; an existing flow's body or state is never edited. Off: the build
  // dispatch, grammar and docs are in place; verify, download and the typed approval land with the commit that turns it on.
  bpf: false,
};

const declaredFeatureOn = (name) => DECLARED_FEATURES[name] === true;

module.exports = { DECLARED_FEATURES, declaredFeatureOn };
