# Shopping contract fixture

Authored expected plan fragment, not captured AI output or a running app. Host auth/Profile rows are omitted to keep this fixture focused on business surfaces. Service names below are fixture contracts, not discovered tenant metadata.

Brief: Shoppers browse groceries, change quantities in a basket, and place a collection order. Show the created order number; a failed order save must retain the basket. Categories, images, stock projections, and order lines support the purchase, not separate management tasks.

## Screens

### Screen Map

| Screen | Route | File | Presentation | Purpose | Data | Native | Source | ID | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| Shop | /(app)/home | app/(app)/home.tsx | default | Discover available groceries | ProductsService.getAll | none | replace template | shop | Shopper compares product, price and availability before selecting |
| Basket | /(app)/basket | app/(app)/basket.tsx | default | Review quantities and place order | OrdersService.create | none | new | basket | Shopper checks quantities and total before committing purchase |
| Order confirmation | /(app)/orders/[id] | app/(app)/orders/[id].tsx | default | Read created order and collection information | OrdersService.get | none | new | order-confirmation | Shopper sees the recorded order rather than an unverified success toast |

### Primary journeys

| Journey | Actor | Task | Entry | Decision | Action + operation | Committed outcome | Next destination | Recovery | Screen IDs |
|---|---|---|---|---|---|---|---|---|---|
| purchase | Shopper | Place a collection order | shop: authenticated Home | Confirm basket quantities and total | Place order → OrdersService.create(basket) | OrdersService.create returns persisted order ID | order-confirmation | Retain basket on failed save; retry there; continue shopping from confirmation | shop, basket, order-confirmation |

### Preview selection

| Screen ID | Rationale | State |
|---|---|---|
| basket | Shows quantity/price decision and labelled commit action | selected basket with editable quantities and total |
| order-confirmation | Shows committed result and next useful destination | saved order number and collection instructions |
| shop | Shows discovery context and evidence for comparison | active collection across all categories, with varied price and availability |

### Navigation Contracts

| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller | Source action / outcome |
|---|---|---|---|---|---|
| /(app)/home | — | — | navigate | root | order-confirmation: continue shopping |
| /(app)/basket | — | — | navigate | shop | shop: review basket |
| /(app)/orders/[id] | id: string | — | push | shop fallback | basket: after order commit |

### Per-Screen Specs

Layout suggestions are provisional until visual approval; operations, data and entry scope remain fixed.

#### Shop (/(app)/home)
- **Screen ID** — shop
- **Archetype** — List
- **Layout delta** — First viewport: collection identity, search/category scope, then product images, names, prices and availability with reachable basket access; Below fold: remaining products through cursor paging.
- **Data** — Initial scope: active collection across all categories; selected filters persist when returning from the basket.
- **UX contract** — Compare products and add an available quantity; do not create an order before Place order.

#### Basket (/(app)/basket)
- **Screen ID** — basket
- **Archetype** — Form
- **Layout delta** — First viewport: basket identity, product identity, local quantity controls and line totals; Below fold: remaining lines with order total beside Place order, reachable by scrolling.
- **Data** — Initial scope: selected basket with editable quantities and total.
- **UX contract** — Confirm quantities; Place order calls OrdersService.create; success requires returned order ID; navigate to order-confirmation; failure retains basket for retry.
- **Control patterns** — line-item-stepper-row; min 0, step 1, stock-bound max; local draft until Place order.
- **State delta** — unavailable item explains why order is blocked; save error keeps quantities; no fabricated checkout success.

#### Order confirmation (/(app)/orders/[id])
- **Screen ID** — order-confirmation
- **Archetype** — Detail
- **Layout delta** — First viewport: saved order number, collection instructions and continue-shopping action; Below fold: saved line-item details, reached by scrolling.
- **Data** — Initial scope: saved order number and collection instructions for the order created from the selected basket.
