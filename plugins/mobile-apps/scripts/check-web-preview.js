#!/usr/bin/env node

/**
 * check-web-preview.js - confirm the local Expo web preview serves a bundle that compiles.
 *
 * `/create-mobile-app` starts `expo start` at Step 8 and then asks the user to review the
 * app. An HTTP 200 for the page proves nothing: Expo serves the HTML shell immediately, and a broken
 * import only surfaces when the browser requests the JavaScript bundle. So this requests the bundle
 * the page names, the way the browser would, and reports Metro's error instead of the user finding
 * a red screen.
 *
 * The page names its entry bundle like this:
 *   <script src="/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.routerRoot=app" defer></script>
 * `lazy=true` lets Metro leave route modules out of the entry bundle, so a broken screen would still
 * answer 200. The check rewrites it to `lazy=false`, which makes Metro compile every route.
 *
 * A failed compile answers HTTP 500 with JSON, for example:
 *   {"type":"UnableToResolveError","originModulePath":"/app/app/(app)/home.tsx",
 *    "targetModuleName":"@/hooks/data/missing","message":"Unable to resolve module ...\u001b[0m ..."}
 * `message` carries ANSI colour codes and a code frame; they are stripped before reporting.
 *
 * Usage:
 *   node check-web-preview.js --url http://localhost:19006 [--timeout-ms 180000]
 * Prints one JSON object. Exit 0 when the bundle compiles, 1 when it does not or the server never
 * answers, 2 on usage errors.
 */

'use strict';

const { normalizePreviewUrl } = require('./app-docs');

// Matches CSI escape sequences such as `\u001b[31m` and `\u001b[0m`.
const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI, '');
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: '*/*' } });
  } finally {
    clearTimeout(timer);
  }
}

/** The first same-origin script whose path ends in `.bundle`, with `lazy` forced off. */
function entryBundleUrl(html, baseUrl) {
  const pattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const candidate = new URL(match[1].replace(/&amp;/g, '&'), baseUrl);
    if (candidate.origin !== new URL(baseUrl).origin) continue;
    if (!/\.bundle$/.test(candidate.pathname)) continue;
    candidate.searchParams.set('lazy', 'false');
    return candidate.toString();
  }
  return null;
}

/**
 * When a route fails to compile, the dev server answers the page itself with HTTP 500 and embeds
 * the error for its own error overlay:
 *   <script id="_expo-static-error" type="application/json">{"logs":[{"level":"resolution",
 *     "type":"error","message":{"content":"Unable to resolve module ..."}, ...}]}</script>
 * Read the first log's message so the caller gets the cause, not just a status code.
 */
function staticPageError(html) {
  const match = /<script[^>]*id=["']_expo-static-error["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const log = (parsed.logs || []).find((entry) => entry && entry.message) || {};
    const content = typeof log.message === 'string' ? log.message : (log.message || {}).content;
    return { type: log.level || log.type || 'BundleError', message: content || '' };
  } catch {
    return { type: 'BundleError', message: '' };
  }
}

async function waitForPage(url, deadline) {
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, Math.max(1000, Math.min(30000, deadline - Date.now())));
      const body = await response.text();
      if (response.ok) return { html: body };
      // A 500 that carries Expo's error payload is a compile failure, not a server still starting:
      // waiting longer cannot fix it, so report it now.
      const pageError = response.status >= 500 ? staticPageError(body) : null;
      if (pageError) return { pageError: { ...pageError, httpStatus: response.status } };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      // Connection refused while Metro is still starting is the expected early state.
      lastError = error.cause && error.cause.code ? error.cause.code : error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The preview at ${url} did not answer (${lastError})`);
}

async function checkWebPreview(rawUrl, { timeoutMs = 180000 } = {}) {
  const url = normalizePreviewUrl(rawUrl);
  const deadline = Date.now() + timeoutMs;

  let page;
  try {
    page = await waitForPage(url, deadline);
  } catch (error) {
    return { status: 'unreachable', url, message: error.message };
  }
  if (page.pageError) {
    return {
      status: 'bundle-error',
      url,
      httpStatus: page.pageError.httpStatus,
      type: page.pageError.type,
      file: '',
      target: '',
      message: stripAnsi(page.pageError.message).trim().slice(0, 4000),
    };
  }
  const { html } = page;

  const bundleUrl = entryBundleUrl(html, url);
  if (!bundleUrl) {
    return { status: 'no-bundle', url, message: 'The page does not reference a JavaScript bundle' };
  }

  let response;
  try {
    // The first full compile of a fresh project takes tens of seconds, so the bundle gets whatever
    // remains of the overall budget rather than a short per-request timeout.
    response = await fetchWithTimeout(bundleUrl, Math.max(5000, deadline - Date.now()));
  } catch (error) {
    return { status: 'unreachable', url, message: `Bundle request failed: ${error.message}` };
  }

  if (response.ok) {
    // Drain the body so the connection closes cleanly; the content itself is not needed.
    await response.arrayBuffer();
    return { status: 'ok', url };
  }

  const body = await response.text();
  let detail;
  try {
    detail = JSON.parse(body);
  } catch {
    detail = { message: body.slice(0, 2000) };
  }
  return {
    status: 'bundle-error',
    url,
    httpStatus: response.status,
    type: detail.type || 'BundleError',
    file: detail.originModulePath || detail.filename || '',
    target: detail.targetModuleName || '',
    message: stripAnsi(detail.message).trim().slice(0, 4000),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--url') options.url = argv[++index];
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.url) throw new Error('--url is required');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000)) {
    throw new Error('--timeout-ms must be at least 1000');
  }
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    normalizePreviewUrl(options.url);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  checkWebPreview(options.url, options).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.status === 'ok' ? 0 : 1);
  });
}

module.exports = { checkWebPreview, entryBundleUrl, staticPageError, stripAnsi };
