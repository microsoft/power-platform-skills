import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  PowerAppsProvider,
  darkTheme,
  lightTheme,
} from '@microsoft/power-apps-native-host';

import authConfig from '../auth.config.json';
import tamaguiConfig from '../tamagui.config';
// @ts-ignore - power.config.json is auto-generated at build time
import powerConfig from '../power.config.json';
// @ts-ignore - connectorSchemas is auto-generated at build time
import { schemaMap } from '../src/generated/connectorSchemas';

declare const require: (id: string) => unknown;
function isMissingOfflineProfile(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "Cannot find module '../offline-profile.json'" ||
    error.message === 'Cannot find module'
  );
}

let offlineProfile: Record<string, unknown> | undefined;
try {
  offlineProfile = require('../offline-profile.json') as Record<string, unknown>;
} catch (error: unknown) {
  if (!isMissingOfflineProfile(error)) throw error;
  offlineProfile = undefined;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <PowerAppsProvider
        msalConfig={authConfig.msal}
        powerConfig={powerConfig}
        schemaMap={schemaMap}
        tamaguiConfig={tamaguiConfig}
        offlineProfile={offlineProfile}
        defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}
        theme={lightTheme}
        darkTheme={darkTheme}
      >
        <StatusBar style="auto" />
        <Slot />
      </PowerAppsProvider>
    </SafeAreaProvider>
  );
}
