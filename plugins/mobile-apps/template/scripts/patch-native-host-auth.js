#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER_TYPE = `    /**
     * Non-secret identity from the current MSAL account. Null for signed-out
     * and no-auth sessions.
     */
    user: {
        oid: string;
        username: string;
        tenantId: string;
    } | null;
`;

function patchJavaScript(source, filePath) {
  const patchedUser = `      user: account && typeof account.claims?.oid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.claims.oid) ? {
        oid: account.claims.oid.toLowerCase(),
        username: account.username,
        tenantId: account.tenantId
      } : null,`;
  if (source.includes('oid: account.claims.oid.toLowerCase()')) {
    return source;
  }

  const previousClaimsPatch = '        oid: account.claims.oid,';
  if (source.includes(previousClaimsPatch)) {
    return source.replace(
      previousClaimsPatch,
      '        oid: account.claims.oid.toLowerCase(),',
    );
  }

  const previousPatch = `      user: account ? {
        oid: account.identifier,
        username: account.username,
        tenantId: account.tenantId
      } : null,`;
  if (source.includes(previousPatch)) {
    return source.replace(previousPatch, patchedUser);
  }

  const needle = '      hasRealAccount: account !== null,\n      error,';
  if (!source.includes(needle)) {
    throw new Error(`Unsupported AuthContext JavaScript shape: ${filePath}`);
  }

  return source.replace(
    needle,
    `      hasRealAccount: account !== null,
${patchedUser}
      error,`,
  );
}

function patchTypes(source, filePath) {
  if (source.includes('    user: {') && source.includes('        oid: string;')) {
    return source;
  }

  const needle = '    hasRealAccount: boolean;\n    error: Error | null;';
  if (!source.includes(needle)) {
    throw new Error(`Unsupported AuthContext declaration shape: ${filePath}`);
  }

  return source.replace(
    needle,
    `    hasRealAccount: boolean;
${USER_TYPE}    error: Error | null;`,
  );
}

function patchFile(filePath, transform) {
  const source = fs.readFileSync(filePath, 'utf8');
  const patched = transform(source, filePath);
  if (patched !== source) {
    fs.writeFileSync(filePath, patched);
  }
}

function main(projectRoot = path.resolve(__dirname, '..')) {
  const packageRoot = path.join(
    projectRoot,
    'node_modules',
    '@microsoft',
    'power-apps-native-host',
    'lib',
  );

  if (!fs.existsSync(packageRoot)) {
    throw new Error(
      '@microsoft/power-apps-native-host is not installed. Run npm install before applying the auth compatibility patch.',
    );
  }

  // Temporary compatibility seam: native auth already provides decoded,
  // non-secret ID-token claims on the MSAL account, but host 0.2.25 does not
  // expose the validated OID through AuthState. Remove this patch once the
  // package publishes the same typed user.oid contract.
  patchFile(path.join(packageRoot, 'module/auth/AuthContext.js'), patchJavaScript);
  patchFile(path.join(packageRoot, 'commonjs/auth/AuthContext.js'), patchJavaScript);
  patchFile(
    path.join(packageRoot, 'typescript/module/auth/AuthContext.d.ts'),
    patchTypes,
  );
  patchFile(
    path.join(packageRoot, 'typescript/commonjs/auth/AuthContext.d.ts'),
    patchTypes,
  );

  process.stdout.write('Native host AuthState exposes typed user.oid.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Native host auth patch failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, patchJavaScript, patchTypes };
