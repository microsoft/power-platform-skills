# Physical push verification protocol

Use this protocol for platform-specific physical push verification skills.
Platform references add permission, installation, and app-state cases; they
must not weaken these common evidence, privacy, or completion rules.

## What physical verification proves

Physical verification joins four independent facts for one test case:

1. the exact fresh native artifact is installed on a supported physical device;
2. the active Firebase client identity belongs to that artifact;
3. the exact published producer and sender flows process one privacy-safe event
   through the expected outbox lifecycle; and
4. the device exhibits the required foreground, background, terminated,
   topic-transition, opt-out, or recovery behavior.

Configuration checks, package presence, a successful build, FlowAgent smoke
tests, an outbox `Sent` state, and FCM acceptance are useful boundaries but are
not physical-delivery proof by themselves.

## Required handoff continuity

Before a live test, require:

- the platform build owner's exact successful handoff and artifact identity;
- active evaluated Firebase project, immutable platform app ID, and native
  application/bundle ID continuity;
- the exact recorded environment, producer flow ID, and sender flow ID;
- either a currently valid plugin-managed sender-auth handoff or the recorded
  status `customer-owned Power Automate sender / observable contract read
  back; authentication not plugin-validated`, including the exact
  customer-supplied sender flow ID and safe FlowAgent read-back evidence;
- explicit confirmation of the exact artifact installed on a supported
  physical device.

The status `customer-owned non-Flow endpoint / plugin physical verification
unavailable` is not a physical-verification handoff. Stop before live sends:
FlowAgent cannot read back an exact sender flow or correlate its run.

Never select an artifact, Firebase app, environment, or flow by a similar
display name. Missing, conflicting, or stale identity stops the test.

## FlowAgent-only flow boundary

Use FlowAgent for every flow definition, connection, trigger/action discovery,
test-event, and run-history operation. Do not use Power Automate portal
automation, direct Flow REST calls, `curl`, PAC/PowerShell, or shell-authored
flow mutation. Local shell commands may validate project files and artifact
metadata only.

Verification is read-only with respect to flow definitions. Never create,
copy, edit, update, publish, disable, or delete a flow. Creating one generic
Dataverse test row through a discovered connector operation is test data, not
flow authoring, and still requires explicit send consent.

### Exact read-back

1. Resolve and set the recorded environment; read it back and compare both
   environment ID and Dataverse URL.
2. Fetch producer and sender by exact recorded IDs and require live state
   `Started`.
3. Read back the producer's actual trigger, recipient resolution, generic
   payload construction, lowercase-OID expression, and queued outbox action.
4. Read back the sender's queued guard, atomic/idempotent claim, audience/topic
   mapping, one authentication/delivery branch, secure settings, and terminal
   outbox updates.
5. Resolve the definitions' connection references and require every used
   connection to test Connected.
6. For managed sender auth, validate the fresh handoff against the active
   Firebase project and require exactly the same mode in the sender read-back.
7. For `customer-owned Power Automate sender / observable contract read back;
   authentication not plugin-validated`, refetch the exact customer-supplied
   sender flow ID and inspect only the observable queued guard, idempotent
   claim, audience/topic routing, one delivery invocation, and terminal outbox
   updates. Do not inspect credentials, authorization configuration, secure
   inputs/outputs, headers, token exchanges, or endpoint secret material. Do
   not claim credential storage, rotation, least privilege, or authentication
   design was validated.
8. For `customer-owned non-Flow endpoint / plugin physical verification
   unavailable`, stop. Do not infer a sender flow, inspect endpoint
   credentials, or attempt plugin physical correlation.

FlowAgent `smoke_test` proves connectivity only. It does not prove a specific
flow definition, topic subscription, provider delivery, or device receipt.

## Privacy-safe correlation

Obtain explicit confirmation before every live notification. Use generic,
non-confidential title/body text and one allowlisted internal route.

Create a unique opaque case label, for example
`PUSH-20260824-01`. The label must not contain a person's name, email, tenant,
customer, record content, or business data.

Correlate only this allowlist:

- case label and bounded UTC test window;
- exact environment, producer flow ID, sender flow ID, and their run IDs;
- safe source-row ID when the producer contract requires one;
- outbox row ID and `Queued -> Sending -> Sent|Failed` timestamps;
- action names, status, start/end times, and bounded sanitized error category;
- physical app state, observed receipt/non-receipt time, and safe route
  label/result;
- safe build identity fields and recovery route.

Never request, collect, display, copy, log, or persist:

- FCM/APNs registration tokens or token fragments;
- Entra OIDs, account IDs, device IDs, advertising IDs, UDIDs, or ADB serials;
- authorization headers, bearer/JWT/access/refresh/ID tokens, client secrets,
  private keys, or service-account JSON;
- raw notification payloads, trigger bodies, action inputs/outputs, secure
  action values, provider responses, or confidential source-row content.

Do not use a provider response as evidence. The safe terminal outbox state and
physical observation are enough; provider acceptance without device behavior
never passes a delivery case.

Use `get_run_history` with the case start window, then `get_run_details` and
`get_run_actions`. Use `get_run_action_repetitions` only when a relevant action
is inside a loop. Request/status-check only safe metadata. If a tool would
expose a prohibited body or value, do not call it; use a safer read-back or
stop as unprovable.

## Topic, outbox, and idempotency evidence

Each positive delivery case has exactly:

- one consented generic source event or direct `allUsers` test row;
- one outbox row;
- one producer run when the producer is part of the case;
- one effective sender claim/run;
- one terminal outbox result; and
- one expected device presentation/navigation result.

The outbox must transition `Queued -> Sending -> Sent` for success, or to one
bounded `Failed` result. The sender's own updates must not retrigger delivery.
A second sender claim, repeated device presentation, repeated navigation, or
cross-case reuse fails idempotency.

`AllUsers` requires exact topic `allUsers` and an empty target OID. A user case
must enter through the exact producer and its read-back lowercase-OID logic.
Verify user routing by controlled account delivery behavior, not by extracting
the OID or target-topic value.

For an `allUsers` case, discover the live Dataverse add-row operation and use
FlowAgent `invoke_operation` to create one generic queued outbox row. For a
user-targeted case, exercise the producer's real trigger contract through its
discovered connector operation, or `run_flow` only when read-back proves a
manual trigger. Never bypass the producer with a direct user-targeted outbox
insert.

## Stop and retry rules

Stop the current case immediately when:

- artifact, installed-app, Firebase, environment, flow, or auth continuity is
  missing, stale, or contradictory;
- either exact flow is not readable and `Started`;
- a required connection is disconnected;
- evidence crosses case windows or cannot join one row/run/device observation;
- delivery, presentation, or navigation is missing, duplicated, or ambiguous;
- a required app state is replaced by an easier state;
- observing evidence would require collecting prohibited data.

Do not repeatedly resubmit a failed run or reuse its outbox row. Inspect one
failed chain's safe action statuses and bounded error category, then route the
failure to the owning build/client/auth/flow skill. After an owner fix:

1. prove continuity again;
2. create a new case label and new test row;
3. rerun only the failed case plus any transition or positive control that
   depends on it.

Use bounded waits defined by the platform matrix. A negative test is
provisional until a positive control succeeds on the same exact artifact,
device session, Firebase identity, and flow definitions. Never explain a
non-delivery as success merely because FCM accepted the request.

## Completion rules

Mark physical verification complete only when every required platform case
passes in order against one unchanged evidence boundary:

- exact fresh installed artifact;
- active matching Firebase client;
- exact published/read-back producer and sender;
- recorded managed auth or the exact customer-owned Power Automate sender
  status and exact read-back flow ID;
- privacy-safe outbox/run/device correlation;
- all app states, topic transitions, negative tests, positive controls, and
  recovery cases required by the platform matrix.

Skipped, configuration-only, foreground-only, FCM-accepted-only, stale-build,
or partially correlated runs remain **pending physical verification**.

The final report may include only the correlation allowlist above. Preserve
prior history and supersede it rather than deleting it. State the failed owner
stage and one exact next action for every `FAIL` or `BLOCKED` case.
