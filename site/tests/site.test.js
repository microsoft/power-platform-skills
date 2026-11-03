'use strict';

// Tests for the showcase site: the shared install links, catalog validation, the static build,
// the browser launcher, and the README links that are built from the same templates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const links = require('../lib/install-links.js');
const { loadCatalog } = require('../lib/catalog.js');
const render = require('../lib/render.js');
const { build, parseArgs, MARKER } = require('../build.js');
const installer = require('../../scripts/install.js');

const MARKETPLACE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'marketplace.json'), 'utf8'));
const MARKETPLACE_NAMES = MARKETPLACE.plugins.map((plugin) => plugin.name).sort();

// Names that must never reach a prompt, a shell command, or a URL. Mirrors the installer's
// injection corpus. Prototype keys such as "constructor" are valid names, so the launcher's
// allowlist test covers them instead.
const BAD_NAMES = [
  'power-pages$(echo REVIEW_ONLY)',
  'power-pages`echo REVIEW_ONLY`',
  'power-pages" & echo REVIEW_ONLY & rem "',
  'power-pages;echo REVIEW_ONLY',
  'power-pages|echo REVIEW_ONLY',
  'power-pages\n',
  'power-pages --scope project',
  '../power-pages',
  'Power-Pages',
  '__proto__',
  '',
  'a--b',
  '-power-pages',
  'x'.repeat(65),
  null,
  42,
];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// ── Install links ───────────────────────────────────────────────

test('Claude Code links pre-fill the documented one-step install prompt', () => {
  assert.equal(links.claudeCodePrompt('power-pages'), '/plugin install power-pages --marketplace microsoft/power-platform-skills');
  assert.equal(links.claudeCodeShellCommand('power-pages'), 'claude plugin install power-pages --marketplace microsoft/power-platform-skills');
  const deepLink = new URL(links.claudeCodeDeepLink('power-pages'));
  assert.equal(deepLink.protocol, 'claude-cli:');
  assert.equal(deepLink.host, 'open');
  assert.equal(deepLink.searchParams.get('q'), links.claudeCodePrompt('power-pages'));
  assert.deepEqual([...deepLink.searchParams.keys()], ['q']);
});

test('Copilot app links wrap a ghapp:// plugin link in the GitHub launcher', () => {
  const install = new URL(links.copilotAppInstallUrl('power-pages'));
  assert.equal(install.origin + install.pathname, 'https://github.com/copilot/app/launch');
  const appLink = install.searchParams.get('open');
  assert.equal(appLink, 'ghapp://plugins/install?source=power-pages%40power-platform-skills');
  assert.equal(new URL(appLink).searchParams.get('source'), 'power-pages@power-platform-skills');

  const marketplace = new URL(links.copilotAppMarketplaceUrl()).searchParams.get('open');
  assert.equal(marketplace, 'ghapp://plugins/marketplace/add?source=microsoft%2Fpower-platform-skills');
  assert.equal(new URL(marketplace).searchParams.get('source'), 'microsoft/power-platform-skills');
});

test('Copilot CLI commands add the marketplace, then install from it', () => {
  assert.deepEqual(links.copilotCliCommands('mobile-app'), [
    'copilot plugin marketplace add microsoft/power-platform-skills',
    'copilot plugin install mobile-app@power-platform-skills',
  ]);
});

test('the copied Copilot CLI command is one line that installs even when the marketplace exists', () => {
  const command = links.copilotCliCommand('pcf');
  assert.equal(command, 'copilot plugin marketplace add microsoft/power-platform-skills; copilot plugin install pcf@power-platform-skills');
  assert.ok(!/[\r\n]/.test(command), 'two pasted lines do not run as one command');

  // Run the line in each POSIX shell available here against a fake copilot whose
  // "marketplace add" fails the way the real CLI does when the marketplace is registered.
  const bin = tempDir('pps-fake-copilot-');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'copilot'), [
    '#!/bin/sh',
    `echo "$*" >> "${log}"`,
    'if [ "$2" = "marketplace" ]; then echo \'Marketplace "power-platform-skills" already registered\' >&2; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const shells = ['sh', 'bash', 'zsh'].filter((shell) => spawnSync('which', [shell]).status === 0);
  if (process.platform === 'win32' || shells.length === 0) return;
  for (const shell of shells) {
    fs.rmSync(log, { force: true });
    const result = spawnSync(shell, ['-c', command], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      'plugin marketplace add microsoft/power-platform-skills',
      'plugin install pcf@power-platform-skills',
    ], shell);
  }
});

test('launcher URLs accept only known apps and keep the base the caller passes', () => {
  assert.equal(links.launcherUrl('../../', 'claude-code', 'pcf'), '../../install/?app=claude-code&plugin=pcf');
  assert.equal(
    links.launcherUrl(links.SITE_URL, 'claude-code', 'pcf'),
    'https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=pcf',
  );
  assert.throws(() => links.launcherUrl('', 'copilot-cli', 'pcf'), /Unsupported launcher app/);
  assert.throws(() => links.launcherUrl('', 'claude-code"><script>', 'pcf'), /Unsupported launcher app/);
});

test('every link builder rejects names outside the Open Plugins grammar', () => {
  const builders = [
    links.claudeCodePrompt,
    links.claudeCodeShellCommand,
    links.claudeCodeDeepLink,
    links.copilotAppInstallUrl,
    links.copilotCliCommands,
    (name) => links.launcherUrl('', 'claude-code', name),
  ];
  for (const name of BAD_NAMES) {
    assert.equal(links.isValidPluginName(name), false, JSON.stringify(name));
    for (const builder of builders) {
      assert.throws(() => builder(name), /Invalid plugin name/, `${builder.name || 'launcherUrl'}(${JSON.stringify(name)})`);
    }
  }
});

test('the browser name check agrees with the installer', () => {
  const names = [...BAD_NAMES, ...MARKETPLACE_NAMES, 'a', 'a.b', 'a-b', 'a..b', 'a.-b', '1', 'x'.repeat(64)];
  for (const name of names) {
    assert.equal(links.isValidPluginName(name), installer.isValidPluginName(name), JSON.stringify(name));
  }
});

test('the install-everything commands match the installer usage', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.js'), 'utf8');
  assert.ok(source.includes(links.INSTALL_ALL.unix), 'scripts/install.js usage no longer shows the curl one-liner');
  assert.ok(source.includes(links.INSTALL_ALL_WITH_DATAVERSE.unix), 'scripts/install.js usage no longer shows the Dataverse one-liner');
  assert.ok(links.INSTALL_ALL.windows.startsWith(`iwr ${links.INSTALLER_URL} -OutFile install.js;`));
});

test('the Dataverse flag reaches the installer, not node or del', () => {
  // Appending the flag to either one-liner breaks it, so the position is pinned here.
  assert.match(links.INSTALL_ALL_WITH_DATAVERSE.windows, /; node install\.js --include-dataverse; del install\.js$/);
  assert.match(links.INSTALL_ALL_WITH_DATAVERSE.unix, /\| node - --include-dataverse$/);
  // `node -` runs the piped script and passes the rest of the arguments to it.
  const piped = spawnSync(process.execPath, ['-', '--include-dataverse'], {
    input: 'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
    encoding: 'utf8',
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout), ['--include-dataverse']);
});

// ── Catalog ─────────────────────────────────────────────────────

test('the real catalog covers exactly the marketplace plugins', () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name).sort(), MARKETPLACE_NAMES);
  for (const plugin of catalog.plugins) {
    assert.match(plugin.docsUrl, /^https:\/\//, plugin.name);
  }
});

// A two-plugin repository: one plugin in the repo and one external, like dataverse.
function fixtureRepo({ catalog: edit = (value) => value, skills = ['make-thing'] } = {}) {
  const root = tempDir('pps-site-repo-');
  writeJson(path.join(root, 'marketplace.json'), {
    name: 'power-platform-skills',
    plugins: [
      { name: 'alpha', source: './plugins/alpha' },
      { name: 'beta', source: { source: 'github', repo: 'example/beta', path: 'plugin' } },
    ],
  });
  writeJson(path.join(root, 'plugins', 'alpha', '.plugin', 'plugin.json'), { name: 'alpha', version: '1.2.3' });
  for (const skill of skills) {
    fs.mkdirSync(path.join(root, 'plugins', 'alpha', 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', 'alpha', 'skills', skill, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const entry = (name, extra) => ({
    name,
    title: name.toUpperCase(),
    goal: 'build',
    product: 'power-apps',
    audience: 'makers',
    status: null,
    summary: `${name} summary`,
    prompts: [`Ask ${name}`],
    requirements: ['Node.js'],
    skills: [{ name: 'make-thing', description: 'Makes a thing.' }],
    notes: [],
    learn: [{ title: 'Docs', url: 'https://learn.microsoft.com/' }],
    ...extra,
  });
  const catalog = {
    goals: [{ id: 'build', title: 'Build', summary: 'Build things.' }],
    plugins: [entry('alpha'), entry('beta', { external: 'https://github.com/example/beta' })],
    faq: [{ question: 'Q?', answer: 'A.' }],
    showcase: [{ plugin: 'alpha', prompt: 'Ask alpha', steps: ['One', 'Two'], waiting: 'Waits' }],
  };
  writeJson(path.join(root, 'site', 'catalog.json'), edit(catalog));
  return root;
}

test('a valid fixture catalog loads with versions from the plugin manifest', () => {
  const catalog = loadCatalog(fixtureRepo());
  const alpha = catalog.plugins.find((plugin) => plugin.name === 'alpha');
  const beta = catalog.plugins.find((plugin) => plugin.name === 'beta');
  assert.equal(alpha.version, '1.2.3');
  assert.equal(alpha.docsUrl, 'https://github.com/microsoft/power-platform-skills/tree/main/plugins/alpha');
  assert.equal(beta.version, null);
  assert.equal(beta.external, true);
});

test('catalog validation reports every drift from the marketplace', () => {
  const cases = [
    ['a marketplace plugin with no entry', (c) => ({ ...c, plugins: c.plugins.filter((p) => p.name !== 'beta') }), /marketplace plugin beta has no entry/],
    ['an entry not in the marketplace', (c) => ({ ...c, plugins: [...c.plugins, { ...c.plugins[0], name: 'gamma' }] }), /gamma.*not in marketplace\.json/],
    ['a skill with no SKILL.md', (c) => { c.plugins[0].skills = [{ name: 'missing', description: 'x' }]; return c; }, /skill "missing"/],
    ['an unknown goal', (c) => { c.plugins[0].goal = 'nope'; return c; }, /unknown goal "nope"/],
    ['an unknown audience', (c) => { c.plugins[0].audience = 'everyone'; return c; }, /unknown audience/],
    ['an http learn link', (c) => { c.plugins[0].learn = [{ title: 'x', url: 'http://example.com' }]; return c; }, /https url/],
    ['an external plugin with no url', (c) => { delete c.plugins[1].external; return c; }, /needs an https external url/],
    ['an in-repo plugin marked external', (c) => { c.plugins[0].external = 'https://example.com'; return c; }, /must not set external/],
    ['a goal with no plugins', (c) => { c.goals.push({ id: 'empty', title: 'E', summary: 'E.' }); return c; }, /goal empty has no plugins/],
    ['too many prompts', (c) => { c.plugins[0].prompts = ['1', '2', '3', '4', '5', '6']; return c; }, /1 to 5 example prompts/],
    ['an unknown product', (c) => { c.plugins[0].product = 'power-bi'; return c; }, /unknown product "power-bi"/],
    ['a showcase prompt the plugin does not list', (c) => { c.showcase[0].prompt = 'Something else'; return c; }, /not one of alpha's prompts/],
    ['a showcase with one step', (c) => { c.showcase[0].steps = ['Only']; return c; }, /2 to 5 steps/],
    ['no showcase', (c) => { c.showcase = []; return c; }, /1 to 6 example sessions/],
  ];
  for (const [label, edit, pattern] of cases) {
    assert.throws(() => loadCatalog(fixtureRepo({ catalog: edit })), pattern, label);
  }
});

// ── Build ───────────────────────────────────────────────────────

function readOut(outDir, relative) {
  return fs.readFileSync(path.join(outDir, relative), 'utf8');
}

function pageData(html) {
  const match = /<script type="application\/json" id="page-data">(.*?)<\/script>/s.exec(html);
  assert.ok(match, 'page-data block missing');
  return JSON.parse(match[1]);
}

test('the build writes a page for every marketplace plugin plus the launcher and 404', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  for (const name of MARKETPLACE_NAMES) {
    assert.ok(files.includes(`plugins/${name}/index.html`), name);
  }
  for (const file of [
    'index.html', 'install/index.html', '404.html', 'assets/styles.css', 'assets/site.js', 'assets/theme.js',
    'assets/launcher.js', 'assets/install-links.js', 'assets/brand/power-platform.svg', 'assets/brand/favicon-32.png',
    'assets/fonts/schibsted-grotesk-latin.woff2', 'assets/fonts/OFL-schibsted-grotesk.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(outDir, file)), file);
  }
  // The browser copy of the link builders is the module the build and tests use.
  assert.equal(readOut(outDir, 'assets/install-links.js'), fs.readFileSync(path.join(REPO_ROOT, 'site', 'lib', 'install-links.js'), 'utf8'));
});

test('every page loads only same-origin assets under a strict content security policy', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';/, file);
    for (const [, attr, value] of html.matchAll(/<(?:script|link)\b[^>]*\b(src|href)="([^"]*)"/g)) {
      if (attr === 'href' && file === '404.html') {
        assert.ok(value.startsWith('/power-platform-skills/'), `${file}: ${value}`);
      } else {
        assert.doesNotMatch(value, /^(?:[a-z]+:)?\/\//i, `${file} loads ${value} from another origin`);
      }
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/, `${file} has an inline script`);
  }
});

test('the launcher allowlist is exactly the marketplace', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const data = pageData(readOut(outDir, 'install/index.html'));
  assert.deepEqual(Object.keys(data.plugins).sort(), MARKETPLACE_NAMES);
});

test('plugin pages link each assistant to its install path', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const html = readOut(outDir, 'plugins/power-automate/index.html');
  const decode = (value) => value.replace(/&amp;/g, '&');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => decode(match[1]));
  assert.ok(hrefs.includes(links.launcherUrl('../../', 'claude-code', 'power-automate')));
  assert.ok(hrefs.includes(links.copilotAppInstallUrl('power-automate')));
  assert.ok(hrefs.includes(links.copilotAppMarketplaceUrl()));
  // Copilot CLI has no URL handler, so its install path is a copy button with both commands.
  assert.ok(html.includes(`data-copy="${links.copilotCliCommand('power-automate')}"`));
});

test('every product icon on the site sits beside its product name', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  const { PRODUCTS } = require('../lib/catalog.js');
  const labelFor = Object.fromEntries(Object.values(PRODUCTS).map((product) => [path.basename(product.icon), product.label]));
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    // An icon's parent element is the unit a reader sees together with it.
    for (const match of html.matchAll(/<img[^>]*src="[^"]*brand\/([a-z-]+\.svg)"[^>]*>/g)) {
      const icon = match[1];
      const label = icon === 'power-platform.svg' ? 'Power Platform' : labelFor[icon];
      const after = html.slice(match.index, match.index + 600).replace(/<[^>]+>/g, ' ');
      assert.ok(after.includes(label), `${file}: ${icon} has no "${label}" label beside it`);
    }
  }
});

test('catalog text is escaped in every page', () => {
  const hostile = '<script>alert(1)</script>"\'&';
  const root = fixtureRepo({
    catalog: (c) => {
      c.plugins[0].summary = hostile;
      c.plugins[0].prompts = [hostile];
      c.plugins[0].title = hostile;
      c.faq[0].answer = hostile;
      c.showcase[0].prompt = hostile;
      c.showcase[0].steps = [hostile, hostile];
      return c;
    },
  });
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ repoRoot: root, outDir, basePath: '/' });
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    assert.ok(!html.includes('<script>alert(1)'), `${file} contains unescaped catalog text`);
  }
  assert.ok(readOut(outDir, 'plugins/alpha/index.html').includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
  // The title also lands in the launcher's JSON data block, which must not close the element.
  assert.equal(pageData(readOut(outDir, 'install/index.html')).plugins.alpha, hostile);
});

test('jsonForScript keeps </script> inside a JSON data block', () => {
  const json = render.jsonForScript({ text: '</script><script>alert(1)</script>' });
  assert.ok(!json.includes('</script'));
  assert.deepEqual(JSON.parse(json), { text: '</script><script>alert(1)</script>' });
});

test('the build clears only folders it created', () => {
  const parent = tempDir('pps-site-out-');
  const unrelated = path.join(parent, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => build({ outDir: unrelated, basePath: '/' }), /Refusing to clear/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');

  const outDir = path.join(parent, 'dist');
  build({ outDir, basePath: '/' });
  fs.writeFileSync(path.join(outDir, 'stale.html'), 'old');
  build({ outDir, basePath: '/' });
  assert.ok(!fs.existsSync(path.join(outDir, 'stale.html')));
  assert.ok(fs.existsSync(path.join(outDir, MARKER)));
});

test('build arguments are strict and the base path is normalized', () => {
  assert.equal(parseArgs([]).basePath, '/power-platform-skills/');
  assert.equal(parseArgs(['--base-path', 'docs']).basePath, '/docs/');
  assert.equal(parseArgs(['--base-path', '/']).basePath, '/');
  assert.throws(() => parseArgs(['--outdir', 'x']), /Unknown or incomplete argument/);
  assert.throws(() => parseArgs(['--out']), /Unknown or incomplete argument/);
});

// ── Launcher page ───────────────────────────────────────────────

// Runs assets/launcher.js against a stub DOM. It records where the page would navigate,
// so no test ever hands a claude-cli: link to the operating system.
function runLauncher(search, { touchOnly = false } = {}) {
  const element = () => ({ hidden: true, textContent: '', href: '#', dataset: {} });
  const ready = element();
  const invalid = element();
  const parts = {
    '[data-launcher-plugin]': element(),
    '[data-launcher-prompt]': element(),
    '[data-launcher-shell]': element(),
    '[data-launcher-copy]': element(),
    '[data-launcher-open]': element(),
    '[data-launcher-touch]': element(),
    '[data-launcher-desktop]': { ...element(), hidden: false },
  };
  ready.querySelector = (selector) => parts[selector];
  const catalog = loadCatalog(REPO_ROOT);
  const data = { plugins: Object.fromEntries(catalog.plugins.map((plugin) => [plugin.name, plugin.title])) };
  const navigations = [];
  const document = {
    title: '',
    getElementById: (id) => (id === 'page-data' ? { textContent: JSON.stringify(data) } : null),
    querySelector: (selector) => ({
      '[data-launcher-state="ready"]': ready,
      '[data-launcher-state="invalid"]': invalid,
    })[selector],
  };
  const window = {
    PowerPlatformSkillsInstallLinks: links,
    location: {
      search,
      set href(value) {
        navigations.push(value);
      },
    },
    setTimeout: (fn) => fn(),
    matchMedia: (query) => ({ matches: touchOnly && query === '(hover: none) and (pointer: coarse)' }),
  };
  const source = fs.readFileSync(path.join(REPO_ROOT, 'site', 'assets', 'launcher.js'), 'utf8');
  vm.runInNewContext(source, { window, document, URLSearchParams });
  return { ready, invalid, parts, navigations, document };
}

test('the launcher opens Claude Code for a known plugin', () => {
  const { ready, invalid, parts, navigations, document } = runLauncher('?app=claude-code&plugin=process-intelligence');
  assert.equal(ready.hidden, false);
  assert.equal(invalid.hidden, true);
  assert.equal(parts['[data-launcher-open]'].href, links.claudeCodeDeepLink('process-intelligence'));
  assert.equal(parts['[data-launcher-prompt]'].textContent, links.claudeCodePrompt('process-intelligence'));
  assert.equal(parts['[data-launcher-copy]'].dataset.copy, links.claudeCodeShellCommand('process-intelligence'));
  assert.equal(parts['[data-launcher-plugin]'].textContent, 'Process Intelligence');
  assert.deepEqual(navigations, [links.claudeCodeDeepLink('process-intelligence')]);
  assert.match(document.title, /Install Process Intelligence in Claude Code/);
});

test('the launcher does not try to open Claude Code on a phone or tablet', () => {
  const { ready, parts, navigations } = runLauncher('?app=claude-code&plugin=pcf', { touchOnly: true });
  assert.equal(ready.hidden, false);
  assert.equal(parts['[data-launcher-open]'].href, links.claudeCodeDeepLink('pcf'));
  assert.equal(parts['[data-launcher-touch]'].hidden, false);
  assert.equal(parts['[data-launcher-desktop]'].hidden, true);
  assert.deepEqual(navigations, []);
});

test('the launcher refuses anything outside its allowlist and never navigates', () => {
  const searches = [
    '',
    '?app=claude-code',
    '?plugin=pcf',
    '?app=copilot-cli&plugin=pcf',
    '?app=claude-code&plugin=unknown-plugin',
    '?app=claude-code&plugin=__proto__',
    '?app=claude-code&plugin=constructor',
    '?app=claude-code&plugin=pcf&plugin=power-pages',
    '?app=claude-code&app=claude-code&plugin=pcf',
    `?app=claude-code&plugin=${encodeURIComponent('pcf --scope project')}`,
    `?app=claude-code&plugin=${encodeURIComponent('pcf\n/help')}`,
  ];
  for (const search of searches) {
    const { ready, invalid, navigations } = runLauncher(search);
    assert.equal(invalid.hidden, false, search);
    assert.equal(ready.hidden, true, search);
    assert.deepEqual(navigations, [], search);
  }
});

// ── Pages deployment ────────────────────────────────────────────

test('every Pages deploy carries the repo stats report', () => {
  // GitHub Pages serves one artifact, so a deploy without the stats branch's microsoft/ folder
  // takes https://microsoft.github.io/power-platform-skills/microsoft/... offline.
  const site = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'showcase-site.yml'), 'utf8');
  const stats = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'github-repo-stats.yml'), 'utf8');
  const statsName = /^name: (.+)$/m.exec(stats)[1].trim();
  assert.match(site, new RegExp(`workflow_run:\\n\\s+workflows:\\n\\s+- ${statsName}\\n`), 'site must republish after the stats workflow');
  assert.match(site, /ref: github-repo-stats\n\s+path: repo-stats\n\s+sparse-checkout: microsoft\n/);
  assert.match(site, /run: cp -R repo-stats\/microsoft site\/dist\/microsoft\n/);
  assert.ok(site.indexOf('cp -R repo-stats/microsoft') < site.indexOf('upload-pages-artifact'), 'stats must be copied before the upload');
  // The report's links are built from this prefix, so it must be the site the workflow deploys.
  assert.match(stats, new RegExp(`ghpagesprefix: ${links.SITE_URL.replace(/\/$/, '').replace(/[.]/g, '\\.')}\\n`));
  assert.match(stats, /databranch: github-repo-stats\n/);
});

// ── README ──────────────────────────────────────────────────────

test('the README install links come from the same templates as the site', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(links.SITE_URL), 'README does not link to the site');
  assert.ok(readme.includes(links.INSTALL_ALL.windows), 'README Windows install command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL.unix), 'README macOS/Linux install command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL_WITH_DATAVERSE.windows), 'README Windows Dataverse command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL_WITH_DATAVERSE.unix), 'README macOS/Linux Dataverse command drifted');
  assert.ok(readme.includes(`](${links.copilotAppMarketplaceUrl()})`), 'README Copilot app marketplace link drifted');
  for (const name of MARKETPLACE_NAMES) {
    assert.ok(readme.includes(`](${links.launcherUrl(links.SITE_URL, 'claude-code', name)})`), `README Claude Code link for ${name}`);
    assert.ok(readme.includes(`](${links.copilotAppInstallUrl(name)})`), `README Copilot app link for ${name}`);
    assert.ok(readme.includes(`/plugin install ${name}@power-platform-skills`), `README manual install for ${name}`);
  }
});
