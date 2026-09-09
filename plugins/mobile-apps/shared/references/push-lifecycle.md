# Push lifecycle and routing contract

Use this reference whenever a skill reports, resumes, builds, or verifies push
notifications. The stages are independent and resumable for Android and iOS.
Completion on one platform never proves completion on the other, and completing
an earlier stage never proves a later stage.

## Guided entry point

`/add-push-notifications` is the default user-facing command. It inspects the
recorded handoffs, asks for a platform only when the prompt does not identify
one, and never asks for a stopping point. It infers an explicit build or
verification request and otherwise defaults to creating delivery flows. It
implements runtime integration and invokes the owner of each other incomplete
stage in order.

Push setup also does not ask whether HTTPS App Links/Universal Links are
wanted. Configure them only when the prompt explicitly supplies that intent
and exact HTTPS origin or an existing approved plan already records the origin;
otherwise keep the approved HTTPS origin `null`.

The individual owner skills remain directly invocable as advanced resume and
repair entry points. A user should not need to manually chain them for a normal
setup. The orchestrator must continue in-session when an owner can run, and
stop only at the selected stopping point, a user-managed external action, or a
real blocker.

## Bounded orchestration

Push setup uses two bounded waves without treating the whole lifecycle as
concurrent:

1. Firebase authentication, project selection/creation, activation, and
   read-back stay serial in `/setup-fcm`. After the parent collects all app and
   replacement decisions, it may run at most two
   `mobile-app:firebase-platform-worker` tracks, one per selected platform.
2. Only after the complete Firebase parent join,
   `/add-push-notifications` may run at most three independent tracks:
   `mobile-app:push-runtime-worker`, `mobile-app:push-wif-worker`, and
   `mobile-app:push-ios-prerequisites-worker`.

The parent owns every question and approval. Before dispatch it freezes
immutable decision envelopes, disjoint `exclusive_files`, and one
`memory-bank.md` SHA-256. Workers never prompt, invoke another worker or skill,
fan out, or write memory. Every return must have a recognized literal status
line and exactly one parseable `WORKER_RESULT`; malformed, identity-drifted, or
unexpected-file results are blocked rather than inferred from disk state.

Every `Task` capability check carries `operation: preflight` in the prompt.
Preflight is mutation-free: no cloud calls, project or memory reads, file
writes, or ownership acquisition. Firebase execution may read only raw memory
bytes for the supplied SHA-256 guard and must report both scratch cleanup and
ownership release on every return. Result paths remain project-relative; the
parent resolves them against the canonical absolute project root before
comparing them with absolute exclusive files.

Cold WIF preserves the short path for an existing dedicated Entra identity:
read-only `plan` -> explicit approval -> final `execute`. A truly absent
identity uses a staged path: initial read-only inventory with a null client ID
-> approval for only the minimal Entra identity/credential and secret-safe Key
Vault bootstrap -> serial `identity-bootstrap` returning the server-generated
client ID -> fresh claim-driven read-only plan -> second explicit approval for
the exact remaining Google/API/RBAC diff -> final `execute`. Bootstrap never
mutates Google state or writes `sender-auth.json`; planning never authorizes
mutation, and first approval never authorizes the remaining plan. The parent
accepts these worker stages only in order and keeps the same run ID. If iOS
worker dispatch cannot run, the serial fallback applies `/setup-apns` once as the
combined Apple-first/APNs owner and accepts one final iOS result; it never
combines separate Apple and APNs terminal results.

Join every started task, including a partially dispatched batch, before
starting an undispatched track or fallback. Group valid `NEEDS_CONTEXT`
requests into one parent question, retry only affected tracks, and cap each
worker at two retries. Preserve successful independent work when one
platform-specific track blocks. Immediately before the single parent memory
merge, recompute the SHA-256 and stop on drift rather than overwriting
concurrent changes.

If task execution is unavailable, use one synchronous worker or the documented
deterministic serial owner/inline fallback; never manufacture parallelism.
FlowAgent authoring, wrapped builds, installation handoffs, and physical
verification remain sequential owner boundaries in canonical lifecycle order.

## Canonical stages and owners

| Stage | Completion evidence | Owner / resume route |
|---|---|---|
| 1. Firebase client | Each selected platform has an active client config matching evaluated Expo identity, an immutable Firebase app ID, and the same Firebase project. | `/setup-fcm` |
| 2. Platform credentials and capabilities | Platform-specific identifiers, entitlements, capabilities, and user-managed signing prerequisites required before wrapping are configured for the exact app identity. iOS uses `/setup-apple-ios` for manual Apple Developer/Xcode guidance with Yes/No confirmations, followed by the `/setup-apns` manual Firebase Console upload of a selected `.p8` authentication key or `.p12` certificate; completion remains pending physical verification. Android may report `not applicable` when the selected runtime requires no separate external handoff. | Current iOS owners are `/setup-apple-ios` and `/setup-apns`. Neither automates Apple configuration or emits an Apple proof artifact. Do not invent an Android credential workflow when no owner is bundled. |
| 3. Runtime integration | The selected platform runtime contains the required native modules, and the app implements consent/permissions, registration-token lifecycle, exact topic transitions, foreground/background/response listeners, and one typed semantic navigation contract shared by in-app, custom-scheme, HTTPS, and push entry points. | `/add-push-notifications` |
| 4. Sender authentication | The Power Automate sender uses either a valid keyless WIF handoff or customer-configured FCM authentication that remains plugin-unvalidated. | `/setup-push-wif` or the customer's manual configuration in the plugin-created sender |
| 5. Power Automate flows | The exact producer and sender flow IDs are recorded, published, and read back from the live environment. | `/create-push-notification-flow` |
| 6. Wrapped build | A fresh platform artifact is created from the current app and push inputs and recorded by the platform build owner. For iOS, signing assets and Xcode configuration are user-managed; `/build-ios` runs the direct Wrap command only after exact confirmation. It captures a deterministic declared-input snapshot before `npm run build:ios`, preserves it through the external build, requires current inputs to equal that snapshot before writing strict project-local `ios-build.json`, and records the fresh IPA's project-relative path/hash/size/mtime plus safe app/Firebase/auth/mode/Team/export/APNs/tooling identity and a validity window no longer than 24 hours. This proves pre/post-build project-input continuity plus artifact identity/freshness. It is not signing/profile/certificate/entitlement/IPA-signature attestation, does not cryptographically embed the input digest in the IPA, and never inspects signing assets or embedded profiles. Artifact creation does not include installation or delivery proof. | iOS: `/build-ios`. Android: `/build-android`. |
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
5. A WIF sender requires a fresh valid `sender-auth.json`. A manually
   authenticated sender uses the exact plugin-created Power Automate flow and
   safe handoff below; never fabricate `sender-auth.json`, inspect credentials,
   or claim its authentication design was validated.
6. Route to a build owner only after the requested platform's stages 1-3 and
   the shared sender-auth/flow stages 4-5 are ready. Route to physical
   verification only after that platform's exact current build is ready and
   installed through the user/operator-owned installation process.
7. For iOS, `scripts/validate-ios-build-handoff.js` must accept
   `ios-build.json` before installation confirmation and again immediately
   before the live verification sequence. Do not repeat it before every send
   while the sequence is uninterrupted and mutation cannot occur; revalidate
   before the next send after an interruption, validity-window crossing, or
   possible project/input/artifact/tooling mutation. A missing, expired,
   malformed, symlinked, escaped, artifact-drifted, identity-drifted, or
   declared-input-drifted handoff returns to `/build-ios`; manual timestamps or
   file-name comparison cannot replace the validator.

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
  authentication not plugin-validated.
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

## Shared physical-delivery contract

Every platform verification owner consumes
[push-physical-verification.md](./push-physical-verification.md) for the common
artifact continuity, live-flow read-back, privacy-safe correlation, topic,
outbox, idempotency, stop/retry, and completion rules.

The platform verification skill remains authoritative for its exact
installation checks, app-state matrix, platform credentials/capabilities, and
other platform-specific gates. The shared protocol does not weaken or replace
those requirements.
