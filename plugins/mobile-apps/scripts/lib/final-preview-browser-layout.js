'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
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
    const viewport = frame.querySelector('[data-first-viewport="' + CSS.escape(screenId) + '"]');
    const focal = frame.querySelector('[data-focal-point="' + CSS.escape(screenId) + '"]');
    if (!visible(viewport) || !visible(focal) || focal.getBoundingClientRect().height < 48) {
      add('preview-layout-first-viewport-hierarchy', screenId + ' has no visible, substantial first-viewport focal point');
    }
    const components = [...frame.querySelectorAll('[data-product-component]')].filter(visible);
    frameFingerprints.push(components.map((element) => {
      const component = element.getBoundingClientRect();
      return [element.tagName, Math.round((component.top - rect.top) / 12), Math.round(component.width / rect.width * 10)];
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
  }
  if (frameFingerprints.length > 1
    && new Set(frameFingerprints.map((value) => JSON.stringify(value))).size === 1) {
    add('preview-layout-repeated-shell', 'computed component layouts repeat across every selected screen');
  }
  const details = document.querySelector('#preview-all-screens details');
  if (details) details.open = true;
  const navigation = document.querySelector('#preview-navigation');
  const destination = document.querySelector('[data-navigation-destination]');
  const navStyle = navigation && getComputedStyle(navigation);
  const destinationStyle = destination && getComputedStyle(destination);
  if (!navigation || !destination || !['flex', 'grid'].includes(navStyle.display)
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

function validateRenderedLayout(html, expected, options = {}) {
  const executable = options.browserExecutable === undefined
    ? findSupportedBrowser(options)
    : options.browserExecutable;
  if (!executable) {
    return { status: 'skipped', reason: 'browser-not-found', errors: [], viewports: [] };
  }
  let temporary;
  const results = [];
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'final-preview-layout-'));
    for (const viewport of options.viewports || VIEWPORTS) {
      const input = path.join(temporary, `${viewport.name}.html`);
      const output = path.join(temporary, `${viewport.name}-dom.html`);
      fs.writeFileSync(input, injectProbe(html, expected));
      const outputDescriptor = fs.openSync(output, 'w');
      // `executable` is selected only from the fixed platform allowlist above; no project or
      // model-authored value can choose a process. shell:false preserves argv boundaries.
      let run;
      try {
        run = (options.spawnSync || spawnSync)(executable, [
          '--headless',
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-extensions',
          '--no-first-run',
          `--user-data-dir=${path.join(temporary, `profile-${viewport.name}`)}`,
          `--window-size=${viewport.width},${viewport.height}`,
          '--dump-dom',
          pathToFileURL(input).href,
        ], {
          shell: false,
          stdio: ['ignore', outputDescriptor, 'ignore'],
          timeout: 2000,
          killSignal: 'SIGKILL',
          windowsHide: true,
        });
      } finally {
        fs.closeSync(outputDescriptor);
      }
      if (run.error || run.status !== 0) {
        return {
          status: 'skipped',
          reason: run.error?.code === 'ETIMEDOUT' ? 'browser-timeout' : 'browser-probe-unavailable',
          errors: [],
          viewports: results,
        };
      }
      const probe = decodeProbe(fs.readFileSync(output, 'utf8'));
      if (!probe) {
        return {
          status: 'skipped',
          reason: 'browser-probe-unavailable',
          errors: [],
          viewports: results,
        };
      }
      results.push({ ...viewport, errors: probe.errors || [] });
    }
  } catch {
    return {
      status: 'skipped',
      reason: 'browser-probe-error',
      errors: [],
      viewports: results,
    };
  } finally {
    if (temporary) {
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch {
        // Optional validation must not make generation depend on browser profile cleanup.
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
      findingCount: result.errors.length,
    })),
  };
}

module.exports = {
  VIEWPORTS,
  browserCandidates,
  decodeProbe,
  findSupportedBrowser,
  injectProbe,
  validateRenderedLayout,
};