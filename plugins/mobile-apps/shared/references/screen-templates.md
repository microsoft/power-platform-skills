# Screen Template Index

Compatibility index for planning and older links. Builders read exactly one
archetype shard rather than this full index.

| Composition | Shard |
|---|---|
| list, queue, feed, discovery | [`screen-templates/list.md`](screen-templates/list.md) |
| detail, comparison, overview | [`screen-templates/detail.md`](screen-templates/detail.md) |
| create, edit, form, capture, workflow-step | [`screen-templates/form.md`](screen-templates/form.md) |
| schedule | [`screen-templates/schedule.md`](screen-templates/schedule.md) |
| conversation | [`screen-templates/conversation.md`](screen-templates/conversation.md) |
| map | [`screen-templates/map.md`](screen-templates/map.md) |
| confirmation, settings | [`screen-templates/supporting.md`](screen-templates/supporting.md) |

## Catalogue keys

Plans and build packs use keys, never pasted descriptions.

**List row styles**

- `flat-separator`: dense operational rows with separators.
- `compact-card`: grouped evidence with restrained surface contrast.
- `media-row`: thumbnail plus identity and decision context.
- `swipe-action-row`: one clear quick action with accessible fallback.

**Detail hero types**

- `identity-summary`: name/identifier, state, and next action.
- `media-evidence`: required photo/document evidence anchors the record.
- `status-band`: compact operational status and provenance.
- `metric-summary`: one schema-backed metric anchors the decision.
- `comparison-summary`: current/target or before/after evidence.

**Operational patterns**

- `scan-geofence-gate`: a dedicated full-screen scanner route with permission,
  location/context gate, guarded mutation, paused state, and focus reset. Home
  may launch it but must never use this pattern on Home or mount the viewfinder
  there.
- `review-signoff`: evidence, blockers, and approval consequence together.
- `queue-triage`: decision-supporting sort/filter plus rapid drill-down.
- `guided-capture`: ordered evidence capture with progress preservation.
- `exception-resolution`: problem, impact, allowed remedies, and audit outcome.
- `start-stop-work`: stateful timer/work session with explicit recovery.

**Calendar/control patterns**

- `calendar-agenda`: selected date plus bounded agenda.
- `date-time-picker`: platform-native date/time entry.
- `choice-select`: generated option constants, never invented values.
- `lookup-picker`: real lookup identity plus formatted label.
- `filter-chip-row`: compact horizontal controls for four or more filters.

## Planner rule

Every user-facing screen declares an archetype/composition and only the keys it
uses. If a needed reusable pattern has no key, add one here and put its detailed
implementation guidance in the matching shard. Product-specific hierarchy
belongs in the compiled build pack, not this catalogue.
