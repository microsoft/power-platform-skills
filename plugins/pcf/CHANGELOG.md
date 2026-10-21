# Changelog

All notable changes to the pcf plugin are documented here.

## [Unreleased] — 1.0.0 (preview)

First preview release: ships the `/pcf:pcf` skill, matrix-pinned templates and recipes, local gates, doctor and upgrade helpers, PAC deploy/package helpers, Dataverse verify/inventory scripts, offline evals, generated-project CI, model-driven app guidance, and Power Pages guidance for standard field controls only.

### Added

- Usage telemetry is enabled on model-apps' shared 1DS tenant, with `/pcf:telemetry on|off|status`, regional routing, base fields only and isolated offline coverage.
- Guided canvas app setup, including the **Power Apps component framework for canvas apps** environment setting, Studio import/updates, and manual API-limit review; canvas-specific automated checks remain out of scope.

### Changed

- The bundled SDK is the one model-apps 2.18.0 ships (power-platform-ux a3443479), beside model-apps 2.18.0's HTTP client; the SDK no longer carries its PCF control registration, which this plugin never called. What changed in them — a web resource's published content read back, an app's sitemap found by its component, a publish sent once — is in requests this plugin does not make: it only reads through them and publishes through PAC, so what it does is unchanged.

### Fixed

- The push receipt (`pcf-receipt.json`) no longer carries an access token that a refused confirmation read quoted, and every file the SDK writes into a push's workspace goes through the same output guard as model-apps' scripts.
- A large result is no longer cut short on Linux and macOS: `emitResult`, the printer of an uncaught error, `check-auth.js`, the result printers of `pcf-inventory.js`, `verify-pcf.js` and `lint-pcf.js`, every script's usage error and the write-safety hook's message make their writes blocking before the process exits. What is printed and every exit status are unchanged; Windows was never affected.
- The output guard (the same module model-apps 2.18.0 ships) also keeps an access token out of bytes written to stdout or stderr, masked with `*` byte for byte so framed output keeps its length, out of the token's base64, percent-encoded and HTML spellings, and out of a token that `util.inspect` or an ellipsis cut short or that was split between two writes (each piece of 24 characters or more), keeping an escape split between two writes whole. Still left: a piece shorter than 24 characters, the middle piece of a token written in three or more writes, a short piece on the far side of a split escape, base64 of a part of the token, and bytes written to a file.
