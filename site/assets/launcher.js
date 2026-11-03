(function () {
  'use strict';

  // Opens Claude Code with a plugin install command pre-filled, for links that cannot use the
  // claude-cli: scheme directly. GitHub strips custom schemes from Markdown, so README buttons
  // point here instead, the same way VS Code links go through vscode.dev/redirect.
  //
  // Expected URL: install/?app=claude-code&plugin=<marketplace plugin name>
  // The page only builds links for plugin names in its build-time allowlist, and only from the
  // fixed templates in install-links.js. Anything else shows the "not valid" state, so a crafted
  // link cannot use this page to pre-fill an arbitrary prompt.

  const links = window.PowerPlatformSkillsInstallLinks;
  const data = JSON.parse(document.getElementById('page-data').textContent);
  const params = new URLSearchParams(window.location.search);
  const app = params.get('app');
  const plugin = params.get('plugin');
  const ready = document.querySelector('[data-launcher-state="ready"]');
  const invalid = document.querySelector('[data-launcher-state="invalid"]');

  // Duplicate parameters are ambiguous, because URLSearchParams.get reads only the first.
  const valid = params.getAll('app').length === 1
    && params.getAll('plugin').length === 1
    && links.LAUNCHER_APPS.indexOf(app) !== -1
    && Object.prototype.hasOwnProperty.call(data.plugins, plugin)
    && links.isValidPluginName(plugin);

  if (!valid) {
    invalid.hidden = false;
    return;
  }

  const title = data.plugins[plugin];
  const deepLink = links.claudeCodeDeepLink(plugin);
  const shellCommand = links.claudeCodeShellCommand(plugin);

  ready.querySelector('[data-launcher-plugin]').textContent = title;
  ready.querySelector('[data-launcher-prompt]').textContent = links.claudeCodePrompt(plugin);
  ready.querySelector('[data-launcher-shell]').textContent = shellCommand;
  ready.querySelector('[data-launcher-copy]').dataset.copy = shellCommand;
  ready.querySelector('[data-launcher-open]').href = deepLink;
  ready.hidden = false;
  document.title = `Install ${title} in Claude Code | Power Platform Skills`;

  // Try once on load, like vscode.dev/redirect does. The browser asks before it opens another
  // app, and if the person dismisses that prompt or has no handler, the button and the
  // fallback steps stay on screen. The short delay lets the page paint behind the prompt.
  window.setTimeout(() => {
    window.location.href = deepLink;
  }, 400);
}());
