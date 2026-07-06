import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PowerAppsProvider } from '@microsoft/power-apps-native-host';

import authConfig from '../auth.config.json';
// @ts-ignore - power.config.json is auto-generated at build time
import powerConfig from '../power.config.json';
// @ts-ignore - connectorSchemas is auto-generated at build time
import { schemaMap } from '../src/generated/connectorSchemas';

export default function RootLayout() {
  return (
    <PowerAppsProvider
      msalConfig={authConfig.msal}
      powerConfig={powerConfig}
      schemaMap={schemaMap}
    >
      <StatusBar style="auto" />
      <Slot />
    </PowerAppsProvider>
  );
}

