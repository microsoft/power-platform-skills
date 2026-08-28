# Map Composition

Use when location is the primary decision surface, not decorative context.

## Required structure

- Keep map and fallback list driven by the same bounded result set.
- Show the current selection, status, distance/context, and next action outside
  the map marker so the decision remains accessible.
- Provide loading, permission-denied, unavailable-location, empty-region, and
  retry states without trapping the user on a blank map.
- Use clustering or bounded viewport queries for dense result sets.
- Preserve a non-map route/list path for screen readers and environments where
  the map provider is unavailable.
- Never imply live tracking, route optimization, eligibility, or geofence
  success unless the approved capability and schema provide that evidence.

## Interaction

Selecting a marker updates an accessible summary card. The summary owns
navigation and primary actions; marker-only gestures are not the sole path.
Recenter and location-permission controls need labels, roles, and minimum touch
targets.
