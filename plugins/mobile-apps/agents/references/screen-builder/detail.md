# Details, review, and decision screens

Load only for an assigned detail/review screen. The actor's next decision determines
hierarchy: identity/context, relevant status/blockers/deadline, and supported next
action before secondary history when the journey calls for it. A read-only detail
does not require a bottom CTA, edit control, hero image, or destructive action.

- Normalize route IDs and return a recoverable invalid-link state before reads.
  Unwrap successful generated query results; request failure is not “record not found”.
- Render friendly retry for load failure and a return path for deleted/missing records.
  Loading retains the same outer geometry and essential navigation as content.
- Related fields use the planned formatted lookup/bounded read/projection contract;
  never run per-row secondary queries to fill a detail section.
- Display dates with shared formatters and choices with generated labels; preserve
  readable large text and avoid truncating essential decisions, amounts, or warnings.
- Approved edit navigation uses the Navigation Contracts route/params, not an invented
  `/[id]/edit` route. Guard repeated taps until the screen regains focus.
- Approved delete requires confirmation, checked service success, pending feedback,
  a synchronous in-flight ref, query invalidation, and exactly one post-delete action.
  Failure keeps the dialog/screen recoverable. Do not auto-close a destructive dialog
  before its request outcome or leave Edit enabled during a delete.
- For review/approval, implement the named business operation and prerequisites;
  changing a badge locally is not completing the decision.

Read `shared/samples/screen-detail.tsx` only for unresolved query/action API idioms.
