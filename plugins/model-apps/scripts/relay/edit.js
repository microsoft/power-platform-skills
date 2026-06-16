'use strict';

// Live E2E for the structural / property / remove / subgrid verbs, in one session,
// through the same driver.js/bridge.js the relay uses. Reads back via getControl to
// verify. setFieldProps / removeControl / moveControl are DIRECT designer commands
// (work on any build); addSubgrid needs the façade build (source:"export").
//
// Env:
//   MM_FORM_URL        (required) form-editor URL
//   MM_EDGE_PROFILE    (required) signed-in Edge profile dir
//   MM_FIELD           (optional) field to set-props / move (default telephone1)
//   MM_REMOVE_FIELD    (optional) field to remove (default fax)
//   MM_SUBGRID_ENTITY  (optional) related table for the subgrid (default contact)
//   MM_SUBGRID_REL     (optional) 1:N relationship name (default contact_customer_accounts)
//   MM_HEADLESS=1      (optional)
//
// NOTE: nothing is saved — all changes are in-memory designer edits only.

const { createDriver, launchEdge } = require('./driver.js');
const log = (...a) => console.log(...a);

const FIELD = process.env.MM_FIELD || 'telephone1';
const REMOVE_FIELD = process.env.MM_REMOVE_FIELD || 'fax';
const SUBGRID_ENTITY = process.env.MM_SUBGRID_ENTITY || 'contact';
const SUBGRID_REL = process.env.MM_SUBGRID_REL || 'contact_customer_accounts';

const j = (x) => JSON.stringify(x && x.result ? x.result : x);

async function main() {
  const url = process.env.MM_FORM_URL;
  const userDataDir = process.env.MM_EDGE_PROFILE;
  if (!url || !userDataDir) { console.error('MM_FORM_URL and MM_EDGE_PROFILE are required'); process.exit(2); }

  log('launching Edge + opening form...');
  const { ctx, page } = await launchEdge({ url, userDataDir, headless: process.env.MM_HEADLESS === '1' });
  const driver = createDriver(page);
  await driver.inject().catch(() => {});
  const status = await driver.waitReady();
  log('status:', JSON.stringify(status));
  if (!status || !status.ok) { console.error('designer not ready. aborting.'); await ctx.close(); process.exit(1); }
  log('handle source: %s', status.source);

  const ins = await driver.call('inspect', []);
  const sections = (ins.result && ins.result.sections) || [];
  log('sections: %d', sections.length);

  log('\n== setFieldProps(%s) ==', FIELD);
  log('  before:', j(await driver.call('getControl', [FIELD])));
  log('  set   :', j(await driver.call('setFieldProps', [FIELD, { label: 'Primary Phone (edited)', visible: false, readonly: true }])));
  log('  after :', j(await driver.call('getControl', [FIELD])));

  log('\n== addSubgrid(%s, %s, rel=%s) ==', sections[0] && sections[0].id, SUBGRID_ENTITY, SUBGRID_REL);
  log('  ->', j(await driver.call('addSubgrid', [sections[0] && sections[0].id, SUBGRID_ENTITY, { relationshipName: SUBGRID_REL }])));

  log('\n== removeControl(%s) ==', REMOVE_FIELD);
  log('  ->', j(await driver.call('removeControl', [REMOVE_FIELD])));
  log('  verify getControl(%s):', REMOVE_FIELD, j(await driver.call('getControl', [REMOVE_FIELD])));

  if (sections[1]) {
    log('\n== moveControl(%s -> section %s) ==', FIELD, sections[1].id);
    log('  ->', j(await driver.call('moveControl', [FIELD, sections[1].id, null])));
  }

  log('\n== addSection(section %s, 2 col) ==', sections[0] && sections[0].id);
  log('  ->', j(await driver.call('addSection', [sections[0] && sections[0].id, 2, 'New Section (edited)'])));

  log('\n== addTab(2 col) ==');
  log('  ->', j(await driver.call('addTab', [null, 2, 'New Tab (edited)'])));

  log('\n== addColumn(section %s -> 2 col) ==', sections[0] && sections[0].id);
  log('  ->', j(await driver.call('addColumn', [sections[0] && sections[0].id, 2])));

  log('\n== addEventHandler(form, onload) ==');
  log('  ->', j(await driver.call('addEventHandler', ['form', { eventType: 'onload', library: process.env.MM_LIBRARY || 'new_demoscript', functionName: 'Demo.onLoad', passExecutionContext: true }])));

  log('\n== setFormProps(name, maxWidth, showImage) ==');
  log('  ->', j(await driver.call('setFormProps', [{ name: 'Account (edited)', maxWidth: 1600, showImage: true }])));

  if (sections[6]) {
    log('\n== removeElement(section %s) ==', sections[6].id);
    log('  ->', j(await driver.call('removeElement', [sections[6].id])));
  }

  log('\n== undo (reverts the last change) ==');
  log('  ->', j(await driver.call('undo', [])));

  // NOTE: form_save / form_publish are NOT called here — they persist, and are
  // gated by MM_ALLOW_SAVE / MM_ALLOW_PUBLISH at the relay. This harness never saves.

  await ctx.close();
  log('\ndone (no save — in-memory only).');
}

main().catch((e) => { console.error('edit failed:', (e && e.stack) || e); process.exit(1); });
