# Push lifecycle and routing contract

Use this reference whenever a skill reports, resumes, builds, or verifies push
notifications. The stages are independent and resumable for Android and iOS.
Completion on one platform never proves completion on the other, and completing
an earlier stage never proves a later stage.

## Canonical stages and owners

| Stage | Completion evidence | Owner / resume route |
|---|---|---|
| 1. Firebase client | Each selected platform has an active client config matching evaluated Expo identity, an immutable Firebase app ID, and the same Firebase project. | `/setup-fcm` |
| 2. Platform credentials and capabilities | Platform-specific identifiers, entitlements, capabilities, and user-managed signing prerequisites required before wrapping are configured for the exact app identity. iOS uses `/setup-apple-ios` for manual Apple Developer/Xcode guidance with Yes/No confirmations, followed by the `/setup-apns` manual Firebase Console upload of a selected `.p8` authentication key or `.p12` certificate; completion remains pending physical verification. Android may report `not applicable` when the selected runtime requires no separate external handoff. | Current iOS owners are `/setup-apple-ios` and `/setup-apns`. Neither automates Apple configuration or emits an Apple proof artifact. Do not invent an Android credential workflow when no owner is bundled. |
| 3. Runtime integration | The selected platform runtime contains the required native modules, and the app implements consent/permissions, registration-token lifecycle, exact topic transitions, foreground/background/response listeners, and one typed semantic navigation contract shared by in-app, custom-scheme, HTTPS, and push entry points. | `/add-push-notifications` |
| 4. Sender authentication | One sender path is operational for the Firebase project: keyless WIF, the managed Function compatibility path, or a customer-owned manual implementation. | `/setup-push-wif`, `/setup-push-service-account`, or the customer's manual process |
| 5. Power Automate flows | The exact producer and sender flow IDs are recorded, published, and read back from the live environment. A customer-owned Power Automate sender must satisfy the same observable flow-ID/state/contract handoff even though its authentication remains unvalidated. | `/create-push-notification-flow` |
| 6. Wrapped build | A fresh platform artifact is created from the current app and push inputs and recorded by the platform build owner. For iOS, signing assets and Xcode configuration are user-managed; `/build-ios` runs the direct Wrap command only after exact confirmation. Artifact creation does not include installation or delivery proof. | iOS: `/build-ios`. Android: `/build-android`. |
| 7. Physical delivery | The exact current wrapped artifact is installed on a supported physical device and end-to-end delivery is correlated through the live flows, provider, device states, topic transitions, and validated semantic navigation intents. HTTPS App Link/Universal Link activation is verified separately on an installed build. | iOS: `/verify-ios-push`. Android: `/verify-android-push`. |

The Android build and verification entries are routing names only for
orchestrators. Do not assume an artifact extension, build mode, installation
mechanism, evidence file, test matrix, or internal workflow; their owner skills
define those details.

## Resume rules

1. Read the recorded handoffs and report every stage independently. Do not
   collapse Firebase client setup, platform provisioning, runtime integration,
   sender authentication, flow publication, build creation, or physical
   delivery into one `configured` state.
2. Track Android and iOS independently for stages 1, 2, 3, 6, and 7. A valid
   Android client or build does not satisfy iOS, and vice versa.
3. Resume at the first incomplete prerequisite for the requested platform.
   Reuse valid upstream handoffs and never redo a proven stage merely because a
   downstream stage is missing.
4. Sender authentication and flows may serve both platforms, but their
   completion still does not prove either wrapped build or either physical
   delivery state.
5. A managed sender requires a fresh valid `sender-auth.json`. Manual senders
   use the safe handoff contract below; never fabricate `sender-auth.json`,
   redirect them through WIF or the Function compatibility owner, inspect
   credentials, or claim their authentication design was validated.
6. Route to a build owner only after the requested platform's stages 1-3 and
   the shared sender-auth/flow stages 4-5 are ready. Route to physical
   verification only after that platform's exact current build is ready and
   installed through the user/operator-owned installation process.

## Canonical reporting states

Use explicit states rather than a single push-ready flag:

- **Firebase client, per platform:** not selected / missing / configured /
  blocked.
- **Platform credentials/capabilities, per platform:** not applicable /
  incomplete / configured, physical verification pending / blocked.
- **Runtime integration, per platform:** missing / incomplete / integrated /
  blocked.
- **Sender authentication:** missing / valid managed handoff / stale or blocked
  / customer-owned Power Automate sender, observable contract read back but
  authentication not plugin-validated / customer-owned non-Flow endpoint,
  plugin physical verification unavailable.
- **Power Automate flows:** missing / recorded / published-and-read-back /
  blocked.
- **Wrapped build, per platform:** not applicable / missing / stale / ready /
  blocked.
- **Physical delivery, per platform:** not applicable / pending / partial /
  failed / verified.

## Safe manual sender handoff

Prefer a customer-owned Power Automate sender because it preserves observable
end-to-end verification without making the plugin responsible for credentials.

### Customer-owned Power Automate sender

The customer supplies and approves recording the exact sender flow ID. The
handoff is ready only when FlowAgent, in the same recorded environment as the
producer:

1. reads the exact producer and customer-supplied sender flow IDs by ID, never
   by display-name selection;
2. records both live states as `Started`;
3. reads back only the observable sender contract: queued-outbox trigger/guard,
   idempotent claim, `allUsers` versus lowercase-OID routing, one delivery
   invocation, and terminal `Sent`/`Failed` updates; and
4. records the environment ID/Dataverse URL, both flow IDs/states, and the
   read-back timestamp as non-secret handoff evidence.

Report this exact status:
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`.

Do not inspect or record credentials, authorization configuration, secure
inputs/outputs, headers, tokens, endpoint secrets, connector secret material,
or raw delivery bodies. Connected/readable flow evidence proves only the
observable operational contract; it does not prove credential security,
rotation, least privilege, or authentication design.

This handoff may resume wrapped build and physical verification. The platform
verification owner must fetch the same exact flow IDs again and require the
same observable live contract before sending.

### Customer-owned non-Flow endpoint

When the sender is not a Power Automate flow, record only a customer-supplied,
non-secret, immutable endpoint identifier and the status:
`customer-owned non-Flow endpoint / plugin physical verification unavailable`.
Do not record endpoint credentials, signed URLs, authorization metadata,
headers, or payloads.

Use a distinct non-Flow handoff schema containing only: `Environment ID`,
`Dataverse URL`, `Producer flow ID`, `Producer flow state`,
`Sender authentication status`, `Sender endpoint identifier`, and
`Flow read-back timestamp`. Omit `Sender flow ID` and `Sender flow state`
because no sender flow exists; empty, null, placeholder, or fabricated sender
flow fields are invalid.

The producer may be recorded independently, but the Power Automate-flow stage
is incomplete for plugin end-to-end verification because FlowAgent cannot read
back a sender flow or correlate its run. Do not route this status into plugin
physical verification or claim physical delivery verified. The customer owns
sender validation and end-to-end delivery evidence outside the plugin. A later
exact Power Automate sender-flow handoff may replace this blocked status.

## Shared physical-delivery contract

Every platform verification owner consumes
[push-physical-verification.md](./push-physical-verification.md) for the common
artifact continuity, live-flow read-back, privacy-safe correlation, topic,
outbox, idempotency, stop/retry, and completion rules.

The platform verification skill remains authoritative for its exact
installation checks, app-state matrix, platform credentials/capabilities, and
other platform-specific gates. The shared protocol does not weaken or replace
those requirements.
