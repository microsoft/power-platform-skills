'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROUTE_MANIFEST_PATH = '.tmp/route-manifest.json';
const SCREEN_STATUSES = new Set(['planned', 'building', 'type-safe', 'available-in-metro', 'reviewed', 'concern']);

function ownerForScreen(pack, screen) {
  const destination = (pack.navigation?.destinations || []).find((item) => item.rootScreenId === screen.id);
  if (destination) return destination.id;
  const flow = (pack.navigation?.flows || []).find((item) => (item.screenIds || []).includes(screen.id));
  return flow?.ownerDestinationId || screen.navigation?.destinationId || null;
}

function isReachable(pack, screen) {
  if (screen.route === pack.navigation?.routingPolicy?.launchRoute || screen.route === pack.navigation?.initialRoute) return true;
  if ((pack.navigation?.destinations || []).some((item) => item.rootScreenId === screen.id)) return true;
  if ((pack.navigation?.flows || []).some((item) => (item.screenIds || []).includes(screen.id) && item.ownerDestinationId)) return true;
  if (pack.navigation?.globalRoutePolicy?.profileScreenId === screen.id) return true;
  return screen.navigation?.deepLinkable === true;
}

function buildRouteManifest(pack) {
  if (!pack || pack.schemaVersion !== 2 || !Array.isArray(pack.screens)) throw new Error('Route manifest requires a schema-v2 screen build pack.');
  const actions = pack.journey?.actions || [];
  const routes = pack.screens.map((screen) => {
    const stageId = screen.journey?.stageId;
    return {
      id: screen.id,
      label: screen.header?.title || screen.id,
      route: screen.route,
      file: screen.file,
      role: screen.navigation?.role || screen.productRole || screen.role,
      ownerDestinationId: ownerForScreen(pack, screen),
      incomingActions: actions.filter((action) => action.target === screen.id).map((action) => action.id),
      outgoingActions: actions.filter((action) => stageId && action.stageId === stageId).map((action) => action.id),
      routeParameters: (screen.routeParameters || []).map((parameter) => ({ ...parameter })),
      dataOperations: (screen.data?.operations || []).map((operation) => operation.id),
      buildStatus: 'planned',
      reachable: isReachable(pack, screen),
      evidenceStatus: 'pending',
    };
  });
  return {
    schemaVersion: 1,
    kind: 'mobile-route-manifest',
    packRevision: pack.revision,
    initialRoute: pack.navigation?.routingPolicy?.launchRoute || pack.navigation?.initialRoute,
    routes,
  };
}

function validateRouteManifest(manifest, pack, options = {}) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== 'mobile-route-manifest') errors.push('route manifest identity is invalid');
  if (manifest?.packRevision !== pack?.revision) errors.push('route manifest pack revision is stale');
  const entries = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const ids = new Set();
  const routes = new Set();
  const files = new Set();
  for (const entry of entries) {
    if (!entry?.id || ids.has(entry.id)) errors.push(`route manifest has missing or duplicate screen id ${entry?.id || '<missing>'}`);
    ids.add(entry?.id);
    if (!entry?.route?.startsWith('/') || routes.has(entry.route)) errors.push(`route manifest has invalid or duplicate route ${entry?.route || '<missing>'}`);
    routes.add(entry?.route);
    if (!/^app\/.+\.tsx$/i.test(String(entry?.file || '')) || files.has(entry.file)) errors.push(`route manifest has invalid or duplicate file ${entry?.file || '<missing>'}`);
    files.add(entry?.file);
    if (!SCREEN_STATUSES.has(entry?.buildStatus)) errors.push(`route manifest screen ${entry?.id} has invalid build status`);
    if (typeof entry?.reachable !== 'boolean') errors.push(`route manifest screen ${entry?.id} lacks reachability result`);
    if (!['pending', 'captured', 'reviewed', 'concern'].includes(entry?.evidenceStatus)) errors.push(`route manifest screen ${entry?.id} has invalid evidence status`);
  }
  for (const screen of pack?.screens || []) {
    const entry = entries.find((candidate) => candidate.id === screen.id);
    if (!entry) errors.push(`route manifest omits screen ${screen.id}`);
    else if (entry.route !== screen.route || entry.file !== screen.file) errors.push(`route manifest drifts from screen ${screen.id}`);
  }
  if (entries.length !== (pack?.screens || []).length) errors.push('route manifest route count does not match build pack');
  if (entries.some((entry) => entry.reachable !== true)) errors.push('route manifest contains an unreachable planned screen');
  if (options.requireComplete) {
    const incomplete = entries.filter((entry) => !['type-safe', 'available-in-metro', 'reviewed', 'concern'].includes(entry.buildStatus));
    if (incomplete.length) errors.push(`route manifest has incomplete screens: ${incomplete.map((entry) => `${entry.id}:${entry.buildStatus}`).join(', ')}`);
  }
  return errors;
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function updateRouteStatus(manifest, screenIds, status, evidenceStatus = null) {
  if (!SCREEN_STATUSES.has(status)) throw new Error(`Unsupported route build status: ${status}.`);
  const selected = new Set(screenIds);
  const found = new Set();
  const routes = manifest.routes.map((entry) => {
    if (!selected.has(entry.id)) return entry;
    found.add(entry.id);
    return { ...entry, buildStatus: status, ...(evidenceStatus ? { evidenceStatus } : {}) };
  });
  const missing = [...selected].filter((screenId) => !found.has(screenId));
  if (missing.length) throw new Error(`Unknown route manifest screens: ${missing.join(', ')}.`);
  return { ...manifest, routes };
}

function parseArgs(argv) {
  const args = { action: 'initialize', screenIds: [], requireComplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--manifest') args.manifest = argv[++index];
    else if (argv[index] === '--screen') args.screenIds.push(argv[++index]);
    else if (argv[index] === '--status') args.status = argv[++index];
    else if (argv[index] === '--evidence-status') args.evidenceStatus = argv[++index];
    else if (argv[index] === '--require-complete') args.requireComplete = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !['initialize', 'update', 'validate'].includes(args.action)) {
    process.stderr.write('Usage: node route-manifest.js --project-root <dir> --action initialize|update|validate [--pack .tmp/screen-build-pack.json] [--manifest .tmp/route-manifest.json] [--screen <id> ... --status <status> --evidence-status <status>]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
    const manifestPath = path.resolve(root, args.manifest || ROUTE_MANIFEST_PATH);
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    let manifest;
    if (args.action === 'initialize') {
      manifest = buildRouteManifest(pack);
      const errors = validateRouteManifest(manifest, pack, { requireComplete: args.requireComplete });
      if (errors.length) throw new Error(errors.join('; '));
      writeAtomic(manifestPath, manifest);
    } else {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (args.action === 'update') {
        if (!args.screenIds.length || !args.status) throw new Error('update requires --screen and --status');
        manifest = updateRouteStatus(manifest, args.screenIds, args.status, args.evidenceStatus);
        writeAtomic(manifestPath, manifest);
      }
      const errors = validateRouteManifest(manifest, pack, { requireComplete: args.requireComplete });
      if (errors.length) throw new Error(errors.join('; '));
    }
    process.stdout.write(`${JSON.stringify({ status: 'ok', action: args.action, manifest: manifestPath, routes: manifest.routes.length }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`route-manifest: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { ROUTE_MANIFEST_PATH, SCREEN_STATUSES, buildRouteManifest, updateRouteStatus, validateRouteManifest, writeAtomic };
