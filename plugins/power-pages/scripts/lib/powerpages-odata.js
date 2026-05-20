#!/usr/bin/env node

// Power Pages OData / Web API runtime rules. These are the semantic rules that aren't
// documented in OData v4 itself and aren't enforced by Dataverse's response schema —
// they live in Power Pages's request-handling middleware and Microsoft engineers' heads.
// Generated SPA service code violates them silently and surfaces as runtime 400s.
//
// Every rule below has the shape of either:
//   - a code-generation guard (consumed by /integrate-webapi at scaffold time), or
//   - a runtime rewriter (consumed by the shared apiClient on every request).
//
// The migration codifies them once here, then every generated service inherits the
// rules by calling into the shared apiClient. No service has to re-state a rule.
//
// References:
//   - Power Pages Web API operations:  https://learn.microsoft.com/power-pages/configure/webapi-feature
//   - Power Pages Web API security:    https://learn.microsoft.com/power-pages/security/web-api-security
//   - Dataverse OData v4 quirks:       https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-data-web-api

// -- Sensitive-PK blocklist ---------------------------------------------------
//
// Power Pages refuses to return certain primary-key columns from $select even when
// the table-permission grants Read. The block is implemented in the Web API
// middleware (it predates the table-permission check), so /audit-permissions and the
// $select-clause generator must avoid these columns regardless of role / scope.
//
// `systemuser` and `team` are also wholly blocked from the Web API surface — Power
// Pages refuses to expose them by design; tables listed here cover both the
// pk-blocked tables and the totally-blocked ones (`isFullyBlocked`).

const SENSITIVE_PK_BLOCKLIST = {
  contact: { primaryKey: 'contactid', isFullyBlocked: false },
  account: { primaryKey: 'accountid', isFullyBlocked: false },
  systemuser: { primaryKey: 'systemuserid', isFullyBlocked: true },
  team: { primaryKey: 'teamid', isFullyBlocked: true },
  // adx_invitation has a similar "internals-only" block on its PK / cross-link columns.
  adx_invitation: { primaryKey: 'adx_invitationid', isFullyBlocked: false },
};

// Returns the subset of `proposedColumns` that's safe to include in a $select clause.
// Drops the table's PK when the table is in the sensitive-PK blocklist; surfaces any
// drop as a `dropped[]` entry so callers (and the agent) can report what changed and why.
function filterSensitivePkFromSelect(table, proposedColumns) {
  const entry = SENSITIVE_PK_BLOCKLIST[table];
  if (!entry) return { columns: proposedColumns.slice(), dropped: [] };
  if (entry.isFullyBlocked) {
    return {
      columns: [],
      dropped: proposedColumns.map((col) => ({ column: col, reason: `Power Pages Web API does not expose any column on "${table}".` })),
    };
  }
  const dropped = [];
  const filtered = [];
  for (const col of proposedColumns) {
    if (col === entry.primaryKey) {
      dropped.push({
        column: col,
        reason: `Power Pages enforces a privacy block on "${table}".${entry.primaryKey} in $select even when table permissions allow Read.`,
      });
      continue;
    }
    filtered.push(col);
  }
  return { columns: filtered, dropped };
}

// -- Lookup filter form -------------------------------------------------------
//
// OData v4 lets `$filter=<navigation-property> eq <guid>` work, but Dataverse +
// Power Pages enforce the `_<lookup>_value eq <guid>` form for lookup columns.
// Filtering on the navigation-property name returns 400.
//
// We rewrite the filter clause in the apiClient layer rather than at code-gen
// time, because filter shapes can be built dynamically in the SPA.

// Returns the rewritten filter expression. The input is the raw `$filter` value
// (everything after `$filter=`). The list of lookup column logical names for the
// table is required so we know which navigation properties to rewrite. Returns the
// input unchanged when no rewrite applies.
//
// Examples (with lookupColumns = ['faq_topic']):
//   "faq_topic eq null"               → "_faq_topic_value eq null"
//   "faq_topic eq 'guid'"             → "_faq_topic_value eq 'guid'"
//   "faq_topic ne null"               → "_faq_topic_value ne null"
//   "name eq 'X' and faq_topic eq G"  → "name eq 'X' and _faq_topic_value eq G"
//   "_faq_topic_value eq null"        → "_faq_topic_value eq null" (already correct)
//   "name eq 'faq_topic'"             → "name eq 'faq_topic'" (string-literal RHS, do not touch)
function rewriteLookupFilter(filterExpression, lookupColumns) {
  if (!filterExpression || !lookupColumns || !lookupColumns.length) return filterExpression;
  let out = filterExpression;
  for (const lookup of lookupColumns) {
    if (!lookup) continue;
    // Match `<lookup> <op> ...` where:
    //   - `<lookup>` is at a word boundary and NOT preceded by `_` or `'` or `"`
    //   - `<op>` is one of eq | ne | gt | ge | lt | le (lookups support eq/ne typically;
    //     others are included so the rewrite covers every comparison the SPA might
    //     emit). The lookahead `(?=\s)` ensures we don't gobble identifiers that
    //     happen to start with the lookup name (e.g., `faq_topic_xxx`).
    const escaped = lookup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^_'"a-zA-Z0-9])${escaped}(?=\\s+(eq|ne|gt|ge|lt|le)\\s)`, 'g');
    out = out.replace(pattern, `$1_${lookup}_value`);
  }
  return out;
}

// -- Write-body exclusions ----------------------------------------------------
//
// Read responses from the Web API include OData annotations
// (`@odata.etag`, `_<lookup>_value@OData.Community.Display.V1.FormattedValue`,
// `<lookup>@OData.Community.Display.V1.FormattedValue`, `<column>@OData.Community.Display.V1.FormattedValue`,
// `<lookup>@Microsoft.Dynamics.CRM.lookuplogicalname`, `<lookup>@Microsoft.Dynamics.CRM.associatednavigationproperty`).
//
// If those leak into a PATCH/POST body — easy to do with `{ ...readResponse, … }`
// — Power Pages returns 400. The shared apiClient must strip every annotation
// before any write. This function is its implementation.

// Strips every OData annotation from an object, returning a new object. Does not
// mutate the input. Annotations are properties whose key contains `@odata.` (lowercase
// or any casing) OR matches `<col>@Microsoft.Dynamics.CRM.*` OR
// `<col>@OData.Community.Display.V1.*`. Anything containing `@` is treated as an
// annotation: the `<column>@<vocabulary>` form is the only legal use of `@` in
// Dataverse JSON property names.
function stripODataAnnotations(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.includes('@')) continue;
    out[key] = value;
  }
  return out;
}

// -- Server-side route shadowing ----------------------------------------------
//
// Power Pages deploys server-rendered fallback templates at specific URLs that
// override SPA routes when both the deployed webpage record and a SPA component
// exist for the same partialurl. The classic case: a hydration deploy creates
// `/profile` from `Profile.aspx` and the migrated SPA's `/profile` component is
// then never served. The metadata-translation step (Phase 7.3.d) must audit for
// these and either rename or remove the deployed webpage before the SPA route
// is implemented.
//
// `partialurl` values returned here are matched case-insensitively against the
// deployed `.powerpages-site/web-pages/<page>.webpage.yml#adx_partialurl`.

const SERVER_RENDERED_ROUTE_SHADOWS = [
  { partialurl: 'profile', knownTemplate: 'Profile' },
  { partialurl: 'sign-in', knownTemplate: 'Sign-In' },
  { partialurl: 'register', knownTemplate: 'Register' },
  { partialurl: 'invitation', knownTemplate: 'Invitation Redemption' },
  { partialurl: 'access-denied', knownTemplate: 'Access Denied' },
  { partialurl: 'page-not-found', knownTemplate: 'Page Not Found' },
  { partialurl: 'search', knownTemplate: 'Search' },
];

// Returns the matching shadow descriptor if `partialurl` lands on a Power-Pages
// server-rendered URL; returns null otherwise.
function lookupRouteShadow(partialurl) {
  if (!partialurl) return null;
  const lower = String(partialurl).toLowerCase().replace(/^\/+|\/+$/g, '');
  return SERVER_RENDERED_ROUTE_SHADOWS.find((s) => s.partialurl === lower) || null;
}

module.exports = {
  // Tables / columns
  SENSITIVE_PK_BLOCKLIST,
  filterSensitivePkFromSelect,
  // Filter rewrite
  rewriteLookupFilter,
  // Body sanitization
  stripODataAnnotations,
  // Route shadowing
  SERVER_RENDERED_ROUTE_SHADOWS,
  lookupRouteShadow,
};
