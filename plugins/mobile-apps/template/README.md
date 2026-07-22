# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 22 LTS.
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

	1. Open the Command Palette.
	2. Run **Chat: Install Plugin From Source**.
	3. Paste the mobile-app plugin manifest URL:

		```text
		https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/.plugin/plugin.json
		```

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

5. Start mobile app:

	Run the below command in a new terminal from the app directory.

	```bash
	npm run dev
	```

6. Preview the app by scanning the QR code with the Power Apps Developer app

	- App store: https://apps.apple.com/us/app/power-apps-developer/id6753083462
	- Play store: (coming soon)
	- App center: https://install.appcenter.ms/orgs/appmagic-player-x6ys/apps/rn-dev-player-preview/distribution_groups/public_distribution/releases

## License and notices

This template is provided under the license in `LICENSE`.
