# Schedule and Calendar Screens

- Use a calendar library only when the approved dependency contract names an
  exact compatible version; otherwise use native date controls and a list.
- The selected date, availability/state legend, and next action are visible
  without scrolling.
- A calendar selection updates the bounded agenda below; it does not trigger
  hidden mutations.
- Use locale-aware labels and explicit timezone context when it affects users.
- Empty dates explain that no work/appointments are scheduled and offer the
  relevant create or date-change action.
- Large data sets query a bounded date range instead of loading all records.
- Touch targets, contrast, and selected/today/focus states must be distinct
  without relying on color alone.
