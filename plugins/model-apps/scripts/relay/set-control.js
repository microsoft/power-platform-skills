'use strict';

// Live E2E for the custom-control SETTER (Phase 2.5): discover -> describe -> set
// a custom control on a field, through the same driver.js/bridge.js the MCP relay
// uses (no MCP/agent in the loop).
//
// Needs the first-party façade build (enableModelMakerBridge) so the bridge
// acquires via the export -> designer_status `source: "export"`. On a normal
// deployed build (`source: "fiber"`) discovery still works but setControl returns
// `needs-facade`. So point MM_FORM_URL at the LOCAL dev build that has the façade:
//   https://make.local.powerapps.com/e/<env>/s/<sol>/entity/<entity>/form/edit/<formId>?cds-form-designer.enableModelMakerBridge=true
//
// One-time:  cd plugins/model-apps/scripts/relay && npm install
// Env:
//   MM_FORM_URL      (required) form-editor URL (use make.local.powerapps.com for the façade build)
//   MM_EDGE_PROFILE  (required) signed-in Edge profile dir (also trusts the make.local dev cert)
//   MM_FIELD         (optional) field logical name (default 'name' = Account Name)
//   MM_CONTROL       (optional) control id (default Business card reader)
//   MM_SHOT          (optional) screenshot path (default ./mm-setcontrol.png)
//   MM_HEADLESS=1    (optional) run Edge headless
//
// NOTE: nothing is saved — setControl is an in-memory designer change only.

const path = require('node:path');
const { createDriver, launchEdge } = require('./driver.js');

const log = (...a) => console.log(...a); // standalone tool — stdout is fine here

const FIELD = process.env.MM_FIELD || 'name';
const CONTROL = process.env.MM_CONTROL || 'Intelligence.BusinessCardReaderControl.BusinessCardReader';
const PARAMS = process.env.MM_PARAMS ? JSON.parse(process.env.MM_PARAMS) : null; // e.g. {"FilterPaneVisible":"true"}

async function main() {
  const url = process.env.MM_FORM_URL;
  const userDataDir = process.env.MM_EDGE_PROFILE;
  if (!url || !userDataDir) {
    console.error('MM_FORM_URL and MM_EDGE_PROFILE are required');
    process.exit(2);
  }

  log('launching Edge + opening form...');
  const { ctx, page } = await launchEdge({ url, userDataDir, headless: process.env.MM_HEADLESS === '1' });
  const driver = createDriver(page);

  await driver.inject().catch(() => {});
  const status = await driver.waitReady();
  log('status:', JSON.stringify(status));
  if (!status || !status.ok) {
    console.error('designer not ready (auth? still loading?). aborting.');
    await ctx.close();
    process.exit(1);
  }
  log('handle source: %s %s', status.source,
    status.source === 'export'
      ? '(façade build — setter available)'
      : '(normal build — setControl will return needs-facade; discovery still works)');

  log('\n-- discover: listControls(%s) --', FIELD);
  const list = await driver.call('listControls', [FIELD]);
  const names = (list.result && list.result.controls || []).map((c) => c.name);
  log('  controls: %j', names);
  log('  target %s present for field: %s', CONTROL, names.indexOf(CONTROL) >= 0);

  log('\n-- describe: describeControl(%s) --', CONTROL);
  const desc = await driver.call('describeControl', [CONTROL]);
  if (desc.ok) {
    log('  %s  kind=%s  requiredParams=%j', desc.result.displayName, desc.result.bindingKind, desc.result.requiredParams);
  } else {
    log('  ->', JSON.stringify(desc));
  }

  const before = await driver.call('getControl', [FIELD]);
  log('  control BEFORE: classId=%s customControls=%j',
    before.result && before.result.classId, before.result && before.result.customControls);

  log('\n-- set: setControl(%s, %s) params=%j --', FIELD, CONTROL, PARAMS);
  const set = await driver.call('setControl', [FIELD, CONTROL, PARAMS, null]);
  log('  ->', JSON.stringify(set));

  const after = await driver.call('getControl', [FIELD]);
  log('  control AFTER:  classId=%s customControls=%j',
    after.result && after.result.classId, after.result && after.result.customControls);
  const changed = before.result && after.result && before.result.classId !== after.result.classId;
  log('  => classId changed by set: %s', changed);

  // Optional settle wait before the screenshot — the canvas re-renders async
  // (and the local debug build shows a loading overlay), so a short wait yields a
  // clean WYSIWYG capture of the placed control.
  const waitMs = Number(process.env.MM_WAIT_MS || 0);
  if (waitMs > 0) {
    log('  waiting %dms for the canvas to settle...', waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const shot = process.env.MM_SHOT || path.join(process.cwd(), 'mm-setcontrol.png');
  await driver.screenshot(shot);
  log('screenshot:', shot);

  await ctx.close();
  log('\ndone (no save — in-memory only).');
  process.exit(set && set.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('set-control failed:', (e && e.stack) || e);
  process.exit(1);
});
