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

// Whether a subarea Url is the dashboard launcher to BOTH of its consumers: the designer recognizes a
// dashboard entry only when the whole Url equals the launcher (compared lower-cased), and the runtime
// shows the dashboard glyph only when the Url contains it (compared case-SENSITIVELY). Only the exact
// launcher satisfies both — `/WorkPlace/Home_Dashboards.aspx` passes the designer and fails the
// runtime; a query suffix passes the runtime and fails the designer.
function isDashboardLauncherUrl(url) {
  return url === DASHBOARD_LAUNCHER_URL;
}

// A GUID as Dataverse may store it in sitemap XML (`{280948EC-…}`, bare, either case) → bare lower.
const bareGuid = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^\{|\}$/g, '').toLowerCase();
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// A URL target compared the way it is resolved. A web-resource reference names a Dataverse web
// resource, whose names are case-insensitive, so it folds; an http(s) URL folds only its scheme and
// host — a path or query value can be case-sensitive, and folding it would let an intended change of
// case look like the live entry and be written back over.
function urlIdentity(url) {
  const u = text(url);
  if (/^\$webresource:/i.test(u) || /^\/webresources\//i.test(u)) return u.toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(u);
  return m ? m[1].toLowerCase() + m[2] : u;
}

/**
 * The comparable identity of a subarea's navigation TARGET, or undefined when it has none.
 *
 * Like the SDK's own `subAreaTargetKey` (its duplicate check): `(type, target)`, GUIDs normalized,
 * logical names case-folded — except a URL, which keeps the case of its path and query (urlIdentity).
 * Neither the SubArea `Id` nor its title says where an entry navigates, so neither can identify it
 * across a download → edit → build round trip.
 */
function subAreaTargetKey(sub) {
  if (!sub || typeof sub !== 'object') return undefined;
  switch (sub.type) {
    case 'Entity': return text(sub.entity) ? `Entity:${text(sub.entity).toLowerCase()}` : undefined;
    case 'URL': return text(sub.url) ? `URL:${urlIdentity(sub.url)}` : undefined;
    case 'DashBoard': return bareGuid(sub.dashboardId) ? `DashBoard:${bareGuid(sub.dashboardId)}` : undefined;
    case 'CustomPage': return text(sub.page) ? `CustomPage:${text(sub.page).toLowerCase()}` : undefined;
    case 'GenPage': return bareGuid(sub.genPageId) ? `GenPage:${bareGuid(sub.genPageId)}` : undefined;
    default: return undefined;
  }
}

// The target attribute each subarea type carries. When a desired subarea is adopted, its target is
// taken VERBATIM from the live node: the two compare equal only after normalization, and re-writing
// `{280948EC-…}` as `280948ec-…` would change the XML for nothing. A URL is not listed: the spec's
// own spelling is what it asks for, and its identity already differs only where case cannot matter.
const TARGET_FIELD = { Entity: 'entity', DashBoard: 'dashboardId', CustomPage: 'page', GenPage: 'genPageId' };

// Deep copy of a bag, so the tree handed to the SDK never aliases the workspace copy it was read from.
const cloneBag = (bag) => (bag === undefined ? undefined : JSON.parse(JSON.stringify(bag)));

// The attribute value of a raw bag node, e.g. `LCID` on `{ n: 'Title', a: [['LCID','1033'], ['Title','Ops']] }`.
const rawAttr = (node, key) => {
  const pair = node && Array.isArray(node.a) ? node.a.find(([k]) => k === key) : undefined;
  return pair ? pair[1] : undefined;
};

/**
 * Make an ADOPTED node's bag carry the title the spec asks for at the SDK's language, which the SDK
 * will not do on its own for a node that has a bag. Its rebuild patches the `<Title LCID="…">` inside
 * an EXISTING `<Titles>` (adding the entry when missing), but it only synthesizes the wrapper for a
 * from-scratch node, and it reads an empty typed title as "no edit". So:
 *   - a title where the live node has no `<Titles>` at all: an empty wrapper is added first in the
 *     node (where the SDK puts a synthesized one) for the SDK to fill;
 *   - no title where the live node has one at this language: that `<Title>` is dropped, and the other
 *     languages' titles are kept — the bag-less write this replaces dropped every language.
 * Bag children are `{ i, node }` with absolute child indices (modeled children fill the gaps), so an
 * insertion shifts every index after it up, and a removal shifts every index after it down — or a
 * modeled child would fill the vacated slot ahead of the kept ones, e.g. a `<SubArea>` written before
 * the group's `<Descriptions>`, which the sitemap schema does not allow.
 */
function reconcileTitleChild(bag, title, liveTitle, lcid) {
  if (!bag || !Array.isArray(bag.c)) return;
  const lang = String(lcid);
  const at = bag.c.findIndex((e) => e && e.node && e.node.n === 'Titles');
  if (text(title)) {
    if (at < 0) {
      bag.c = [{ i: 0, node: { n: 'Titles', a: [], c: [] } }, ...bag.c.map((e) => ({ ...e, i: e.i + 1 }))];
    }
    return;
  }
  if (!text(liveTitle) || at < 0) return;
  const titles = bag.c[at].node;
  titles.c = (titles.c || []).filter((n) => !(n && n.n === 'Title' && rawAttr(n, 'LCID') === lang));
  if (!titles.c.some((n) => n && n.n === 'Title')) {
    const gone = bag.c[at].i;
    bag.c = bag.c.filter((_, k) => k !== at).map((e) => (e.i > gone ? { ...e, i: e.i - 1 } : e));
  }
}

// Icons compare case-insensitively: appDef lower-cases a bare web-resource name (the icon lookup is
// case-insensitive), so a live `new_Icon.svg` and a spec `new_icon.svg` are the same icon. Titles
// compare exactly — a changed capital is a real rename.
const CHROME = [
  { field: 'title', same: (a, b) => text(a) === text(b) },
  { field: 'icon', same: (a, b) => text(a).toLowerCase() === text(b).toLowerCase() },
  { field: 'vectorIcon', same: (a, b) => text(a).toLowerCase() === text(b).toLowerCase() },
];

/**
 * Whether a rebuild KEEPS a live nav entry's `field` rather than writing the spec's value: the spec
 * still has the value its baseline (`base`, from chromeByTargetKey) recorded for the entry and the
 * environment no longer does — so the change was made there, after the baseline, and the spec is
 * stale for that field rather than asking for it. (The spec and live values then differ, too.) The one
 * rule both the build and `--verify` apply, so verify accepts exactly what the build kept.
 */
function keepsLiveValue(field, specValue, liveValue, base) {
  const rule = CHROME.find((c) => c.field === field);
  if (!rule || !base) return false;
  return rule.same(specValue, base[field]) && !rule.same(liveValue, base[field]);
}

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
  // The language the SDK reads and writes titles in (its construction-time LCID).
  const lcid = opts.lcid || 1033;
  const liveAreas = (live && Array.isArray(live.areas)) ? live.areas : [];
  const desiredAreas = (desired && Array.isArray(desired.areas)) ? desired.areas : [];
  const kids = (node, key) => (node && Array.isArray(node[key]) ? node[key] : []);
  const notes = [];

  // Correspondence is decided in PASSES over a whole level, never node by node in document order: a
  // weaker rule must not let an earlier node take a live node that a later one matches by a stronger
  // rule. (A new first area gets appDef's `area_0`; if it could claim the live `area_0` by id before
  // the moved area that is still labelled the same got to it, the two would swap identities.)
  //
  // Areas and groups have no target of their own. They correspond, in order of the evidence:
  //   1. by a label their level uses exactly once, in the spec and live;
  //   2. by the navigation entries they hold: a node and a live node whose entries are each other's
  //      strictly best overlap (the share of targets they have in common) are the same node — a relabelled
  //      one, or one of several with a repeated label. An entry can recur across areas (first-party
  //      sitemaps list a table under several), so it is the best overlap that counts, not any; a tie pairs
  //      nothing;
  //   3. by the id this plugin gave them on an earlier build (`area_0`, `group_0_1`) — how a relabelled
  //      node with no entries to go by is recognized — but never a live node whose label an unpaired spec
  //      node still wants, nor two nodes whose entries all differ;
  //   4. with no label at the SDK's language (a downloaded app titled only in another language) and no
  //      entries on either side, the next such live node in document order.
  // A repeated label, or none, decides nothing by position where entries can speak. Taking the first
  // live "Main", or the one whose id appDef's numbering happened to repeat, or the next unlabelled one,
  // gave a new or reordered node another node's id and bag — with two live "Main"s and the first renamed
  // in the spec, the one left took the renamed area's; with a leading area and a second "Main" added, the
  // new leading `area_0` took the original's. A node none of the passes identifies is written as new
  // rather than given another node's bag.
  const sameTitle = (a, b) => text(a) !== '' && text(a).toLowerCase() === text(b).toLowerCase();
  const labelKey = (n) => text(n && n.title).toLowerCase();
  const sameId = (d, l) => text(l.id) !== '' && text(l.id).toLowerCase() === text(d.id).toLowerCase();
  // How many nodes of a level carry each label (compared as sameTitle compares them).
  const labelCounts = (list) => {
    const counts = new Map();
    for (const n of list) {
      const k = n && typeof n === 'object' ? labelKey(n) : '';
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
  };
  // The navigation targets of the entries under a node (subAreaTargetKey), as a Set.
  const targetsOf = (subs) => {
    const keys = new Set();
    for (const sub of subs) {
      const key = subAreaTargetKey(sub);
      if (key) keys.add(key);
    }
    return keys;
  };
  const groupTargets = (group) => targetsOf(kids(group, 'subAreas'));
  const areaTargets = (area) => targetsOf(kids(area, 'groups').flatMap((g) => kids(g, 'subAreas')));
  const overlap = (a, b) => [...a].some((k) => b.has(k));
  // The share of two nodes' targets they have in common (Jaccard): 1 for the same entries, 0 for none.
  const similarity = (a, b) => {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const k of a) if (b.has(k)) common += 1;
    return common / (a.size + b.size - common);
  };
  // The candidate with the strictly highest positive score, or null (none, or a tie at the top).
  const strictBest = (scored) => {
    let top = 0;
    let at = null;
    let tied = false;
    for (const [candidate, score] of scored) {
      if (score > top) { top = score; at = candidate; tied = false; } else if (score > 0 && score === top) tied = true;
    }
    return tied ? null : at;
  };
  const correspond = (want, have, targetsOfNode) => {
    const live = have.filter((n) => n && typeof n === 'object');
    const taken = new Set();
    const match = new Array(want.length);
    const pair = (i, l) => { match[i] = l; taken.add(l); };
    const wantCounts = labelCounts(want);
    const haveCounts = labelCounts(live);
    const wantTargets = want.map((d) => (d && typeof d === 'object' ? targetsOfNode(d) : new Set()));
    const haveTargets = new Map(live.map((l) => [l, targetsOfNode(l)]));
    const stillWanted = (label) => label !== '' && want.some((d, i) => d && !match[i] && labelKey(d) === label);
    const entriesDiffer = (i, l) => wantTargets[i].size > 0 && haveTargets.get(l).size > 0 && !overlap(wantTargets[i], haveTargets.get(l));
    const unpaired = (fn) => want.forEach((d, i) => { if (!match[i] && d && typeof d === 'object') fn(d, i); });
    unpaired((d, i) => {
      if (wantCounts.get(labelKey(d)) !== 1 || haveCounts.get(labelKey(d)) !== 1) return;
      const l = live.find((n) => !taken.has(n) && sameTitle(n.title, d.title));
      if (l) pair(i, l);
    });
    // Repeated until nothing pairs: each pairing takes a candidate away, which can settle another's best.
    for (let paired = true; paired;) {
      paired = false;
      unpaired((d, i) => {
        if (!wantTargets[i].size) return;
        const l = strictBest(live.filter((n) => !taken.has(n)).map((n) => [n, similarity(wantTargets[i], haveTargets.get(n))]));
        if (!l) return;
        const back = strictBest(want.map((o, j) => [j, !match[j] && o && typeof o === 'object' ? similarity(wantTargets[j], haveTargets.get(l)) : 0]));
        if (back === i) { pair(i, l); paired = true; }
      });
    }
    unpaired((d, i) => {
      const l = live.find((n) => !taken.has(n) && sameId(d, n) && !stillWanted(labelKey(n)) && !entriesDiffer(i, n));
      if (l) pair(i, l);
    });
    unpaired((d, i) => {
      if (text(d.title) !== '' || wantTargets[i].size) return;
      const l = live.find((n) => !taken.has(n) && text(n.title) === '' && !haveTargets.get(n).size);
      if (l) pair(i, l);
    });
    return match;
  };
  const areaMatch = correspond(desiredAreas, liveAreas, areaTargets);
  const groupMatch = desiredAreas.map((a, ai) => correspond(kids(a, 'groups'), kids(areaMatch[ai], 'groups'), groupTargets));

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
      reconcileTitleChild(nextArea.bag, area.title, liveArea.title, lcid);
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
        reconcileTitleChild(nextGroup.bag, group.title, liveGroup.title, lcid);
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
          // Every dashboard entry gets the exact launcher Url — the shape earlier builds wrote had none,
          // which is what restores its glyph — since only that exact string satisfies both the designer
          // and the runtime (isDashboardLauncherUrl). A live entry that already has it is unchanged.
          if (sub.type === 'DashBoard') nextSub.dashboardUrl = DASHBOARD_LAUNCHER_URL;
          const base = baseChrome.get(pick.key);
          const label = text(liveSub.title) || text(sub.title) || pick.key;
          for (const { field: f, same } of CHROME) {
            if (same(sub[f], liveSub[f])) {
              // Equal as far as the platform cares (an icon name differing only in case): re-emit the
              // live string, so the node round-trips byte-for-byte.
              if (text(liveSub[f])) nextSub[f] = liveSub[f];
              continue;
            }
            if (keepsLiveValue(f, sub[f], liveSub[f], base)) {
              // Changed in the environment since the baseline, untouched in the spec: keep it.
              if (text(liveSub[f])) nextSub[f] = liveSub[f];
              else delete nextSub[f];
              notes.push({ kind: 'kept', node: 'subArea', target: `nav entry "${label}"`, field: f, live: text(liveSub[f]), spec: text(sub[f]) });
            } else {
              notes.push({ kind: 'changed', node: 'subArea', target: `nav entry "${label}"`, field: f, live: text(liveSub[f]), spec: text(sub[f]), ...(base ? { intended: true } : {}) });
            }
          }
          reconcileTitleChild(nextSub.bag, nextSub.title, liveSub.title, lcid);
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

// The id a plain `{ <name or key>: id }` map holds for `name` — only as the map's OWN entry, so a
// dashboard named `constructor` never resolves to Object.prototype's.
const ownId = (map, name) => (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined);
const idMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Every subarea of an App Spec, in document order.
function specSubAreas(spec) {
  const out = [];
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const a of list(spec && spec.appShell && spec.appShell.areas)) {
    for (const g of list(a && a.groups)) for (const s of list(g && g.subAreas)) if (s && typeof s === 'object') out.push(s);
  }
  return out;
}

/**
 * The target key (see subAreaTargetKey) an App Spec subarea navigates to in one environment. A table
 * or URL target is in the spec itself; a dashboard (named) or a page (by key — schemaVersion 2, which
 * every loaded spec and every baseline is migrated to) takes its id from `ids`:
 * `{ dashboards: { <name>: id }, pages: { <key>: id } }`. Undefined without a target or an id.
 */
function specSubAreaTargetKey(s, ids = {}) {
  if (!s || typeof s !== 'object') return undefined;
  if (s.entity) return subAreaTargetKey({ type: 'Entity', entity: s.entity });
  if (s.dashboard) return subAreaTargetKey({ type: 'DashBoard', dashboardId: ownId(idMap(ids.dashboards), s.dashboard) });
  if (s.page) return subAreaTargetKey({ type: 'GenPage', genPageId: ownId(idMap(ids.pages), s.page) });
  if (s.url) return subAreaTargetKey({ type: 'URL', url: s.url });
  return undefined;
}

/**
 * The chrome (`title`, `icon`, `vectorIcon`) a BASELINE spec gives each nav entry, keyed by the target
 * key the entry has in this environment — the key `adoptLiveSitemap` matches live entries by.
 *
 * A dashboard or page takes its id from the ids the baseline RECORDED for this environment
 * (`__deployedIds`, written with it — see deployed-baseline.js) before `ids`, the ids this build (its
 * `result.created`) or verify resolved: after the author renames a dashboard in the spec, as the
 * build's warning asks, the baseline still names it by the old name, and only the recorded id still
 * connects it to the live entry. The spec's own `dashboardId` / `pageId` are never read: a spec
 * downloaded from one environment and built into another carries the first one's ids. An entry with
 * no id either way is left out, and the spec then simply wins.
 */
function chromeByTargetKey(baseline, ids = {}) {
  const map = new Map();
  const recorded = idMap(baseline && baseline.__deployedIds);
  // Spread copies own keys as data properties (never through the __proto__ setter), recorded ids last.
  const resolved = {
    dashboards: { ...idMap(ids.dashboards), ...idMap(recorded.dashboards) },
    pages: { ...idMap(ids.pages), ...idMap(recorded.pages) },
  };
  for (const s of specSubAreas(baseline)) {
    const key = specSubAreaTargetKey(s, resolved);
    if (!key) continue;
    // A target listed twice is ambiguous, so neither occurrence is used as a baseline.
    map.set(key, map.has(key) ? null : { title: s.title, icon: s.icon, vectorIcon: s.vectorIcon });
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

module.exports = { DASHBOARD_LAUNCHER_URL, isDashboardLauncherUrl, subAreaTargetKey, specSubAreaTargetKey, specSubAreas, adoptLiveSitemap, chromeByTargetKey, keepsLiveValue, describeSitemapNotes };
