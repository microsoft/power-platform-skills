# Home Composition Registry

Home composition is selected independently from archetype and visual personality. The same business workflow can be expressed through different compositions.

## Composition Keys

### `asset-command`

Use when one asset/object and its lifecycle drive the next decision.

Required pieces: object/media hero, health/lifecycle state, one integrated next action, at most two supporting indicators, next section preview, related work rail.

### `media-command`

Use when media or a physical product/place is the primary orientation signal.

Required pieces: media occupying 35-55% of first viewport, overlaid or adjacent identity, one integrated CTA, maximum two supporting facts, visible hint of next content.

### `object-command`

Use when one current appointment, workout, account, course, booking, or case anchors the experience.

Required pieces: current object hero, progress/urgency, one next action, compact supporting context.

### `relationship-command`

Use for CRM/clienteling and people/account workflows.

Required pieces: account/contact identity, relationship health/cadence, next best action, recent interaction, pipeline/opportunity context.

### `data-command`

Use when one balance, score, risk, or operational metric drives action.

Required pieces: one dominant metric, trend/threshold context, one due/exception item, recent activity, one action. Do not lead with a grid of equal metrics.

### `scan-command`

Use when scanning is the primary repeated entry point.

Required pieces: scanner/finder target, manual fallback, last/recent scan context, clear no-match state. Do not duplicate the same primary scan action in both a persistent dock and a dedicated center tab.

### `queue-first`

Use when prioritizing a small number of urgent assignments/exceptions is the main job.

Required pieces: scope/context, prioritized queue, severity/urgency signal, filter recovery, visible next action. Summary counts are secondary.

### `timeline-first`

Use when dates, appointments, maintenance windows, dispatch, or deadlines dominate.

Required pieces: current date/window, overdue/today/upcoming groups, one current item, calendar/timeline control appropriate to the task.

### `narrative-home`

Use when onboarding, discovery, brand story, or guided content should establish context before operations.

Required pieces: strong visual/type thesis, one primary offer/action, one supporting narrative, visible next section. Operational state remains accessible but does not dominate the first viewport.

### `personalized-feed`

Use for recommendations, learning, consumer fitness, content, or relationship activity.

Required pieces: personalized next item, horizontal or chronological feed, progress/context, one resume/start action.

### `operational-dashboard`

Use only when users genuinely compare several metrics and queues at once.

Required pieces: context header, one current/next object, 2-4 summary metrics, 3-5 rows, one action. It is not the universal default.

## First-Viewport Rules

Every Home spec must declare:

- Signature component name.
- Viewport share between 0.20 and 0.65.
- Minimum height in dp.
- Media requirement.
- Headline minimum in sp.
- Maximum supporting metrics.
- Primary-action location.
- Whether the next section must be visible.
- Whether an action may duplicate a tab destination.

## Selection Guidance

Archetypes suggest candidates, never mandates. Examples:

- Asset maintenance + utility: `queue-first` or `operational-dashboard`.
- Asset maintenance + premium: `asset-command` or `media-command`.
- Field inspection + utility: `queue-first`.
- Field inspection + premium: `asset-command` with assignment/evidence media.
- Retail + premium: `media-command` or `narrative-home`.
- CRM + polished operational: `relationship-command`.

## Cross-Tab Variation

Screen planning must output a silhouette for every tab root. At least one of these must differ across neighboring tabs: dominant component, scroll axis, content grouping, primary control, or media usage. Renaming the same `header + chips + bordered rows` layout does not count as variation.
