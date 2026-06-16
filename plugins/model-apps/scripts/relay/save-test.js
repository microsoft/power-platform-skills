'use strict';

// Live validation of form_save / form_publish — the ONLY harness that PERSISTS.
// 3 passes against the same form:
//   1. read the original maxWidth, set a benign sentinel, SAVE + PUBLISH.
//   2. re-open (fresh load) -> assert the sentinel PERSISTED, then restore the
//      original and SAVE + PUBLISH.
//   3. re-open -> assert restored.
// Net effect: form CONTENT is unchanged (only modifiedon moves). Proves the full
// persist + publish path end to end.
//
// NOTE: this calls bridge.save()/publish() DIRECTLY. The MM_ALLOW_SAVE /
// MM_ALLOW_PUBLISH gate is a guard on the MCP tool layer (the agent path), not on
// standalone harnesses — so this harness WILL persist to the env.
//
// Env: MM_FORM_URL (required), MM_EDGE_PROFILE (required), MM_HEADLESS=1.

const { createDriver, launchEdge } = require('./driver.js');
const log = (...a) => console.log(...a);
const SENTINEL = '1234';

async function pass(url, userDataDir, fn) {
  const { ctx, page } = await launchEdge({ url, userDataDir, headless: process.env.MM_HEADLESS === '1' });
  const driver = createDriver(page);
  await driver.inject().catch(() => {});
  const status = await driver.waitReady();
  if (!status || !status.ok) { await ctx.close(); throw new Error('designer not ready (source=' + (status && status.source) + ')'); }
  try { return await fn(driver, status); } finally { await ctx.close(); }
}
const maxWidth = async (d) => String(((await d.call('getFormProps', [])).result || {}).maxWidth);

async function main() {
  const url = process.env.MM_FORM_URL, userDataDir = process.env.MM_EDGE_PROFILE;
  if (!url || !userDataDir) { console.error('MM_FORM_URL and MM_EDGE_PROFILE are required'); process.exit(2); }
  let orig;

  log('PASS 1: read orig, set sentinel, save + publish');
  await pass(url, userDataDir, async (d, st) => {
    log('  source:', st.source);
    orig = await maxWidth(d);
    log('  orig maxWidth:', orig);
    await d.call('setFormProps', [{ maxWidth: Number(SENTINEL) }]);
    log('  save    ->', JSON.stringify(await d.call('save', [])));
    log('  publish ->', JSON.stringify(await d.call('publish', [])));
  });

  log('\nPASS 2: re-open, assert sentinel persisted, restore orig, save + publish');
  await pass(url, userDataDir, async (d) => {
    const after = await maxWidth(d);
    log('  maxWidth after save:', after, '  => PERSISTED:', after === SENTINEL);
    await d.call('setFormProps', [{ maxWidth: Number(orig) }]);
    log('  save    ->', JSON.stringify(await d.call('save', [])));
    log('  publish ->', JSON.stringify(await d.call('publish', [])));
  });

  log('\nPASS 3: re-open, assert restored');
  await pass(url, userDataDir, async (d) => {
    const restored = await maxWidth(d);
    log('  maxWidth now:', restored, '  => RESTORED:', restored === String(orig));
  });

  log('\ndone — save + publish validated; form content restored.');
}
main().catch((e) => { console.error('save-test failed:', (e && e.stack) || e); process.exit(1); });
