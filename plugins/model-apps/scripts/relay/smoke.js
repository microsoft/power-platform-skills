'use strict';

// Standalone LIVE smoke test for the model-maker relay.
//
// Drives the real form designer through the SAME driver.js + bridge.js the MCP
// relay uses, but with no MCP client / LLM in the loop — a deterministic,
// one-command live integration check (handle acquisition + inspect + add).
//
// One-time:  cd plugins/model-apps/scripts/relay && npm install
// Env:
//   MM_FORM_URL      (required) the form-editor URL to open
//                    (/e/<env>/s/<solution>/entity/<entity>/form/edit/<formId>)
//   MM_EDGE_PROFILE  (required) a signed-in persistent Edge profile dir
//   MM_ADD_FIELD     (optional) logical name to add, e.g. accountcategorycode
//   MM_ADD_SECTION   (optional) target section id (default: first section from inspect)
//   MM_SHOT          (optional) screenshot path (default ./mm-smoke.png)
//   MM_HEADLESS=1    (optional) run Edge headless
//
// NOTE: nothing is saved — addField is an in-memory designer change only.

const path = require('node:path');
const { createDriver, launchEdge } = require('./driver.js');

const log = (...a) => console.log(...a); // standalone tool — stdout is fine here

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

  const ins = await driver.call('inspect', []);
  if (ins && ins.result) {
    log('inspect: formType=%s sections=%d available(first 5)=%j',
      ins.result.formType, (ins.result.sections || []).length, (ins.result.available || []).slice(0, 5));
  } else {
    log('inspect:', JSON.stringify(ins));
  }

  const field = process.env.MM_ADD_FIELD;
  if (field) {
    const sectionId =
      process.env.MM_ADD_SECTION ||
      (ins.result && ins.result.sections && ins.result.sections[0] && ins.result.sections[0].id);
    if (!sectionId) {
      console.error('no section id to target (pass MM_ADD_SECTION)');
    } else {
      log('addField %s -> section %s ...', field, sectionId);
      const r = await driver.call('addField', [field, sectionId, false]);
      log('addField:', JSON.stringify(r));

      const shot = process.env.MM_SHOT || path.join(process.cwd(), 'mm-smoke.png');
      await driver.screenshot(shot);
      log('screenshot:', shot);

      const after = await driver.call('inspect', []);
      const stillAvailable =
        after.result && after.result.available && after.result.available.some((a) => a.name === field);
      log('verify: %s now placed =', field, !stillAvailable);
    }
  }

  await ctx.close();
  log('done.');
}

main().catch((e) => {
  console.error('smoke failed:', (e && e.stack) || e);
  process.exit(1);
});
