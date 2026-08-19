# Product Archetype Registry

The archetype describes the app's primary repeated user loop. It does not determine visual personality.

## Classification Method

1. Extract the user's primary objects, decisions, and repeated loop.
2. Match the loop against the registry.
3. Record secondary behaviors as workflow capabilities.
4. Cite evidence and confidence in `## Product Experience`.
5. Never classify from one keyword when the overall loop points elsewhere.

## Archetypes

### `asset-maintenance-cmms`

- Primary loop: identify asset -> assess health -> plan/perform maintenance -> resolve issue -> verify return to service.
- Signals: equipment lifecycle, preventive maintenance, work history, downtime, repairs, parts, warranty, service intervals.
- Common capabilities: QR lookup, inspections, evidence, issue triage, repair tracking, maintenance scheduling, warranty management.
- Supporting inspection does not make this `field-inspection`.
- Typical Home choices: `asset-command`, `queue-first`, `timeline-first`, `operational-dashboard`.
- Signature components: AssetCommandHero, MaintenanceDueRail, RepairProgress, WarrantyCoverage.

### `field-inspection`

- Primary loop: receive assignment -> execute ordered checks -> capture evidence/defects -> sign off.
- Signals: checklist completion, zones, compliance, evidence requirements, site visit, inspection sign-off.
- Common capabilities: offline work, camera evidence, location, ordered stepper, supervisor override.
- Typical Home choices: `queue-first`, `operational-dashboard`, `timeline-first`.
- Signature components: AssignmentHero, ChecklistProgress, EvidenceCapture, DefectSeverity.

### `field-service-dispatch`

- Primary loop: accept job -> travel/arrive -> diagnose/service -> capture labor/parts -> hand off/close.
- Signals: dispatch, route, technician assignment, travel status, ETA, work timer, customer sign-off.
- Typical Home choices: `queue-first`, `timeline-first`, `operational-dashboard`.
- Signature components: DispatchHero, JobTimeline, WorkTimer, SignoffSummary.

### `facilities-operations`

- Primary loop: monitor facilities -> identify risk/request -> coordinate work -> verify building/service state.
- Signals: sites, buildings, rooms, utilities, compliance schedules, vendor work, facility availability.
- Typical Home choices: `site-command`, `queue-first`, `operational-dashboard`.

### `inventory-scan-first`

- Primary loop: scan item/location -> compare expected state -> count/move/receive -> resolve variance.
- Signals: SKU, bin, aisle, warehouse, barcode, cycle count, transfer, receiving, variance.
- Typical Home choices: `scan-command`, `queue-first`, `operational-dashboard`.
- Signature components: ScanFirstLookup, BinContext, VarianceAction, TransferSummary.

### `crm-relationship-workspace`

- Primary loop: understand relationship -> decide next action -> interact -> update cadence/opportunity.
- Signals: account, contact, opportunity, pipeline, follow-up, interaction, relationship health.
- Typical Home choices: `relationship-command`, `queue-first`, `personalized-feed`.

### `retail-catalog`

- Primary loop: discover/browse products -> compare/select -> basket/order -> fulfillment.
- Signals: catalog, product, collection, price, availability, basket, order, promotion.
- Typical Home choices: `media-command`, `narrative-home`, `personalized-feed`.
- Media is normally required.

### `healthcare-wellness`

- Primary loop: understand current care/wellness state -> complete next task/check-in -> review progress -> follow up.
- Signals: patient, appointment, care plan, measurement, habit, wellness goal, clinical follow-up.
- Typical Home choices: `object-command`, `timeline-first`, `personalized-feed`.

### `consumer-fitness`

- Primary loop: choose/resume workout -> train -> record performance -> recover/track progress.
- Signals: workout, exercise, set, rep, training plan, streak, personal record, recovery.
- Typical Home choices: `media-command`, `object-command`, `personalized-feed`.

### `learning-coaching`

- Primary loop: resume lesson/practice -> complete activity -> receive feedback -> progress.
- Signals: course, lesson, quiz, coaching, learning path, certification, streak.
- Typical Home choices: `narrative-home`, `object-command`, `personalized-feed`.

### `finance-operations`

- Primary loop: understand balance/risk -> review activity/exception -> approve/reconcile/act.
- Signals: account, ledger, transaction, invoice, budget, reimbursement, approval, reconciliation.
- Typical Home choices: `data-command`, `queue-first`, `timeline-first`.

### `scheduling-booking`

- Primary loop: discover availability -> choose slot/resource -> book/manage -> attend/complete.
- Signals: calendar, appointment, reservation, booking, availability, recurring schedule.
- Typical Home choices: `timeline-first`, `object-command`, `personalized-feed`.

### `admin-operations`

- Primary loop: monitor queues/records -> process exceptions -> manage configuration/access.
- Signals: admin, back office, batch operations, system settings, access management.
- Typical Home choices: `operational-dashboard`, `queue-first`.

### `custom`

Use only when no registry archetype explains the primary loop. The planner must describe the repeated loop and propose original signature components.

## Capability Vocabulary

Use reusable workflow slugs rather than creating new archetypes for every feature:

`qr-lookup`, `barcode-scan`, `camera-evidence`, `ordered-checklist`, `issue-triage`, `repair-tracking`, `preventive-maintenance`, `warranty-management`, `calendar-scheduling`, `offline-work`, `geolocation`, `signature-capture`, `document-management`, `approval`, `relationship-history`, `catalog-browse`, `basket-order`, `progress-tracking`, `notifications`, `batch-actions`.
