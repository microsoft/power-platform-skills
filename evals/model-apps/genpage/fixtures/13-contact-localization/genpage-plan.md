# Genpage Plan

## User Requirements

Build a page showing Contact records with name, email, and phone.

## Working Directory

contact-localized/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- Environment URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Sales Hub (55555555-4444-5555-6666-777777777777)
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Contacts (Localized) | page.tsx | Contact list with multi-language UI (en/ar/fr) | contact |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

contact

## Localization

- Detected languages (from `pac model list-languages`):
  - English (United States) (1033, en-US)
  - Arabic (Saudi Arabia) (1025, ar-SA) — RTL
  - French (France) (1036, fr-FR)
- Translation dictionary keyed by BCP-47 tag
- All user-visible text via translate() helper
- dir attribute set from locale.isRtl
- Logical CSS properties (marginInlineStart/End, paddingInlineStart/End)

## Design Preferences

- DataGrid with sortable, resizable columns
- Column headers and table aria-label come from translate()
- Logical CSS only (no marginLeft/Right or paddingLeft/Right)

## Relevant Samples

- plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list pattern)
- references/localization.md (multi-language + RTL pattern)

## Per-Page Specifications

### Contacts (Localized)

- File: page.tsx
- Entity: contact
- Language detection: `Xrm.Utility.getGlobalContext().userSettings.languageId`
- Locale map: { 1033: en-US, 1025: ar-SA (RTL), 1036: fr-FR }
- Translations dict has entries for en-US, ar-SA, fr-FR
- Icons: PeopleRegular (unsized)
