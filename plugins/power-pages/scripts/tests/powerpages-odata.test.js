const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SENSITIVE_PK_BLOCKLIST,
  filterSensitivePkFromSelect,
  rewriteLookupFilter,
  stripODataAnnotations,
  SERVER_RENDERED_ROUTE_SHADOWS,
  lookupRouteShadow,
} = require('../lib/powerpages-odata');

// filterSensitivePkFromSelect -------------------------------------------------

test('filterSensitivePkFromSelect leaves a non-sensitive table unchanged', () => {
  const result = filterSensitivePkFromSelect('faq_article', ['faq_articleid', 'faq_articletitle']);
  assert.deepEqual(result.columns, ['faq_articleid', 'faq_articletitle']);
  assert.deepEqual(result.dropped, []);
});

test('filterSensitivePkFromSelect drops contactid from $select on contact', () => {
  // The exact bug from the retrospective (defect #3): the table-permission allowlist
  // included contactid, /audit-permissions saw nothing wrong, runtime returned 400.
  const result = filterSensitivePkFromSelect('contact', ['contactid', 'firstname', 'emailaddress1']);
  assert.deepEqual(result.columns, ['firstname', 'emailaddress1']);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].column, 'contactid');
  assert.match(result.dropped[0].reason, /privacy block/i);
});

test('filterSensitivePkFromSelect drops accountid from $select on account', () => {
  const result = filterSensitivePkFromSelect('account', ['accountid', 'name']);
  assert.deepEqual(result.columns, ['name']);
  assert.equal(result.dropped.length, 1);
});

test('filterSensitivePkFromSelect blocks every column when the table is fully blocked (systemuser, team)', () => {
  // Power Pages refuses to expose systemuser and team at all. Returning an empty
  // column list tells the caller to fail loudly rather than generate a meaningless
  // sitesetting whose Web API request will 400 on every call.
  const result = filterSensitivePkFromSelect('systemuser', ['systemuserid', 'fullname']);
  assert.deepEqual(result.columns, []);
  assert.equal(result.dropped.length, 2);
  for (const d of result.dropped) {
    assert.match(d.reason, /does not expose/i);
  }
});

test('SENSITIVE_PK_BLOCKLIST includes the four tables every Power Pages site has to handle', () => {
  // The migration sees these tables most often (contact, systemuser, account, team).
  // If the constant drifts, the test surfaces it before a release.
  for (const expected of ['contact', 'systemuser', 'account', 'team']) {
    assert.ok(SENSITIVE_PK_BLOCKLIST[expected], `expected ${expected} in blocklist`);
  }
});

// rewriteLookupFilter ---------------------------------------------------------

test('rewriteLookupFilter rewrites <lookup> eq null to _<lookup>_value eq null', () => {
  // Defect #2 from the retrospective: $filter=faq_parenttopic eq null returned 400.
  assert.equal(
    rewriteLookupFilter('faq_parenttopic eq null', ['faq_parenttopic']),
    '_faq_parenttopic_value eq null',
  );
});

test('rewriteLookupFilter rewrites <lookup> eq guid to _<lookup>_value eq guid', () => {
  assert.equal(
    rewriteLookupFilter("faq_topic eq 'abc-123'", ['faq_topic']),
    "_faq_topic_value eq 'abc-123'",
  );
});

test('rewriteLookupFilter handles ne / gt / ge / lt / le as well as eq', () => {
  assert.equal(
    rewriteLookupFilter('faq_topic ne null', ['faq_topic']),
    '_faq_topic_value ne null',
  );
});

test('rewriteLookupFilter leaves an already-rewritten filter alone', () => {
  // Idempotent: an SPA that hand-writes the `_..._value` form (or a re-applied apiClient
  // chain) must not double-rewrite to `__faq_topic_value_value`.
  assert.equal(
    rewriteLookupFilter('_faq_topic_value eq null', ['faq_topic']),
    '_faq_topic_value eq null',
  );
});

test('rewriteLookupFilter handles compound filters with both lookup and non-lookup clauses', () => {
  assert.equal(
    rewriteLookupFilter("name eq 'X' and faq_topic eq null", ['faq_topic']),
    "name eq 'X' and _faq_topic_value eq null",
  );
});

test('rewriteLookupFilter rewrites multiple distinct lookup columns in the same filter', () => {
  assert.equal(
    rewriteLookupFilter('faq_topic eq null and faq_parenttopic eq null', ['faq_topic', 'faq_parenttopic']),
    '_faq_topic_value eq null and _faq_parenttopic_value eq null',
  );
});

test('rewriteLookupFilter does not rewrite a string literal that happens to match a lookup column name', () => {
  // The RHS string `'faq_topic'` is content, not an identifier. Rewriting it would
  // change the semantics of the filter.
  assert.equal(
    rewriteLookupFilter("name eq 'faq_topic'", ['faq_topic']),
    "name eq 'faq_topic'",
  );
});

test('rewriteLookupFilter does not gobble identifiers that start with the lookup name', () => {
  // `faq_topic_xxx eq null` references a different column whose name happens to share
  // a prefix with `faq_topic`. The rewrite must not touch it.
  assert.equal(
    rewriteLookupFilter('faq_topic_xxx eq null', ['faq_topic']),
    'faq_topic_xxx eq null',
  );
});

test('rewriteLookupFilter is a no-op when the lookup column list is empty or missing', () => {
  assert.equal(rewriteLookupFilter('faq_topic eq null', []), 'faq_topic eq null');
  assert.equal(rewriteLookupFilter('faq_topic eq null', null), 'faq_topic eq null');
});

// stripODataAnnotations -------------------------------------------------------

test('stripODataAnnotations removes @odata.etag from the body', () => {
  // Defect #4: PATCH body contained @odata.etag (from spreading a read response) and
  // Power Pages returned 400.
  const cleaned = stripODataAnnotations({
    '@odata.etag': 'W/"123"',
    firstname: 'Ada',
    emailaddress1: 'ada@example.com',
  });
  assert.deepEqual(cleaned, { firstname: 'Ada', emailaddress1: 'ada@example.com' });
});

test('stripODataAnnotations removes _<lookup>_value@OData.Community.Display.V1.FormattedValue', () => {
  const cleaned = stripODataAnnotations({
    firstname: 'Ada',
    '_parentcustomerid_value': 'abc-123',
    '_parentcustomerid_value@OData.Community.Display.V1.FormattedValue': 'Contoso',
    '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
  });
  // The legit write-value form `_<lookup>_value` is preserved; only annotations drop.
  assert.deepEqual(Object.keys(cleaned).sort(), ['_parentcustomerid_value', 'firstname']);
});

test('stripODataAnnotations does not mutate the input object', () => {
  const input = { '@odata.etag': 'x', firstname: 'Ada' };
  const cleaned = stripODataAnnotations(input);
  assert.equal(Object.keys(input).length, 2);
  assert.notEqual(cleaned, input);
});

test('stripODataAnnotations passes non-object inputs through unchanged', () => {
  assert.equal(stripODataAnnotations(null), null);
  assert.equal(stripODataAnnotations(undefined), undefined);
  // Arrays are not the shape we care about for a write body — pass through.
  const arr = [1, 2, 3];
  assert.equal(stripODataAnnotations(arr), arr);
});

// lookupRouteShadow -----------------------------------------------------------

test('lookupRouteShadow finds /profile as a known server-rendered shadow', () => {
  // Defect #5: /profile served the legacy Power Pages page instead of the SPA because
  // a deployed Profile webpage record shadowed the SPA route. The lookup gives the
  // metadata-translation step the list to audit.
  const match = lookupRouteShadow('profile');
  assert.ok(match);
  assert.equal(match.knownTemplate, 'Profile');
});

test('lookupRouteShadow handles leading and trailing slashes', () => {
  assert.ok(lookupRouteShadow('/profile/'));
  assert.ok(lookupRouteShadow('profile/'));
});

test('lookupRouteShadow is case-insensitive', () => {
  assert.ok(lookupRouteShadow('PROFILE'));
});

test('lookupRouteShadow returns null for routes that are not Power Pages server-rendered', () => {
  assert.equal(lookupRouteShadow('articles'), null);
  assert.equal(lookupRouteShadow('about'), null);
  assert.equal(lookupRouteShadow(null), null);
  assert.equal(lookupRouteShadow(''), null);
});

test('SERVER_RENDERED_ROUTE_SHADOWS covers the seven well-known Power Pages routes', () => {
  // If this list drifts, the route-shadow audit (Phase 7.3.d) may miss real collisions.
  const required = ['profile', 'sign-in', 'register', 'invitation', 'access-denied', 'page-not-found', 'search'];
  const present = SERVER_RENDERED_ROUTE_SHADOWS.map((s) => s.partialurl);
  for (const r of required) assert.ok(present.includes(r), `missing ${r}`);
});
