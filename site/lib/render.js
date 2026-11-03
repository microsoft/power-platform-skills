'use strict';

// Renders the showcase site's HTML from the validated catalog. Every value that comes from
// JSON goes through escapeHtml or escapeAttr; nothing is inserted as raw HTML.

const links = require('./install-links.js');

const REPO_URL = `https://github.com/${links.REPO}`;
const README_URL = `${REPO_URL}#readme`;
const TELEMETRY_URL = `${REPO_URL}#telemetry`;

const ASSISTANTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'copilot-app', label: 'GitHub Copilot app' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI' },
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

function layout({ title, description, root, body, scripts = [], data = null }) {
  const pageTitle = title ? `${title} | Power Platform Skills` : 'Power Platform Skills';
  const dataBlock = data ? `\n<script type="application/json" id="page-data">${jsonForScript(data)}</script>` : '';
  const scriptTags = scripts.map((src) => `\n<script src="${escapeAttr(root + src)}" defer></script>`).join('');
  // The site loads nothing from other origins, so the policy only allows its own files.
  // GitHub Pages cannot send response headers, which is why this is a meta tag.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeAttr(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${escapeAttr(root)}assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${escapeAttr(root)}assets/styles.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-row">
    <a class="wordmark" href="${escapeAttr(root || './')}">Power Platform Skills</a>
    <nav aria-label="Main">
      <ul class="nav-list">
        <li><a href="${escapeAttr(root)}#plugins">Plugins</a></li>
        <li><a href="${escapeAttr(root)}#install-everything">Install</a></li>
        <li><a href="${escapeAttr(root)}#questions">Questions</a></li>
        <li><a href="${REPO_URL}">GitHub</a></li>
      </ul>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <p>Power Platform Skills is an open source project from Microsoft, licensed under <a href="${REPO_URL}/blob/main/LICENSE">MIT</a>.</p>
    <ul class="footer-links">
      <li><a href="${REPO_URL}">Source on GitHub</a></li>
      <li><a href="${TELEMETRY_URL}">Telemetry and privacy</a></li>
      <li><a href="${REPO_URL}/blob/main/SECURITY.md">Security</a></li>
      <li><a href="${REPO_URL}/blob/main/SUPPORT.md">Support</a></li>
    </ul>
  </div>
</footer>
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
  const lines = text.split('\n').map((line) => {
    const words = line.split(' ').map((word) => `<span class="code-word">${escapeHtml(word)}</span>`).join(' ');
    return `<span class="code-line">${words}</span>`;
  }).join('');
  return `<div class="code-block"><pre><code>${lines}</code></pre>${copyButton(text, label)}</div>`;
}

function audienceLabel(plugin) {
  return AUDIENCE_LABELS[plugin.audience];
}

function statusBadge(plugin) {
  return plugin.status ? `<span class="badge badge-status">${escapeHtml(STATUS_LABELS[plugin.status])}</span>` : '';
}

// One picker drives every install panel in its scope. Radio buttons keep it usable with a
// keyboard and without JavaScript; styles.css shows the matching panels with :has(), and
// site.js remembers the choice across pages.
function assistantPicker(scopeId, legend) {
  const options = ASSISTANTS.map((assistant, index) => `
      <label class="picker-option">
        <input type="radio" name="assistant-${escapeAttr(scopeId)}" value="${assistant.id}"${index === 0 ? ' checked' : ''}>
        <span>${escapeHtml(assistant.label)}</span>
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
  return `<li class="plugin-row">
        <div class="plugin-name">
          <h4><a href="${escapeAttr(page)}">${escapeHtml(plugin.title)}</a></h4>
          <p class="plugin-meta">For ${escapeHtml(audienceLabel(plugin).toLowerCase())}${plugin.status ? ` ${statusBadge(plugin)}` : ''}</p>
        </div>
        <div class="plugin-body">
          <p>${escapeHtml(plugin.summary)}</p>
          <p class="sample-prompt"><span class="sr-only">Example: </span>${escapeHtml(plugin.prompts[0])}</p>
        </div>
        <div class="plugin-actions">
          <a class="button button-primary" data-for="claude-code" href="${escapeAttr(links.launcherUrl(root, 'claude-code', plugin.name))}">Install in Claude Code${forPlugin}</a>
          <a class="button button-primary" data-for="copilot-app" href="${escapeAttr(links.copilotAppInstallUrl(plugin.name))}">Install in Copilot app${forPlugin}</a>
          <a class="button button-primary" data-for="copilot-cli" href="${escapeAttr(page)}#install" data-copy="${escapeAttr(`${cliAdd}\n${cliInstall}`)}" data-label="Copy install commands"><span data-button-label>Copy install commands</span>${forPlugin}</a>
          <a class="text-link" href="${escapeAttr(page)}">Details<span class="sr-only"> about ${escapeHtml(plugin.title)}</span></a>
        </div>
      </li>`;
}

// The hero types one real example prompt on load (site.js). Each "Try" button swaps in a
// prompt from a different plugin, so the hero doubles as a map from requests to plugins.
// Preferred plugins come first; if one is renamed or removed, others from the catalog fill
// its place so the build never fails over a hero choice.
const HERO_PLUGINS = ['power-pages', 'model-apps', 'power-automate', 'process-intelligence'];
const HERO_SIZE = HERO_PLUGINS.length;

function heroPicks(catalog) {
  const preferred = HERO_PLUGINS
    .map((name) => catalog.plugins.find((plugin) => plugin.name === name))
    .filter(Boolean);
  const others = catalog.plugins.filter((plugin) => !preferred.includes(plugin));
  return [...preferred, ...others].slice(0, HERO_SIZE);
}

function heroSection(picks) {
  const first = picks[0];
  const tries = picks.map((plugin, index) => `<li><button type="button" class="try-button" data-hero-index="${index}" aria-pressed="${index === 0 ? 'true' : 'false'}">${escapeHtml(plugin.prompts[0])}</button></li>`).join('');
  return `<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <h1>Describe what you need. Your AI assistant builds it on Power Platform.</h1>
      <p class="lede">Free plugins from Microsoft that teach GitHub Copilot and Claude Code how to create Power Pages sites, Power Apps, and Power Automate flows, and how to publish them to your environment.</p>
      <p class="hero-actions">
        <a class="button button-primary button-large" href="#plugins">Choose a plugin</a>
        <a class="button button-quiet button-large" href="#install-everything">Install everything</a>
      </p>
    </div>
    <div class="hero-demo" data-hero>
      <p class="demo-label" id="demo-label">You type</p>
      <div class="prompt-box" aria-labelledby="demo-label">
        <p class="prompt-text"><span data-hero-text>${escapeHtml(first.prompts[0])}</span><span class="caret" aria-hidden="true"></span></p>
      </div>
      <p class="demo-result">Your assistant uses the <a data-hero-link href="plugins/${escapeAttr(first.name)}/">${escapeHtml(first.title)}</a> plugin.</p>
      <div class="try">
        <p class="try-label" id="try-label">Try another request</p>
        <ul class="try-list" aria-labelledby="try-label">${tries}</ul>
      </div>
    </div>
  </div>
</section>`;
}

function stepsSection() {
  return `<section class="steps" aria-labelledby="steps-title">
  <div class="wrap">
    <h2 id="steps-title">How it works</h2>
    <ol class="step-list">
      <li><h3>Install the plugins</h3><p>Do it once, with one click or one command. The one-command install also keeps them up to date.</p></li>
      <li><h3>Describe what you want</h3><p>Open your assistant in a folder and ask in your own words. It asks follow-up questions when it needs to.</p></li>
      <li><h3>Review and approve</h3><p>Your assistant asks before it runs commands or changes files. Many plugins also show you a plan or confirm the environment before they publish.</p></li>
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
      <p>Pick the assistant you use, then install the plugins you need. You can add more later.</p>
    </div>
    <div class="catalog-tools">
      ${assistantPicker('catalog', 'Your AI assistant')}
      <nav class="goal-nav" aria-label="Jump to a goal">
        <ul>${jump}</ul>
      </nav>
    </div>
    <div class="callout" data-for="copilot-app">
      <p><strong>First time in the Copilot app?</strong> Add the Power Platform marketplace before you install a plugin. You only do this once.</p>
      <a class="button button-quiet" href="${escapeAttr(links.copilotAppMarketplaceUrl())}">Add the marketplace</a>
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

function installEverythingSection() {
  return `<section class="install-all" id="install-everything" aria-labelledby="install-all-title">
  <div class="wrap install-grid">
    <div>
      <h2 id="install-all-title">Install everything at once</h2>
      <p>One command installs every plugin into Claude Code and GitHub Copilot CLI, whichever you have. It also installs the Power Platform CLI if it is missing, and turns on automatic updates.</p>
      <p>You need <a href="https://nodejs.org/en/download">Node.js</a> and at least one of <a href="https://code.claude.com/docs/en/setup">Claude Code</a> or <a href="https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli">GitHub Copilot CLI</a>.</p>
      <p class="fine-print">The Dataverse plugin is left out by default. To include it, use the commands under Include Dataverse.</p>
    </div>
    <div class="install-commands">
      <h3>On Windows, in PowerShell</h3>
      ${codeBlock(links.INSTALL_ALL.windows, 'Copy command')}
      <h3>On macOS or Linux, in Terminal</h3>
      ${codeBlock(links.INSTALL_ALL.unix, 'Copy command')}
      <p class="fine-print">The same command also works in the Windows Command Prompt.</p>
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

function beforeSection() {
  return `<section class="before" aria-labelledby="before-title">
  <div class="wrap">
    <h2 id="before-title">Before you start</h2>
    <ul class="check-list">
      <li><strong>An AI assistant.</strong> <a href="https://code.claude.com/docs/en/setup">Claude Code</a>, the <a href="https://github.com/features/ai/github-app">GitHub Copilot app</a>, or <a href="https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli">GitHub Copilot CLI</a>.</li>
      <li><strong>A Power Platform environment you can build in.</strong> A <a href="https://learn.microsoft.com/power-platform/developer/create-developer-environment">developer environment</a> is free and the safest place to try things.</li>
      <li><strong>A few tools for some plugins.</strong> Each plugin page lists what it needs, and your assistant tells you when something is missing.</li>
    </ul>
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
    <h2 id="faq-title">Questions</h2>
    <div class="faq-list">
    ${items}
    <p class="fine-print">More answers, a glossary, and developer docs are in the <a href="${README_URL}">README</a>.</p>
    </div>
  </div>
</section>`;
}

function renderHome(catalog) {
  const root = '';
  const picks = heroPicks(catalog);
  const hero = picks.map((plugin) => ({ prompt: plugin.prompts[0], title: plugin.title, href: `plugins/${plugin.name}/` }));
  return layout({
    title: '',
    description: 'Free plugins from Microsoft that teach GitHub Copilot and Claude Code to build Power Pages sites, Power Apps, and Power Automate flows.',
    root,
    body: [heroSection(picks), stepsSection(), pluginsSection(catalog, root), installEverythingSection(), beforeSection(), faqSection(catalog)].join('\n'),
    scripts: ['assets/site.js'],
    data: { hero },
  });
}

function installPanel(plugin, root) {
  const [cliAdd, cliInstall] = links.copilotCliCommands(plugin.name);
  return `<section class="install-panel assistant-scope" id="install" aria-labelledby="install-title">
      <h2 id="install-title">Install ${escapeHtml(plugin.title)}</h2>
      ${assistantPicker('plugin', 'Your AI assistant')}
      <div class="install-option" data-for="claude-code">
        <p>Opens a terminal with the install command already typed. Press Enter to install.</p>
        <a class="button button-primary" href="${escapeAttr(links.launcherUrl(root, 'claude-code', plugin.name))}">Install in Claude Code</a>
        <p class="fine-print">Prefer to type it? Run this in a terminal:</p>
        ${codeBlock(links.claudeCodeShellCommand(plugin.name), 'Copy command')}
        <p class="fine-print">The Claude desktop app's Code tab and the Claude Code extension for VS Code use the same plugins.</p>
      </div>
      <div class="install-option" data-for="copilot-app">
        <ol class="install-steps">
          <li><p>Add the Power Platform marketplace. You only do this once.</p><a class="button button-quiet" href="${escapeAttr(links.copilotAppMarketplaceUrl())}">Add the marketplace</a></li>
          <li><p>Install the plugin.</p><a class="button button-primary" href="${escapeAttr(links.copilotAppInstallUrl(plugin.name))}">Install in Copilot app</a></li>
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

function renderPlugin(plugin, catalog) {
  const root = '../../';
  const goal = catalog.goals.find((item) => item.id === plugin.goal);
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

  const body = `<div class="wrap plugin-page">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
      <li><a href="${root}#plugins">All plugins</a></li>
      <li><a href="${root}#goal-${escapeAttr(goal.id)}">${escapeHtml(goal.title)}</a></li>
    </ol>
  </nav>
  <header class="plugin-header">
    <h1>${escapeHtml(plugin.title)}</h1>
    <p class="lede">${escapeHtml(plugin.summary)}</p>
    <p class="plugin-facts">
        ${meta}
    </p>
  </header>
  <div class="plugin-grid">
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
</div>`;

  return layout({
    title: plugin.title,
    description: plugin.summary,
    root,
    body,
    scripts: ['assets/site.js'],
  });
}

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
    <p class="fine-print">Your browser may ask whether to open the link. Choose Open.</p>
    <h2>Nothing happened?</h2>
    <ol class="plain-list numbered">
      <li>Make sure <a href="https://code.claude.com/docs/en/setup">Claude Code</a> is installed.</li>
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
    scripts: ['assets/install-links.js', 'assets/site.js', 'assets/launcher.js'],
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
