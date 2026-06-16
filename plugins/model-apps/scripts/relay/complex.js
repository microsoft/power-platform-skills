'use strict';

// Live showcase: build a COMPLEX form end-to-end through the relay's own verbs —
// form-level props, custom controls (business card reader + rich text), a related-
// records GRID (subgrid), structure (tab / section / column), and a form script
// (library + onLoad handler). All in-memory; NOTHING is saved. Needs the façade
// build (source:"export") for the custom-control / subgrid / tab / section verbs.
//
// Env: MM_FORM_URL (required), MM_EDGE_PROFILE (required),
//      MM_LIBRARY (optional, default new_demoscript), MM_HEADLESS=1, MM_SHOT.

const path = require('node:path');
const { createDriver, launchEdge } = require('./driver.js');
const log = (...a) => console.log(...a);
const j = (x) => JSON.stringify(x && x.result ? x.result : x);

async function main() {
  const url = process.env.MM_FORM_URL, userDataDir = process.env.MM_EDGE_PROFILE;
  if (!url || !userDataDir) { console.error('MM_FORM_URL and MM_EDGE_PROFILE are required'); process.exit(2); }

  log('launching Edge + opening form...');
  const { ctx, page } = await launchEdge({ url, userDataDir, headless: process.env.MM_HEADLESS === '1' });
  const driver = createDriver(page);
  await driver.inject().catch(() => {});
  const status = await driver.waitReady();
  log('status:', JSON.stringify(status));
  if (!status || !status.ok) { console.error('designer not ready. aborting.'); await ctx.close(); process.exit(1); }
  log('handle source: %s\n', status.source);

  const c = (m, a) => driver.call(m, a);
  const inspect = async () => (await c('inspect', [])).result || { tabs: [], sections: [], available: [] };
  const step = async (label, m, a) => { const r = await c(m, a); log('  ' + label + '  ->  ' + j(r)); return r; };

  let s = await inspect();
  log('start: %d tabs, %d sections, %d available fields\n', s.tabs.length, s.sections.length, s.available.length);
  const sec0 = s.sections[0] && s.sections[0].id;
  const tabsBefore = new Set(s.tabs.map((t) => t.id));
  const secsBefore = new Set(s.sections.map((x) => x.id));

  log('— form —');
  await step('setFormProps(name, maxWidth)', 'setFormProps', [{ name: 'Account 360 (model-maker demo)', maxWidth: 1600 }]);

  log('\n— custom controls —');
  await step("setControl('name', BusinessCardReader)", 'setControl', ['name', 'Intelligence.BusinessCardReaderControl.BusinessCardReader', null, null]);
  await step("setControl('description', RichText)", 'setControl', ['description', 'MscrmControls.RichTextEditor.RichTextEditorControl', null, null]);

  log('\n— grid (related-records subgrid) —');
  await step("addSubgrid(sec0, contact)", 'addSubgrid', [sec0, 'contact', { relationshipName: 'contact_customer_accounts' }]);

  log('\n— layout —');
  await step('addColumn(sec0 -> 2)', 'addColumn', [sec0, 2]);

  log('\n— structure: new tab -> section -> field —');
  await step("addTab('Engagement', 2col)", 'addTab', [null, 2, 'Engagement']);
  s = await inspect();
  const newTab = s.tabs.map((t) => t.id).find((id) => !tabsBefore.has(id));
  log('  new tab id: %s', newTab);
  if (newTab) {
    await step("addSection(newTab, 2col, 'Activities')", 'addSection', [newTab, 2, 'Activities']);
    s = await inspect();
    const newSec = s.sections.map((x) => x.id).find((id) => !secsBefore.has(id));
    log('  new section id: %s', newSec);
    const fld = (s.available[0] && s.available[0].name);
    if (newSec && fld) await step('addField(' + fld + ' -> newSection)', 'addField', [fld, newSec, false]);
  }

  log('\n— form script —');
  const lib = process.env.MM_LIBRARY || 'new_demoscript';
  await step('addLibrary(' + lib + ')', 'addLibrary', [lib]);
  await step('addEventHandler(form, onload)', 'addEventHandler', ['form', { eventType: 'onload', library: lib, functionName: 'Demo.onLoad', passExecutionContext: true }]);

  log('\n— verify —');
  await step("getControl('name')", 'getControl', ['name']);
  s = await inspect();
  log('  final: %d tabs, %d sections', s.tabs.length, s.sections.length);

  const shot = process.env.MM_SHOT || path.join(process.cwd(), 'mm-complex.png');
  await driver.screenshot(shot);
  log('\nscreenshot: %s', shot);

  await ctx.close();
  log('done (no save — in-memory only).');
}

main().catch((e) => { console.error('complex failed:', (e && e.stack) || e); process.exit(1); });
