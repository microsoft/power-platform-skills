# Inspection contract fixture

Authored expected plan fragment, not captured AI output or a running app. Host auth/Profile rows are omitted. Service/module names describe the assumed approved fixture capability and data contracts, not a live tenant test.

Brief: Inspectors select assigned site checks, mark checklist responses, and capture a photo for each failed check. Submit only after required evidence uploads complete. Failed uploads retain the local capture for retry. Camera is explicitly required; location, signature and background/offline sync are not. Sites, checklist definitions, responses and attachments are supporting data.

## Screens

### Screen Map

| Screen | Route | File | Presentation | Purpose | Data | Native | Source | ID | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| Assigned checks | /(app)/home | app/(app)/home.tsx | default | Choose an assigned inspection | InspectionsService.getAll | none | replace template | assigned-checks | Inspector picks work from a direct assignment list |
| Checklist | /(app)/inspections/[id] | app/(app)/inspections/[id]/index.tsx | default | Record responses and required evidence | ResponsesService.update; EvidenceService.create | expo-camera | new | checklist | Inspector works through checks and captures failures in place |
| Review submission | /(app)/inspections/[id]/review | app/(app)/inspections/[id]/review.tsx | default | Verify evidence and submit | InspectionsService.update | none | new | inspection-review | Inspector checks retained evidence and submits completed work |

### Primary journeys

| Journey | Actor | Task | Entry | Decision | Action + operation | Committed outcome | Next destination | Recovery | Screen IDs |
|---|---|---|---|---|---|---|---|---|---|
| submit-inspection | Inspector | Complete assigned checklist with evidence | assigned-checks: selected assignment | Mark pass/fail; attach required photo; confirm submission | Submit inspection → InspectionsService.update after required evidence uploads | Responses and required evidence retained; InspectionsService.update records submitted state | assigned-checks | Keep local capture/draft after upload failure; retry upload before submit; camera denial explains required evidence blocker | assigned-checks, checklist, inspection-review |

### Preview selection

| Screen ID | Rationale | State |
|---|---|---|
| checklist | Shows evidence capture tied to failed checks | failed response with required photo capture |
| inspection-review | Distinguishes local evidence from committed submission | upload failed, local capture retained, Submit disabled with reason |

### Navigation Contracts

| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller | Source action / outcome |
|---|---|---|---|---|---|
| /(app)/home | — | — | navigate | root | inspection-review: successful submission |
| /(app)/inspections/[id] | id: string | — | push | assigned-checks fallback | assigned-checks: open checklist |
| /(app)/inspections/[id]/review | id: string | — | push | checklist fallback | checklist: review completed responses |

### Per-Screen Specs

#### Review submission (/(app)/inspections/[id]/review)
- **Screen ID** — inspection-review
- **Archetype** — Form
- **Layout delta** — response summary + per-evidence retained/upload status → Submit inspection with blockers.
- **UX contract** — Submit only when responses and required uploads are retained; InspectionsService.update commits submitted state; success returns to assigned-checks; failed upload retains local capture for retry, not a successful submission.
- **Artifact persistence** — child Evidence table through verified EvidenceService upload contract; local capture is intermediate, not retained evidence.
- **State delta** — uploadFailed offers retry; permissionDenied explains missing required camera evidence without bypass; no invented offline queue.
- **Idempotency guards** — pending submission disables CTA; retries reuse retained evidence IDs.
