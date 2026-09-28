# Offline Profile Schema (Dataverse)

Canonical field map for the three Dataverse entities that back a Mobile Offline Profile, plus the per-table prerequisites on `EntityMetadata`. Source of truth — sourced from the Microsoft Learn entity references; cross-check before changing any POST body.

External references:
- [`mobileofflineprofile`](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/mobileofflineprofile)
- [`mobileofflineprofileitem`](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/mobileofflineprofileitem)
- [`mobileofflineprofileitemassociation`](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/mobileofflineprofileitemassociation)

---

## Layer 1 — Per-table prerequisites (`EntityMetadata`)

Before a table can be added to a profile, both flags must be set on its `EntityDefinition`:

| Field | Type | UI label (maker portal) | Required value |
|---|---|---|---|
| `IsAvailableOffline` | Boolean | "Can be taken offline" (Image 4) | `true` |
| `ChangeTrackingEnabled` | Boolean | "Track changes" (Image 4) | `true` |

Both are set by `/enable-tables-offline` via PUT to `EntityDefinitions(LogicalName='<table>')` with the `MSCRM.MergeLabels=true` header (otherwise display labels get wiped). See [dataverse-offline-api.md](./dataverse-offline-api.md) §1 for the PUT recipe.

Tables with `IsCustomizable.Value=false` cannot be modified outside a managed-solution patch — the skill skips them and surfaces as `DONE_WITH_CONCERNS`.

---

## Layer 2 — Profile shell (`mobileofflineprofile`)

EntitySet: `mobileofflineprofiles` — `OrganizationOwned`, primary id `mobileofflineprofileid`.

### Writable fields (the only ones the skill POSTs)

| Field | Type | Max | UI label | Notes |
|---|---|---|---|---|
| `name` | String (Text) | 255 | "Name" (Image 3) | Required |
| `description` | String (Memo/TextArea) | 2000 | "Description" (Image 3) | Optional |

### Read-only state fields the skill reads

| Field | Type | Choices | Notes |
|---|---|---|---|
| `componentstate` | Picklist | 0=Published, 1=Unpublished, 2=Deleted, 3=Deleted Unpublished | Profile must be `0` (Published) to be honored at sync time |
| `publishedon` | DateTime | — | Set by `PublishAllXml`; null until first publish |
| `isvalidated` | Boolean | — | Set by `Validate` action; profile sync ignores invalid profiles |
| `mobileofflineprofileid` | Uniqueidentifier | — | Captured from `OData-EntityId` response header on create |

### Important: things NOT on this entity

The Image 2 panel mixes profile fields with **app-level** settings. These are NOT on `mobileofflineprofile`:

| Image 2 control | Where it actually lives |
|---|---|
| "Can be used offline" toggle | App-level — for code apps, written to `offline-profile.json` `appConfig.enabled` |
| "Select offline profile" dropdown | App-level — `offline-profile.json` top-level `profileId` |
| "Data row limit" (2000 default) | App-level — `offline-profile.json` `appConfig.serverRowLimit` (canvas/non-Dataverse delegation rows) |
| "Debug published app" | App-level — out of v0 scope |

> **Why `offline-profile.json` and not `power.config.json`?** `power.config.json` is generated and owned by `npx power-apps init` — the upstream tool controls its schema, and adding custom fields there risks being overwritten on re-init or breaking when the upstream schema changes. `offline-profile.json` is fully owned by `/setup-offline-profile`, so app-level offline settings live there safely.

---

## Layer 3 — Per-table item (`mobileofflineprofileitem`)

EntitySet: `mobileofflineprofileitems` — `OrganizationOwned`, primary id `mobileofflineprofileitemid`. One row per table in the profile.

### Writable fields

| Field | Type | Range / choices | UI label | Notes |
|---|---|---|---|---|
| `name` | String | 255 | (auto from table) | Required |
| `regardingobjectid_mobileofflineprofile@odata.bind` | Lookup | — | (implicit) | Required — binds to parent `/mobileofflineprofiles(<id>)` |
| `selectedentitytypecode` | EntityName | — | (table column header) | Required — table's logical name |
| `recorddistributioncriteria` | Picklist | 0=Download related data only, 1=All records, 2=Other data filter, 3=Custom data filter | Image 5 radios | See mapping table below |
| `recordsownedbyme` | Boolean | — | "User's rows" (Image 6) | Only meaningful with `recorddistributioncriteria=2` |
| `recordsownedbymyteam` | Boolean | — | "Team rows" (Image 6) | Only meaningful with `recorddistributioncriteria=2` |
| `recordsownedbymybusinessunit` | Boolean | — | "Business unit rows" (Image 6) | Only meaningful with `recorddistributioncriteria=2` |
| `getrelatedentityrecords` | Boolean | — | (implicit) | Default `true` — required for relationship inclusion to work |
| `syncintervalinminutes` | Integer | 5–1440 | "Sync frequency" (Image 5/6) | Default `10` (matches maker portal) |
| `selectedcolumns` | Memo | 100,000 chars | "Filter columns (X/Y)" (Image 5/6) | JSON string. See "selectedcolumns shape" below. |
| `profileitemrule` | Lookup → `savedquery` | — | (Custom mode only) | Required only for Custom (`recorddistributioncriteria=3`). v0 does NOT support this. |
| `canbefollowed` | Boolean | — | (not user-facing) | Default `false` |
| `isvisibleingrid` | Boolean | — | (internal — controls subgrid visibility) | Default `true`; do not set explicitly |

### Image 5/6 radio → `recorddistributioncriteria` mapping

| Image radio | Picklist value | Required sub-flags |
|---|---|---|
| "Related rows only" | `0` | none |
| "All rows" | `1` | none |
| "Organization rows" | `2` | at least one of `recordsownedbyme` / `recordsownedbymyteam` / `recordsownedbymybusinessunit` |
| "Custom" | `3` | requires `profileitemrule` → savedquery. **v0: NOT SUPPORTED.** |

### Ownership rule

For `OrganizationOwned` tables, only `recorddistributioncriteria=1` (All records) makes sense — the per-user filters are meaningless. The maker portal disables the Organization radio for these tables; the architect agent encodes the same rule.

### `selectedcolumns` shape

**⚠️ Empirical — verified by inspecting maker-portal-created profiles.** Documented as memo (max 100,000 chars), but the entity reference does not pin the format. Confirmed shape:

```json
{
  "Columns": [
    "cr123_title",
    "cr123_body",
    "cr123_visitid",
    "modifiedon",
    "createdon",
    "statecode"
  ]
}
```

Stored as a stringified JSON in the memo. Column names are **lowercase logical names** (not display names, not schema names). System-required columns (primary id, primary name, `statecode`, `statuscode`, `modifiedon`, `createdon`) should always be in the list — omitting them may cause sync failures or display issues. The architect agent's "always-include" set covers these.

### Read-only state fields

| Field | Type | Notes |
|---|---|---|
| `mobileofflineprofileitemid` | Uniqueidentifier | Captured from `OData-EntityId` on create |
| `componentstate` | Picklist | Same enum as profile shell |
| `entityobjecttypecode` | Integer | Server-resolved from `selectedentitytypecode` |
| `isvalidated` | Boolean | Set by `Validate` |
| `publishedon` | DateTime | Set by `PublishAllXml` |

---

## Layer 4 — Per-relationship inclusion (`mobileofflineprofileitemassociation`)

EntitySet: `mobileofflineprofileitemassociations` — `OrganizationOwned`. One row per relationship included for a profile item. Maps to Image 5's "Relationships (X/Y)" tree and "Images (0/1)" tree.

### Writable fields

| Field | Type | Notes |
|---|---|---|
| `name` | String (200) | Required. Convention: `<profileItemName>_<relationshipName>` |
| `mobileofflineprofileitemid_mobileofflineprofileitem@odata.bind` | Lookup | Required — binds to parent profile item |
| `relationshipid` | Uniqueidentifier | Required — the relationship's `MetadataId` (resolved via `EntityDefinitions(LogicalName='<x>')/ManyToOneRelationships`) |
| `relationshipname` | String (200) | Schema name of the relationship (e.g. `cr123_note_visit`) |
| `relationshipdisplayname` | String (200) | Display name (often duplicate of schema name) |
| `selectedrelationshipsschema` | Picklist | Server-defined per-table picklist. Resolved at runtime — see API recipes §4. |

### Relationship lookup pattern

For a parent table, two queries cover both relationship directions:

```text
GET /EntityDefinitions(LogicalName='<table>')/ManyToOneRelationships
GET /EntityDefinitions(LogicalName='<table>')/OneToManyRelationships
```

Each returns `MetadataId`, `SchemaName`, `ReferencingEntity`, `ReferencedEntity`, etc. Use `MetadataId` as `relationshipid` and `SchemaName` as `relationshipname`.

**For file/image columns** (Image 5 "Images (0/1)"): these are exposed as attributes of type `Image` or `File`, not as separate relationships. The maker portal renders them in a separate tree but the underlying storage is still a `mobileofflineprofileitemassociation` row. The architect agent enumerates them via `EntityDefinitions(LogicalName='<x>')/Attributes?$filter=AttributeType eq 'Image' or AttributeType eq 'File'`.

### Read-only state fields

Same shape as the profile/item entities — `componentstate`, `isvalidated`, `publishedon`, `mobileofflineprofileitemassociationid`.

---

## Layer 5 — Membership entities (assignment)

Out of v0.1 scope (`/assign-offline-profile` lands in v0.3). Documented here for the v0.3 implementer:

| Entity | Purpose | Key fields |
|---|---|---|
| `usermobileofflineprofilemembership` | Assign one user to a profile | `mobileofflineprofileid`, `systemuserid` |
| `teammobileofflineprofilemembership` | Assign a team to a profile (cascades to members) | `mobileofflineprofileid`, `teamid` |

A user MAY be assigned to multiple profiles via separate membership rows. The Dataverse runtime resolves the active profile per device/session based on org-level rules outside this skill's scope.

---

## Persistence in the user's project

The skill snapshots the created profile into `offline-profile.json` at the project root, mirroring the shape of `.datamodel-manifest.json`. This file is the **read source** for `/edit-offline-profile`, `/preview-offline-scope`, and `/add-table-to-offline-profile`.

Shape:

```json
{
  "profileId": "<guid>",
  "name": "...",
  "publishedOn": "<iso8601>",
  "mode": "create-new" | "extend",
  "tables": [
    {
      "logicalName": "cr123_note",
      "itemId": "<guid>",
      "recordDistributionCriteria": 2,
      "recordsOwnedByMe": true,
      "recordsOwnedByMyTeam": false,
      "recordsOwnedByMyBusinessUnit": false,
      "syncIntervalInMinutes": 10,
      "selectedColumns": ["cr123_title", "cr123_body", "..."],
      "schemaColumns": ["cr123_title", "cr123_body", "cr123_internalnotes", "..."],
      "relationships": [
        {
          "associationId": "<guid>",
          "relationshipName": "cr123_note_visit",
          "relationshipId": "<guid>"
        }
      ]
    }
  ]
}
```

`selectedColumns` is the curated set the runtime syncs; `schemaColumns` is the **schema-reconciliation baseline** — every schema column logical name the table had (from `.datamodel-manifest.json`) when this item was last reconciled, including columns deliberately left out of `selectedColumns`. `scripts/offline-profile-delta.js` diffs later manifest columns against `schemaColumns` (not `selectedColumns`) so it only surfaces *genuinely new* columns. See [offline-profile-reconciliation.md](./offline-profile-reconciliation.md).

App-level offline config (previously written into `power.config.json` as an `offline` block) now lives inside the same `offline-profile.json` file under an `appConfig` key:

```json
{
  "profileId": "<guid>",
  "appConfig": {
    "enabled": true,
    "serverRowLimit": 2000
  }
}
```

`power.config.json` is intentionally NOT touched by the offline skill — it stays owned by `npx power-apps init`.

---

## Empirical checks to rerun when Dataverse behavior changes

1. **`selectedcolumns` JSON shape** — sample one profile created by maker portal in a dev environment, dump the field, confirm the `{"Columns": [...]}` structure. If different, update §3 above.
2. **`selectedrelationshipsschema` picklist values** — these are dynamically resolved per table. Document discovery query in [dataverse-offline-api.md](./dataverse-offline-api.md) once an example is captured.
3. **Validate request body shape** — the `Validate` message exists per the messages table on the entity reference, but the exact request body is undocumented. May need empirical capture if validation becomes mandatory.
