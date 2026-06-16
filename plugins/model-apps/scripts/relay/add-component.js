'use strict';

// Live E2E: place a custom control as a NEW COMPONENT in a section, with params —
// for UNBOUND / dataset controls (PowerBI, subgrid) that aren't bound to a field.
// Uses the same driver.js/bridge.js the relay uses. Needs the façade build
// (designer_status source:"export"); on a normal build addComponent returns
// needs-facade.
//
// One-time:  cd plugins/model-apps/scripts/relay && npm install
// Env:
//   MM_FORM_URL      (required) form-editor URL (use make.local for the façade build)
//   MM_EDGE_PROFILE  (required) signed-in Edge profile dir
//   MM_CONTROL       (optional) control id (default PowerBI: MscrmControls.PowerBIPCFControl)
//   MM_SECTION       (optional) target section id (default: first section from inspect)
//   MM_PARAMS        (optional) JSON of control params, e.g. {"FilterPaneVisible":"true"}
//   MM_HEADLESS=1    (optional)
//
// NOTE: nothing is saved — addComponent is an in-memory designer change only.

const { createDriver, launchEdge } = require('./driver.js');

const log = (...a) => console.log(...a); // standalone tool — stdout is fine here

const CONTROL = process.env.MM_CONTROL || 'MscrmControls.PowerBIPCFControl';
const PARAMS = process.env.MM_PARAMS ? JSON.parse(process.env.MM_PARAMS) : null;

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
  if (!status || !status.ok) { console.error('designer not ready. aborting.'); await ctx.close(); process.exit(1); }
  log('handle source: %s', status.source);

  const ins = await driver.call('inspect', []);
  const section = process.env.MM_SECTION
    || (ins.result && ins.result.sections && ins.result.sections[0] && ins.result.sections[0].id);
  log('target section: %s', section);

  const desc = await driver.call('describeControl', [CONTROL]);
  if (desc.ok) log('describe: %s kind=%s requiredParams=%j', desc.result.displayName, desc.result.bindingKind, desc.result.requiredParams);

  log('\n-- addComponent(%s -> section %s) params=%j --', CONTROL, section, PARAMS);
  const r = await driver.call('addComponent', [CONTROL, section, PARAMS, null]);
  log('  ->', JSON.stringify(r));

  await ctx.close();
  log('\ndone (no save — in-memory only).');
  process.exit(r && r.ok ? 0 : 1);
}

main().catch((e) => { console.error('add-component failed:', (e && e.stack) || e); process.exit(1); });
