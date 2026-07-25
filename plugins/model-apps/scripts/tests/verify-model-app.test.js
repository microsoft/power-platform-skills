'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { readerFor } = require('../verify-model-app.js');

// Minimal SDK stub: provides just enough surface for readerFor (appIdFor resolution + base reads).
function stubSdk() {
  return { queryRecords: async () => [{ appmoduleid: 'app-1' }], findTables: async () => [], findColumns: async () => [] };
}

test('readerFor.pages() HALTS fail-closed when enumeration fails', async () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: { enumerate: async () => ({ ok: false, error: 'auth expired' }) },
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')),
  });
  await assert.rejects(reader.pages(), /enumeration failed/i);
});

test('readerFor.pageCode downloads ONCE (cached) and returns the page code; a download failure throws', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  let downloads = 0;
  const genpageCli = {
    enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-1', name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      downloads += 1;
      fs.mkdirSync(path.join(outputDir, 'gp-1'), { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'gp-1', 'page.tsx'), 'pageId: "gp-2"', 'utf8');
      return true;
    },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: ws });
  assert.strictEqual(await reader.pageCode('gp-1'), 'pageId: "gp-2"');
  await reader.pageCode('gp-1');
  assert.strictEqual(downloads, 1, 'download runs once and is cached');

  // A download failure must throw so the mandatory build gate can treat it as unableToRun.
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: {
      enumerate: async () => ({ ok: true, pages: [] }),
      download: async () => { throw new Error('pac download failed'); },
    },
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')),
  });
  await assert.rejects(failing.pageCode('gp-1'), /download failed/i);
});

test('readerFor WITHOUT a genpageCli has no pages() — verifySpec then fails closed for a page-bearing spec', () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {});
  // No genpageCli → no pages method → verifySpec detects reader-incapacity and sets unableToRun (C6).
  assert.strictEqual(typeof reader.pages, 'undefined', 'no page reader when no genpageCli is wired (drives the C6 unable-to-run path)');
});
