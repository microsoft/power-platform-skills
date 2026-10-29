# Changelog

All notable changes to the pcf plugin are documented here.

## [Unreleased] — 1.0.0 (preview)

First preview release: ships the `/pcf:pcf` skill, matrix-pinned templates and recipes, local gates, doctor and upgrade helpers, PAC deploy/package helpers, Dataverse verify/inventory scripts, offline evals, generated-project CI, model-driven app guidance, and Power Pages guidance for standard field controls only.

### Added

- Usage telemetry is enabled on model-apps' shared 1DS tenant, with `/pcf:telemetry on|off|status`, regional routing, base fields only and isolated offline coverage.
- Guided canvas app setup, including the **Power Apps component framework for canvas apps** environment setting, Studio import/updates, and manual API-limit review; canvas-specific automated checks remain out of scope.

### Changed

- The bundled SDK is the one model-apps 2.20.5 ships (power-platform-ux 59ae2d72e2a8), beside model-apps 2.20.5's HTTP client; the SDK no longer carries its PCF control registration, which this plugin never called. This plugin only reads through them and publishes through PAC; its reads pass its real-bundle tests unchanged.
- The PCF guide explains why calls after an early-return guard or in an `else` branch are reported, and shows the positive guard block to use instead.
- An optional call with type arguments that is handed a context member, such as `factory?.<T>(context.device).captureImage()`, is now reported as a Pages call even when the factory returns its own object; call it without `?.` or keep the result in a local first.

### Fixed

- `check-auth.js` no longer reports success for an identity that cannot read customizations (no security role in the environment); it fails with `no_customization_role` and names a role to ask for.
- The push receipt (`pcf-receipt.json`) no longer carries an access token that a refused confirmation read quoted, and every file the SDK writes into a push's workspace goes through the same output guard as model-apps' scripts.
- A large result is no longer cut short on Linux and macOS: `emitResult`, the printer of an uncaught error, `check-auth.js`, the result printers of `pcf-inventory.js`, `verify-pcf.js` and `lint-pcf.js`, every script's usage error and the write-safety hook's message make their writes blocking before the process exits. What is printed and every exit status are unchanged; Windows was never affected.
- The output guard (the same module model-apps 2.19.0 ships) also keeps an access token out of bytes written to stdout or stderr, masked with `*` byte for byte so framed output keeps its length, out of the token's base64 — and the base64 of each of its parts of 24 characters or more — and its percent-encoded and HTML spellings, and out of a token that `util.inspect` or an ellipsis cut short or that was split between two writes (each piece of 24 characters or more), keeping an escape split between two writes whole, also after a nested write and the write around it were both refused. Still left: a piece shorter than 24 characters, the middle piece of a token written in three or more writes, a short piece on the far side of a split escape, base64 of a piece of the token that is not a whole part, and bytes written to a file.
- The Pages guard check now catches Pages calls written through parentheses, template-literal keys, `.call`, `.apply`, `.bind` or `Reflect.apply`, and counts them as feature use.
- A write in a parameter default now ends the Pages guard proof even when the function body declares the same name.
- `this` in a computed class member key, such as one after a typed or private field, now means the enclosing method's `this`, so a write there ends that method's Pages guard proof.
- A `.ts` file with hundreds of `<Type>value` casts is now analyzed instead of being treated as unparseable, which had reported every Pages call in it as unguarded.
- A local object literal named like the context, such as `const ctx = { device: { captureImage() { return 1; } } }`, is no longer mistaken for the PCF context when only its own simple functions are called.
- The pcf evals report a case with nothing graded as unscored, not passed; exit status unchanged.
