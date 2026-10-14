'use strict';
// The one shape a generative page has as an entry of an app's navigation, in the SDK's App artifact
// (`siteMap.areas[].groups[].subAreas[]`):
//
//   { id: 'sub_0_0_1', title: 'Overview', type: 'GenPage', genPageId: '<page id>', vectorIcon?: '…', icon?: '…' }
//
// The build writes it for every page of an App Spec (lib/sdk-build.js `appDef`), and placing ONE page into an app that already
// exists (lib/genpage-sdk.js `placeInApp`, and apps.js when it creates an app around a first page) writes it too. Both go through
// this, so a page is a sub-area of exactly one shape wherever it was placed: the SDK's adapter serializes `genPageId` as the
// `GenPageId` attribute of a `<SubArea>` and adds the designer defaults (the page icon, `Client`, `AvailableOffline`,
// `PassParams`) itself, so nothing besides the target is spelled out here.
//
// `base` carries what every kind of sub-area has — `{ id, title }` and, when the caller has them, `icon` / `vectorIcon`.
function genPageSubArea(base, genPageId) {
  return { ...base, type: 'GenPage', genPageId };
}

// A sub-area id for a page placed on its own, which no sub-area of the app can already have: a SubArea `Id` must be unique across
// the sitemap, and an app edited in Maker holds designer-minted ids (`SubArea_<guid>`) and the build's positional ones
// (`sub_<area>_<group>_<index>`), so one derived from the page's own id collides with neither. A build that later rewrites the whole
// sitemap renames it to its positional id, as it does every other sub-area.
function genPageSubAreaId(genPageId) {
  return `genpage_${String(genPageId).replace(/[{}-]/g, '').toLowerCase()}`;
}

module.exports = { genPageSubArea, genPageSubAreaId };
