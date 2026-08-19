---
name: native-capabilities
description: "Use to run Stage 5 of the mobile app journey: integrate approved camera, location, scanning, file, sharing, secure storage, or other template-supported native capabilities while preserving a working mock fallback and reviewable workflows."
argument-hint: "Integrate approved native capabilities from the app plan"
user-invocable: true
---

# Mobile App Native Capabilities

Own typed native wrappers, permission handling, platform fallbacks, and their approved screen integration.

Read [stage-contract.md](../create-mobile-app/references/stage-contract.md), [template-contract.md](../create-mobile-app/references/template-contract.md), and [ux-quality.md](../create-mobile-app/references/ux-quality.md).

## Procedure

1. Require an accepted App Builder stage, reconcile its compatibility snapshot, and read the approved native capability matrix.
2. If none are approved, run the working app gate, mark Native Capabilities `not-required`, and return `DONE_NOT_REQUIRED`.
3. Verify every capability against live packages, Expo config plugins, host support, platform, and app-store/privacy implications. Use only template-shipped native modules; never install a native package, transitive native dependency, config plugin, or dependency requiring a rebuilt binary. Mark a capability unavailable when the shipped template cannot support it. Consider all shipped categories: camera/barcode, image/media pick/edit/save, audio/video, document/file, location, secure store/local auth/crypto, sharing/print/mail/clipboard, device/application/network context, orientation/keep-awake, linking/web browser, and system UI. Select only plan-approved capabilities.
4. Integrate one related capability group per wave behind typed wrappers under `src/native/` or the established local boundary.
5. Implement least-privilege permission timing and denied, restricted, unavailable, cancelled, success, retry, settings, and alternative/manual behavior as applicable. Never request permission on app launch unless the primary workflow immediately requires it.
6. Define a discriminated result union for every wrapper with `success`, `cancelled`, `denied`, `unavailable`, and `error` outcomes plus `simulated: true` where applicable. Include normalized metadata and machine-readable reason/error codes; do not use ambiguous `null`, booleans, or thrown platform errors as the public contract. The wrapper owns platform checks and module calls.
7. Keep deterministic web fallback with fixture-backed output and visible simulated state. Preserve drafts across permission prompts, pickers, browser/auth sessions, and external apps. Normalize file URIs, metadata, media sizes, and cleanup/retention at the wrapper boundary; do not keep large payloads in component state.
8. Preserve the existing Power Apps host/offline plugins, auth broker schemes, root provider, Metro logging/verification endpoint, and Babel plugin ordering. Make root config changes only inside existing customization markers and only when the shipped capability requires them.
9. Treat Dataverse mobile offline separately: this stage does not create `offline-profile.json` or assign profiles. Record `/setup-offline-profile` and `/assign-offline-profile` as deferred follow-up when offline sync is approved.
10. Run `npm run type-check`, then `npm run bundle:web`/`npm run web` only when the capability has a supported web path and the complete app is ready. Never run Android/iOS bundles, native launch commands, simulators, dev clients, or device builds. Record native-only behavior as `not-run`; accept wrapped-device evidence only when the user supplies and confirms it.
11. Review resource lifecycle and privacy: stop camera/audio/location work, release temporary files, avoid logging sensitive values, store secrets only in Secure Store, and document retention/deletion behavior.
12. Run the working app gate and provide manual review for success, denial, cancel, unavailable hardware, operational failure, fallback, and external-app return.

Do not add external connectors or Dataverse. Native outputs such as images or coordinates remain in domain/mock storage until later adapters are approved.