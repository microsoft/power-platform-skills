'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  patchJavaScript,
  patchTypes,
} = require('../../template/scripts/patch-native-host-auth');

test('adds the current account identity to the auth provider value', () => {
  const source = `value: {
      hasRealAccount: account !== null,
      error,
    }`;
  const patched = patchJavaScript(source, 'AuthContext.js');

  assert.match(patched, /typeof account\.claims\?\.oid === 'string'/);
  assert.match(patched, /oid: account\.claims\.oid\.toLowerCase\(\)/);
  assert.match(patched, /username: account\.username/);
  assert.match(patched, /tenantId: account\.tenantId/);
});

test('adds a typed non-secret user to AuthState', () => {
  const source = `export interface AuthState {
    hasRealAccount: boolean;
    error: Error | null;
}`;
  const patched = patchTypes(source, 'AuthContext.d.ts');

  assert.match(patched, /user: \{/);
  assert.match(patched, /oid: string;/);
  assert.match(patched, /\} \| null;/);
});

test('is idempotent after the host exposes the contract', () => {
  const js = 'oid: account.claims.oid.toLowerCase()';
  const types = '    user: {\n        oid: string;\n    } | null;';
  assert.strictEqual(patchJavaScript(js, 'AuthContext.js'), js);
  assert.strictEqual(patchTypes(types, 'AuthContext.d.ts'), types);
});

test('replaces the earlier home-account identifier compatibility patch', () => {
  const source = `      user: account ? {
        oid: account.identifier,
        username: account.username,
        tenantId: account.tenantId
      } : null,`;
  const patched = patchJavaScript(source, 'AuthContext.js');

  assert.doesNotMatch(patched, /account\.identifier/);
  assert.match(patched, /oid: account\.claims\.oid\.toLowerCase\(\)/);
});

test('fails closed on an unsupported host package shape', () => {
  assert.throws(
    () => patchJavaScript('const changed = true;', 'AuthContext.js'),
    /Unsupported AuthContext JavaScript shape/,
  );
  assert.throws(
    () => patchTypes('interface AuthState {}', 'AuthContext.d.ts'),
    /Unsupported AuthContext declaration shape/,
  );
});
