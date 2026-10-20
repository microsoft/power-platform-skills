# Changelog

All notable changes to the pcf plugin are documented here.

## [Unreleased] — 1.0.0 (preview)

First preview release: ships the `/pcf:pcf` skill, matrix-pinned templates and recipes, local gates, doctor and upgrade helpers, PAC deploy/package helpers, Dataverse verify/inventory scripts, offline evals, generated-project CI, model-driven app guidance, and Power Pages guidance for standard field controls only.

### Added

- Usage telemetry is enabled on model-apps' shared 1DS tenant, with `/pcf:telemetry on|off|status`, regional routing, base fields only and isolated offline coverage.
- Guided canvas app setup, including the **Power Apps component framework for canvas apps** environment setting, Studio import/updates, and manual API-limit review; canvas-specific automated checks remain out of scope.

### Changed

- The bundled SDK is the one model-apps 2.17.0 ships (power-platform-ux d603c799); it no longer carries the SDK's PCF control registration, which this plugin never called.

### Fixed

- The push receipt (`pcf-receipt.json`) no longer carries an access token that a refused confirmation read quoted, and every file the SDK writes into a push's workspace goes through the same output guard as model-apps' scripts.
