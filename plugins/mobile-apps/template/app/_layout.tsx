import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PowerAppsProvider } from '@microsoft/power-apps-native-host';

import appConfig from '../app.json';
import authConfig from '../auth.config.json';
import tamaguiConfig from '../tamagui.config';

declare const require: (id: string) => unknown;

function isMissingModule(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Cannot find module');
}

/**
 * `power.config.json`, `src/generated/connectorSchemas` and `offline-profile.json` are all
 * produced after the project is created, so this file must tolerate each being absent or the
 * app cannot bundle at all before then. Tolerating them is what lets the app render straight
 * after `npm install`, before an environment is chosen or `npx power-apps init` has run; a
 * generated app always has the real files by the time it is pushed.
 *
 * Each id is written as a literal. Metro resolves `require()` statically and rejects a variable
 * id with "Invalid call ... require(id)", so these cannot be folded into a shared helper that
 * takes the id as a parameter - the repetition is load-bearing.
 */
let powerConfig: Record<string, unknown> = {};
try {
  powerConfig = require('../power.config.json') as Record<string, unknown>;
} catch (error: unknown) {
  if (!isMissingModule(error)) throw error;
}

let schemaMap: Record<string, unknown> = {};
try {
  const generated = require('../src/generated/connectorSchemas') as {
    schemaMap?: Record<string, unknown>;
  };
  schemaMap = generated.schemaMap ?? {};
} catch (error: unknown) {
  if (!isMissingModule(error)) throw error;
}

let offlineProfile: Record<string, unknown> | undefined;
try {
  offlineProfile = require('../offline-profile.json') as Record<string, unknown>;
} catch (error: unknown) {
  if (!isMissingModule(error)) throw error;
  offlineProfile = undefined;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <PowerAppsProvider
        appConfig={appConfig}
        msalConfig={authConfig.msal}
        powerConfig={powerConfig}
        schemaMap={schemaMap}
        tamaguiConfig={tamaguiConfig}
        offlineProfile={offlineProfile}
        defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}
      >
        <StatusBar style="auto" />
        <Slot />
      </PowerAppsProvider>
    </SafeAreaProvider>
  );
}
