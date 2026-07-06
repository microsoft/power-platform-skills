/**
 * Type declarations for JSON config files imported in this project.
 *
 * auth.config.json is the single source of truth for all auth and
 * app-identity settings. TypeScript will use this declaration to type-check
 * every import of that file.
 */

import type { AuthConfig } from '@microsoft/power-apps-native-host';

declare module '*/auth.config.json' {
  const value: AuthConfig;
  export default value;
}
