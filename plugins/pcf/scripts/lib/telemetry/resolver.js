'use strict';

// This plugin owns its key/collector routing and Power Apps client envelope.
// region/ is a byte-identical Power Pages copy; keep PCF-specific policy here.
// The shared org-to-region cache stores only a region, so each plugin still
// selects its own instrumentation key from its own config on every event.
const { resolve: resolveRegion, mapToRegion } = require('./region/region-resolver');

// PAC's Cloud: Public/UsGov/UsGovHigh/UsGovDod/China stamp identifies the cloud;
// Tip1/Tip2/Test/Preprod identify internal stamps. See the documented cloud values:
// https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/auth#pac-auth-create
// A missing stamp is public ONLY when PAC is signed out (no organization).
const PUBLIC_CLOUDS = new Set(['', 'public']);
const STAMPED_CLOUDS = new Set([
  'usgov', 'usgovgcc', 'gcc', 'gov',
  'usgovhigh', 'high',
  'usgovdod', 'dod',
  'china', 'mooncake', 'chinacloud',
  'tip1', 'tip2', 'test', 'preprod',
]);
const NO_FALLBACK_REGION = '__no_fallback__';

function entryFromMap(regionsMap, region) {
  const entry = regionsMap && regionsMap[region];
  if (!entry || !entry.instrumentation_key || !entry.collector_url) return null;
  return { region, iKey: entry.instrumentation_key, collectorUrl: entry.collector_url };
}

async function resolve({ event, cfg, cloud, configDir }) {
  const regionsMap = (cfg && cfg.regions) || {};
  const defaultRegion = (cfg && cfg.default_region) || 'us';
  const stamp = String(cloud || '').trim().toLowerCase();
  const orgId = (event && event.data && event.data.orgId) || '';

  // A sovereign/internal stamp already identifies its destination. Do not call
  // Artemis: the generic router's failed lookup falls back to a public default.
  // A missing entry returns null, and ikey.json has no static fallback key.
  if (STAMPED_CLOUDS.has(stamp)) {
    return entryFromMap(regionsMap, mapToRegion(stamp, '', defaultRegion));
  }
  // The copied normalizer treats unknown clouds as Public. Fail closed instead,
  // including a signed-in org with no stamp: it could belong to a sovereign cloud.
  if (!PUBLIC_CLOUDS.has(stamp) || (!stamp && orgId)) return null;
  if (!orgId) return entryFromMap(regionsMap, defaultRegion);

  // Public orgs must stay in their geo's data boundary, even during an outage.
  // The sentinel has no config entry, so an unavailable/unrecognized Artemis geo
  // cannot become a US fallback. Only derived regions enter the shared cache.
  return resolveRegion({
    orgId, cloud, regionsMap, defaultRegion: NO_FALLBACK_REGION, configDir,
  });
}

function isProvisioned(cfg) {
  // Gate before the expensive PAC shell-outs. Flipping disabled before replacing
  // the placeholder must not create a local mirror or attempt transmission.
  const defaultRegion = (cfg && cfg.default_region) || 'us';
  const entry = cfg && cfg.regions && cfg.regions[defaultRegion];
  return !!(entry && entry.instrumentation_key
    && entry.instrumentation_key !== 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING'
    && entry.collector_url);
}

// The Power Apps ingestion mapping accepts the shared `event` stream, not a
// plugin-named stream. Keep PCF rows separable from other plugins and real client
// traffic with clientType + customDimensions.pluginName, using the same shape:
//   { ver: "4.0", name: "event", time, iKey: "o:<tenant token>",
//     data: { app_Name: "powerappsclient", clientType: "PcfAIPlugin",
//             event_Name: "skill_started", session_Id, tenantId?, severity, timestamp,
//             customDimensions: "{\"pluginName\":\"pcf\",\"skillName\":\"pcf\",...}" },
//     ext: { app: { sesId, ver }, os: { name, ver } } }
// The dispatcher already allowlists data. Rearrange only those approved fields;
// PCF hooks supply no eventInfo and never attach a signed-in user object ID.
function formatEnvelope({ time, data, iKey, eventStreamName }) {
  const fields = data || {};
  const dimensions = { ...fields };
  delete dimensions.eventName;
  delete dimensions.eventType;
  delete dimensions.severity;
  return {
    ver: '4.0',
    name: eventStreamName || 'event',
    time,
    iKey: 'o:' + String(iKey || '').split('-')[0],
    data: {
      app_Name: 'powerappsclient',
      clientType: 'PcfAIPlugin',
      event_Name: fields.eventName || '',
      session_Id: fields.sessionId || '',
      ...(fields.tenantId ? { tenantId: fields.tenantId } : {}),
      severity: fields.severity || 'Info',
      timestamp: time,
      customDimensions: JSON.stringify(dimensions),
    },
    ext: {
      app: { sesId: fields.sessionId || '', ver: fields.pluginVersion || '' },
      os: { name: fields.osName || '', ver: fields.osVersion || '' },
    },
  };
}

module.exports = { resolve, isProvisioned, formatEnvelope };
