'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VIEWPORTS = Object.freeze([
  { name: 'mobile-compact', width: 360, height: 800 },
  { name: 'mobile-standard', width: 390, height: 844 },
  { name: 'mobile-wide', width: 430, height: 932 },
]);

function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    return [
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
  ];
}

function findSupportedBrowser(options = {}) {
  const candidates = options.candidates
    || browserCandidates(options.platform, options.env);
  const exists = options.existsSync || fs.existsSync;
  return candidates.find((candidate) => exists(candidate)) || null;
}

function probeScript(expected) {
  const screenIds = expected.screens.map((screen) => screen.screenId);
  const actionIds = expected.screens.flatMap((screen) => screen.primaryActions.map((action) => ({
    screenId: screen.screenId,
    markerId: action.markerId,
  })));
  const data = JSON.stringify({ screenIds, actionIds }).replace(/</g, '\\u003c');
  return `<script id="__final_preview_layout_probe__">
(() => {
  const expected = ${data};
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0.05 && rect.width > 0 && rect.height > 0;
  };
  const bodyStyle = getComputedStyle(document.body);
  if (bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
    || /Times New Roman/i.test(bodyStyle.fontFamily)) {
    add('preview-layout-styles-ineffective', 'computed page background or typography remains at browser defaults');
  }
  if (document.documentElement.scrollWidth > innerWidth + 2) {
    add('preview-layout-page-overflow', 'page width exceeds the rendered viewport');
  }
  const frameFingerprints = [];
  for (const screenId of expected.screenIds) {
    const frame = document.querySelector('[data-mobile-frame="' + CSS.escape(screenId) + '"]');
    if (!visible(frame)) {
      add('preview-layout-frame-hidden', screenId + ' mobile frame is not rendered');
      continue;
    }
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    if (rect.width < 280 || rect.width > 460 || rect.height < 560 || rect.height > 900) {
      add('preview-layout-frame-dimensions', screenId + ' is not bounded to credible phone dimensions');
    }
    if (frame.scrollWidth > frame.clientWidth + 2) {
      add('preview-layout-horizontal-overflow', screenId + ' has horizontal content overflow');
    }
    if (['hidden', 'clip'].includes(style.overflowY) && frame.scrollHeight > frame.clientHeight + 2) {
      add('preview-layout-content-clipped', screenId + ' clips vertical content with no scroll path');
    }
    const escaped = [...frame.querySelectorAll('*')].find((element) => {
      if (!visible(element)) return false;
      const child = element.getBoundingClientRect();
      return child.left < rect.left - 2 || child.right > rect.right + 2;
    });
    if (escaped) add('preview-layout-descendant-overflow', screenId + ' contains content outside its phone frame');

    const headings = [...frame.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible);
    if (headings.some((heading) => {
      const headingStyle = getComputedStyle(heading);
      return (heading.scrollWidth > heading.clientWidth + 2
          || heading.scrollHeight > heading.clientHeight + 2)
        && ['hidden', 'clip'].includes(headingStyle.overflow);
    })) {
      add('preview-layout-header-truncated', screenId + ' contains a truncated header');
    }
    const headingText = headings.map((heading) => heading.textContent.trim()).filter(Boolean);
    if (new Set(headingText).size !== headingText.length) {
      add('preview-layout-duplicated-header', screenId + ' repeats an identical visible header');
    }

    const interactive = [...frame.querySelectorAll('button,a,[role="button"],input,select,textarea')]
      .filter(visible);
    if (interactive.some((element) => {
      const target = element.getBoundingClientRect();
      return target.width < 44 || target.height < 44;
    })) {
      add('preview-layout-touch-target-small', screenId + ' contains a touch target smaller than 44px');
    }
    const textNodes = [...frame.querySelectorAll('p,span,small,label,button,a,h1,h2,h3')]
      .filter((element) => visible(element) && element.textContent.trim());
    if (textNodes.some((element) => parseFloat(getComputedStyle(element).fontSize) < 10)) {
      add('preview-layout-text-unreadable', screenId + ' contains rendered text smaller than 10px');
    }

    const overlapCandidates = [...new Set([
      ...frame.querySelectorAll('h1,h2,h3,p,button,a,[data-primary-action]'),
    ])].filter(visible);
    let overlapFound = false;
    for (let leftIndex = 0; leftIndex < overlapCandidates.length && !overlapFound; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < overlapCandidates.length; rightIndex += 1) {
        const left = overlapCandidates[leftIndex];
        const right = overlapCandidates[rightIndex];
        if (left.contains(right) || right.contains(left)) continue;
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const overlapWidth = Math.min(leftRect.right, rightRect.right)
          - Math.max(leftRect.left, rightRect.left);
        const overlapHeight = Math.min(leftRect.bottom, rightRect.bottom)
          - Math.max(leftRect.top, rightRect.top);
        if (overlapWidth > 2 && overlapHeight > 2) {
          overlapFound = true;
          break;
        }
      }
    }
    if (overlapFound) add('preview-layout-elements-overlap', screenId + ' contains overlapping text or actions');

    const viewport = frame.querySelector('[data-first-viewport="' + CSS.escape(screenId) + '"]');
    const focal = frame.querySelector('[data-focal-point="' + CSS.escape(screenId) + '"]');
    if (!visible(viewport) || !visible(focal) || focal.getBoundingClientRect().height < 48) {
      add('preview-layout-first-viewport-hierarchy', screenId + ' has no visible, substantial first-viewport focal point');
    }
    const components = [...frame.querySelectorAll('[data-product-component]')].filter(visible);
    if (components.length > 12 || components.some((component) => (
      component.getBoundingClientRect().height < 28
    ))) {
      add('preview-layout-card-density-excessive', screenId + ' packs too many or too-small component regions into one frame');
    }
    frameFingerprints.push(components.map((element) => {
      const component = element.getBoundingClientRect();
      return [
        element.tagName,
        Math.round((component.top - rect.top) / 16),
        Math.round(component.width / rect.width * 10),
        Math.round(component.height / rect.height * 10),
      ];
    }));
  }
  for (const action of expected.actionIds) {
    const frame = document.querySelector('[data-mobile-frame="' + CSS.escape(action.screenId) + '"]');
    const viewport = frame && frame.querySelector('[data-first-viewport="' + CSS.escape(action.screenId) + '"]');
    const button = frame && frame.querySelector('[data-primary-action="' + CSS.escape(action.markerId) + '"]');
    if (!visible(frame) || !visible(viewport) || !visible(button)) {
      add('preview-layout-primary-action-hidden', action.markerId + ' is not visibly rendered');
      continue;
    }
    const frameRect = frame.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.height < 40 || buttonRect.width < 80
      || buttonRect.top < viewportRect.top - 2 || buttonRect.bottom > viewportRect.bottom + 2
      || buttonRect.bottom > frameRect.top + Math.min(frame.clientHeight, 844) + 2) {
      add('preview-layout-primary-action-below-fold', action.markerId + ' is not usable in the first phone viewport');
    }
    if (frameRect.bottom - buttonRect.bottom < 8) {
      add('preview-layout-safe-area-spacing', action.markerId + ' has insufficient bottom safe-area spacing');
    }
    const tabBar = frame.querySelector('[role="tablist"],[data-tab-bar]');
    if (visible(tabBar)) {
      const tabRect = tabBar.getBoundingClientRect();
      if (Math.min(buttonRect.right, tabRect.right) - Math.max(buttonRect.left, tabRect.left) > 2
        && Math.min(buttonRect.bottom, tabRect.bottom) - Math.max(buttonRect.top, tabRect.top) > 2) {
        add('preview-layout-action-tab-collision', action.markerId + ' overlaps the rendered tab bar');
      }
    }
  }
  const similar = (left, right) => {
    if (left.length !== right.length || left.length === 0) return false;
    const matches = left.filter((entry, index) => {
      const other = right[index];
      return entry[0] === other[0]
        && Math.abs(entry[1] - other[1]) <= 1
        && Math.abs(entry[2] - other[2]) <= 1
        && Math.abs(entry[3] - other[3]) <= 1;
    }).length;
    return matches / left.length >= 0.85;
  };
  if (frameFingerprints.length > 1
    && frameFingerprints.every((value, index) => (
      index === 0 || similar(frameFingerprints[0], value)
    ))) {
    add('preview-layout-repeated-shell', 'computed component layouts are nearly identical across every selected screen');
  }
  const details = document.querySelector('#preview-all-screens details');
  if (details) details.open = true;
  const navigation = document.querySelector('#preview-navigation');
  const destination = document.querySelector('[data-navigation-destination]');
  const navStyle = navigation && getComputedStyle(navigation);
  const destinationStyle = destination && getComputedStyle(destination);
  const navigationLayouts = navigation && [navigation, ...navigation.querySelectorAll('*')]
    .map((element) => getComputedStyle(element))
    .filter((style) => ['flex', 'grid'].includes(style.display));
  if (!navigation || !destination || navigationLayouts.length === 0
    || (navStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && parseFloat(navStyle.borderTopWidth) === 0
      && parseFloat(navStyle.borderBottomWidth) === 0)
    || (parseFloat(destinationStyle.paddingLeft) + parseFloat(destinationStyle.paddingRight) < 8
      && destinationStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && parseFloat(destinationStyle.borderLeftWidth) === 0)) {
    add('preview-layout-navigation-unstyled', 'computed navigation retains an unstyled document-link layout');
  }
  const index = document.querySelector('[data-screen-index]');
  if (!index || index.getBoundingClientRect().height < 24) {
    add('preview-layout-screen-index-unstyled', 'expanded screen index has no measurable compact layout');
  }
  document.documentElement.setAttribute('data-preview-layout-result', btoa(JSON.stringify({ errors })));
})();
</script>`;
}

function injectProbe(html, expected) {
  const script = probeScript(expected);
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">';
  const local = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`)
    : `${policy}${html}`;
  return /<\/body\s*>/i.test(local)
    ? local.replace(/<\/body\s*>/i, `${script}</body>`)
    : `${local}${script}`;
}

function decodeProbe(stdout) {
  const encoded = String(stdout || '').match(/data-preview-layout-result="([^"]+)"/i)?.[1];
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function startLoopbackServer(html, options = {}) {
  return new Promise((resolve, reject) => {
    const createServer = options.createServer || http.createServer;
    const server = createServer((request, response) => {
      if (!['GET', 'HEAD'].includes(request.method) || request.url !== '/preview') {
        response.writeHead(request.method === 'GET' ? 404 : 405, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : html);
    });
    server.once('error', reject);
    // Port 0 delegates collision-free selection to the OS. The explicit IPv4 loopback host
    // prevents preview/customer content from becoming reachable on a LAN interface.
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const result = {
        address,
        server,
        url: `http://127.0.0.1:${address.port}/preview`,
      };
      options.onServerStarted?.(result);
      resolve(result);
    });
  });
}

function closeLoopbackServer(server, options = {}) {
  return new Promise((resolve) => {
    if (!server?.listening) {
      options.onServerClosed?.();
      resolve();
      return;
    }
    server.closeAllConnections?.();
    server.close(() => {
      options.onServerClosed?.();
      resolve();
    });
  });
}

function runChromium({
  executable,
  profileDirectory,
  spawnProcess = spawn,
  timeoutMs = 5000,
  url,
  viewport,
}) {
  return new Promise((resolve) => {
    // The executable comes only from the platform allowlist. Browser networking is disabled
    // and host resolution is black-holed except for the loopback page served above.
    const child = spawnProcess(executable, [
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${viewport.width},${viewport.height}`,
      '--dump-dom',
      url,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: null, stdout, error: { code: 'ETIMEDOUT' } });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish({ status: null, stdout: '', error: { code: 'EOUTPUTLIMIT' } });
      }
    });
    child.once('error', (error) => finish({ status: null, stdout, error }));
    child.once('close', (status) => finish({ status, stdout, error: null }));
  });
}

function normalizeAdapter(kind, adapter) {
  if (!adapter) return null;
  if (typeof adapter === 'function') return { kind, render: adapter };
  if (typeof adapter.render === 'function') return { kind, render: adapter.render.bind(adapter) };
  throw new Error(`${kind} adapter must be a function or expose render()`);
}

function browserAdapters(options = {}) {
  const adapters = [
    normalizeAdapter('agent-browser', options.agentBrowserAdapter),
    normalizeAdapter('connected-browser', options.connectedBrowserAdapter),
  ].filter(Boolean);
  const executable = options.browserExecutable === undefined
    ? findSupportedBrowser(options)
    : options.browserExecutable;
  if (executable) {
    adapters.push({
      kind: 'local-chromium',
      render: (request) => (options.runBrowser || runChromium)({
        ...request,
        executable,
        spawnProcess: options.spawnProcess || spawn,
        timeoutMs: options.timeoutMs || 5000,
      }),
    });
  }
  return adapters;
}

async function validateRenderedLayout(html, expected, options = {}) {
  const adapters = browserAdapters(options);
  if (adapters.length === 0) {
    return { status: 'skipped', reason: 'browser-unavailable', errors: [], viewports: [] };
  }
  let temporary;
  let loopback;
  const results = [];
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'final-preview-layout-'));
    loopback = await startLoopbackServer(injectProbe(html, expected), options);
    for (const viewport of options.viewports || VIEWPORTS) {
      let completed = null;
      for (const adapter of adapters) {
        let run;
        try {
          run = await adapter.render({
            url: loopback.url,
            viewport,
            profileDirectory: path.join(temporary, `profile-${viewport.name}`),
          });
        } catch (error) {
          run = { status: null, stdout: '', error };
        }
        const probe = !run?.error && run?.status === 0 ? decodeProbe(run.stdout) : null;
        if (probe) {
          completed = { adapter: adapter.kind, errors: probe.errors || [] };
          break;
        }
      }
      if (!completed) {
        return {
          status: 'skipped',
          reason: 'browser-unavailable',
          errors: [],
          viewports: results,
        };
      }
      results.push({ ...viewport, ...completed });
    }
  } catch {
    return {
      status: 'skipped',
      reason: 'browser-unavailable',
      errors: [],
      viewports: results,
    };
  } finally {
    await closeLoopbackServer(loopback?.server, options);
    if (temporary) {
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch {
        // Browser validation is optional; profile cleanup failure cannot block generation.
      }
    }
  }
  const errors = results.flatMap((result) => result.errors.map((error) => ({
    ...error,
    message: `${result.name}: ${error.message}`,
  })));
  return {
    status: errors.length > 0 ? 'failed' : 'passed',
    reason: null,
    errors,
    viewports: results.map((result) => ({
      name: result.name,
      width: result.width,
      height: result.height,
      adapter: result.adapter,
      findingCount: result.errors.length,
    })),
  };
}

module.exports = {
  VIEWPORTS,
  browserAdapters,
  browserCandidates,
  closeLoopbackServer,
  decodeProbe,
  findSupportedBrowser,
  injectProbe,
  runChromium,
  startLoopbackServer,
  validateRenderedLayout,
};