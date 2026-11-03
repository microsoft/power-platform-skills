'use strict';
// What the App Spec's navigation (`appShell`) holds, and whether Dataverse will take an app built from it.
//
// A model-driven app's navigation is a sitemap: areas hold groups and groups hold entries (the spec calls an
// entry a `subArea`): https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/create-site-map-app
//
// WHY the build asks. It creates a NEW app in its app-shell phase with the navigation the spec gives it,
// LEAVING OUT every page entry: a page does not exist yet, and the pages phase writes it into the navigation
// once it does (sdk-build.js `appDef`, `omitUnbuiltPages`). Dataverse refuses to CREATE a sitemap with nothing in
// it. Measured against a live environment, creating an app whose sitemap has no entry answers
//
//   HTTP 400: SiteMap needs to have a non-empty Area with a non-empty Group, even when ignoring all Areas,
//   Groups, and SubAreas with an IsVisible child
//
// It does NOT refuse the same navigation when the sitemap of an app that ALREADY EXISTS is UPDATED. Measured against
// a live environment, on an app that had one entry: the SDK's update of its navigation to `areas: []`, and to an
// area holding an empty group, were both saved; a raw PATCH of the sitemap row to
// `<SiteMap><Area Id="a" Title="Main"><Group Id="g" Title="Records" /></Area></SiteMap>` answered 204; and publishing
// after each of them (the SDK's publish, and a raw PublishXml of the app and its sitemap) was accepted, the
// published sitemap then holding no SubArea at all. So an empty navigation is refused where the platform refuses
// it, for a new app, and only said so for an app that exists, which is left with no entries (`warn`).
//
// A NEW app whose navigation holds ONLY page entries is not refused by a build that can create its pages FIRST: one that has the
// pages phase, and is not a changed-only re-upload, for a spec whose page entries all name pages it builds. Such a build leaves the
// app's create to the end of the pages phase and makes the app with the pages already in its first navigation (sdk-build.js
// `createAppWithPages`), so the sitemap it creates is not empty. That is the order `apps.js create --page-id` has always used — a page
// made with no app, then the app around it, through the same SDK create and the same sub-area (genpage-subarea.js) — and that order
// was live-verified. Any other run creates the app before its pages, and is still refused (`newAppPagesFirst` false; `whyNotPagesFirst`
// says why).
//
// The spec models no IsVisible children, so none are ignored here. A spec whose navigation is only pages, or is
// `areas: []`, or has an area with no group, or a group with no entry, is still VALID — validateAppSpec accepts
// a spec with no appShell at all, which data-only builds and downloaded specs rely on — so such a build of a new
// app used to fail at the app-shell step, AFTER the solution, tables, columns, views and forms had been written. The
// build, its dry run and lint-app-spec ask this module instead, from the spec alone, before anything is written.

// The `code` of the BuildHalt the build raises for a navigation this module refuses.
const NAVIGATION_REFUSAL_CODE = 'app-navigation-empty';

const PLATFORM_REFUSAL = 'Dataverse refuses to create a sitemap with no non-empty area holding a non-empty group (HTTP 400: "SiteMap needs to have a non-empty Area with a non-empty Group")';
const ENTRY_EXAMPLE = "{ entity: '<table>', title: '<label>' }";

// The kind of target an entry has, in the precedence `appDef` gives them: a dashboard wins over a page, a page over
// a url, and anything else is a table. `appDef` classifies through this function too, so the entries it leaves
// out of a new app's first navigation (the pages) and the ones counted here cannot differ.
function navigationEntryKind(entry) {
  if (entry.dashboard) return 'dashboard';
  if (entry.page) return 'page';
  if (entry.url) return 'url';
  return 'entity';
}

// What the navigation holds, counted the way the build walks it (areas → groups → entries). Total on any shape:
// lint runs on specs still being typed, so a node that is not an object is not counted rather than thrown on.
//   declared  appShell.areas is an array — without it `appDef` has nothing to build a sitemap from and throws
//   pages     the `page` of every page entry, in order
function navigationHolds(spec) {
  const shell = spec && spec.appShell;
  const holds = { declared: !!shell && Array.isArray(shell.areas), areas: 0, groups: 0, entries: 0, pages: [] };
  if (!holds.declared) return holds;
  const nodes = (value) => (Array.isArray(value) ? value : []).filter((node) => node && typeof node === 'object');
  for (const area of nodes(shell.areas)) {
    holds.areas += 1;
    for (const group of nodes(area.groups)) {
      holds.groups += 1;
      for (const entry of nodes(group.subAreas)) {
        holds.entries += 1;
        if (navigationEntryKind(entry) === 'page') holds.pages.push(entry.page);
      }
    }
  }
  return holds;
}

// Whether the navigation holds entries and every one of them is a page — the one navigation a NEW app is built from only by
// creating its pages first (the app step decides that from this and from the run's shape: sdk-build.js, `createAppWithPages`).
const onlyPages = (holds) => holds.declared && holds.entries > 0 && holds.entries === holds.pages.length;
function navigationIsPagesOnly(spec) {
  return onlyPages(navigationHolds(spec));
}

// What a navigation that cannot build a NEW app holds, why that stops one, and what to add. `held` is the first of the
// three on its own, for the warning an app that exists gets. `pagesFirst` is whether the run creates a new app's pages
// before the app (navigationVerdict's `newAppPagesFirst`): an entry for one of the spec's pages is then one the app's first
// navigation holds, so the advice offers it. `whyNotPagesFirst` is why a run does not, for a navigation of pages only.
function navigationAdvice(holds, { pagesFirst = false, whyNotPagesFirst } = {}) {
  const orPage = pagesFirst ? ", or an entry for one of the spec's pages (a build that has the pages phase creates a new app's pages before the app)" : '';
  const notAPage = pagesFirst ? '' : ' A new app needs one entry that is not a page, since a page entry joins the navigation only once its page exists.';
  if (!holds.declared) {
    // `appDef` throws on a spec with no appShell.areas before it asks whether the app exists, so no app, new or not, is built from it.
    return {
      kind: 'undeclared',
      held: 'the spec has no appShell.areas',
      problem: 'the spec has no appShell.areas, so there is no navigation to build the app with.',
      fix: `Add appShell.areas with a group holding an entry — for example ${ENTRY_EXAMPLE} in appShell.areas[].groups[].subAreas${orPage}.${notAPage}`,
    };
  }
  if (holds.entries > 0) {
    // Reached only for a run that does NOT create a new app's pages first (navigationVerdict): one that does builds a navigation of pages only.
    const shown = holds.pages.slice(0, 5).map((page) => `'${page}'`).join(', ');
    const more = holds.pages.length > 5 ? ` and ${holds.pages.length - 5} more` : '';
    const held = `the navigation holds only page entries (${shown}${more})`;
    return {
      kind: 'pages-only',
      held,
      problem: `${held}. A page entry joins the navigation only once its page exists, and ${whyNotPagesFirst || 'this run does not create the pages before the app'}, so a new app would be created without them, and ${PLATFORM_REFUSAL}.`,
      fix: `A build that has the pages phase creates such an app after its pages, with them in its first navigation: run the whole build, with every page the navigation names implemented. Or give a group one entry that is not a page — for example ${ENTRY_EXAMPLE}; a dashboard or url entry works too — and keep the page entries beside it.`,
    };
  }
  const what = holds.areas === 0 ? 'appShell.areas is empty'
    : holds.groups === 0 ? 'no area in appShell has a group'
      : 'no group in appShell has an entry';
  const held = `the navigation has no entry (${what})`;
  return {
    kind: 'empty',
    held,
    problem: `${held}, and ${PLATFORM_REFUSAL}.`,
    fix: `Give an area a group with an entry — for example ${ENTRY_EXAMPLE} in appShell.areas[].groups[].subAreas${orPage}.${notAPage}`,
  };
}

// Decide whether the build may go on with this spec's navigation. Returns
//   { outcome: 'ok' }                           nothing is wrong, whether the app is new or not
//   { outcome: 'refuse', kind, code, message }  the navigation cannot be saved: stop before writing anything
//   { outcome: 'warn', kind, message }          the app exists and takes it, and its author should hear what it leaves: go on, and say so
//   { outcome: 'unknown', kind, message }       fine for an app that exists, refused for a new one, and the caller
//                                               could not tell which this is — say so, and go on
// `kind` is 'pages-only' (entries, but all pages), 'empty' (no entry at all) or 'undeclared' (no appShell.areas).
//
//   appExists            true / false, or undefined when it could not be read
//   existingAppIsWritten whether this run writes the spec's navigation to an app that already exists (sdk-build.js
//                        existingAppSitemapIsWritten); a run that writes none asks nothing of the spec for such an app
//   whyUnknown           what stopped the caller reading it, for the `unknown` message
//   newAppPagesFirst     whether this run creates a NEW app's pages before the app, so that the app's first navigation holds
//                        its page entries (sdk-build.js pagesFirstRule: the app step and the pages phase, not a changed-only
//                        re-upload, and every page entry naming a page the run builds). lint-app-spec speaks of the build
//                        `--apply` runs, which does. Absent is false: the stricter rule.
//   whyNotPagesFirst     why it does not, for the refusal of a navigation of pages only
//
//   the navigation holds                NEW app (its first push     EXISTING app (its sitemap        existence
//                                       creates the sitemap)        is updated)                      UNKNOWN
//   an entry that is not a page         ok                          ok                               ok
//   entries, every one a page, and
//     the run creates the pages first   ok                          ok                               ok
//     a run that does not               refuse                      ok                               unknown
//   no entry at all                     refuse                      warn (ok if this run writes      unknown
//                                                                   no navigation to it)
//   no appShell.areas                   refuse                      refuse                           refuse
//
// Why they differ:
//   NEW app       an entry its first push holds, since that push creates the sitemap and Dataverse refuses to CREATE one with
//                 no entry (the HTTP 400 quoted above). A run that creates the pages first creates the app after them, so its
//                 first push holds the page entries; any other run creates the app before its pages and leaves them out, so it
//                 needs one entry that is not a page.
//   EXISTING app  its navigation is written from the whole spec once the pages exist (the pages phase's finalizer), so a
//                 page entry counts, and Dataverse accepts an empty navigation when a sitemap is UPDATED (measured, above):
//                 the build goes on, with a warning that the app is left with no entries. A run that writes no navigation
//                 to it asks nothing of the spec.
//   no appShell.areas  refused for every app: `appDef` throws on it before it asks whether the app exists.
function navigationVerdict(spec, { appExists, existingAppIsWritten = true, whyUnknown, newAppPagesFirst = false, whyNotPagesFirst } = {}) {
  const holds = navigationHolds(spec);
  if (holds.declared && holds.entries > holds.pages.length) return { outcome: 'ok' };
  // Pages only, in a run that creates a new app's pages first: a new app is created with them, and an app that exists takes them as it
  // always did — so the answer is the same whichever this is, and whether or not that could be read.
  if (newAppPagesFirst && onlyPages(holds)) return { outcome: 'ok' };
  const advice = navigationAdvice(holds, { pagesFirst: newAppPagesFirst, whyNotPagesFirst });
  if (appExists === false || advice.kind === 'undeclared') {
    return { outcome: 'refuse', kind: advice.kind, code: NAVIGATION_REFUSAL_CODE, message: `${advice.problem} ${advice.fix}` };
  }
  const acceptsEmpty = 'Dataverse accepts an empty navigation when the navigation of an app that already exists is updated';
  if (appExists === true) {
    if (advice.kind !== 'empty' || !existingAppIsWritten) return { outcome: 'ok' };
    return {
      outcome: 'warn',
      kind: advice.kind,
      message: `${advice.held}, so the app is left with no navigation entries (any it has now are removed). ${acceptsEmpty}, so the build goes on. To keep the app navigable, give an area a group with an entry — for example ${ENTRY_EXAMPLE} in appShell.areas[].groups[].subAreas.`,
    };
  }
  const exists = advice.kind === 'pages-only' ? 'an app that already exists takes its page entries once the pages are built'
    : existingAppIsWritten ? `an app that already exists is built with no navigation entries: ${acceptsEmpty}`
      : 'this run writes no navigation to an app that already exists';
  return {
    outcome: 'unknown',
    kind: advice.kind,
    message: `${advice.problem} That matters only if the app is new (${exists}), and whether it exists could not be checked (${whyUnknown || 'the environment was not read'}), so nothing stops the build here; a new app would stop at the app step, after the tables are written. ${advice.fix}`,
  };
}

module.exports = { NAVIGATION_REFUSAL_CODE, navigationEntryKind, navigationHolds, navigationIsPagesOnly, navigationVerdict };
