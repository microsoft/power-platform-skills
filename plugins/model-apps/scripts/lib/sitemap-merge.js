'use strict';
// Rewrite an EXISTING app's sitemap without destroying what the App Spec cannot describe
// (AB#6726727).
//
// The build describes navigation from the App Spec (appDef, sdk-build.js), which carries each node's
// label or title, its target and its icons — nothing else. The vendored SDK projects a FETCHED sitemap
// into typed nodes that each keep a `bag`: every attribute and child the typed layer does not model
// (`Url`, `Client`, `Sku`, `AvailableOffline`, `ResourceId`, titles in other languages, `<Privilege>`
// entries). A node that arrives WITHOUT a bag is serialized from scratch with the classic designer's
// defaults for a new node:
//
//   <SubArea Id="sub_0_0_0" DefaultDashboard="…" ResourceId="SitemapDesigner.NewSubArea"
//            Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web"
//            Sku="All,OnPremise,Live,SPLA" AvailableOffline="true" PassParams="false">
//
// Every existing-app build handed the SDK bag-less nodes, so any edit — even an unrelated one —
// rewrote every live node that way. A designer-made dashboard entry
//
//   <SubArea Id="ops_dashboard" Url="/workplace/home_dashboards.aspx" DefaultDashboard="…"
//            Client="All,Web" AvailableOffline="false">
//
// lost its launcher `Url`, and with it the dashboard glyph: the runtime shows that glyph only for a
// subarea whose Url is the dashboard launcher, and the designer only recognizes a subarea as a
// dashboard entry by that Url (it writes it on every dashboard entry it creates).
//
// `adoptLiveSitemap` re-attaches each node the build wants to the LIVE node it corresponds to and
// keeps the live `id` and `bag`, so the SDK re-emits the node as it was and overlays only the fields
// the spec sets. A subarea corresponds by its navigation TARGET (the identity the SDK itself uses to
// spot duplicates); areas and groups have no target, so they correspond by label, then by the id an
// earlier build of this plugin gave them.

// The fixed launcher path the designer gives every dashboard entry it creates, and the one the
// runtime keys the dashboard glyph on.
const DASHBOARD_LAUNCHER_URL = '/workplace/home_dashboards.aspx';

// Whether a subarea Url is the dashboard launcher, the way the runtime decides it: it looks for the
// launcher path anywhere in the Url (case-insensitively here, since Dataverse paths are).
function isDashboardLauncherUrl(url) {
  return typeof url === 'string' && url.toLowerCase().includes(DASHBOARD_LAUNCHER_URL);
}

// A GUID as Dataverse may store it in sitemap XML (`{280948EC-…}`, bare, either case) → bare lower.
const bareGuid = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^\{|\}$/g, '').toLowerCase();
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The comparable identity of a subarea's navigation TARGET, or undefined when it has none.
 *
 * Mirrors the SDK's own `subAreaTargetKey` (its duplicate check): `(type, target)`, GUIDs normalized,
 * logical names and URLs case-folded. Neither the SubArea `Id` nor its title says where an entry
 * navigates, so neither can identify it across a download → edit → build round trip.
 */
function subAreaTargetKey(sub) {
  if (!sub || typeof sub !== 'object') return undefined;
  switch (sub.type) {
    case 'Entity': return text(sub.entity) ? `Entity:${text(sub.entity).toLowerCase()}` : undefined;
    case 'URL': return text(sub.url) ? `URL:${text(sub.url).toLowerCase()}` : undefined;
    case 'DashBoard': return bareGuid(sub.dashboardId) ? `DashBoard:${bareGuid(sub.dashboardId)}` : undefined;
    case 'CustomPage': return text(sub.page) ? `CustomPage:${text(sub.page).toLowerCase()}` : undefined;
    case 'GenPage': return bareGuid(sub.genPageId) ? `GenPage:${bareGuid(sub.genPageId)}` : undefined;
    default: return undefined;
  }
}

// The target attribute each subarea type carries. When a desired subarea is adopted, its target is
// taken VERBATIM from the live node: the two compare equal only after normalization, and re-writing
// `{280948EC-…}` as `280948ec-…` would change the XML for nothing.
const TARGET_FIELD = { Entity: 'entity', URL: 'url', DashBoard: 'dashboardId', CustomPage: 'page', GenPage: 'genPageId' };

// Deep copy of a bag, so the tree handed to the SDK never aliases the workspace copy it was read from.
const cloneBag = (bag) => (bag === undefined ? undefined : JSON.parse(JSON.stringify(bag)));

// Icons compare case-insensitively: appDef lower-cases a bare web-resource name (the icon lookup is
// case-insensitive), so a live `new_Icon.svg` and a spec `new_icon.svg` are the same icon. Titles
// compare exactly — a changed capital is a real rename.
const CHROME = [
  { field: 'title', same: (a, b) => text(a) === text(b) },
  { field: 'icon', same: (a, b) => text(a).toLowerCase() === text(b).toLowerCase() },
  { field: 'vectorIcon', same: (a, b) => text(a).toLowerCase() === text(b).toLowerCase() },
];

/**
 * Re-attach `desired` (appDef's `siteMap`) to the `live` sitemap the SDK fetched for the same app.
 *
 * Returns `{ siteMap, notes }`. `siteMap` is a fresh tree: every node that corresponds to a live node
 * carries the live `id` and `bag`; the rest are new and keep appDef's ids, renamed only where one
 * would collide with an adopted id. `notes` lists what happened to existing nodes, for the build to
 * report (`node` is 'area' | 'group' | 'subArea'):
 *   { kind: 'kept', node, target, field, live, spec }    — see `baseChrome`
 *   { kind: 'changed', node, target, field, live, spec, intended? } — the build changes this value;
 *                                                          `intended` when the baseline shows the spec did
 *
 * `opts.baseChrome` (optional) maps a subarea target key to `{ title, icon, vectorIcon }` as the spec
 * last applied to — or downloaded from — this environment described it. With it, a value the spec
 * has NOT changed since then but the environment HAS (a rename in the designer after the download)
 * is kept, not silently reverted: the spec is stale for that field, not asking for a change. Without
 * a baseline there is no telling the two apart, so the spec wins and the change is reported.
 */
function adoptLiveSitemap(desired, live, opts = {}) {
  const baseChrome = opts.baseChrome instanceof Map ? opts.baseChrome : new Map();
  const liveAreas = (live && Array.isArray(live.areas)) ? live.areas : [];
  const desiredAreas = (desired && Array.isArray(desired.areas)) ? desired.areas : [];
  const kids = (node, key) => (node && Array.isArray(node[key]) ? node[key] : []);
  const notes = [];

  // Correspondence is decided in PASSES over a whole level, never node by node in document order: a
  // weaker rule must not let an earlier node take a live node that a later one matches by a stronger
  // rule. (A new first area gets appDef's `area_0`; if it could claim the live `area_0` by id before
  // the moved area that is still labelled the same got to it, the two would swap identities.)
  //
  // Areas and groups have no target, so they correspond by label first; then by the id this plugin
  // gave them on an earlier build (`area_0`, `group_0_1`), which is how a relabelled node is still
  // recognized; then — for a node with no label at the SDK's language, as a downloaded app titled only
  // in another language has — the next unlabelled live node in document order.
  const sameTitle = (a, b) => text(a) !== '' && text(a).toLowerCase() === text(b).toLowerCase();
  const correspond = (want, have) => {
    const taken = new Set();
    const match = new Array(want.length);
    const passes = [
      (d, l) => sameTitle(l.title, d.title),
      (d, l) => text(l.id) !== '' && text(l.id).toLowerCase() === text(d.id).toLowerCase(),
      (d, l) => text(d.title) === '' && text(l.title) === '',
    ];
    for (const same of passes) {
      want.forEach((d, i) => {
        if (match[i] || !d) return;
        const l = have.find((n) => n && typeof n === 'object' && !taken.has(n) && same(d, n));
        if (l) { match[i] = l; taken.add(l); }
      });
    }
    return match;
  };
  const areaMatch = correspond(desiredAreas, liveAreas);
  const groupMatch = desiredAreas.map((a, ai) => correspond(kids(a, 'groups'), kids(areaMatch[ai], 'groups')));

  // Subareas correspond by navigation target: first within the live group their own group adopted (an
  // entry that stayed put), then anywhere (an entry that moved). Each live node is adopted at most once.
  const liveSubs = [];
  for (const area of liveAreas) for (const group of kids(area, 'groups')) for (const sub of kids(group, 'subAreas')) {
    const key = subAreaTargetKey(sub);
    if (key) liveSubs.push({ sub, group, key });
  }
  const claimed = new Set();
  const subMatch = desiredAreas.map((a) => kids(a, 'groups').map((g) => new Array(kids(g, 'subAreas').length)));
  const subPass = (inOwnGroup) => desiredAreas.forEach((a, ai) => kids(a, 'groups').forEach((g, gi) => kids(g, 'subAreas').forEach((sub, si) => {
    if (subMatch[ai][gi][si]) return;
    const key = subAreaTargetKey(sub);
    if (!key) return;
    const own = groupMatch[ai][gi];
    const hit = liveSubs.find((c) => !claimed.has(c.sub) && c.key === key && (!inOwnGroup || (own && c.group === own)));
    if (hit) { subMatch[ai][gi][si] = hit; claimed.add(hit.sub); }
  })));
  subPass(true);
  subPass(false);

  const out = desiredAreas.map((area, ai) => {
    const liveArea = areaMatch[ai];
    const nextArea = { ...area, groups: [], __adopted: !!liveArea };
    if (liveArea) {
      nextArea.id = liveArea.id;
      nextArea.bag = cloneBag(liveArea.bag);
      if (text(area.title) !== text(liveArea.title)) {
        notes.push({ kind: 'changed', node: 'area', target: `area "${text(liveArea.title) || liveArea.id}"`, field: 'title', live: text(liveArea.title), spec: text(area.title) });
      }
    }
    kids(area, 'groups').forEach((group, gi) => {
      const liveGroup = groupMatch[ai][gi];
      const nextGroup = { ...group, subAreas: [], __adopted: !!liveGroup };
      if (liveGroup) {
        nextGroup.id = liveGroup.id;
        nextGroup.bag = cloneBag(liveGroup.bag);
        if (text(group.title) !== text(liveGroup.title)) {
          notes.push({ kind: 'changed', node: 'group', target: `group "${text(liveGroup.title) || liveGroup.id}"`, field: 'title', live: text(liveGroup.title), spec: text(group.title) });
        }
      }
      kids(group, 'subAreas').forEach((sub, si) => {
        const pick = subMatch[ai][gi][si];
        const nextSub = { ...sub, __adopted: !!pick };
        if (pick) {
          const liveSub = pick.sub;
          nextSub.id = liveSub.id;
          nextSub.bag = cloneBag(liveSub.bag);
          const field = TARGET_FIELD[sub.type];
          if (field && liveSub[field] !== undefined) nextSub[field] = liveSub[field];
          // A live dashboard entry keeps its own launcher Url (verbatim, whatever its casing or query);
          // one without it — the shape earlier builds wrote — gets the designer's, which is what brings
          // its glyph back. The runtime only looks for the launcher path in the Url, so a Url that
          // lacks it is not worth keeping.
          if (sub.type === 'DashBoard') {
            nextSub.dashboardUrl = isDashboardLauncherUrl(liveSub.dashboardUrl) ? liveSub.dashboardUrl : (sub.dashboardUrl || DASHBOARD_LAUNCHER_URL);
          }
          const base = baseChrome.get(pick.key);
          const label = text(liveSub.title) || text(sub.title) || pick.key;
          for (const { field: f, same } of CHROME) {
            if (same(sub[f], liveSub[f])) {
              // Equal as far as the platform cares (an icon name differing only in case): re-emit the
              // live string, so the node round-trips byte-for-byte.
              if (text(liveSub[f])) nextSub[f] = liveSub[f];
              continue;
            }
            if (base && same(sub[f], base[f]) && !same(liveSub[f], base[f])) {
              // Changed in the environment since the baseline, untouched in the spec: keep it.
              if (text(liveSub[f])) nextSub[f] = liveSub[f];
              else delete nextSub[f];
              notes.push({ kind: 'kept', node: 'subArea', target: `nav entry "${label}"`, field: f, live: text(liveSub[f]), spec: text(sub[f]) });
            } else {
              notes.push({ kind: 'changed', node: 'subArea', target: `nav entry "${label}"`, field: f, live: text(liveSub[f]), spec: text(sub[f]), ...(base ? { intended: true } : {}) });
            }
          }
        }
        nextGroup.subAreas.push(nextSub);
      });
      nextArea.groups.push(nextGroup);
    });
    return nextArea;
  });

  // Ids must stay unique across the sitemap. An adopted node keeps its live id; a new node keeps
  // appDef's positional id unless an adopted node already holds it (appDef numbers by position, so a
  // new `area_1` can meet an adopted live `area_1` that has moved). Adopted ids are reserved FIRST so
  // a new node earlier in the document can never take one.
  const used = new Set();
  const nodes = [];
  for (const a of out) {
    nodes.push(a);
    for (const g of a.groups) {
      nodes.push(g);
      for (const s of g.subAreas) nodes.push(s);
    }
  }
  for (const n of nodes) if (n.__adopted && text(n.id)) used.add(text(n.id).toLowerCase());
  for (const n of nodes) {
    const adopted = n.__adopted;
    delete n.__adopted;
    if (adopted) continue;
    let id = text(n.id) || 'node';
    if (used.has(id.toLowerCase())) {
      let i = 2;
      while (used.has(`${id}_${i}`.toLowerCase())) i += 1;
      id = `${id}_${i}`;
    }
    n.id = id;
    used.add(id.toLowerCase());
  }
  return { siteMap: { ...(desired || {}), areas: out }, notes };
}

/**
 * The chrome (`title`, `icon`, `vectorIcon`) a spec gives each subarea, keyed by the SAME target key
 * `adoptLiveSitemap` uses — so a baseline spec can be lined up against the live sitemap.
 *
 * A spec names a dashboard or page, not its id, so `ids` supplies the ids THIS build resolved:
 * `{ dashboards: { name: id }, pages: { key: id } }` (the build's `result.created`). A baseline
 * entry whose dashboard or page this build did not resolve is left out: with no identity there is
 * nothing to line it up with, and the spec then simply wins.
 */
function chromeByTargetKey(spec, ids = {}) {
  const map = new Map();
  const areas = spec && spec.appShell && Array.isArray(spec.appShell.areas) ? spec.appShell.areas : [];
  for (const a of areas) {
    for (const g of (a && Array.isArray(a.groups) ? a.groups : [])) {
      for (const s of (g && Array.isArray(g.subAreas) ? g.subAreas : [])) {
        if (!s || typeof s !== 'object') continue;
        let key;
        if (s.entity) key = subAreaTargetKey({ type: 'Entity', entity: s.entity });
        else if (s.dashboard) key = subAreaTargetKey({ type: 'DashBoard', dashboardId: (ids.dashboards || {})[s.dashboard] });
        else if (s.page) key = subAreaTargetKey({ type: 'GenPage', genPageId: (ids.pages || {})[s.page] });
        else if (s.url) key = subAreaTargetKey({ type: 'URL', url: s.url });
        // A target listed twice is ambiguous, so neither occurrence is used as a baseline.
        if (!key) continue;
        map.set(key, map.has(key) ? null : { title: s.title, icon: s.icon, vectorIcon: s.vectorIcon });
      }
    }
  }
  for (const [k, v] of map) if (v === null) map.delete(k);
  return map;
}

/**
 * One warning line per note worth reporting. A `changed` subarea note the baseline explains (the spec
 * itself changed the value) is the edit the author asked for, so it is not repeated back.
 */
function describeSitemapNotes(notes) {
  const shown = (v) => (v ? `'${v}'` : '(none)');
  const lines = [];
  for (const n of notes || []) {
    if (n.kind === 'kept') {
      lines.push(`${n.target}: kept the environment's ${n.field} ${shown(n.live)} — it changed there after this spec was last applied or downloaded, and the spec still has ${shown(n.spec)}. Change the spec to change it.`);
    } else if (n.kind === 'changed' && n.node === 'subArea' && !n.intended) {
      lines.push(`${n.target}: ${n.field} changes from ${shown(n.live)} to the spec's ${shown(n.spec)}. No baseline in this spec's workspace records the entry, so a change made in the designer cannot be told from one made in the spec.`);
    } else if (n.kind === 'changed' && n.node !== 'subArea') {
      lines.push(`${n.target}: ${n.field} changes from ${shown(n.live)} to the spec's ${shown(n.spec)}.`);
    }
  }
  return lines;
}

module.exports = { DASHBOARD_LAUNCHER_URL, isDashboardLauncherUrl, subAreaTargetKey, adoptLiveSitemap, chromeByTargetKey, describeSitemapNotes };
