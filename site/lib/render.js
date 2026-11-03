'use strict';

// Renders the showcase site's HTML from the validated catalog. Every value that comes from
// JSON goes through escapeHtml or escapeAttr; nothing is inserted as raw HTML.
//
// Design brief (see plugins/power-pages/references/design-aesthetics.md for the method):
// - Audience and job: Power Platform makers, partners, and developers who want an AI assistant
//   to build for them. They come to find the plugin for their goal and install it.
// - Primary action: "Choose a plugin". Secondary: "Install everything".
// - Principal doubt: "Will an AI agent build this correctly, and is it safe in my environment?"
// - Proof: it is Microsoft's, open source, and the assistant asks before it acts; the hero
//   session shows the real steps a plugin takes, including where it stops for approval.
// - Design thesis: official and calm. The Power Platform ribbon's teal-to-green is the one
//   signal for "your assistant is working", on navy ink and cool paper, with Schibsted Grotesk
//   headlines, Public Sans text, JetBrains Mono for anything you type, and 10px corners.
// - Signature moment: the hero session, which turns a plain request into finished steps.

const links = require('./install-links.js');
const { PRODUCTS } = require('./catalog.js');

const REPO_URL = `https://github.com/${links.REPO}`;
const README_URL = `${REPO_URL}#readme`;
const TELEMETRY_URL = `${REPO_URL}#telemetry`;
const DEV_ENV_URL = 'https://learn.microsoft.com/power-platform/developer/create-developer-environment';
const CLAUDE_CODE_URL = 'https://code.claude.com/docs/en/setup';
const COPILOT_CLI_URL = 'https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli';
const COPILOT_APP_URL = 'https://github.com/features/ai/github-app';

// `short` is the visible label in tight pickers; the accessible name still starts with the
// full name, so the visible text stays part of it (WCAG 2.5.3).
const ASSISTANTS = [
  { id: 'claude-code', label: 'Claude Code', prefix: '', short: 'Claude Code' },
  { id: 'copilot-app', label: 'GitHub Copilot app', prefix: 'GitHub ', short: 'Copilot app' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', prefix: 'GitHub ', short: 'Copilot CLI' },
];

const AUDIENCE_LABELS = {
  makers: 'Makers',
  developers: 'Developers',
  both: 'Makers and developers',
};

const STATUS_LABELS = {
  preview: 'Preview',
  'private-preview': 'Private preview',
};

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const escapeAttr = escapeHtml;

// JSON inside <script type="application/json"> is data, not code, but the HTML parser still
// ends the element at the first "</script". Escaping "<" keeps any string value from closing it.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// One icon style for the whole site: 24px grid, 1.75 stroke, round caps and joins.
const ICON_PATHS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  waiting: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  system: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  badge: '<path d="M12 3l2.4 1.8 3-.2.9 2.9 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-.9 2.9-3-.2L12 21l-2.4-1.8-3 .2-.9-2.9L3.3 14.7l.9-2.9-.9-2.9 2.4-1.8.9-2.9 3 .2z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>',
  plug: '<path d="M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  sandbox: '<path d="M9 3h6M10 3v6.2L4.8 18.1A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.9L14 9.2V3"/><path d="M7.2 15h9.6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
};

function icon(name, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

// Product icons are decorative here: the product's name always appears beside them.
function productIcon(root, product, size, className = 'product-icon') {
  return `<img class="${className}" src="${escapeAttr(root + PRODUCTS[product].icon)}" alt="" width="${size}" height="${size}">`;
}

function themeSwitch() {
  // Hidden until site.js runs, because switching needs JavaScript. Without it the page
  // follows the system theme, which is also the default.
  const options = [
    ['system', 'Match system theme'],
    ['light', 'Light theme'],
    ['dark', 'Dark theme'],
  ].map(([value, label]) => `<button type="button" class="theme-option" data-theme-choice="${value}" aria-pressed="${value === 'system'}" title="${label}">${icon(value)}<span class="sr-only">${label}</span></button>`).join('');
  return `<div class="theme-switch" role="group" aria-label="Color theme" data-theme-switch hidden>${options}</div>`;
}

function siteHeader(root) {
  const home = root || './';
  return `<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${escapeAttr(home)}">
      <img class="brand-mark" src="${escapeAttr(root)}assets/brand/power-platform.svg" alt="" width="32" height="32">
      <span class="brand-name">Power Platform Skills</span>
    </a>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul class="nav-list">
        <li><a href="${escapeAttr(root)}#plugins">Plugins</a></li>
        <li><a href="${escapeAttr(root)}#how-it-works">How it works</a></li>
        <li><a href="${escapeAttr(root)}#install-everything">Install</a></li>
        <li><a href="${escapeAttr(root)}#questions">Questions</a></li>
        <li><a href="${REPO_URL}">GitHub</a></li>
      </ul>
      <a class="button button-primary button-small nav-cta" href="${escapeAttr(root)}#plugins">Choose a plugin</a>
      <div class="nav-theme"><span class="nav-theme-label" aria-hidden="true">Theme</span>${themeSwitch()}</div>
    </nav>
    <div class="header-tools">
      <button type="button" class="menu-button" aria-expanded="false" aria-controls="site-nav" data-menu-button>${icon('menu', 'icon icon-open')}${icon('close', 'icon icon-close')}<span class="sr-only">Menu</span></button>
    </div>
  </div>
</header>`;
}

function siteFooter(root) {
  return `<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <a class="brand" href="${escapeAttr(root || './')}">
        <img class="brand-mark" src="${escapeAttr(root)}assets/brand/power-platform.svg" alt="" width="28" height="28">
        <span class="brand-name">Power Platform Skills</span>
      </a>
      <p>An open source project from Microsoft, licensed under <a href="${REPO_URL}/blob/main/LICENSE">MIT</a>.</p>
    </div>
    <nav aria-label="Footer">
      <ul class="footer-links">
        <li><a href="${REPO_URL}">Source on GitHub</a></li>
        <li><a href="${REPO_URL}/issues">Report an issue</a></li>
        <li><a href="${TELEMETRY_URL}">Telemetry and privacy</a></li>
        <li><a href="${REPO_URL}/blob/main/SECURITY.md">Security</a></li>
        <li><a href="${REPO_URL}/blob/main/SUPPORT.md">Support</a></li>
      </ul>
    </nav>
    <p class="trademarks">Microsoft, Power Platform, Power Apps, Power Automate, Power Pages, and Dataverse are trademarks of the Microsoft group of companies. Other names may be trademarks of their respective owners.</p>
  </div>
</footer>`;
}

function layout({ title, description, root, body, scripts = [], data = null }) {
  const pageTitle = title ? `${title} | Power Platform Skills` : 'Power Platform Skills: AI assistant plugins for Power Platform';
  const dataBlock = data ? `\n<script type="application/json" id="page-data">${jsonForScript(data)}</script>` : '';
  const scriptTags = ['assets/site.js', ...scripts].map((src) => `\n<script src="${escapeAttr(root + src)}" defer></script>`).join('');
  // The site loads nothing from other origins, so the policy only allows its own files.
  // GitHub Pages cannot send response headers, which is why this is a meta tag.
  // Fonts are self-hosted for the same reason, and so visitors' addresses go to no font CDN.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeAttr(description)}">
<meta property="og:title" content="${escapeAttr(pageTitle)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:type" content="website">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f4f7f7" media="(prefers-color-scheme: light)" data-theme-color="light">
<meta name="theme-color" content="#08161f" media="(prefers-color-scheme: dark)" data-theme-color="dark">
<link rel="icon" href="${escapeAttr(root)}assets/brand/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="${escapeAttr(root)}assets/brand/power-platform.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${escapeAttr(root)}assets/brand/apple-touch-icon.png">
<link rel="preload" href="${escapeAttr(root)}assets/fonts/schibsted-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${escapeAttr(root)}assets/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<script src="${escapeAttr(root)}assets/theme.js"></script>
<link rel="stylesheet" href="${escapeAttr(root)}assets/styles.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${siteHeader(root)}
<main id="main">
${body}
</main>
${siteFooter(root)}
<div class="sr-only" aria-live="polite" id="announcer"></div>${dataBlock}${scriptTags}
</body>
</html>
`;
}

function copyButton(text, label = 'Copy') {
  // Hidden until site.js runs, because copying needs JavaScript. The text stays visible
  // and selectable either way.
  return `<button type="button" class="copy-button" data-copy="${escapeAttr(text)}" data-label="${escapeAttr(label)}" hidden>${escapeHtml(label)}</button>`;
}

function codeBlock(text, label) {
  // One block per command with a hanging indent, so a long command that wraps in a narrow
  // column still reads as one command rather than two. Each word is kept whole, because a
  // break after the hyphen in "power-pages" looks like two separate words to someone
  // typing the command by hand; only a word wider than the column breaks inside.
  // URLs are single words too long for a phone, so they may also break after each "/" (a <wbr>
  // adds no character, so selecting and copying the text still gives the exact command).
  const lines = text.split('\n').map((line) => {
    const words = line.split(' ').map((word) => `<span class="code-word">${escapeHtml(word).replace(/\/(?=[^/])/g, '/<wbr>')}</span>`).join(' ');
    return `<span class="code-line">${words}</span>`;
  }).join('');
  return `<div class="code-block"><pre><code>${lines}</code></pre>${copyButton(text, label)}</div>`;
}

function audienceLabel(plugin) {
  return AUDIENCE_LABELS[plugin.audience];
}

function statusBadge(plugin) {
  return plugin.status ? `<span class="badge">${escapeHtml(STATUS_LABELS[plugin.status])}</span>` : '';
}

// The product's name must sit next to its icon. When the plugin's own title already is the
// product name (Power Pages, Power Automate, Dataverse), the title is that label.
function productLabel(plugin) {
  const label = PRODUCTS[plugin.product].label;
  return label === plugin.title ? '' : label;
}

// One picker drives every install panel in its scope. Radio buttons keep it usable with a
// keyboard and without JavaScript; styles.css shows the matching panels with :has(), and
// site.js remembers the choice across pages.
function assistantPicker(scopeId, legend) {
  const options = ASSISTANTS.map((assistant, index) => `
        <label class="picker-option">
          <input type="radio" name="assistant-${escapeAttr(scopeId)}" value="${assistant.id}"${index === 0 ? ' checked' : ''}>
          <span>${assistant.prefix ? `<span class="sr-only">${escapeHtml(assistant.prefix)}</span>` : ''}${escapeHtml(assistant.short)}</span>
        </label>`).join('');
  return `<fieldset class="assistant-picker" data-assistant-picker>
      <legend>${escapeHtml(legend)}</legend>
      <div class="picker-options">${options}
      </div>
    </fieldset>`;
}

function pluginRow(plugin, root) {
  const page = `${root}plugins/${plugin.name}/`;
  const [cliAdd, cliInstall] = links.copilotCliCommands(plugin.name);
  // Every row has the same visible button labels, so screen readers also hear the plugin name.
  const forPlugin = `<span class="sr-only"> for ${escapeHtml(plugin.title)}</span>`;
  const product = productLabel(plugin);
  return `<li class="plugin-row">
        <div class="plugin-ident">
          ${productIcon(root, plugin.product, 44)}
          <div>
            <h4><a href="${escapeAttr(page)}">${escapeHtml(plugin.title)}</a></h4>
            ${product ? `<p class="plugin-product">${escapeHtml(product)}</p>` : ''}
          </div>
        </div>
        <div class="plugin-body">
          <p>${escapeHtml(plugin.summary)}</p>
          <p class="sample-prompt"><span class="sr-only">Example: </span>${escapeHtml(plugin.prompts[0])}</p>
          <p class="plugin-meta"><span>For ${escapeHtml(audienceLabel(plugin).toLowerCase())}</span>${statusBadge(plugin)}</p>
        </div>
        <div class="plugin-actions">
          <a class="button button-primary" data-for="claude-code" href="${escapeAttr(links.launcherUrl(root, 'claude-code', plugin.name))}">Install in Claude Code${forPlugin}</a>
          <a class="button button-primary" data-for="copilot-app" href="${escapeAttr(links.copilotAppInstallUrl(plugin.name))}">Install in Copilot app${forPlugin}</a>
          <a class="button button-primary" data-for="copilot-cli" href="${escapeAttr(page)}#install" data-copy="${escapeAttr(`${cliAdd}\n${cliInstall}`)}" data-label="Copy install commands"><span data-button-label>Copy install commands</span>${forPlugin}</a>
          <a class="text-link" href="${escapeAttr(page)}">Details<span class="sr-only"> about ${escapeHtml(plugin.title)}</span></a>
        </div>
      </li>`;
}

// ── Home ────────────────────────────────────────────────────────

function sessionScenarios(catalog, root) {
  return catalog.showcase.map((item) => {
    const plugin = catalog.plugins.find((candidate) => candidate.name === item.plugin);
    return {
      prompt: item.prompt,
      steps: item.steps,
      waiting: item.waiting || null,
      title: plugin.title,
      product: PRODUCTS[plugin.product].label,
      icon: root + PRODUCTS[plugin.product].icon,
      href: `${root}plugins/${plugin.name}/`,
    };
  });
}

function sessionStep(text, state) {
  const badge = state === 'waiting' ? '<span class="step-badge">Your turn</span>' : '';
  return `<li class="step is-${state}">${icon(state === 'waiting' ? 'waiting' : 'check', 'icon step-icon')}<span class="step-text">${escapeHtml(text)}</span>${badge}</li>`;
}

// The signature moment. The server renders the first example in its finished state, which is
// what visitors without JavaScript or with reduced motion see. site.js replays it step by step
// and lets visitors switch between examples.
function sessionWindow(scenarios) {
  const first = scenarios[0];
  const steps = first.steps.map((text) => sessionStep(text, 'done'));
  if (first.waiting) steps.push(sessionStep(first.waiting, 'waiting'));
  const tabs = scenarios.map((scenario, index) => `<button type="button" role="tab" class="scenario-tab" id="scenario-tab-${index}" aria-controls="session-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-scenario="${index}">${escapeHtml(scenario.title)}</button>`).join('');
  return `<div class="hero-visual">
      <figure class="session" data-session>
        <div class="session-bar">
          <span>Example session in your AI assistant</span>
        </div>
        <div class="session-body" id="session-panel">
          <p class="session-who">You</p>
          <p class="session-prompt"><span data-session-prompt>${escapeHtml(first.prompt)}</span><span class="caret" aria-hidden="true"></span></p>
          <div class="session-reply" data-session-reply>
            <p class="session-plugin">
              <img data-session-icon src="${escapeAttr(first.icon)}" alt="" width="28" height="28">
              <span><strong data-session-product>${escapeHtml(first.product)}</strong><span class="session-plugin-name" data-session-plugin>${escapeHtml(first.title)} plugin</span></span>
            </p>
            <ol class="session-steps" data-session-steps>
              ${steps.join('\n              ')}
            </ol>
          </div>
        </div>
        <figcaption class="session-caption">An example of the steps a plugin takes. <a data-session-link href="${escapeAttr(first.href)}">See the ${escapeHtml(first.title)} plugin</a></figcaption>
      </figure>
      <div class="scenario-tabs" role="tablist" aria-label="Example requests" data-scenario-tabs hidden>${tabs}</div>
      <template id="icon-done">${icon('check', 'icon step-icon')}</template>
      <template id="icon-waiting">${icon('waiting', 'icon step-icon')}</template>
    </div>`;
}

function heroSection(catalog, scenarios) {
  return `<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <h1 id="hero-title">Build on Power Platform by describing what you need</h1>
      <p class="lede">Free plugins from Microsoft teach GitHub Copilot and Claude Code to create Power Pages sites, Power Apps, and Power Automate flows, and to publish them to your environment.</p>
      <div class="hero-actions">
        <a class="button button-primary button-large" href="#plugins">Choose a plugin</a>
        <a class="button button-secondary button-large" href="#install-everything">Install everything</a>
      </div>
      <ul class="proof-list">
        <li>${icon('badge')}<span>Built by Microsoft</span></li>
        <li>${icon('code')}<span>Free and open source</span></li>
        <li>${icon('plug')}<span>${catalog.plugins.length} plugins for Claude Code and GitHub Copilot</span></li>
      </ul>
    </div>
    ${sessionWindow(scenarios)}
  </div>
</section>`;
}

function howSection() {
  return `<section class="how" id="how-it-works" aria-labelledby="how-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="how-title">How it works</h2>
      <p>Three steps, and nothing changes in your environment until you approve it.</p>
    </div>
    <ol class="process">
      <li>
        <span class="process-node" aria-hidden="true">1</span>
        <h3>Install the plugins</h3>
        <p>Add them to your AI assistant once, with one click or one command.</p>
      </li>
      <li>
        <span class="process-node" aria-hidden="true">2</span>
        <h3>Describe what you want</h3>
        <p>Open your assistant in a folder and ask in your own words. It asks follow-up questions when it needs to.</p>
      </li>
      <li>
        <span class="process-node" aria-hidden="true">3</span>
        <h3>Review and approve</h3>
        <p>Your assistant asks before it runs commands or changes files. Many plugins also show you a plan or confirm the environment before they publish.</p>
      </li>
    </ol>
  </div>
</section>`;
}

function pluginsSection(catalog, root) {
  const jump = catalog.goals.map((goal) => `<li><a href="#goal-${escapeAttr(goal.id)}">${escapeHtml(goal.title)}</a></li>`).join('');
  const groups = catalog.goals.map((goal) => {
    const rows = catalog.plugins.filter((plugin) => plugin.goal === goal.id).map((plugin) => pluginRow(plugin, root)).join('\n      ');
    return `<section class="goal-group" id="goal-${escapeAttr(goal.id)}" aria-labelledby="goal-${escapeAttr(goal.id)}-title">
    <div class="goal-head">
      <h3 id="goal-${escapeAttr(goal.id)}-title">${escapeHtml(goal.title)}</h3>
      <p>${escapeHtml(goal.summary)}</p>
    </div>
    <ul class="plugin-list">
      ${rows}
    </ul>
  </section>`;
  }).join('\n  ');
  return `<section class="plugins assistant-scope" id="plugins" aria-labelledby="plugins-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="plugins-title">Choose a plugin</h2>
      <p>Pick the assistant you use, then install the plugins for what you want to build. You can add more later.</p>
    </div>
    <div class="catalog-tools">
      ${assistantPicker('catalog', 'Your AI assistant')}
      <nav class="goal-nav" aria-label="Jump to a goal">
        <ul>${jump}</ul>
      </nav>
    </div>
    <div class="callout" data-for="copilot-app">
      <p><strong>First time in the Copilot app?</strong> Add the Power Platform marketplace before you install a plugin. You only do this once.</p>
      <a class="button button-secondary button-small" href="${escapeAttr(links.copilotAppMarketplaceUrl())}">Add the marketplace</a>
    </div>
    <div class="callout" data-for="claude-code">
      <p>Each button opens a terminal with the install command already typed. Press Enter to install. Clicking does nothing yet? Open Claude Code once and send any message, then try again.</p>
    </div>
    <div class="callout" data-for="copilot-cli">
      <p>Copilot CLI can't be opened from a link. Each button copies two commands. Paste them into a terminal and press Enter.</p>
    </div>
  ${groups}
  </div>
</section>`;
}

function controlSection() {
  return `<section class="control" aria-labelledby="control-title">
  <div class="wrap control-grid">
    <div class="control-intro">
      <h2 id="control-title">You stay in control</h2>
      <p>Plugins work with your sign-in and your permissions, on your computer. Here is what keeps you in charge.</p>
    </div>
    <ul class="assurances">
      <li>${icon('shield', 'icon assurance-icon')}<h3>It asks before it acts</h3><p>Your assistant asks before it runs a command or changes a file, and you can say no.</p></li>
      <li>${icon('sandbox', 'icon assurance-icon')}<h3>Try it somewhere safe</h3><p>A free <a href="${DEV_ENV_URL}">developer environment</a> keeps experiments away from your organization's live apps.</p></li>
      <li>${icon('code', 'icon assurance-icon')}<h3>Read every line</h3><p>Every plugin is open source under the MIT license, on <a href="${REPO_URL}">GitHub</a>.</p></li>
      <li>${icon('eye', 'icon assurance-icon')}<h3>Choose what you share</h3><p>Some plugins send usage data to Microsoft, and each one has a command to turn it off. <a href="${TELEMETRY_URL}">See what is collected</a>.</p></li>
    </ul>
  </div>
</section>`;
}

function installEverythingSection() {
  return `<section class="install-all" id="install-everything" aria-labelledby="install-all-title">
  <div class="wrap install-grid">
    <div class="install-copy">
      <h2 id="install-all-title">Install everything at once</h2>
      <p>One command installs every plugin into Claude Code and GitHub Copilot CLI, whichever you have. It also installs the Power Platform CLI if it is missing, and turns on automatic updates.</p>
      <p>You need <a href="https://nodejs.org/en/download">Node.js</a> and at least one of <a href="${CLAUDE_CODE_URL}">Claude Code</a> or <a href="${COPILOT_CLI_URL}">GitHub Copilot CLI</a>.</p>
      <p class="fine-print">The Dataverse plugin is left out by default. To include it, use the commands under Include Dataverse.</p>
    </div>
    <div class="terminal">
      <h3>On Windows, in PowerShell</h3>
      ${codeBlock(links.INSTALL_ALL.windows, 'Copy command')}
      <h3>On macOS, Linux, or the Windows Command Prompt</h3>
      ${codeBlock(links.INSTALL_ALL.unix, 'Copy command')}
      <details class="dataverse-commands" id="include-dataverse">
        <summary>Include Dataverse</summary>
        <h3>On Windows, in PowerShell</h3>
        ${codeBlock(links.INSTALL_ALL_WITH_DATAVERSE.windows, 'Copy command')}
        <h3>On macOS, Linux, or the Windows Command Prompt</h3>
        ${codeBlock(links.INSTALL_ALL_WITH_DATAVERSE.unix, 'Copy command')}
      </details>
    </div>
  </div>
</section>`;
}

function faqSection(catalog) {
  const items = catalog.faq.map((item) => `<details>
      <summary>${escapeHtml(item.question)}</summary>
      <p>${escapeHtml(item.answer)}</p>
    </details>`).join('\n    ');
  return `<section class="faq" id="questions" aria-labelledby="faq-title">
  <div class="wrap faq-grid">
    <div>
      <h2 id="faq-title">Questions</h2>
      <p>Before you start, you need an AI assistant (<a href="${CLAUDE_CODE_URL}">Claude Code</a>, the <a href="${COPILOT_APP_URL}">GitHub Copilot app</a>, or <a href="${COPILOT_CLI_URL}">GitHub Copilot CLI</a>) and a Power Platform environment you can build in.</p>
    </div>
    <div class="faq-list">
    ${items}
    <p class="fine-print">More answers, a glossary, and developer docs are in the <a href="${README_URL}">README</a>.</p>
    </div>
  </div>
</section>`;
}

function finalSection() {
  return `<section class="final-cta" aria-labelledby="final-title">
  <div class="wrap final-grid">
    <div>
      <h2 id="final-title">Pick a plugin and ask your first question</h2>
      <p>Start with the goal you care about most. You can add more plugins at any time.</p>
    </div>
    <a class="button button-ink button-large" href="#plugins">Choose a plugin</a>
  </div>
</section>`;
}

function renderHome(catalog) {
  const root = '';
  const scenarios = sessionScenarios(catalog, root);
  return layout({
    title: '',
    description: 'Free plugins from Microsoft that teach GitHub Copilot and Claude Code to build Power Pages sites, Power Apps, and Power Automate flows.',
    root,
    body: [
      heroSection(catalog, scenarios),
      howSection(),
      pluginsSection(catalog, root),
      controlSection(),
      installEverythingSection(),
      faqSection(catalog),
      finalSection(),
    ].join('\n'),
    data: { scenarios },
  });
}

// ── Plugin page ─────────────────────────────────────────────────

function installPanel(plugin, root) {
  const [cliAdd, cliInstall] = links.copilotCliCommands(plugin.name);
  return `<section class="install-panel assistant-scope" id="install" aria-labelledby="install-title">
      <h2 id="install-title">Install ${escapeHtml(plugin.title)}</h2>
      ${assistantPicker('plugin', 'Your AI assistant')}
      <div class="install-option" data-for="claude-code">
        <p>Opens a terminal with the install command already typed. Press Enter to install.</p>
        <a class="button button-primary button-block" href="${escapeAttr(links.launcherUrl(root, 'claude-code', plugin.name))}">Install in Claude Code</a>
        <p class="fine-print">Prefer to type it? Run this in a terminal:</p>
        ${codeBlock(links.claudeCodeShellCommand(plugin.name), 'Copy command')}
        <p class="fine-print">The Claude desktop app's Code tab and the Claude Code extension for VS Code use the same plugins.</p>
      </div>
      <div class="install-option" data-for="copilot-app">
        <ol class="install-steps">
          <li><p>Add the Power Platform marketplace. You only do this once.</p><a class="button button-secondary button-block" href="${escapeAttr(links.copilotAppMarketplaceUrl())}">Add the marketplace</a></li>
          <li><p>Install the plugin.</p><a class="button button-primary button-block" href="${escapeAttr(links.copilotAppInstallUrl(plugin.name))}">Install in Copilot app</a></li>
        </ol>
        <p class="fine-print">The app asks you to confirm each step.</p>
      </div>
      <div class="install-option" data-for="copilot-cli">
        <p>Paste these into a terminal and press Enter.</p>
        ${codeBlock(`${cliAdd}\n${cliInstall}`, 'Copy commands')}
        <p class="fine-print">VS Code also picks up plugins you install with Copilot CLI.</p>
      </div>
    </section>`;
}

function listSection(id, title, items) {
  if (!items.length) return '';
  return `<section aria-labelledby="${id}">
      <h2 id="${id}">${escapeHtml(title)}</h2>
      <ul class="plain-list">
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n        ')}
      </ul>
    </section>`;
}

// Ends each plugin page with somewhere to go next: plugins for the same goal first, then
// others, so a visitor who picked the wrong plugin finds the right one without going back.
function relatedPlugins(plugin, catalog) {
  const sameGoal = catalog.plugins.filter((other) => other !== plugin && other.goal === plugin.goal);
  const others = catalog.plugins.filter((other) => other !== plugin && other.goal !== plugin.goal);
  return [...sameGoal, ...others].slice(0, 3);
}

function renderPlugin(plugin, catalog) {
  const root = '../../';
  const goal = catalog.goals.find((item) => item.id === plugin.goal);
  const product = PRODUCTS[plugin.product].label;
  const prompts = plugin.prompts.map((prompt) => `<li><span class="prompt-quote">${escapeHtml(prompt)}</span>${copyButton(prompt, 'Copy')}</li>`).join('\n        ');
  const skills = plugin.skills.map((skill) => `<div><dt><code>/${escapeHtml(skill.name)}</code></dt><dd>${escapeHtml(skill.description)}</dd></div>`).join('\n        ');
  const learn = [
    { title: plugin.external ? 'Plugin documentation (separate repository)' : 'Plugin documentation on GitHub', url: plugin.docsUrl },
    ...plugin.learn,
  ].map((link) => `<li><a href="${escapeAttr(link.url)}">${escapeHtml(link.title)}</a></li>`).join('\n        ');
  const meta = [
    `<span>For ${escapeHtml(audienceLabel(plugin).toLowerCase())}</span>`,
    statusBadge(plugin),
    plugin.version ? `<span>Version ${escapeHtml(plugin.version)}</span>` : '',
  ].filter(Boolean).join('\n        ');
  const related = relatedPlugins(plugin, catalog).map((other) => `<li>
        <a class="related-link" href="${root}plugins/${escapeAttr(other.name)}/">
          ${productIcon(root, other.product, 36)}
          <span><strong>${escapeHtml(other.title)}</strong>${productLabel(other) ? `<span class="related-product">${escapeHtml(productLabel(other))}</span>` : ''}<span>${escapeHtml(other.summary)}</span></span>
        </a>
      </li>`).join('\n      ');

  const body = `<div class="plugin-page">
<div class="wrap plugin-grid">
    <header class="plugin-head">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><a href="${root}#plugins">All plugins</a></li>
          <li><a href="${root}#goal-${escapeAttr(goal.id)}">${escapeHtml(goal.title)}</a></li>
        </ol>
      </nav>
      <p class="product-line">${productIcon(root, plugin.product, 40)}<span>${escapeHtml(product)}</span></p>
      <h1>${escapeHtml(plugin.title)}</h1>
      <p class="lede">${escapeHtml(plugin.summary)}</p>
      <p class="plugin-facts">
        ${meta}
      </p>
    </header>
    ${installPanel(plugin, root)}
    <div class="plugin-details">
    <section aria-labelledby="ask-title">
      <h2 id="ask-title">Things you can ask</h2>
      <ul class="prompt-list">
        ${prompts}
      </ul>
    </section>
    ${listSection('needs-title', 'What you need', plugin.requirements)}
    <section aria-labelledby="skills-title">
      <h2 id="skills-title">Skills you can run</h2>
      <p>Your assistant picks the right skill from your request. You can also start one by typing its name.</p>
      <dl class="skill-list">
        ${skills}
      </dl>
    </section>
    ${listSection('notes-title', 'Good to know', plugin.notes)}
    <section aria-labelledby="learn-title">
      <h2 id="learn-title">Learn more</h2>
      <ul class="plain-list">
        ${learn}
      </ul>
    </section>
    </div>
</div>
</div>
<section class="related" aria-labelledby="related-title">
  <div class="wrap">
    <h2 id="related-title">More plugins</h2>
    <ul class="related-list">
      ${related}
    </ul>
  </div>
</section>`;

  return layout({
    title: plugin.title,
    description: plugin.summary,
    root,
    body,
  });
}

// ── Launcher and 404 ────────────────────────────────────────────

function renderLauncher(catalog) {
  const root = '../';
  // The launcher builds links only for plugins in this allowlist and only from the fixed
  // templates in install-links.js, so a crafted URL cannot pre-fill an arbitrary prompt.
  const data = {
    plugins: Object.fromEntries(catalog.plugins.map((plugin) => [plugin.name, plugin.title])),
  };
  const body = `<div class="wrap launcher">
  <section data-launcher-state="ready" hidden aria-labelledby="launcher-title">
    <h1 id="launcher-title">Opening Claude Code</h1>
    <p class="lede">A terminal window opens with this command typed in. Press Enter to install <span data-launcher-plugin></span>.</p>
    <div class="code-block"><pre><code data-launcher-prompt></code></pre></div>
    <p><a class="button button-primary button-large" data-launcher-open href="#">Open Claude Code</a></p>
    <p class="fine-print" data-launcher-desktop>Your browser may ask whether to open the link. Choose Open.</p>
    <p class="callout" data-launcher-touch hidden>Claude Code runs on a computer. Open this page on the computer where you use Claude Code, or send yourself the link.</p>
    <h2>Nothing happened?</h2>
    <ol class="plain-list numbered">
      <li>Make sure <a href="${CLAUDE_CODE_URL}">Claude Code</a> is installed.</li>
      <li>Open Claude Code once in a terminal and send any message, such as <code>/help</code>. That lets your computer open Claude Code from links. Then try the button again.</li>
      <li>If Claude Code says it doesn't recognize <code>--marketplace</code>, run <code>claude update</code> and try again.</li>
      <li>Or skip the link and run this in a terminal:</li>
    </ol>
    <div class="code-block"><pre><code data-launcher-shell></code></pre><button type="button" class="copy-button" data-launcher-copy data-label="Copy command" hidden>Copy command</button></div>
    <p><a href="${root}#plugins">Back to all plugins</a></p>
  </section>
  <section data-launcher-state="invalid" hidden aria-labelledby="invalid-title">
    <h1 id="invalid-title">This install link isn't valid</h1>
    <p class="lede">The link doesn't name a plugin from the Power Platform Skills marketplace.</p>
    <p><a class="button button-primary" href="${root}#plugins">Choose a plugin</a></p>
  </section>
  <noscript>
    <h1>Install links need JavaScript</h1>
    <p>Turn on JavaScript, or follow the install steps on the <a href="${root}#plugins">plugin page</a>.</p>
  </noscript>
</div>`;
  return layout({
    title: 'Install',
    description: 'Open Claude Code with a Power Platform Skills plugin ready to install.',
    root,
    body,
    scripts: ['assets/install-links.js', 'assets/launcher.js'],
    data,
  });
}

// GitHub Pages serves 404.html for a missing path at any depth, so relative links would break.
// `basePath` is the site's absolute path, such as "/power-platform-skills/", which keeps the
// page working on forks and local previews that are served from a different path.
function renderNotFound(basePath) {
  const root = basePath;
  const body = `<div class="wrap launcher">
  <h1>This page doesn't exist</h1>
  <p class="lede">The link may be old, or the plugin may have a new name.</p>
  <p><a class="button button-primary" href="${escapeAttr(root)}#plugins">See all plugins</a></p>
</div>`;
  return layout({ title: 'Page not found', description: 'Page not found.', root, body });
}

module.exports = {
  ASSISTANTS,
  escapeHtml,
  jsonForScript,
  renderHome,
  renderPlugin,
  renderLauncher,
  renderNotFound,
};
