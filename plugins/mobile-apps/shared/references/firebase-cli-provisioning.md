# Firebase CLI provisioning preflight

Use this workflow for local, interactive provisioning. It combines the `gcloud`
active account and Application Default Credentials (ADC) with an on-demand
Firebase CLI. Never install `firebase-tools` globally, print access tokens, pass
tokens on the command line, or commit Firebase Admin service-account JSON.
Native client SDK configuration may be committed when the app workflow validates
it and the project intentionally keeps it under `firebase/`; these files contain
client identifiers, not an Admin private key.

## 1. Verify Google identity and ADC

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
ADC_TOKEN="$(gcloud auth application-default print-access-token)"
ADC_EMAIL="$(
  curl --silent --show-error --fail \
    --header "Authorization: Bearer ${ADC_TOKEN}" \
    https://openidconnect.googleapis.com/v1/userinfo |
    jq -er '.email'
)"
unset ADC_TOKEN
test "$ADC_EMAIL" = "<INTENDED_GOOGLE_ACCOUNT>"
```

The first command reports the principal used by `gcloud`; the user-info call
proves which principal ADC represents. Keep the token only in a shell variable
and never print it or its authorization header. These credential stores are
independent. If ADC is missing, expired, cannot return an email, or belongs to
the wrong user, repair it interactively:

```bash
gcloud auth application-default login --account "<INTENDED_GOOGLE_ACCOUNT>"
```

Complete the browser flow with the intended Google account, then rerun both
checks. Do not capture or log the token.

## 2. Verify Firebase access through ADC

Firebase CLI prefers its own signed-in account store when one exists and falls
back to ADC otherwise. Inspect that store without changing it:

```bash
npx firebase-tools login:list
```

If it contains no authorized account, require the verified ADC email from Step
1, then verify the machine-readable result:

```bash
npx firebase-tools projects:list --json |
  jq -e '.status == "success" and (.result | type == "array")' >/dev/null
```

To verify a particular project is visible, retain only its non-secret project ID:

```bash
npx firebase-tools projects:list --json |
  jq -e --arg id "<PROJECT_ID>" \
    '.status == "success" and any(.result[]; .projectId == $id)' >/dev/null
```

If `login:list` names a different account, do **not** treat that as an ADC
failure and do not delete, rename, or edit the Firebase credential store. Either:

- use the matching stored account explicitly with `--account <EMAIL>`; or
- run the ADC-only `projects:list --json` check from a clean OS user/profile or
  CI environment that has ADC but no Firebase CLI login.

Do not use `firebase login`, `login:add`, or `logout` merely to make the stores
match. If interactive Firebase login is intentionally required, get the user's
approval because it changes a separate persistent credential store.

## 3. Provision only after confirmation

Listing is read-only. Before either command below, show the selected account,
project ID, display name, and organization/folder (if any), then obtain explicit
confirmation. Project IDs are globally unique and cannot be changed.

Create a new Google Cloud project and add Firebase:

```bash
npx firebase-tools projects:create <PROJECT_ID> \
  --display-name "<DISPLAY_NAME>"
```

Optionally add exactly one parent:

```bash
--organization <ORGANIZATION_ID>
--folder <FOLDER_ID>
```

Upgrade an existing Google Cloud project by adding Firebase resources:

```bash
npx firebase-tools projects:addfirebase <PROJECT_ID>
```

Treat `projects:addfirebase` as a persistent project upgrade, not a harmless
lookup. Never infer permission to create or upgrade from permission to list.

## 4. List, register, and configure apps

Always pass `--project <PROJECT_ID>` rather than relying on a local alias.
Platforms are `IOS`, `ANDROID`, or `WEB` (case-insensitive).

```bash
npx firebase-tools apps:list --project <PROJECT_ID>
npx firebase-tools apps:list ANDROID --project <PROJECT_ID>

npx firebase-tools apps:create ANDROID "<DISPLAY_NAME>" \
  --package-name <ANDROID_PACKAGE_NAME> --project <PROJECT_ID>
npx firebase-tools apps:create IOS "<DISPLAY_NAME>" \
  --bundle-id <IOS_BUNDLE_ID> --project <PROJECT_ID>
npx firebase-tools apps:create IOS "<DISPLAY_NAME>" \
  --bundle-id <IOS_BUNDLE_ID> --app-store-id <APP_STORE_ID> \
  --project <PROJECT_ID>
npx firebase-tools apps:create WEB "<DISPLAY_NAME>" --project <PROJECT_ID>

npx firebase-tools apps:sdkconfig ANDROID <APP_ID> \
  --project <PROJECT_ID> --out firebase/google-services.download.json
npx firebase-tools apps:sdkconfig IOS <APP_ID> \
  --project <PROJECT_ID> --out firebase/GoogleService-Info.download.plist
npx firebase-tools apps:sdkconfig WEB <APP_ID> --project <PROJECT_ID>
```

App creation is persistent; confirm the project, platform, display name, and
package/bundle ID first. Treat generated SDK configuration as environment-bound
configuration. Download to a non-canonical project-local candidate, validate it,
and compare it with any existing canonical file before moving or replacing it.

## Official references

- [Firebase CLI documentation](https://firebase.google.com/docs/cli)
- [Firebase projects and Google Cloud projects](https://firebase.google.com/docs/projects/learn-more)
- [Provide credentials to ADC](https://cloud.google.com/docs/authentication/provide-credentials-adc)
- [`gcloud auth application-default login`](https://cloud.google.com/sdk/gcloud/reference/auth/application-default/login)
- [`gcloud auth application-default print-access-token`](https://cloud.google.com/sdk/gcloud/reference/auth/application-default/print-access-token)
- Firebase CLI source: [`projects:list`](https://github.com/firebase/firebase-tools/blob/main/src/commands/projects-list.ts),
  [`projects:create`](https://github.com/firebase/firebase-tools/blob/main/src/commands/projects-create.ts),
  [`projects:addfirebase`](https://github.com/firebase/firebase-tools/blob/main/src/commands/projects-addfirebase.ts),
  [`apps:list`](https://github.com/firebase/firebase-tools/blob/main/src/commands/apps-list.ts),
  [`apps:create`](https://github.com/firebase/firebase-tools/blob/main/src/commands/apps-create.ts), and
  [`apps:sdkconfig`](https://github.com/firebase/firebase-tools/blob/main/src/commands/apps-sdkconfig.ts)
