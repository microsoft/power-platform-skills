'use strict';
// lib/left-on-disk.js: the one wording of what a command says when the page backend could not remove a workspace it made. The commands that use it — and
// that each say it, in the channel of their own — are tested with the commands (genpage.test.js, genpage-upload.test.js, genpage-base.test.js, apps.test.js,
// verify-model-app.test.js, sdk-build-pages-deploy.test.js, build-model-app.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leftOnDiskWarning } = require('../lib/left-on-disk.js');

test('a non-empty `{ left }` is one warning that names every folder and says what to do; anything else says nothing', () => {
  assert.strictEqual(
    leftOnDiskWarning({ left: ['C:\\temp\\genpage-x1y2z3'] }),
    'the page workspace could not be removed, so page source may be left on disk: C:\\temp\\genpage-x1y2z3 — delete the folder by hand',
  );
  assert.strictEqual(
    leftOnDiskWarning({ left: ['/tmp/genpage-a', '/tmp/genpage-b'] }),
    'the page workspace could not be removed, so page source may be left on disk: /tmp/genpage-a, /tmp/genpage-b — delete the folder by hand',
  );
  // dispose() of a stand-in, of a backend that was lent an SDK, or one that answers nothing: no folder is known to be left.
  for (const disposed of [undefined, null, {}, { left: [] }, { left: undefined }, { left: 'C:\\temp\\genpage-x1y2z3' }, 'C:\\temp\\genpage-x1y2z3', 0]) {
    assert.strictEqual(leftOnDiskWarning(disposed), null, JSON.stringify(disposed));
  }
});

test('an entry that is not a folder name is not named', () => {
  assert.strictEqual(
    leftOnDiskWarning({ left: ['', null, 5, undefined, 'C:\\temp\\genpage-x1y2z3'] }),
    'the page workspace could not be removed, so page source may be left on disk: C:\\temp\\genpage-x1y2z3 — delete the folder by hand',
  );
  assert.strictEqual(leftOnDiskWarning({ left: ['', null, 5] }), null);
});
