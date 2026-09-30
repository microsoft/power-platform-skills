import type { ComponentProps } from 'react';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PowerAppsProvider } from '@microsoft/power-apps-native-host';

import appConfig from '../app.json';
import authConfig from '../auth.config.json';
import tamaguiConfig from '../tamagui.config';

declare const require: (id: string) => unknown;

/**
 * Taken from the provider's own props rather than restated here. `schemaMap` is
 * `Record<string, ConnectorSchema>`, not `Record<string, unknown>`; typing it loosely compiles
 * until the value reaches the provider and then fails the scaffold gate with TS2322. Deriving it
 * means this file cannot drift from the host package across an upgrade.
 */
type ProviderProps = ComponentProps<typeof PowerAppsProvider>;

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
let powerConfig: ProviderProps['powerConfig'] = {};
try {
  powerConfig = require('../power.config.json') as ProviderProps['powerConfig'];
} catch (error: unknown) {
  if (!isMissingModule(error)) throw error;
}

let schemaMap: ProviderProps['schemaMap'] = {};
try {
  const generated = require('../src/generated/connectorSchemas') as {
    schemaMap?: ProviderProps['schemaMap'];
  };
  schemaMap = generated.schemaMap ?? {};
} catch (error: unknown) {
  if (!isMissingModule(error)) throw error;
}

let offlineProfile: ProviderProps['offlineProfile'];
try {
  offlineProfile = require('../offline-profile.json') as ProviderProps['offlineProfile'];
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
