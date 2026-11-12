'use strict';
// OData v4 string-literal escaping, in exactly one place. A single quote inside a string literal
// is escaped by doubling it (OData convention). null/undefined collapse to an empty literal so
// callers never emit `null`/`undefined` into a $filter. Shared by every script that builds an
// OData filter (provision-solution, verify-model-app, verify-spec, sdk-teardown) to prevent the
// escaping rule from drifting across copies.
function odataLit(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

module.exports = { odataLit };
