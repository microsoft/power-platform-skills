# Connectivity Intent Ownership

During `/create-mobile-app`, wording such as offline, offline-first, limited or
intermittent connectivity, disconnected use, or no connectivity is operating
context only. Requirements discovery and planning continue from the user's
independently stated workflows, data, device capabilities, integrations, and
explicit connectivity-diagnostic features.

After a Dataverse model is materialized, the create flow offers
`/setup-offline-profile`. That skill owns which Dataverse tables and columns
are available offline. Mobile Offline Profile setup does not add generated
screens, routes, sync controls, queues, banners, or record-status UI.

An explicit product requirement for a custom connectivity diagnostic or an
app-owned sync queue is separate from Mobile Offline Profile setup and must be
named as such in the approved requirements and screen specifications.
