# Design Direction Catalogue

This is the single registry and routing source for `/design-system`. Every
`direction-*.md` file in this directory appears exactly once below. Skills,
generators, and tests read this table; do not maintain routing carve-outs
elsewhere.

## Registered Catalogue

`Route clauses` are semicolon-separated alternatives. Within one clause, `&`
means every group must match; `|` separates terms in a group. Matching is
case-insensitive against the confirmed brief, app name, users, and purpose.
Highest priority wins. `polished-inspection` is the default when no clause
matches.

| Slug | Source | Priority | Route clauses | Summary |
|---|---|---:|---|---|
| `carrier-consumer` | `direction-carrier-consumer.md` | 100 | `airline\|aviation\|flight\|carrier\|cabin\|onboard & retail\|shop\|shopping\|store\|product\|catalog\|catalogue\|buy\|purchase\|duty-free\|duty free\|merchandise`; `passenger & retail\|shop\|shopping\|product\|catalog\|buy\|purchase` | Passenger-facing carrier retail and commerce |
| `airline` | `direction-airline.md` | 90 | `airline\|aviation\|flight\|aircraft\|carrier & crew\|pilot\|ground ops\|ground operations\|turnaround\|tarmac\|dispatch\|maintenance\|safety\|operations`; `airline operations`; `flight operations`; `airline\|aviation\|flight\|aircraft\|carrier` | Crew, ground, and operational aviation |
| `inspection` | `direction-inspection.md` | 80 | `outdoor\|glove\|sunlight\|rugged & inspection\|field\|maintenance\|route\|dispatch`; `field operations`; `field service` | High-contrast hands-busy field work |
| `product` | `direction-product.md` | 60 | `consumer\|customer\|premium\|wellness\|learning\|engagement\|retention\|marketplace\|commerce\|retail` | Consumer and experience-led products |
| `saas` | `direction-saas.md` | 50 | `internal\|employee\|approval\|helpdesk\|expense\|request\|tracker\|dashboard\|report\|back office` | Familiar enterprise and internal tools |
| `polished-inspection` | `direction-polished-inspection.md` | 0 | - | Demo-friendly enterprise operations default |

## Selection Rules

1. An explicit `--direction <slug>` wins when the slug is registered.
2. Otherwise evaluate every route clause and choose the highest-priority match.
3. Passenger commerce outranks operational aviation when a brief serves both
   passengers and cabin retail staff. The product is retail-first, so route it
   to `carrier-consumer`.
4. Crew, pilot, turnaround, tarmac, maintenance, safety, and ground-operation
   workflows route to `airline` unless a higher-priority passenger-commerce
   clause also matches.
5. When no clause matches, use `polished-inspection`; never infer from a
   directory filename or a separate skill-local keyword table.

## Bundle Contract

Each source file supplies every key in `design-bundle-schema.md`. A direction
locks surface, palette, typography, row treatment, density, motion, status,
empty state, primary action, and copy tone as one coherent choice. Per-screen
overrides remain explicit.

## Hybrid Handling

A user may combine named dimensions after routing, for example:

```text
Hybrid = carrier-consumer.{surface,palette,typography}
       + airline.{density,status_saturation}
```

Record each overridden dimension and source in `## Design Direction`. Hybrid is
a user decision, never an automatic fallback.

## When Routing Is Bypassed

Use supplied brand tokens directly when the user provides a complete brand book
or design system. A one-screen utility can use the routed default without
opening a picker. An explicit Microsoft-default request resolves to `saas`.
