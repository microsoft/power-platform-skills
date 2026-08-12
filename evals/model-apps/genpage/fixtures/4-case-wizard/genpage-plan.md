# Genpage Plan

## User Requirements

Build a multi-step wizard form for creating new Case records. Step 1: customer
info. Step 2: case details (title, priority, category). Step 3: review and
submit. Use the incident and contact tables.

## Working Directory

new-case-wizard/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Service Hub (22222222-1111-2222-3333-444444444444)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| New Case Wizard | page.tsx | 3-step wizard for creating contact + incident | incident, contact |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

incident, contact

## Connector Bindings

No connector bindings.

## Design Preferences

- 3 steps: customer info → case details → review
- Next / Back navigation, disabled at boundaries
- Submit creates a contact row then an incident row referencing it
- aria-label on every form input

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| New Case Wizard | 2-wizard-multi-step.tsx | wizard pattern reference |
## Per-Page Specifications

### New Case Wizard


- **File:** page.tsx
- **Purpose:** 3-step wizard for creating contact + incident
- **Entities:** incident, contact
- **Needs caching:** false
- **Key Features:** Three-step create form for customer info, case details, and review before submit.
- **Components:** Input, Dropdown, Button, Field, MessageBar, Text, and wizard progress indicators from Fluent UI V9.
- **Layout:** Single-card stepper layout with review summary; responsive vertical stacking on narrow screens.
- **Data Binding:** No initial fetch; on submit create contact then incident with the contact bind.
- **Interactions:** Next/Back step navigation, validation before advancing, and submit via dataApi.createRow.
- File: page.tsx
- Entities: contact (create), incident (create with @odata.bind to contact)
- Components: Fluent UI V9 Input, Dropdown, Button, Field, MessageBar
- State: local `step` (1/2/3) + form fields
- Submit: dataApi.createRow('contact', ...) then dataApi.createRow('incident', { ..., 'customerid_contact@odata.bind': '/contacts(<id>)' })
- Icons: PersonRegular, DocumentRegular, CheckmarkCircleRegular (unsized)
