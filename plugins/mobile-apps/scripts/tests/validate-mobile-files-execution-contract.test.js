'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  executionApprovedJsDependencies,
  mergeApprovedJsDependencies,
} = require('../validate-mobile-files');

test('loads exact pure-JavaScript approvals from the execution contract', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-file-execution-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), JSON.stringify({
    javascriptDependencies: [{
      package: 'react-native-calendars',
      version: '1.1314.0',
      classification: 'pure-js',
    }],
  }));

  assert.deepEqual(executionApprovedJsDependencies(root), [{
    name: 'react-native-calendars',
    version: '1.1314.0',
  }]);
});

test('rejects conflicting dependency approval versions', () => {
  assert.throws(
    () => mergeApprovedJsDependencies(
      [{ name: 'react-native-calendars', version: '1.1315.0' }],
      [{ name: 'react-native-calendars', version: '1.1314.0' }],
    ),
    /conflicting approved versions/,
  );
});