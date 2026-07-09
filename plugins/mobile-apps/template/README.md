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

4. Create a Microsoft Entra app registration and grant admin consent. (simplified experience coming soon)

	Create a native/public client app registration for the mobile app, then add
	the following redirect URIs:

	```text
	https://login.microsoftonline.com/common/oauth2/nativeclient
	msauth.com.microsoft.PreviewApp://auth
	```

	Add these API permissions as **Delegated** permissions, then grant admin
	consent for the tenant:

	- Azure API Connections
		- `Runtime.All`
	- Dynamics CRM
		- `user_impersonation`
	- Microsoft Graph
		- `User.Read`
	- Power Platform API
		- `Connectivity.Connections.Read`
		- `Connectivity.Connections.Write`
		- `Connectivity.Connectors.Read`
		- `PowerApps.Apps.Read`
	- PowerApps Service
		- `User`

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
