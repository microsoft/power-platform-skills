# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building an
iOS, Android, or hosted web app that connects to Power Platform data through
`@microsoft/power-apps-native-host`.

## Requirements

- Node.js 24 LTS.
- npm 10 or newer.
- The Power Apps Developer app from the Apple App Store or Google Play.

## Setup

**Building native mobile apps with Power Platform is in Private Preview; do not use this in production.**

Start from the Power Platform mobile app template, then use the mobile-app
skill to generate the app plan, data model, screens, native capabilities, and
connector wiring.

1. Create a new app from the template and install dependencies:

	```sh
	npx degit microsoft/power-platform-skills/plugins/mobile-apps/template#main my-mobile-app
	cd my-mobile-app
	npm install
	```

2. Install the mobile-app plugin from the Power Platform Skills marketplace.

	For GitHub Copilot in VS Code:

	1. Open the Extensions view.
	2. Enter `@agentplugin` in the search box.
	3. Find the Power Platform mobile-app plugin and select **Install**.
	4. Reload VS Code if prompted, then open Copilot Chat in Agent mode.

	Alternatively, install it from a terminal with GitHub Copilot CLI:

	```sh
	copilot plugin marketplace add microsoft/power-platform-skills
	copilot plugin install mobile-app@power-platform-skills
	```

	For Claude CLI:

	```sh
	claude plugin marketplace add microsoft/power-platform-skills
	claude plugin install mobile-app@power-platform-skills --scope user
	```

3. Open the template folder in VS Code and run the skill from Copilot Chat:

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
	the native app registration for this flow. You do not need to add redirect
	URIs or API permissions manually, and tenant-wide admin consent is not
	required.

	If the app was created without a client ID, run
	`/set-app-registration-native` later from the app folder. It opens the same
	environment-specific page and writes the pasted client ID to
	`auth.config.json`.

	### Required API permissions

	The Microsoft Entra app registration requires these delegated permissions from the **Power Platform API**.
	If you create the registration via Power Apps Wrap, it configures these automatically; the list is for reference only.

	- `PowerApps.Apps.Play`
	- `PowerApps.Apps.Read`
	- `Connectivity.Connectors.Read`
	- `Connectivity.Connections.Read`
	- `Connectivity.Connections.Write`
	- `Connectivity.Connections.UserConsent`


5. Start mobile app:

	Run the below command in a new terminal from the app directory.

	```bash
	npm run dev
	```

6. Preview the app by scanning the QR code with the Power Apps Developer app

	- App store: https://apps.apple.com/us/app/power-apps-developer/id6753083462
	- Play store: (coming soon)
	- App center: https://install.appcenter.ms/orgs/appmagic-player-x6ys/apps/rn-dev-player-preview/distribution_groups/public_distribution/releases

## Upgrade the Native Host

From the app directory, preview the next template upgrade:

```bash
npx --package @microsoft/power-apps-native-host@latest upgrade-template --dry-run
```

Apply it:

```bash
npx --package @microsoft/power-apps-native-host@latest upgrade-template
```

Each run upgrades one template version, installs compatible dependencies, and
runs Expo validation. If another version is available, run the command again.
The current version is stored in `app.json` under
`expo.extra.powerappsNative`; do not edit this object.

Apps created before this version file existed must specify their source template
version:

```bash
npx --package @microsoft/power-apps-native-host@latest \
	upgrade-template --from-version 1
```

The upgrader never changes `app/`, `src/`, `android/`, or `ios/`. If a root
configuration change conflicts with your customization, it writes a `.rej` file
for manual resolution. Failed validation restores files managed by the upgrade.

Supported package managers are npm, pnpm, and Bun. See
[CUSTOMIZATION.md](CUSTOMIZATION.md) before changing root configuration files.

### Manual migration to a new template

To migrate without `upgrade-template`, create a new app from the latest template
instead of modifying the old app in place. Commit or back up the old app first.

1. Create the new app and install its dependencies.
2. Copy the contents of `app/` and `src/` from the old app into the same
	directories in the new app:

	```bash
	cp -R ../old-app/app/. app/
	cp -R ../old-app/src/. src/
	```

3. Copy app-owned assets and settings such as `assets/`, `auth.config.json`,
	`power.config.json`, and `offline-profile.json` as needed. Review each file
	before replacing the version supplied by the new template.
4. Keep the new template's `package.json`, lock file, root configuration files,
	`android/`, and `ios/`. Reapply old customizations selectively rather than
	copying these files wholesale.
5. Run `npm install`, `npm run type-check`, and the bundle command for each
	target platform, such as `npm run bundle:android` or `npm run bundle:ios`.
6. Give the resulting errors to GitHub Copilot in Agent mode and ask it to
	update the migrated `app/` and `src/` code for the new template APIs while
	preserving the new template configuration. Review the changes and rerun the
	failing command until the build succeeds.

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

To publish as a Code App, run `npm run bundle:web`, set `appType` to `CodeApp`
and `distPath` to `dist-web` in `power.config.json`, then run
`npx power-apps push`.

To publish to Power Pages, run `npm run bundle:web -- powerpages`, then use the Power Pages
skills to upload the generated `dist-web` directory.

## License and notices

This template is provided under the license in `LICENSE`.
