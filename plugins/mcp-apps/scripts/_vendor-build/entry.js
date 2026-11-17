import { webDarkTheme, webLightTheme } from '@fluentui/tokens';
// The convenience app-with-deps export embeds upstream dependency copies, so lockfile
// security updates would not reach the runtime. Bundle the peer-dependent entry instead.
import { App } from '@modelcontextprotocol/ext-apps';

// The generated widget application runs in a separate module block. Expose only
// the stable values it needs instead of leaking every bundled package export.
globalThis.McpAppsRuntime = Object.freeze({
  App,
  webDarkTheme,
  webLightTheme,
});
