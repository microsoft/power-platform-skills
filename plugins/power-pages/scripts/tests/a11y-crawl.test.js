const assert = require('node:assert/strict');
const test = require('node:test');

const { CrawlQueue, exclusionReason, normalizeUrl, routeOf } = require('../lib/a11y/crawl');

const ORIGIN = 'https://contoso.powerappsportals.com';

test('normalizeUrl strips fragments and trailing slashes but keeps the query', () => {
  assert.equal(normalizeUrl('/about/#team', ORIGIN), `${ORIGIN}/about`);
  assert.equal(normalizeUrl('/', ORIGIN), `${ORIGIN}/`);
  assert.equal(normalizeUrl('/search?q=a', ORIGIN), `${ORIGIN}/search?q=a`);
  assert.equal(normalizeUrl('mailto:help@contoso.com', ORIGIN), null);
  assert.equal(normalizeUrl('javascript:void(0)', ORIGIN), null);
  assert.equal(normalizeUrl('http://[bad', ORIGIN), null);
});

test('exclusionReason skips sign-out, platform endpoints, files, external and user excludes', () => {
  assert.equal(exclusionReason(`${ORIGIN}/Account/Login/LogOff`, ORIGIN), 'sign-out');
  assert.equal(exclusionReason(`${ORIGIN}/signout`, ORIGIN), 'sign-out');
  assert.equal(exclusionReason(`${ORIGIN}/_api/contacts`, ORIGIN), 'platform-endpoint');
  assert.equal(exclusionReason(`${ORIGIN}/_services/about`, ORIGIN), 'platform-endpoint');
  assert.equal(exclusionReason(`${ORIGIN}/docs/guide.PDF`, ORIGIN), 'file');
  assert.equal(exclusionReason('https://example.com/', ORIGIN), 'external');
  assert.equal(exclusionReason(`${ORIGIN}/admin/users`, ORIGIN, ['/admin']), 'user-excluded');
  assert.equal(exclusionReason(`${ORIGIN}/about`, ORIGIN), null);
});

test('routeOf returns path and query only', () => {
  assert.equal(routeOf(`${ORIGIN}/a/b?x=1`), '/a/b?x=1');
});

test('CrawlQueue dedupes, records exclusions and enforces the page cap', () => {
  const q = new CrawlQueue({ origin: ORIGIN, maxPages: 2, exclude: [] });
  assert.equal(q.add('/'), true);
  assert.equal(q.add('/#main'), false, 'same page after normalization');
  assert.equal(q.add('/Account/Login/LogOff'), false);
  assert.equal(q.add('https://example.com/'), false);
  assert.equal(q.add('/about'), true);
  assert.equal(q.add('/contact'), false, 'over cap');
  assert.equal(q.next(), `${ORIGIN}/`);
  assert.equal(q.next(), `${ORIGIN}/about`);
  assert.equal(q.next(), null);
  assert.deepEqual(q.summary(), {
    queued: 2,
    notAuditedOverCap: ['/contact'],
    excluded: [{ route: '/Account/Login/LogOff', reason: 'sign-out' }],
  });
});

test('CrawlQueue.addExplicit bypasses exclusions and the cap but not cross-origin', () => {
  const q = new CrawlQueue({ origin: ORIGIN, maxPages: 1, exclude: ['/private'] });
  assert.equal(q.addExplicit(`${ORIGIN}/`), true);
  assert.equal(q.addExplicit(`${ORIGIN}/private`), true);
  assert.equal(q.addExplicit('https://example.com/'), false);
  assert.equal(q.addExplicit(`${ORIGIN}/`), false);
  assert.equal(q.summary().queued, 2);
});
