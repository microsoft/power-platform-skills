import { webDarkTheme, webLightTheme } from '@fluentui/tokens';
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

// The generated widget application runs in a separate module block. Expose only
// the stable values it needs instead of leaking every bundled package export.
globalThis.McpAppsRuntime = Object.freeze({
  App,
  webDarkTheme,
  webLightTheme,
});
