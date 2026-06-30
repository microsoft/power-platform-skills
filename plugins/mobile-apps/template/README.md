# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 20 LTS.
- npm 10 or newer.
- The Power Apps Developer app from the Apple App Store or Google Play.

## Setup

Start from the Power Platform mobile app template, then use the mobile-app
skill to generate the app plan, data model, screens, native capabilities, and
connector wiring.

1. Create a new app from the template and install dependencies:

	```sh
	npx degit https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template#main my-mobile-app
	cd my-mobile-app
	npm install
	```

2. Install the mobile-app skill from the Power Platform skills plugin:

	```text
	https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/.plugin/plugin.json
	```

3. Open the template folder in VS Code and run the skill from Copilot Chat:

	```text
	/create-mobile-app
	```

	The template includes this host package and the required Expo / React Native
	runtime dependencies. The skill updates the app in place as it designs and
	generates the mobile experience.

4. Configure your app identity as needed:

	```bash
	APP_DISPLAY_NAME="Contoso Field App" \
	APP_SLUG="contoso-field-app" \
	APP_SCHEME="contoso-field-app" \
	ANDROID_PACKAGE="com.contoso.fieldapp" \
	IOS_BUNDLE_IDENTIFIER="com.contoso.fieldapp" \
	npm run dev
	```

5. Start Expo:

	```bash
	npm run dev
	```

## Supported Public Scripts

- `npm run dev`: starts Expo. The `predev` hook regenerates connector schemas first.
- `npm run generate-schemas`: regenerates `src/generated/connectorSchemas.ts` from `.power/schemas`.

## License and notices

This template is provided under the license in `LICENSE`.
