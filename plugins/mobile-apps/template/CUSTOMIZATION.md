# Customize Your App Safely

You can customize this app while continuing to receive template upgrades.

## Change freely

You can make any changes under:

- `app/`
- `src/`

Add, edit, move, rename, or delete screens, components, services, styles, and
other app code in these directories. `upgrade-template` never changes them.

You can also add your own dependencies, scripts, assets, and other files. Custom
dependencies are kept during upgrades, although incompatible packages may need
to be updated for a newer Expo SDK.

## Generated connector schemas

Do not edit `src/generated/connectorSchemas.ts` manually. After adding or
removing connectors, regenerate it with:

```bash
npm run generate-schemas
```

Commit the generated file with your app. Template upgrades never change it.

## Be careful with root files

JavaScript and configuration files in the project root may be updated by future
template upgrades. Examples include:

- `app.config.js`
- `babel.config.js`
- `metro.config.js`
- `tamagui.config.ts`
- `tsconfig.json`

Keep changes to these files small and focused. If your changes overlap a future
template update, the upgrader may create a `.rej` file that you must resolve
manually.

When a root file contains customization markers, edit only inside marked
sections. Do not remove or rename comments that say `DO NOT REMOVE OR RENAME THE COMMENT`.
Future template updates keep marked sections unchanged, which reduces upgrade conflicts.

In `app.config.js`, use `CUSTOMER APP SETTINGS` for app identity, package names,
icon, and version defaults. Use `CUSTOMIZATION` for additional Expo config
overrides.

Do not edit or delete `expo.extra.powerappsNative` in `app.json`. It records
which template upgrades have been applied.

The upgrader does not change `android/` or `ios/`. If you maintain native
projects, update them separately when required.

## Before upgrading

1. Commit or back up your work.
2. Preview the upgrade:

   ```bash
   npx --package @microsoft/power-apps-native-host@latest upgrade-template --dry-run
   ```

3. Review warnings and run the upgrade.
4. Resolve any `.rej` files, then test your app.