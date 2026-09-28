# Connectivity Intent Ownership

During `/create-mobile-app`, wording such as offline, offline-first, limited or
intermittent connectivity, disconnected use, or no connectivity is operating
context only. Requirements discovery and planning continue from the user's
independently stated workflows, data, device capabilities, integrations, and
explicit connectivity-diagnostic features.

Planning and generation must not add offline-specific business tables, columns,
status fields, services, hooks, stores, queues, routes, or screens solely from
that connectivity wording. Offline storage and synchronization are runtime
concerns owned by the bundled offline package and native host.

After a Dataverse model is materialized, the create flow offers
`/setup-offline-profile`. That skill owns which Dataverse tables and columns
are available offline. The bundled `@microsoft/power-apps-native-offline`
package is consumed by `@microsoft/power-apps-native-host`: a valid
`offline-profile.json` activates local SQLite reads/writes, queued
synchronization, reconnect behavior, and the host-rendered status overlay.
Mobile Offline Profile setup therefore does not add duplicate generated
screens, routes, sync controls, queues, banners, or record-status UI.

An explicit product requirement for a custom connectivity diagnostic or an
app-owned sync queue is separate from Mobile Offline Profile setup and must be
named as such in the approved requirements and screen specifications.
