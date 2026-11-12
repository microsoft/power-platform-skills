/**
 * Install commands and one-click install links for Power Platform Skills plugins.
 *
 * This file is the single source of truth for every install command and link that the
 * showcase site renders, that the browser launcher page builds, and that the README tests
 * compare against. It runs in Node (build and tests) and in the browser (copied to the
 * site's assets folder as-is), so it uses no Node APIs and no ES module syntax.
 *
 * Every link reuses a URL handler that the AI assistant already registers, so a click never
 * runs anything by itself:
 *   - Claude Code registers `claude-cli://open`. The link only pre-fills the prompt box in a
 *     new terminal window; the user still reads it and presses Enter.
 *     https://code.claude.com/docs/en/deep-links
 *   - The GitHub Copilot app accepts `ghapp://plugins/...` links through GitHub's hosted
 *     https launcher, and shows a confirmation before it adds a marketplace or installs.
 *     https://docs.github.com/copilot/how-tos/github-copilot-app/open-with-deep-links
 *   - GitHub Copilot CLI registers no URL handler, so it gets copyable commands instead.
 *
 * GitHub-rendered Markdown strips custom schemes such as `claude-cli:`, so README links to
 * Claude Code go through the site's /install/ launcher page, the same way VS Code links go
 * through vscode.dev/redirect.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PowerPlatformSkillsInstallLinks = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REPO = 'microsoft/power-platform-skills';
  const MARKETPLACE = 'power-platform-skills';
  const SITE_URL = 'https://microsoft.github.io/power-platform-skills/';
  const INSTALLER_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/scripts/install.js';
  const COPILOT_APP_LAUNCHER = 'https://github.com/copilot/app/launch?open=';

  // The launcher page accepts only these `app` values. Copilot app links already use an https
  // launcher that GitHub renders, so only Claude Code needs our own redirect page.
  const LAUNCHER_APPS = ['claude-code'];

  // The same Open Plugins name grammar as scripts/install.js: 1-64 lowercase letters or
  // digits, with single dots or hyphens between alphanumeric characters. Names are already
  // allowlisted against marketplace.json; this is defense in depth, because a name ends up
  // inside a prompt that an assistant will run once the user presses Enter.
  function isValidPluginName(name) {
    const match = typeof name === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.exec(name);
    return Boolean(match && match[0] === name && name.indexOf('--') === -1 && name.indexOf('..') === -1);
  }

  function requireName(name) {
    if (!isValidPluginName(name)) {
      throw new Error('Invalid plugin name: ' + JSON.stringify(name));
    }
    return name;
  }

  // Claude Code v2.1.275 and later accept `--marketplace` in a session: it adds the marketplace
  // when it is missing and reuses it otherwise, so one prompt works on a fresh machine.
  // https://code.claude.com/docs/en/plugins/install#add-a-marketplace-and-install-in-one-command
  function claudeCodePrompt(name) {
    return '/plugin install ' + requireName(name) + ' --marketplace ' + REPO;
  }

  function claudeCodeShellCommand(name) {
    return 'claude plugin install ' + requireName(name) + ' --marketplace ' + REPO;
  }

  function claudeCodeDeepLink(name) {
    return 'claude-cli://open?q=' + encodeURIComponent(claudeCodePrompt(name));
  }

  // `base` is the site root: an absolute URL for README links, or a relative path such as
  // '../../' for links between site pages, so the site also works from a local preview.
  function launcherUrl(base, app, name) {
    if (LAUNCHER_APPS.indexOf(app) === -1) {
      throw new Error('Unsupported launcher app: ' + JSON.stringify(app));
    }
    return base + 'install/?app=' + encodeURIComponent(app) + '&plugin=' + encodeURIComponent(requireName(name));
  }

  // The launcher wants the whole app link encoded in `open`, and each query value inside the
  // app link encoded first, so `@` and `/` end up double-encoded in the final URL.
  function copilotAppUrl(appLink) {
    return COPILOT_APP_LAUNCHER + encodeURIComponent(appLink);
  }

  function copilotAppMarketplaceUrl() {
    return copilotAppUrl('ghapp://plugins/marketplace/add?source=' + encodeURIComponent(REPO));
  }

  function copilotAppInstallUrl(name) {
    return copilotAppUrl('ghapp://plugins/install?source=' + encodeURIComponent(requireName(name) + '@' + MARKETPLACE));
  }

  function copilotCliCommands(name) {
    return [
      'copilot plugin marketplace add ' + REPO,
      'copilot plugin install ' + requireName(name) + '@' + MARKETPLACE,
    ];
  }

  // Both commands on one line, so a single paste and a single Enter run them. Two pasted lines
  // run as two commands, or wait in the buffer, depending on the shell.
  // The separator is ';' rather than '&&' for two reasons:
  //   - `copilot plugin marketplace add` exits 1 when the marketplace is already registered:
  //       Failed to add marketplace: ... Marketplace "power-platform-skills" already registered
  //     so '&&' would skip the install for anyone adding a second plugin.
  //   - Windows PowerShell 5.1, the default on Windows, rejects '&&'; ';' works there, in
  //     PowerShell 7, bash, zsh, and fish. cmd.exe needs '&' instead, which the site says.
  function copilotCliCommand(name) {
    return copilotCliCommands(name).join('; ');
  }

  // The one-line installers from the README. PowerShell gets its own form because Windows
  // PowerShell aliases `curl` to Invoke-WebRequest, which cannot pipe a script into node.
  const INSTALL_ALL = {
    windows: 'iwr ' + INSTALLER_URL + ' -OutFile install.js; node install.js; del install.js',
    unix: 'curl -fsSL ' + INSTALLER_URL + ' | node',
  };

  // The installer flag must reach install.js, not node or del, so it cannot simply be appended:
  //   curl ... | node --include-dataverse    -> node rejects the unknown option
  //   ...; del install.js --include-dataverse -> the flag lands on del, and the install skips Dataverse
  // `node -` makes node read the piped script and pass the arguments after it to the script.
  const INSTALL_ALL_WITH_DATAVERSE = {
    windows: 'iwr ' + INSTALLER_URL + ' -OutFile install.js; node install.js --include-dataverse; del install.js',
    unix: 'curl -fsSL ' + INSTALLER_URL + ' | node - --include-dataverse',
  };

  // Computers the site has install steps for. macOS and Linux share the curl one-liner; only
  // how you open a terminal differs.
  const OPERATING_SYSTEMS = ['windows', 'macos', 'linux'];

  function installAllCommand(os, options) {
    const commands = options && options.dataverse ? INSTALL_ALL_WITH_DATAVERSE : INSTALL_ALL;
    if (OPERATING_SYSTEMS.indexOf(os) === -1) throw new Error('Unknown operating system: ' + JSON.stringify(os));
    return os === 'windows' ? commands.windows : commands.unix;
  }

  // Guesses the visitor's computer from what the browser reports, so the site can show the one
  // install command that fits. Returns null for phones and tablets (the assistant runs on a
  // computer) and when nothing matches; the page then asks the visitor to choose.
  // Inputs, as browsers report them:
  //   userAgentData.platform  "Windows" | "macOS" | "Linux" | "Chrome OS" | "Android" (Chromium only)
  //   userAgentData.mobile    true on phones (Chromium only)
  //   platform                "Win32" | "MacIntel" | "Linux x86_64" | "iPhone" | "iPad" (deprecated, still set)
  //   userAgent               "... (Windows NT 10.0; Win64; x64) ..." | "... (Macintosh; Intel Mac OS X 10_15_7) ..."
  //                           | "... (X11; Linux x86_64) ..." | "... (Linux; Android 14; ...) ..."
  //   maxTouchPoints          iPadOS 13+ reports "MacIntel" like a Mac, but with touch points above 1
  function detectOs(nav) {
    const data = (nav && nav.userAgentData) || {};
    const platform = String(data.platform || (nav && nav.platform) || '');
    const agent = String((nav && nav.userAgent) || '');
    if (data.mobile || /android|iphone|ipad|ipod/i.test(platform + ' ' + agent)) return null;
    if (/^win/i.test(platform) || /windows nt/i.test(agent)) return 'windows';
    if (/mac/i.test(platform) || /macintosh/i.test(agent)) {
      return nav && nav.maxTouchPoints > 1 ? null : 'macos';
    }
    // Chrome OS runs the commands in its Linux development environment.
    if (/linux|chrome os|cros|x11/i.test(platform + ' ' + agent)) return 'linux';
    return null;
  }

  return {
    REPO: REPO,
    MARKETPLACE: MARKETPLACE,
    SITE_URL: SITE_URL,
    INSTALLER_URL: INSTALLER_URL,
    LAUNCHER_APPS: LAUNCHER_APPS,
    INSTALL_ALL: INSTALL_ALL,
    INSTALL_ALL_WITH_DATAVERSE: INSTALL_ALL_WITH_DATAVERSE,
    OPERATING_SYSTEMS: OPERATING_SYSTEMS,
    installAllCommand: installAllCommand,
    detectOs: detectOs,
    isValidPluginName: isValidPluginName,
    claudeCodePrompt: claudeCodePrompt,
    claudeCodeShellCommand: claudeCodeShellCommand,
    claudeCodeDeepLink: claudeCodeDeepLink,
    launcherUrl: launcherUrl,
    copilotAppMarketplaceUrl: copilotAppMarketplaceUrl,
    copilotAppInstallUrl: copilotAppInstallUrl,
    copilotCliCommands: copilotCliCommands,
    copilotCliCommand: copilotCliCommand,
  };
}));
