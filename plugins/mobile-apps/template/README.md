# Legacy Mobile App Preparation Fixture

This directory is a **legacy preparation/test fixture**, not the current
customer template. Its older dependency versions are intentional: they protect
backward-compatible preparation and provide missing app-guidance defaults.
Do not update those pins merely because a new runtime has shipped.

New apps use the published
[`@microsoft/power-apps-native-template`](https://www.npmjs.com/package/@microsoft/power-apps-native-template)
package and its verified creation CLI. The following setup guidance applies to
that acquired app, not to cloning or installing this fixture as a new app.

## Requirements

- Node.js 24 LTS.
- npm 10 or newer.
- The Power Apps Mobile Preview app from the Apple App Store or Google Play.

## Setup

**Building native mobile apps with Power Platform is in Private Preview; do not use this in production.**

Start from the Power Platform mobile app template, then use the mobile-app
skill to generate the app plan, data model, screens, native capabilities, and
connector wiring.

1. Install the mobile-app plugin from the Power Platform Skills marketplace.

	For GitHub Copilot in VS Code:

	1. Open the Extensions view.
	2. Enter `@agentplugin` in the search box.
	3. Find the Power Platform mobile-app plugin and select **Install**.
	4. Reload VS Code if prompted, then open Copilot Chat in Agent mode.

	Alternatively, run these manual commands **inside a Claude Code or GitHub
	Copilot CLI session**, not a shell:

	```text
	/plugin marketplace add microsoft/power-platform-skills
	/plugin install mobile-app@power-platform-skills
	```

	See the [public manual installation instructions](https://github.com/microsoft/power-platform-skills#manual-installation).
	If installed but disabled or not loaded, enable/load the plugin in your host.
	Installation is optional and never performed automatically by app guidance.

2. Choose an exact published npm template and acquire it into a new/empty folder
   using the guarded [plugin setup sequence](../README.md#setup).

   That sequence checks published metadata and integrity, invokes the contained
   creation CLI, and separately obtains approval for shipped-lock `npm ci`.
   Do not use a Git checkout or this bundled fixture as a fallback for missing
   publications. Existing apps use the upgrade workflow below, not creation.

3. Open the acquired app folder in VS Code and run the skill from Copilot Chat:

	```text
	/create-mobile-app
	```

	The template includes this host package and the required Expo / React Native
	runtime dependencies. The skill updates the app in place as it designs and
	generates the mobile experience.

	When prompted to sign in, use credentials for the tenant where the Dataverse
	environment belongs.

4. Create the Microsoft Entra app registration from Power Apps Wrap.

	Open the app-registration page for the Power Platform environment selected
	during `/create-mobile-app`:

	```text
	https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
	```

	Create the registration on that page, copy its **Application (client) ID**,
	and paste it when `/create-mobile-app` asks. The Wrap experience configures
	the native app registration for this flow. Do not add redirect URIs or API
	permissions manually; use Wrap to repair missing configuration. Some repairs
	and consent operations require an Azure tenant admin.

	If the app was created without a client ID, run
	`/set-app-registration-native` later from the app folder. It discovers
	tenant-visible registrations, checks the required permission profile, and
	writes the selected client ID to `auth.config.json`.

	### Required API permissions

	The read-only checker validates the native runtime profile. The baseline is
	Dynamics CRM `user_impersonation` plus Power Platform API
	`PowerApps.Apps.Read`. Apps using Power Platform connectors additionally
	require Azure API Connections `Runtime.All` and the Power Platform API
	`Connectivity.Connectors.Read`, `Connectivity.Connections.Read`,
	`Connectivity.Connections.Write`, and
	`Connectivity.Connections.UserConsent` scopes. The checker does not require
	unrelated Wrap packaging permissions. Redirect platforms, packaging
	permissions, third-party-app allowlisting, and admin consent are finalized in
	Wrap.


5. Start mobile app:

	`/create-mobile-app` starts Metro with the template-owned `npm run dev`.
	npm runs the app's declared `predev` command first. The published template's
	`predev` generates schemas; run `npm run type-check` separately rather than
	assuming schema generation also type-checks the app.
	The template's Metro config delegates sanitized logging to the native host package, which writes `.powernative/metro-logs/`,
	allowing `/debug-app` to work across VS Code, Copilot CLI, and Claude Code
	without a terminal ID.

	To start Metro manually instead, run the command below from the app directory.
	Manual starts and `/debug-app` use the same `.powernative` log source.

	```bash
	npm run dev
	```

	### Multi-tenant support

	To let users choose among environments in multiple Microsoft Entra tenants,
	set the app registration's supported account type to accounts in any
	organizational directory and add the following fields under
	`expo.extra.powerappsNative` in `app.json`:

	```json
	{
	  "tenantMode": "multi",
	  "appDisplayName": "My App",
	  "appName": "MyApp",
	  "tenantPolicy": "organizations"
	}
	```

	Use `{ "allowedTenantIds": ["<tenant-guid>"] }` for `tenantPolicy` to
	restrict access to specific tenants. The native host supplies the sign-in,
	environment discovery, and environment-selection screens.

	### Dev tunneling

	When a device cannot reach the workstation over the local network, start an
	authenticated Microsoft Dev Tunnel:

	```bash
	az login
	npm run dev -- --tunnel
	```

	Pass `--tunnel-tenant <tenant-id>` to select an Entra tenant. The command
	creates no anonymous access rule and deletes the tunnel when Metro exits.


6. Preview the app by scanning the QR code with the Power Apps Mobile Preview app

	- App store: https://apps.apple.com/us/app/power-apps-developer/id6753083462
	- Play store: https://play.google.com/store/apps/details?id=com.microsoft.PreviewApp

## App-local agent guidance

[AGENTS.md](AGENTS.md) is the canonical guidance for agents working in this app.
[CLAUDE.md](CLAUDE.md) imports it, and
[.github/copilot-instructions.md](.github/copilot-instructions.md) links to it
relatively, so the guidance travels with the app without private plugin paths.
It routes relevant requests to skills advertised by the current host, keeps
small edits small, and separates startup diagnosis from upgrades.

Approved fresh-template preparation adds only missing guidance files and preserves
existing customer guidance byte-for-byte. Existing apps can opt into guidance
adoption separately; do not run fresh-template preparation over them.
`/debug-app` can diagnose startup failures before the app loads. An agent already
running creation can offer that workflow after observing a failure, but
`npm run dev` alone does not wake an agent or install a monitor. No automatic
hooks or watchers are added.

For app problems (including dependency installation, startup, runtime, or QR
opening), try the available `/debug-app` skill first before reporting an issue.
This is a recommendation, not a prerequisite: honor explicit direct report
requests. Plugin installation/loading failures can make app diagnosis unavailable;
do not block reporting in those cases.

## Upgrade the Native Host

Run `/check-updates` from the existing app. It selects an exact published Host
and matching template, rehearses the complete required migration chain in a
test copy, validates the result, and asks separately before applying changes
to the original app. See the [upgrade workflow](../skills/check-updates/SKILL.md).

The published Host owns dependency installation and protected state changes.
Do not independently install a floating Host, invent a source version, copy a
new template over the app, or edit `expo.extra.powerappsNative` by hand.
Missing recorded state or an unsupported migration requires recovery/review.
The current published migration supports npm; other package managers need
explicit support from the selected Host, not a claim inherited from this fixture.
Preserve app code, offline profiles, settings, and data through the reviewed
preview/application process.

## Web

Start the browser app:

```bash
npm run web
```

The command opens **Local Play** in your default browser and embeds the local
Expo app in the hosted Power Apps player. Use the same browser profile as your
Power Platform tenant.

Web builds are supported in Code Apps. They are also supported in Power Pages
when the app uses Dataverse only.

For an explicitly approved, separate Code App, use that app's own configuration
and the installed CLI's supported upload path for `npm run bundle:web`. Keep its
identity separate from an existing Mobile App; do not remove the Mobile App's
`appId` or change its `appType` just to publish web output.

For mobile deployment, follow [`/deploy`](../skills/deploy/SKILL.md): build and
stage the complete web/native payload into the existing configured upload
directory, then confirm the target before pushing.

To publish to Power Pages, run `npm run bundle:web -- powerpages`, then use the Power Pages
skills to upload the generated `dist-web` directory.

## License and notices

This template is provided under the license in `LICENSE`.
