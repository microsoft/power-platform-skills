const assert = require('node:assert/strict');
const test = require('node:test');

const { NAVIGATION_TIMEOUT_MS, NETWORK_IDLE_GRACE_MS, gotoSettled, parseRouteList } = require('../lib/review-navigation');

test('parseRouteList anchors every route to the site root and drops empty entries', () => {
  assert.deepEqual(parseRouteList('/, about ,/contact/,,'), ['/', '/about', '/contact/']);
  assert.deepEqual(parseRouteList(''), []);
  assert.deepEqual(parseRouteList(undefined), []);
});

function fakePage({ idle = 'resolve' } = {}) {
  const calls = [];
  return {
    calls,
    goto: async (url, options) => { calls.push(['goto', url, options]); },
    waitForLoadState: async (state, options) => {
      calls.push(['waitForLoadState', state, options]);
      if (idle === 'timeout') throw new Error('Timeout 5000ms exceeded.');
    },
    waitForTimeout: async (ms) => { calls.push(['waitForTimeout', ms]); },
  };
}

test('gotoSettled navigates to load, then waits for network idle within a grace period', async () => {
  const page = fakePage();
  await gotoSettled(page, 'http://localhost:5173/about', { settleMs: 1200 });
  assert.deepEqual(page.calls, [
    ['goto', 'http://localhost:5173/about', { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS }],
    ['waitForLoadState', 'networkidle', { timeout: NETWORK_IDLE_GRACE_MS }],
    ['waitForTimeout', 1200],
  ]);
});

test('gotoSettled carries on when the network never goes idle', async () => {
  // Long polling or frequent analytics beacons keep the network busy indefinitely.
  const page = fakePage({ idle: 'timeout' });
  await gotoSettled(page, 'https://contoso.example/', { settleMs: 500 });
  assert.deepEqual(page.calls.at(-1), ['waitForTimeout', 500]);
});

test('gotoSettled skips the settle delay when none is given', async () => {
  const page = fakePage();
  await gotoSettled(page, 'https://contoso.example/');
  assert.equal(page.calls.some(([name]) => name === 'waitForTimeout'), false);
});
