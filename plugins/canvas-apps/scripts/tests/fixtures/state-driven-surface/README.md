# State-driven surface visibility fixture

This fixture preserves the established generic plan shape: an Action Contract observer
declares `Surface.Visible=state predicate` inline rather than using a dedicated visibility
table. The surface's YAML uses a bounded equivalent predicate. Tests derive missing
evidence, missing/wrong YAML, child-only, always-visible, and navigation-only cases from
this passing baseline.

This fixture covers a declared create-to-delete continuation. The create event captures the
record returned by `Patch`, stores its immutable ID and continuation mode, and the delete event
targets that ID directly. Before removal it retains a same-ID snapshot for the receipt and for
canonical/destination absence checks after continuation state is cleared.

Tests introduce one defect at a time: missing evidence or clears, mutating cancellation,
manual rediscovery by display name or list position, event mismatch, missing snapshot receipt,
and incomplete absence proof. All results are static formula validation; runtime remains
`NOT RUN`.
