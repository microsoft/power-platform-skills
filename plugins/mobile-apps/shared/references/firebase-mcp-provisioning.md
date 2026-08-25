# Firebase MCP project, app, and client provisioning

This is the canonical workflow for Firebase MCP authentication, project
selection/provisioning, native app identity, client SDK configuration, and the
manual APNs upload boundary.

## Contents

1. [Verify Firebase MCP authentication](#1-verify-firebase-mcp-authentication)
2. [List, select, and activate a Firebase project](#2-list-select-and-activate-a-firebase-project)
3. [Create a project or add Firebase](#3-create-a-project-or-add-firebase-to-an-existing-google-cloud-project)
4. [Read back active-project readiness](#4-read-back-active-project-readiness)
5. [List, register, and re-read native Firebase apps](#5-list-register-and-re-read-native-firebase-apps)
6. [Retrieve, validate, and install SDK config](#6-retrieve-validate-and-install-sdk-config-through-firebase-mcp)
7. [Verify Expo activation and write the handoff](#7-verify-expo-activation-and-write-the-handoff)
8. [APNs credentials remain manual](#8-apns-credentials-remain-a-manual-console-boundary)

Use this workflow for local, interactive Firebase provisioning through the
**official Firebase MCP server** backed by stable `firebase-tools` **15.27.0**. Use
Firebase MCP for Firebase project discovery, selection, creation, native app
registration, and SDK config retrieval. Do **not** fall back to `firebase-tools`
CLI commands, raw REST calls, or browser automation when those Firebase MCP
operations are unavailable.

Native client SDK configuration may be committed when the app workflow validates
it and the project intentionally keeps it under `firebase/`; these files contain
client identifiers, not an Admin private key.

## 1. Verify Firebase MCP authentication

Start with the current Firebase MCP environment:

- Call `mcp__firebase__firebase_get_environment` (`firebase_get_environment`) with `{}`.
- Read only the authenticated user, available accounts, active project, and
  detected app IDs.

If the authenticated user already matches the intended Google account, continue.
If another already-signed-in account should be active, switch only through the
official MCP environment tool:

```json
{
  "active_user_account": "<INTENDED_GOOGLE_ACCOUNT>"
}
```

Call that payload with `mcp__firebase__firebase_update_environment`
(`firebase_update_environment`), then rerun
`mcp__firebase__firebase_get_environment` and require the intended account.

If the intended account is not already authenticated, use only
`mcp__firebase__firebase_login` (`firebase_login`):

1. Call it with `{}`.
2. Display **both** the returned login URL and Session ID to the user.
3. Instruct the user to verify that the Session ID shown in the browser matches
   the Session ID returned by the tool before granting access.
4. After the user pastes the authorization code back, call the tool again with:

```json
{
  "authCode": "<AUTH_CODE>"
}
```

5. Rerun `mcp__firebase__firebase_get_environment` and require the intended
   authenticated user.

If credentials are stale or the user explicitly wants to switch accounts, use
`mcp__firebase__firebase_login` with `{ "reauth": true }` only after approval.
Do not record Google account details, login URLs, Session IDs, or authorization
codes in `memory-bank.md`.

`gcloud` / ADC checks are **not required** for Firebase project/app/config work
owned by Firebase MCP. Keep separate Google Cloud CLI identity checks in other
owner workflows only when they explicitly need local `gcloud` continuity.

## 2. List, select, and activate a Firebase project

List accessible Firebase projects with the official MCP tool:

```json
{
  "page_size": 1000
}
```

Call that payload with `mcp__firebase__firebase_list_projects`
(`firebase_list_projects`). If the tool returns `next_page_token`, keep paging
with the returned token until the selected project appears or the list is
exhausted. Parse only non-secret project metadata such as `projectId` and
`displayName`.

Ask the user to choose one path:

- **Existing Firebase project:** select one exact `projectId` from the latest
  MCP result.
- **New project without parent-placement requirements:** provide a globally
  unique project ID and optional display name.
- **Existing Google Cloud project:** provide its exact project ID and use the
  official MCP create tool to add Firebase.

If the user requires a **new** project under a specific **organization** or
**folder**, STOP. The official Firebase MCP `firebase_create_project` tool in
stable `firebase-tools` 15.27.0 exposes `project_id` and `display_name`, but **no**
organization/folder parent arguments. Do not fall back to CLI parent flags.

For an existing Firebase project, confirm the authenticated user and exact
project ID, then activate it with `mcp__firebase__firebase_update_environment`:

```json
{
  "active_project": "<PROJECT_ID>"
}
```

## 3. Create a project or add Firebase to an existing Google Cloud project

Creation and Firebase enablement are persistent actions. Show the authenticated
user, project ID, and display name first, explain the immutable/persistent
effect, and require explicit confirmation before calling the create tool.

Use `mcp__firebase__firebase_create_project` (`firebase_create_project`) with:

```json
{
  "project_id": "<PROJECT_ID>",
  "display_name": "<DISPLAY_NAME>"
}
```

Source-verified behavior in stable `firebase-tools` 15.27.0:

- if the Cloud project does **not** exist, the tool creates a new Firebase
  project;
- if the Cloud project already exists and already has Firebase enabled, the tool
  reports that state without recreating it;
- if the Cloud project exists but is **not** Firebase-enabled, the same tool
  adds Firebase to that existing Google Cloud project.

There is **no separate addFirebase core MCP tool** in this stable surface. For
an existing GCP project that needs Firebase enabled, use
`mcp__firebase__firebase_create_project`; do **not** invent another MCP tool or
emulate the path with CLI commands.

On permission, billing, organization-policy, auth, or ownership failures,
report the exact MCP error and STOP.

## 4. Read back active-project readiness

After selecting or creating/upgrading a project:

1. Rerun `mcp__firebase__firebase_list_projects` and require the exact
   `projectId` to appear in the latest paginated result set.
2. Call `mcp__firebase__firebase_update_environment` with
   `{ "active_project": "<PROJECT_ID>" }`.
3. Call `mcp__firebase__firebase_get_project` (`firebase_get_project`) with `{}`
   and require the returned current project to match the exact selected
   `projectId`.

If the project is missing, the active project drifts, or the authenticated user
is wrong, STOP before app registration or SDK config retrieval.

## 5. List, register, and re-read native Firebase apps

Always work against the **active** Firebase project selected above.

Evaluate dynamic Expo config through the deterministic resolver before listing
apps:

```bash
npx expo config --type public --json |
  node "${PLUGIN_ROOT}/scripts/resolve-firebase-app-identity.js" \
    --project-root .
```

Require `status == "ready"` and use only its display name, Android package,
iOS bundle ID, and selected native platforms. Stop on missing/placeholder
identifiers. Report Web as skipped. Create `firebase/` before writing scratch
or candidate files.

List apps with `mcp__firebase__firebase_list_apps` (`firebase_list_apps`):

```json
{ "platform": "android" }
{ "platform": "ios" }
{ "platform": "all" }
```

When deterministic local matching is required, write the **exact text result**
from the MCP tool to a project-local scratch file (for example
`firebase/.android-apps.mcp.yaml` or `firebase/.ios-apps.mcp.yaml`) and pass it
unchanged to `scripts/resolve-firebase-app-identity.js`. The resolver accepts
the official server's flat js-yaml app-list format and rejects general-purpose
YAML features. Never synthesize, truncate, or hand-edit the output before
matching.

Branch only on the resolver's structured result:

- `match`: reuse and record the exact `.app.appId`.
- `selection-required`: show only safe candidates (`appId`, display name,
  platform, exact package/bundle), require one immutable app ID independently
  per platform, and rerun the same unmodified input with
  `--selected-app-id "<APP_ID>"`. Never select by display name or accept an ID
  absent from the candidates.
- `no-match`: app creation may be proposed.
- `ambiguous`: stop on conflicts, missing selected IDs, or platform/identity
  mismatch; never guess, delete, rename, or create around them.
- `error`: stop on the safe parser/input error.

Register a native app only after showing the authenticated user, project ID,
platform, exact package/bundle identity, and display name and receiving
explicit confirmation. Create only selected native platforms. Use
`mcp__firebase__firebase_create_app`
(`firebase_create_app`) with one of these shapes:

```json
{
  "platform": "android",
  "display_name": "<DISPLAY_NAME>",
  "android_config": {
    "package_name": "<ANDROID_PACKAGE_NAME>"
  }
}
```

```json
{
  "platform": "ios",
  "display_name": "<DISPLAY_NAME>",
  "ios_config": {
    "bundle_id": "<IOS_BUNDLE_ID>",
    "app_store_id": "<APP_STORE_ID>"
  }
}
```

Never create a Web app in these mobile push workflows. After every creation,
rerun `mcp__firebase__firebase_list_apps` and the deterministic local resolver.
Require `match` and a non-empty app ID; if safe duplicates now require
selection, use the explicit branch above. A rerun with unchanged Expo identity
must reuse the same app IDs and require no additional creation or confirmation.
Delete only completed/stopped app-list scratch files, never canonical configs.

## 6. Retrieve, validate, and install SDK config through Firebase MCP

Immediately before retrieval, refresh each selected platform's app-list scratch
file and rerun `resolve-firebase-app-identity.js` with
`--selected-app-id "<APP_ID>"`. Require `status == "match"` and the same
project/platform/package-or-bundle identity. Stop on `selection-required`,
`no-match`, `ambiguous`, `error`, or drift.

Then use `mcp__firebase__firebase_get_sdk_config`
(`firebase_get_sdk_config`) with the **exact selected app ID**:

```json
{ "app_id": "<ANDROID_APP_ID>" }
{ "app_id": "<IOS_APP_ID>" }
```

For Android and iOS, the tool returns the config filename plus a fenced code
block containing the raw file contents. Require the expected filename before
writing anything:

- Android must return `google-services.json`
- iOS must return `GoogleService-Info.plist`

Write the **exact raw MCP tool text** to a project-local scratch file first:

- `firebase/.android-sdk-config.mcp.txt`
- `firebase/.ios-sdk-config.mcp.txt`

Then pass that scratch file through the deterministic local extractor:

```bash
node "${PLUGIN_ROOT}/scripts/extract-firebase-sdk-config.js" \
  --project-root . --platform android \
  --input firebase/.android-sdk-config.mcp.txt \
  --output firebase/google-services.download.json

node "${PLUGIN_ROOT}/scripts/extract-firebase-sdk-config.js" \
  --project-root . --platform ios \
  --input firebase/.ios-sdk-config.mcp.txt \
  --output firebase/GoogleService-Info.download.plist
```

The extractor accepts only the documented `SDK config content for \`<file>\``
wrapper, rejects extra prose, prompt-injection-shaped filenames, and
credential-/token-shaped payloads, then writes only the fenced file contents to
the non-canonical candidate path:

- `firebase/google-services.download.json`
- `firebase/GoogleService-Info.download.plist`

Do not write directly onto a canonical file and do not normalize or reformat
contents before validation.

Validate each candidate against its canonical destination:

```bash
node "${PLUGIN_ROOT}/scripts/validate-firebase-client-config.js" \
  --project-root . --platform android \
  --candidate firebase/google-services.download.json \
  --destination firebase/google-services.json \
  --expected-project-id "<PROJECT_ID>" \
  --expected-app-id "<ANDROID_APP_ID>" \
  --expected-identifier "<ANDROID_PACKAGE>"

node "${PLUGIN_ROOT}/scripts/validate-firebase-client-config.js" \
  --project-root . --platform ios \
  --candidate firebase/GoogleService-Info.download.plist \
  --destination firebase/GoogleService-Info.plist \
  --expected-project-id "<PROJECT_ID>" \
  --expected-app-id "<IOS_APP_ID>" \
  --expected-identifier "<IOS_BUNDLE_ID>"
```

Run only selected platforms. The helper rejects path escapes, symlinks,
credential-shaped Android JSON, and unsafe plist constructs without making
network calls. Branch only on its structured result:

- `ready`: move the validated candidate to the canonical destination.
- `reuse`: retain the byte-identical canonical file and delete the candidate.
- `invalid`: stop; never install or replace from a mismatched candidate.
- `conflict`: show only safe issue codes and require explicit replacement
  confirmation before `mv -f`; otherwise delete the candidate unchanged.
- `error`: stop on the safe path/parser/input error.

Never print either config. A rerun with unchanged Firebase output must take
`reuse` without another replacement confirmation. Delete only MCP scratch and
candidate files after their branch completes; never delete canonical config.

Native client configs contain client identifiers, not Firebase Admin private
keys, and may be committed under `firebase/`. Never request, download, copy, or
commit a Firebase Admin service-account private-key JSON.

## 7. Verify Expo activation and write the handoff

The template auto-discovers the canonical project-relative files. Use
`GOOGLE_SERVICES_JSON` or `GOOGLE_SERVICE_INFO_PLIST` only for an explicitly
requested project-relative regular file inside the project; reject absolute,
outside-project, symlink, and missing paths.

Evaluate rather than trusting source text or environment variables:

```bash
EXPO_CONFIG="$(npx expo config --type public --json)"
printf '%s' "$EXPO_CONFIG" |
  jq -e '.android.googleServicesFile == "./firebase/google-services.json"'
printf '%s' "$EXPO_CONFIG" |
  jq -e '.ios.googleServicesFile == "./firebase/GoogleService-Info.plist"'
```

Run only selected-platform assertions, using the normalized override path when
one was explicitly approved. Whenever either service file is active, require
the evaluated plugin list to contain `@react-native-firebase/app` and
`@react-native-firebase/messaging`. If neither config exists, require both
service-file fields and both plugins to be absent.

Record non-secret setup state in `memory-bank.md`: Firebase project ID and, for
each selected native platform, the immutable app ID, evaluated package/bundle
identity, reused/created result, and evaluated project-relative config path.
Use stable `Firebase push handoff` table keys:

- `Firebase project ID`
- `Android Firebase app ID`, `Android package`, `Android client config path`
- `iOS Firebase app ID`, `iOS bundle ID`, `iOS client config path`

Omit unselected platform rows. Do not record Google account details, login
URLs, Session IDs, authorization codes, tokens, credentials, config contents,
runtime registration tokens, or topic subscriptions. Runtime token/topic
lifecycle belongs to `/add-push-notifications`.

Run `npx expo config --type public`, `npx tsc --noEmit`, the push config
validator, and changed-file validation before reporting completion.

## 8. APNs credentials remain a manual Console boundary

The official Firebase MCP server does **not** expose an APNs authentication-key
upload tool. There is no supported Firebase MCP, Firebase CLI, or Firebase
Management API operation for uploading an Apple APNs authentication key.

For iOS push, use only a manually handled Apple APNs authentication key (`.p8`)
created or selected on the exact validated Apple Team, downloaded once to a
user-controlled location outside every repository, and manually uploaded by the
user in Firebase Console to the exact selected Firebase iOS app.

An agent must never request, read, copy, encode, validate, or upload the `.p8`.
Do not use Fastlane `pem`, APNs certificate/`.p12` generation, certificate-based
Firebase credentials, browser automation, undocumented endpoints, or reverse-
engineered upload calls as substitutes.

## Official references

- [Firebase MCP server documentation](https://firebase.google.com/docs/ai-assistance/mcp-server)
- [Firebase MCP README in firebase-tools 15.27.0](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/README.md)
- Firebase MCP source in `firebase-tools` 15.27.0:
  - [`get_environment`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/get_environment.ts)
  - [`login`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/login.ts)
  - [`update_environment`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/update_environment.ts)
  - [`list_projects`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/list_projects.ts)
  - [`get_project`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/get_project.ts)
  - [`create_project`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/create_project.ts)
  - [`list_apps`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/list_apps.ts)
  - [`create_app`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/create_app.ts)
  - [`get_sdk_config`](https://github.com/firebase/firebase-tools/blob/v15.27.0/src/mcp/tools/core/get_sdk_config.ts)
