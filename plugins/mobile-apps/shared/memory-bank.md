# Memory Bank — Power Apps Native Code App

This file is the per-project notebook the agent maintains across `/create-mobile-app`, `/add-*`, `/edit-app`, `/list-connections`, and `/deploy` invocations. Treat it as the single source of truth for "what has been done in this project so far."

> **For agents:** Read this file at the start of any skill invocation. Update the relevant section after any successful action. Never delete entries — append, mark superseded.

---

## Project facts

| Key | Value |
|---|---|
| Display name | _<set by /create-mobile-app>_ |
| Slug | |
| Scheme | |
| iOS bundle id | |
| Android bundle id | |
| Working directory | |
| Plugin version that created the project | |
| Created | _<ISO date>_ |
| Metro terminal id | _<background-shell id from Step 12 — agent reads this terminal's output for live debug. If empty/dead, re-launch with `cd <working_dir> && npm run dev` and update this field._ |
| Metro launch command | _e.g. `cd <working_dir> && npm run dev`_ |

## Power Platform context

| Key | Value |
|---|---|
| Active environment ID | |
| Active environment name | |
| Environment URL | _e.g. https://orgXXXX.crm.dynamics.com — captured at /add-dataverse Step 1_ |
| Power Apps CLI identity | |
| App registration (Entra) | _clientId pasted during /create-mobile-app or manual /set-app-registration-native_ |
| Solution unique name | _e.g. `Default` or `<AppNameSolution>` — captured at /add-dataverse Step 3b. Required for the `--solution` flag on every metadata POST so artifacts land in our solution._ |
| Publisher prefix | _e.g. `cr3e9` — from the solution's publisher's `customizationprefix`. All schema names use this prefix._ |
| `playerConfig.ts` last modified by | |

## Data model

### Reused tables
_<table name — when added — generated service file>_

### Extended tables
_<table name — extension columns — when added>_

### Created tables (Tier order)
_<table name — Tier — MetadataId — solution — relationships — when added>_

> **Why MetadataId + solution are recorded:** the `/add-dataverse` Step 5a pre-flight check uses these to distinguish "we own this table" (idempotent skip) from "name collision with someone else's table" (stop and prompt). Without the MetadataId we can't tell the two apart on a re-run.

### Collision history
_<table name — collision type (foreign / tombstone / reserved) — resolution (renamed / adopted / waited / prefix-switched) — when>_

## Offline profile

_Populated by `/setup-offline-profile`. Step 1b reads this section on every run to detect resume state (in-progress profile from a prior interrupted session)._

```yaml
status: none           # none | in-progress | done
profileId:             # mobileofflineprofile GUID, captured at Step 5
profileName:           # human-readable name
mode:                  # create-new | extend
publishedOn:           # ISO8601 timestamp from Step 8 publish
gate1:                 # pending | approved | rejected   (table prereqs)
gate2:                 # pending | approved | rejected   (per-table row scope)
gate3:                 # pending | approved | rejected   (relationships + columns + sync)
tablesCount:           # number of mobileofflineprofileitem rows
associationsCount:     # number of mobileofflineprofileitemassociation rows
```

> **Resume contract:** if `status: in-progress` is left across sessions, `/setup-offline-profile` Step 1b asks the user to resume or start fresh. Never leave `in-progress` past a session unless deliberate.

## Native capabilities

| Capability | Module | Wrapper file | When added | Justification |
|---|---|---|---|---|
| _e.g. camera_ | _expo-camera_ | _src/native/camera.ts_ | _ISO date_ | _from plan_ |

## Connectors

| Connector kind | Service file | Connection ID | Owner | When added |
|---|---|---|---|---|
| dataverse | (multiple, see Data Model) | (built-in) | — | Step 8 of /create-mobile-app |

## Screens (live inventory)

| Route | Archetype | Source of truth | Last built by | Notes |
|---|---|---|---|---|
| `app/index.tsx` | Auth redirect | template | — | do not modify |
| `app/login.tsx` | Auth | template | — | do not modify unless an explicit auth skill requires it |
| `app/oauth-callback.tsx` | Auth | template | — | do not modify |
| `app/(app)/_layout.tsx` | Layout | template | — | |
| `app/(app)/home.tsx` | Tab-root | template / replaced | _<agent>_ | |

## Design system

| Aspect | Status |
|---|---|
| Tamagui config | default `@tamagui/config/v4` (no brand tokens) |
| Brand tokens | _<none, or list>_ |
| Theme variants | light, dark |
| `PortalProvider` | wired in template |
| `PowerAppsHostProvider` | wired in template (handles all connector routing) |

## Seeded sample data

_Written by `/add-sample-data`. Tracks records inserted so re-runs are idempotent and the user can clean up later if needed._

| Date | Table | Records inserted | First GUID | Last GUID |
|---|---|---|---|---|
| | | | | |

## Build history

| Date | Platform | Result | Notes |
|---|---|---|---|
| | ios / android / web | success / fail | |

## Known issues / follow-ups

_Append items here. Mark resolved with strikethrough rather than deleting._

- _e.g._ Connection `b8e4-...` for SharePoint expires 2026-07-15 — re-bind before then

## Plan history

| Date | Section edited | Reason |
|---|---|---|
| | Data Model / Native / Screens | |

---

## How agents should use this file

1. **At skill start:** Read the relevant section(s) before asking the user any question that this file might already answer.
2. **At skill end:** Append to the relevant section. Use ISO dates. One-line entries.
3. **Never delete:** If a decision was reversed, mark it as `~~superseded~~` rather than removing.
4. **Conflict policy:** If this file disagrees with what's actually in the project (e.g., file says SharePoint connection bound, but `/list-connections` shows none), trust the live state and update this file.
