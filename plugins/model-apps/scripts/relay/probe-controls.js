'use strict';

// READ-ONLY live probe: what custom controls (PCF / AI Builder) does an environment
// offer for a field?
//
// Drives the real form designer through the SAME driver.js + bridge.js the MCP
// relay uses, but calls only the read-only `listControls` bridge method -- it
// MUTATES NOTHING. Use it to see, for a given field, the default component-picker
// list (e.g. "Business card reader", "Rich Text Editor Control") the env exposes,
// before building the setter (Phase 2.2).
//
// One-time:  cd plugins/model-apps/scripts/relay && npm install
// Env:
//   MM_FORM_URL      (required) the form-editor URL to open
//                    (/e/<env>/s/<solution>/entity/<entity>/form/edit/<formId>)
//   MM_EDGE_PROFILE  (required) a signed-in persistent Edge profile dir
//   MM_PROBE_FIELD   (optional) logical name to probe (default: account primary name 'name');
//                    comma-separated for several, or 'none' for the unbound/default list
//   MM_DESCRIBE      (optional) control ids to describe (binding kind + param schema),
//                    comma-separated; or 'all' to describe every control from the first field's list
//   MM_HEADLESS=1    (optional) run Edge headless
//
// Usage:  MM_FORM_URL=... MM_EDGE_PROFILE=... [MM_PROBE_FIELD=name,description] [MM_DESCRIBE=all] node probe-controls.js

const { createDriver, launchEdge } = require('./driver.js');

const log = (...a) => console.log(...a); // standalone tool — stdout is fine here

async function main() {
  const url = process.env.MM_FORM_URL;
  const userDataDir = process.env.MM_EDGE_PROFILE;
  if (!url || !userDataDir) {
    console.error('MM_FORM_URL and MM_EDGE_PROFILE are required');
    process.exit(2);
  }

  // Default to the account primary name field; 'none' probes the unbound/default list.
  const raw = process.env.MM_PROBE_FIELD != null ? process.env.MM_PROBE_FIELD : 'name';
  const fields = raw
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s.toLowerCase() === 'none' ? null : s));

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

  let firstList = [];
  for (const field of fields) {
    log('\n=== listControls(%s) ===', field === null ? '<unbound/default>' : field);
    const r = await driver.call('listControls', [field]);
    if (!r || !r.ok) {
      log('  ->', JSON.stringify(r));
      continue;
    }
    if (!firstList.length) firstList = (r.result.controls || []).map((c) => c.name);
    log('  field=%s dataType=%s count=%d', r.result.field, r.result.dataType, r.result.count);
    for (const c of r.result.controls || []) {
      log('   - %s  [%s]  kind=%s bound=%s dataset=%s  types=%j',
        c.displayName, c.name, c.bindingKind, c.isBound, c.hasDataset, c.compatibleDataTypes);
    }
  }

  // Optional: describe controls (binding kind + parameter schema from the manifest).
  const describeRaw = process.env.MM_DESCRIBE;
  if (describeRaw) {
    const ids = describeRaw.trim().toLowerCase() === 'all'
      ? firstList
      : describeRaw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      log('\n=== describeControl(%s) ===', id);
      const d = await driver.call('describeControl', [id]);
      if (!d || !d.ok) { log('  ->', JSON.stringify(d)); continue; }
      const R = d.result;
      log('  %s  kind=%s bound=%s dataset=%s  requiredParams=%j',
        R.displayName, R.bindingKind, R.isBound, R.hasDataset, R.requiredParams);
      for (const p of R.params || []) {
        log('    * %s%s  usage=%s ofType=%s default=%j%s',
          p.name, p.isPrimary ? ' (primary)' : '', p.usage, p.ofType, p.defaultValue,
          p.enumValues ? '  enum=' + JSON.stringify(p.enumValues.map((e) => e.value)) : '');
      }
    }
  }

  await ctx.close();
  log('\ndone (read-only — nothing was changed).');
}

main().catch((e) => {
  console.error('probe failed:', (e && e.stack) || e);
  process.exit(1);
});
