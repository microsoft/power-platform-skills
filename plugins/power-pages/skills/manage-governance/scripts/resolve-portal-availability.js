#!/usr/bin/env node

// resolve-portal-availability.js — Partition an environment's portals into
// AVAILABLE vs UNAVAILABLE for a given CHILD governance policy, based on the
// live state of that policy's PARENT policies.
//
// WHY this exists — the parent/child availability rule
// ----------------------------------------------------
// Power Pages authentication governance is a tree (see
// references/governance-mapping.json `policyAvailabilityDependencies`):
//
//   EnableExternalAuthProviders            (the "Main Flag" / root parent)
//     ├─ EnableProtocolOpenIdConnect
//     ├─ EnableProtocolSAML20
//     ├─ EnableProtocolWsFederation
//     └─ EnableProtocolOpenAuth            (OAuth 2.0 — also a parent)
//           ├─ EnableIdpOAuthFacebook
//           ├─ EnableIdpOAuthGoogle
//           └─ EnableIdpOAuthMicrosoft
//
// A portal (or the whole env) is only ELIGIBLE for governing a child setting
// where EVERY gating parent is Enabled for that portal. Concretely:
//   * If External Auth is Disabled on a portal/env, that portal is UNAVAILABLE
//     for OpenID Connect / SAML 2.0 / WS-Federation / OAuth 2.0.
//   * If OAuth 2.0 OR External Auth is Disabled on a portal/env, that portal is
//     UNAVAILABLE for Facebook / Google / Microsoft.
// The picker must still SHOW the unavailable portals — listed below the
// available ones with the blocking parent named — so the admin understands why
// they cannot target them.
//
// This module is pure-data-in / data-out for the partition + render logic
// (network-free, unit-testable). The optional CLI mode reads each parent's
// env-level value (get-env op) plus the env's inclusion/exclusion lists
// (get-portal op) via the shared governance transport, builds `parentStates`,
// and prints the partition (JSON or Markdown). Only a portal LIST must be
// supplied to the CLI (--portalsFile) — this module never re-implements the
// /websites pagination that list-portals.js already owns (DRY).

'use strict';

const fs = require('fs');
const path = require('path');

const MAPPING_PATH = path.join(__dirname, '..', 'references', 'governance-mapping.json');

function loadMapping(mappingPath) {
  const raw = fs.readFileSync(mappingPath || MAPPING_PATH, 'utf8');
  return JSON.parse(raw);
}

function findPolicy(mapping, policyName) {
  return (mapping.policies || []).find((p) => p.policyName === policyName) || null;
}

// The gating parents a child policy depends on. Read straight from the child's
// own `availabilityDependsOn` (the per-policy field is authoritative; the
// top-level policyAvailabilityDependencies block is only the readable overview).
// A leaf/independent policy (e.g. Maker Copilot, local login) returns [].
function dependenciesForPolicy(policyName, mapping) {
  const policy = findPolicy(mapping, policyName);
  if (!policy || !Array.isArray(policy.availabilityDependsOn)) return [];
  return policy.availabilityDependsOn.slice();
}

// Canonicalize an env-level governance value to All | None | Include | Exclude.
// get-env.js already normalizes *Sites -> canonical, but be defensive: accept
// the applyTo enum spellings too so this works whether it is fed the normalized
// `value` or the raw `body`. Anything unrecognized (including a missing value
// from a failed read) returns 'Unknown'.
function canonicalizeEnvValue(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'all' || s === 'allsites') return 'All';
  if (s === 'none') return 'None';
  if (s === 'include' || s === 'includesites' || s === 'includedsites') return 'Include';
  if (
    s === 'exclude' ||
    s === 'excludesites' ||
    s === 'excludedsites' ||
    s === 'allsitesexceptexcluded'
  ) {
    return 'Exclude';
  }
  return 'Unknown';
}

// Resolve a single portal's state under a parent policy, following the
// siteStateRules contract (references/governance-mapping.json `siteStateRules`,
// mirrored in SKILL.md Phase 4.4.3):
//
//   env All     -> Enabled
//   env None    -> Disabled
//   env Include -> Enabled  iff the portal is on the inclusion list
//   env Exclude -> Disabled iff the portal is on the exclusion list
//
// A parent env value we cannot canonicalize returns 'Unknown' (the availability
// layer treats Unknown as fail-open — see computeAvailability).
function computeSiteState(envValue, opts = {}) {
  const canon = canonicalizeEnvValue(envValue);
  const inInclusion = Boolean(opts.inInclusion);
  const inExclusion = Boolean(opts.inExclusion);
  if (canon === 'All') return 'Enabled';
  if (canon === 'None') return 'Disabled';
  if (canon === 'Include') return inInclusion ? 'Enabled' : 'Disabled';
  if (canon === 'Exclude') return inExclusion ? 'Disabled' : 'Enabled';
  return 'Unknown';
}

// Pull the inclusion/exclusion portal-id sets out of a get-portal (env-level)
// response body. The gateway's exact field naming for these lists is documented
// as an ASSUMPTION in references/commands.md and has been observed under several
// spellings across rings (InclusionList / IncludedSites / details.IncludedSites,
// camel- or Pascal-cased), and each entry may be a bare id string OR an object
// carrying the id under id/Id/portalId/websiteId. Be liberal in what we accept
// so a naming drift degrades to "list looks empty" (fail-open) rather than a
// crash. Returns { inclusion: Set<string>, exclusion: Set<string> } of lowercased
// id strings for case-insensitive membership tests.
function extractLists(body) {
  const inclusion = new Set();
  const exclusion = new Set();
  if (!body || typeof body !== 'object') return { inclusion, exclusion };

  const details = body.details || body.Details || {};
  const idOf = (entry) => {
    if (entry == null) return null;
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object') {
      return entry.id || entry.Id || entry.portalId || entry.PortalId || entry.websiteId || entry.WebsiteId || null;
    }
    return null;
  };
  const harvest = (arr, set) => {
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      const id = idOf(entry);
      if (id) set.add(String(id).trim().toLowerCase());
    }
  };

  // Inclusion spellings.
  harvest(body.InclusionList || body.inclusionList, inclusion);
  harvest(body.IncludedSites || body.includedSites, inclusion);
  harvest(details.InclusionList || details.inclusionList, inclusion);
  harvest(details.IncludedSites || details.includedSites, inclusion);
  // Exclusion spellings.
  harvest(body.ExclusionList || body.exclusionList, exclusion);
  harvest(body.ExcludedSites || body.excludedSites, exclusion);
  harvest(details.ExclusionList || details.exclusionList, exclusion);
  harvest(details.ExcludedSites || details.excludedSites, exclusion);

  return { inclusion, exclusion };
}

function portalIdOf(portal) {
  if (!portal) return null;
  const id = portal.portalId || portal.id || portal.Id || null;
  return id == null ? null : String(id).trim();
}

// Batch form of computeSiteState — resolve MANY portals' own state for a single
// policy from ONE env read + ONE getDetails read, with zero per-portal network
// calls. This is the whole point of the getDetails path: the gateway's
// `GET /websites/{portalId}/governance/{policy}` endpoint is per-portal (one
// boolean per call), so reading N portals costs N cold-started calls and N
// chances to hit a transient "PAC not signed in". Instead read the env value
// once (get-env.js) and the inclusion/exclusion lists once
// (get-details.js -> GET /governance/{policy}/details), then classify every
// portal locally against those lists via the same siteStateRules contract.
//
// `envValue` is the raw env-level policy value (All|None|Include|Exclude, any
// casing). `detailsBody` is the getDetails response body (its IncludedSites /
// ExcludedSites arrays are parsed by extractLists, which already tolerates the
// several field spellings observed across rings). `portals` is an array of
// portal ids (strings) or portal objects ({ portalId|id|Id, name, url, ... }).
// Returns one entry per input portal preserving order and any passed-through
// name/url, with `state` = 'Enabled'|'Disabled'|'Unknown'.
function resolvePortalStates(envValue, detailsBody, portals) {
  const { inclusion, exclusion } = extractLists(detailsBody);
  const list = Array.isArray(portals) ? portals : [];
  return list.map((entry) => {
    // Accept either a bare id string or a portal object so callers can pass the
    // raw id list OR the list-portals.js records straight through.
    const isObj = entry && typeof entry === 'object';
    const id = isObj ? portalIdOf(entry) : entry == null ? '' : String(entry).trim();
    const key = String(id || '').toLowerCase();
    const state = computeSiteState(envValue, {
      inInclusion: inclusion.has(key),
      inExclusion: exclusion.has(key),
    });
    const out = { portalId: id || '', state };
    if (isObj) {
      if (entry.name != null) out.name = entry.name;
      // list-portals.js records carry the site URL under websiteUrl; the render
      // helpers expect `url`, so surface both spellings when present.
      const url = entry.url != null ? entry.url : entry.websiteUrl;
      if (url != null) out.url = url;
    }
    return out;
  });
}

/**
 * Partition portals into available / unavailable for a target child policy.
 *
 * @param {object} req
 * @param {string} req.targetPolicy - the CHILD policy the admin wants to govern.
 * @param {Array<object>} req.portals - portal objects ({ portalId, name, websiteUrl|url, ... }).
 * @param {object} req.parentStates - map keyed by parent policyName:
 *   { [parentPolicyName]: {
 *       envValue: 'All'|'None'|'Include'|'Exclude'|'Unknown',
 *       inclusion?: Set<string>|string[],   // portal ids (any casing)
 *       exclusion?: Set<string>|string[]
 *     } }
 *   A parent absent from the map, or with envValue 'Unknown', is treated as
 *   fail-open (does not block) but recorded in `unreadParents`.
 * @param {object} [opts]
 * @param {object} [opts.mapping] - preloaded mapping (defaults to committed JSON).
 * @returns {{
 *   policy: string,
 *   dependencies: string[],
 *   available: Array<object>,
 *   unavailable: Array<object & { blockingParents: string[], blockedBy: string[], unreadParents: string[] }>
 * }}
 */
function computeAvailability(req, opts = {}) {
  const mapping = opts.mapping || loadMapping();
  const targetPolicy = req.targetPolicy;
  const portals = Array.isArray(req.portals) ? req.portals : [];
  const parentStates = req.parentStates || {};
  const deps = dependenciesForPolicy(targetPolicy, mapping);

  // No dependencies -> every portal is available (leaf/independent policy).
  if (deps.length === 0) {
    return { policy: targetPolicy, dependencies: [], available: portals.slice(), unavailable: [] };
  }

  // Pre-normalize each parent's membership sets once.
  const norm = {};
  for (const parent of deps) {
    const st = parentStates[parent] || {};
    const toSet = (v) => {
      if (v instanceof Set) {
        return new Set([...v].map((x) => String(x).trim().toLowerCase()));
      }
      if (Array.isArray(v)) return new Set(v.map((x) => String(x).trim().toLowerCase()));
      return new Set();
    };
    norm[parent] = {
      envValue: st.envValue,
      inclusion: toSet(st.inclusion),
      exclusion: toSet(st.exclusion),
    };
  }

  const available = [];
  const unavailable = [];
  for (const portal of portals) {
    const pid = (portalIdOf(portal) || '').toLowerCase();
    const blockingParents = [];
    const unreadParents = [];
    for (const parent of deps) {
      const st = norm[parent];
      const state = computeSiteState(st.envValue, {
        inInclusion: st.inclusion.has(pid),
        inExclusion: st.exclusion.has(pid),
      });
      if (state === 'Disabled') blockingParents.push(parent);
      else if (state === 'Unknown') unreadParents.push(parent);
    }
    if (blockingParents.length > 0) {
      unavailable.push({
        ...portal,
        blockingParents,
        // Human-facing parent labels (the `subject` from the mapping, e.g.
        // "External authentication providers"), for the "blocked by" reason.
        blockedBy: blockingParents.map((n) => {
          const p = findPolicy(mapping, n);
          return (p && p.subject) || n;
        }),
        unreadParents,
      });
    } else {
      // Fail-open: an unread parent does NOT hide the portal, but we surface it
      // so the caller can note "couldn't confirm <parent>" if desired.
      available.push(unreadParents.length ? { ...portal, unreadParents } : portal);
    }
  }
  return { policy: targetPolicy, dependencies: deps, available, unavailable };
}

// ---------------------------------------------------------------------------
// Rendering — the partitioned picker table (Markdown, chat-safe)
// ---------------------------------------------------------------------------
function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function urlOf(portal) {
  return (portal && (portal.url || portal.websiteUrl || portal.WebsiteUrl)) || '';
}

// Render one Markdown table with AVAILABLE portals first, then the UNAVAILABLE
// ones listed directly BELOW (per the requirement "Disabled Portal or
// Environment should be shown just below it"). The Availability column carries
// the 🟢 / ⚪ marker; unavailable rows also name the blocking parent so the admin
// sees *why* the portal is ineligible. Emit the output as a rendered Markdown
// table (NOT inside a code fence). `opts.icons` defaults on.
function renderAvailabilityMarkdown(partition, opts = {}) {
  const icons = opts.icons !== false;
  const avail = Array.isArray(partition.available) ? partition.available : [];
  const unavail = Array.isArray(partition.unavailable) ? partition.unavailable : [];
  const headers = ['#', 'Portal Name', 'Portal URL', 'Portal ID', 'Availability'];

  const rows = [];
  let n = 0;
  for (const p of avail) {
    n += 1;
    rows.push([
      String(n),
      (p && p.name) || '(unnamed)',
      urlOf(p),
      portalIdOf(p) || '',
      icons ? '🟢 Available' : 'Available',
    ]);
  }
  for (const p of unavail) {
    n += 1;
    const reason = (p.blockedBy && p.blockedBy.length)
      ? `blocked by ${p.blockedBy.join(', ')} (Disabled)`
      : 'blocked by a parent setting (Disabled)';
    rows.push([
      String(n),
      (p && p.name) || '(unnamed)',
      urlOf(p),
      portalIdOf(p) || '',
      (icons ? '⚪ Unavailable — ' : 'Unavailable — ') + reason,
    ]);
  }

  const head = '| ' + headers.map(mdCell).join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => '| ' + r.map(mdCell).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

// Render ONLY the AVAILABLE portals for a child auth policy — the scope picker
// the admin uses for the four sign-in protocols (OpenID Connect / SAML 2.0 /
// WS-Federation / OAuth 2.0) and the social IdPs. Per the requirement, the
// scope list must show ONLY the sites the admin can actually target:
//   * list only the portals where the gating parent (External Auth — and for
//     the social IdPs also OAuth 2.0) is ENABLED;
//   * if NONE are available, show a single clear "<parent> is Disabled for this
//     environment" message INSTEAD of an empty table — the child cannot be
//     governed anywhere in the env until the parent is enabled, so the
//     orchestrator must not prompt for a scope;
//   * if only SOME are available, list just those and append an info line
//     naming how many sites were hidden and why.
// This differs from renderAvailabilityMarkdown (which lists the ineligible
// portals BELOW the eligible ones): here the unavailable portals are OMITTED
// from the table and only summarized, because the scope picker only needs the
// actionable set.
function renderAvailablePortalsMarkdown(partition, opts = {}) {
  const mapping = opts.mapping || loadMapping();
  const icons = opts.icons !== false;
  const avail = Array.isArray(partition.available) ? partition.available : [];
  const unavail = Array.isArray(partition.unavailable) ? partition.unavailable : [];

  const childPolicy = findPolicy(mapping, partition.policy);
  const childSubject = (childPolicy && childPolicy.subject) || partition.policy || 'this setting';

  // Distinct human-facing name(s) of the parent(s) that blocked sites. Prefer
  // the `blockedBy` labels actually recorded on the unavailable portals; fall
  // back to the child's declared dependency subjects when nothing is blocked
  // (so the empty-state message still names a parent even in odd data).
  const blockingSubjects = [];
  const seen = new Set();
  for (const p of unavail) {
    for (const subj of p.blockedBy || []) {
      if (!seen.has(subj)) { seen.add(subj); blockingSubjects.push(subj); }
    }
  }
  if (blockingSubjects.length === 0) {
    for (const dep of partition.dependencies || []) {
      const pp = findPolicy(mapping, dep);
      const subj = (pp && pp.subject) || dep;
      if (!seen.has(subj)) { seen.add(subj); blockingSubjects.push(subj); }
    }
  }
  const subjects = blockingSubjects.length
    ? blockingSubjects
    : ['The required parent setting'];
  // The social IdPs (Facebook / Google / Microsoft) depend on TWO parents —
  // External authentication providers AND OAuth 2.0 sign-in — so a site is only
  // eligible when BOTH are enabled, and is blocked when EITHER is disabled.
  // That asymmetry drives two different conjunctions:
  //   * disabled-state phrasing uses "or"  — either parent being off blocks the
  //     child ("the External Auth OR OAuth 2.0 Governance setting is off");
  //   * enable / enabled-state phrasing uses "and" — every parent must be on
  //     ("turn on both the External Auth AND OAuth 2.0 Governance settings";
  //      "both … Governance settings are on").
  const multi = subjects.length > 1;
  const orList = subjects.join(' or ');
  const andList = subjects.join(' and ');
  // Plain-language "Governance setting" phrasing for the availability messages,
  // so the admin sees WHY a portal is filtered in the same vocabulary the rest
  // of the skill uses: the child and its blocking parent(s) are each named as
  // "the <subject> Governance setting", their state as on/off, and the
  // consequence spelled out as "… can't apply". E.g. "the OAuth 2.0 sign-in
  // Governance setting can't apply because the External authentication providers
  // Governance setting is off". See the parent/child availability model in
  // references/governance-mapping.json.
  const childGov = `the ${childSubject} Governance setting`;
  // Disabled-state reference to the blocking parent(s). Singular "setting" even
  // in the multi-parent case because the "or" makes it read as a single either
  // clause ("the X or Y Governance setting is off").
  const parentGovOff = `the ${orList} Governance setting`;
  // Enable instruction (empty state): every parent must be turned on, so the
  // multi-parent case says "both … Governance settings".
  const enableInstruction = multi
    ? `turn on both the ${andList} Governance settings`
    : `turn on the ${andList} Governance setting`;
  // Subset "only where …" clause: every parent must be on.
  const enabledClause = multi
    ? `both the ${andList} Governance settings are on`
    : `the ${andList} Governance setting is on`;

  // Empty state — no site is eligible because a parent is Disabled env-wide (or
  // Disabled on every site). For a social IdP that means External Auth or OAuth
  // 2.0 (or both) is off. Return the single message the picker shows in place of
  // a table; the orchestrator must NOT prompt for a scope here.
  if (avail.length === 0) {
    const dot = icons ? '🔴 ' : '';
    return `**${dot}The ${orList} Governance setting is off for this environment.** ` +
      `No sites are available to configure ${childGov} here — ${enableInstruction} first, then try again.`;
  }

  // Render only the available portals (the actionable set).
  const headers = ['#', 'Portal Name', 'Portal URL', 'Portal ID'];
  const head = '| ' + headers.join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const rows = avail.map((p, i) => '| ' + [
    String(i + 1),
    mdCell((p && p.name) || '(unnamed)'),
    mdCell(urlOf(p)),
    mdCell(portalIdOf(p) || ''),
  ].join(' | ') + ' |');
  const out = [head, sep, ...rows];

  // "Proper information" when only a subset is eligible: name how many sites are
  // shown vs hidden and why, in plain "Governance setting" language so the admin
  // understands the list was filtered and what would unblock the hidden sites.
  if (unavail.length > 0) {
    const total = avail.length + unavail.length;
    const dot = icons ? '🟢 ' : '';
    out.push('');
    out.push(
      `> ${dot}Showing ${avail.length} of ${total} site(s) — ${childGov} can only ` +
      `be configured on sites where ${enabledClause}. ` +
      `${unavail.length} site(s) are hidden because ${parentGovOff} is off on them, ` +
      `so ${childGov} can't apply there.`
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI — read parent states via the governance transport, partition, print.
// ---------------------------------------------------------------------------
async function readParentStates(deps, envId) {
  // Lazy-require the transport so the pure functions above (and their tests)
  // never pull in the network stack.
  const { callGovernance } = require('./governance-transport');
  const { normalizeEnvValue } = require('./policies');
  const parentStates = {};
  for (const parent of deps) {
    // Env-level value for this parent.
    const envRes = await callGovernance({ op: 'getEnv', envId, policy: parent });
    if (!envRes.ok) {
      const msg = envRes.error?.message || `status ${envRes.statusCode}`;
      const code = envRes.error?.code === 'ContextError' ? 2 : 1;
      const err = new Error(`Reading parent "${parent}" env state failed: ${msg}`);
      err.exitCode = code;
      throw err;
    }
    const envValue = canonicalizeEnvValue(normalizeEnvValue(envRes.body));

    // Inclusion/exclusion lists only matter for Include/Exclude env values.
    //
    // These lists come from the env-level `getDetails` op
    // (`GET /governance/{policy}/details`), which returns the whole list, e.g.:
    //   { "IncludedSites": ["096b20ff-…","214d497a-…"], "ExcludedSites": null }
    //
    // NOT from `getPortal` (`GET /websites/{portalId}/governance/{policy}`):
    // that op is portal-scoped and returns only a single boolean for the one
    // portal id (`{ ..., "body": true|false }`) — it never returns the env's
    // full list. It also 404s on a dummy all-zero id ("Website with the given
    // id does not exist"), so the previous dummy-id `getPortal` call always
    // came back empty, leaving `inclusion` empty and making every portal
    // resolve to Disabled — i.e. an `Include` parent (enabled on a subset) was
    // mis-reported as disabled env-wide. `getDetails` is the correct source.
    let inclusion = new Set();
    let exclusion = new Set();
    if (envValue === 'Include' || envValue === 'Exclude') {
      const listRes = await callGovernance({
        op: 'getDetails',
        envId,
        policy: parent,
      });
      if (listRes.ok) {
        const lists = extractLists(listRes.body);
        inclusion = lists.inclusion;
        exclusion = lists.exclusion;
      }
      // A failed list read leaves both sets empty -> Include resolves every
      // portal to Disabled (fail-closed for the list, but the parent value was
      // read successfully so this is the correct conservative result).
    }
    parentStates[parent] = { envValue, inclusion, exclusion };
  }
  return parentStates;
}

const HELP = `resolve-portal-availability.js — Partition portals into available /
unavailable for a CHILD governance policy, based on its parent policies' state.

Usage:
  node resolve-portal-availability.js --policy <childPolicy> --portalsFile <path> [--envId <guid>] [--markdown]

Flags:
  --policy       Child policy name (e.g. EnableProtocolOpenIdConnect,
                 EnableIdpOAuthGoogle). Leaf policies with no parents return
                 every portal as available.
  --portalsFile  Path to JSON produced by list-portals.js ({ portals: [...] } or
                 a bare array). Required — this script does NOT re-page /websites.
  --envId        Optional environment id (falls back to the current PAC env).
  --markdown     Print the picker table (Markdown) instead of JSON.
  --available-only  With --markdown, list ONLY the available portals (the scope
                 picker for child auth policies). Shows a single "<parent> is
                 Disabled for this environment" message when none are available,
                 and an info line when only a subset is. Without this flag,
                 --markdown lists unavailable portals below the available ones.
  --help         Show this help.

Exit codes:
  0  Success   2  Sign-in required   1  Other failure

Stdout (JSON, default):
  { "status": "ok", "policy": "<name>", "dependencies": [ ... ],
    "available":   [ { portal } ... ],
    "unavailable": [ { portal, "blockingParents": [...], "blockedBy": [...] } ... ] }
`;

function parseFlags(argv) {
  const out = { markdown: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') out.policy = argv[++i];
    else if (a === '--portalsFile') out.portalsFile = argv[++i];
    else if (a === '--envId') out.envId = argv[++i];
    else if (a === '--markdown' || a === '--md') out.markdown = true;
    else if (a === '--available-only' || a === '--availableOnly') out.availableOnly = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!flags.policy || !flags.portalsFile) {
    process.stderr.write('Usage: node resolve-portal-availability.js --policy <name> --portalsFile <path> [--envId <guid>] [--markdown]\n');
    process.exit(1);
    return;
  }

  const { assertPolicy } = require('./policies');
  assertPolicy(flags.policy);

  const mapping = loadMapping();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(flags.portalsFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`resolve-portal-availability: could not read/parse --portalsFile: ${e.message}\n`);
    process.exit(1);
    return;
  }
  const portals = Array.isArray(parsed) ? parsed : parsed.portals || [];
  const deps = dependenciesForPolicy(flags.policy, mapping);

  let parentStates = {};
  if (deps.length > 0) {
    try {
      parentStates = await readParentStates(deps, flags.envId);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(e.exitCode || 1);
      return;
    }
  }

  const partition = computeAvailability(
    { targetPolicy: flags.policy, portals, parentStates },
    { mapping }
  );

  if (flags.markdown) {
    // The scope picker for child auth policies wants ONLY the available
    // portals (--available-only); the default markdown view lists unavailable
    // portals below the available ones.
    const render = flags.availableOnly
      ? renderAvailablePortalsMarkdown(partition, { mapping })
      : renderAvailabilityMarkdown(partition);
    process.stdout.write(render + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ status: 'ok', ...partition }, null, 2) + '\n');
}

module.exports = {
  loadMapping,
  findPolicy,
  dependenciesForPolicy,
  canonicalizeEnvValue,
  computeSiteState,
  extractLists,
  resolvePortalStates,
  computeAvailability,
  renderAvailabilityMarkdown,
  renderAvailablePortalsMarkdown,
  readParentStates,
};

if (require.main === module) {
  main();
}
