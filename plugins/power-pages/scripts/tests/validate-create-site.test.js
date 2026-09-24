const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const {
  validateProject,
  validateDeclarativeProject,
  readWebsiteIdentity,
  parseArgs,
} = require('../../skills/create-site/scripts/validate-site');

const WEBSITE_ID = '33333333-3333-3333-3333-333333333333';
const HOME_ID = '44444444-4444-4444-4444-444444444444';
const SCRIPT = require.resolve('../../skills/create-site/scripts/validate-site');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.validate-create-site-'));
  try {
    return await fn(dir);
  } finally {
    // Windows can briefly retain directory handles after a validator child exits.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function writeFile(root, relativePath, content = '') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function bootstrapFixture(root, { nested = false, version = '5.2.2', setting } = {}) {
  const site = nested ? path.join(root, '.powerpages-site') : root;
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(site, '.portalconfig'), { recursive: true });
  writeFile(site, 'website.yml', `id: ${WEBSITE_ID}\nname: Contoso Programs\n`);
  writeFile(
    site, path.join('web-pages', 'home.webpage.yml'),
    `id: ${HOME_ID}\nname: Home\npartialurl: /\n`,
  );
  writeBootstrap(site, 'bootstrap.min.css', version);
  if (setting !== undefined) {
    writeFile(
      site, path.join('site-settings', 'bootstrap.sitesetting.yml'),
      `name: Site/BootstrapV5Enabled\nvalue: ${setting}\n`,
    );
  }
  return site;
}

function writeBootstrap(site, filename, version, id = '55555555-5555-5555-5555-555555555555') {
  writeFile(
    site, path.join('web-files', `${filename}.webfile.yml`),
    `id: ${id}\nname: ${filename}\npartialurl: ${filename}\nfilename: ${filename}\nparentpageid: ${HOME_ID}\n`,
  );
  if (version !== null) {
    writeFile(site, path.join('web-files', filename), `/*! Bootstrap v${version} */\n.btn { padding: 6px; }\n`);
  }
}

function runCli(root, args, input = '') {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  });
}

test('validates a declarative project with matching identity and assets', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.powerpages-site', '.portalconfig'), { recursive: true });
    writeFile(
      root,
      path.join('.powerpages-site', 'website.yml'),
      `id: ${WEBSITE_ID}\nname: Contoso Programs\n`,
    );
    writeFile(
      root,
      path.join('.powerpages-site', 'web-pages', 'home.webpage.yml'),
      'id: 44444444-4444-4444-4444-444444444444\nname: Home\n',
    );

    const result = validateProject(root, { expectedWebsiteRecordId: WEBSITE_ID });
    assert.equal(result.siteType, 'declarative');
    assert.deepEqual(result.errors, []);
  }));

test('blocks a declarative project whose website identity differs from creation', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.powerpages-site', '.portalconfig'), { recursive: true });
    writeFile(
      root,
      path.join('.powerpages-site', 'website.yml'),
      'id: 55555555-5555-5555-5555-555555555555\nname: Wrong Site\n',
    );
    writeFile(root, path.join('.powerpages-site', 'site-settings', 'x.sitesetting.yml'), 'id: x\n');

    const result = validateProject(root, { expectedWebsiteRecordId: WEBSITE_ID });
    assert.match(result.errors.join('\n'), /does not match created website/);
  }));

test('requires the portalconfig marker, declarative assets, and Git', () =>
  withTempDir((root) => {
    writeFile(
      root,
      path.join('.powerpages-site', 'website.yml'),
      `id: ${WEBSITE_ID}\nname: Empty Site\n`,
    );

    const result = validateProject(root);
    const message = result.errors.join('\n');
    assert.match(message, /portalconfig/);
    assert.match(message, /no site assets/);
    assert.match(message, /Git repository not initialized/);
  }));

test('can validate downloaded identity and assets before Git initialization', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.powerpages-site', '.portalconfig'), { recursive: true });
    writeFile(
      root,
      path.join('.powerpages-site', 'website.yml'),
      `id: ${WEBSITE_ID}\nname: Downloaded Site\n`,
    );
    writeFile(root, path.join('.powerpages-site', 'web-pages', 'home.webpage.yml'), 'name: Home\n');

    const result = validateProject(root, {
      expectedWebsiteRecordId: WEBSITE_ID,
      skipGit: true,
    });
    assert.deepEqual(result.errors, []);
  }));

test('validates a manually downloaded declarative site opened at its site root', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
    writeFile(root, 'website.yml', `id: ${WEBSITE_ID}\nname: Manual Download\n`);
    writeFile(root, path.join('web-pages', 'home.webpage.yml'), 'name: Home\n');

    const result = validateProject(root, { expectedWebsiteRecordId: WEBSITE_ID });
    assert.equal(result.siteType, 'declarative');
    assert.deepEqual(result.errors, []);
  }));

test('does not count customization documentation as a declarative site asset', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
    writeFile(root, 'website.yml', `id: ${WEBSITE_ID}\nname: Documentation Only\n`);
    writeFile(
      root,
      path.join('docs', 'customize-declarative-site', 'current-plan.html'),
      '<html><body>Plan</body></html>',
    );

    const result = validateProject(root, { expectedWebsiteRecordId: WEBSITE_ID });
    assert.match(result.errors.join('\n'), /no site assets/);
  }));

test('uses the direct-root website path in identity mismatch errors', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
    writeFile(
      root,
      'website.yml',
      'id: 55555555-5555-5555-5555-555555555555\nname: Wrong Site\n',
    );
    writeFile(root, path.join('web-pages', 'home.webpage.yml'), 'name: Home\n');

    const result = validateProject(root, { expectedWebsiteRecordId: WEBSITE_ID });
    assert.match(result.errors.join('\n'), /^website\.yml id /);
  }));

test('readWebsiteIdentity strips quotes and inline comments', () =>
  withTempDir((root) => {
    const filePath = path.join(root, 'website.yml');
    fs.writeFileSync(filePath, `id: "${WEBSITE_ID}" # created site\n`);
    assert.equal(readWebsiteIdentity(filePath).id, WEBSITE_ID);
  }));

test('preserves the existing code-site validation path', () =>
  withTempDir((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'src'));
    writeFile(root, '.gitignore', 'node_modules\n');
    writeFile(
      root,
      'powerpages.config.json',
      JSON.stringify({
        $schema: 'https://example.invalid/schema.json',
        compiledPath: 'dist',
        siteName: 'Code Site',
        defaultLandingPage: 'index.html',
      }),
    );
    writeFile(
      root,
      'package.json',
      JSON.stringify({ scripts: { build: 'build', dev: 'dev' } }),
    );
    writeFile(root, path.join('src', 'main.ts'), 'export const ready = true;\n');

    const result = validateProject(root);
    assert.equal(result.siteType, 'code');
    assert.deepEqual(result.errors, []);
    for (const expectedBootstrapMajor of [3, 5]) {
      const explicit = validateProject(root, { expectedBootstrapMajor });
      assert.equal(explicit.siteType, 'code');
      assert.match(explicit.errors.join('\n'), /only supported for declarative sites, not code sites/);
      const cli = runCli(root, ['--projectRoot', root, '--bootstrapVersion', String(expectedBootstrapMajor)]);
      assert.equal(cli.status, 2);
      assert.match(cli.stderr, /only supported for declarative sites, not code sites/);
    }
  }));

test('verifies actual Bootstrap 3 and 5 assets for both direct and nested downloads', () =>
  withTempDir((work) => {
    for (const nested of [false, true]) {
      for (const [version, expectedBootstrapMajor] of [['3.3.6', 3], ['5.2.2', 5]]) {
        const root = path.join(work, `${nested}-${expectedBootstrapMajor}`);
        bootstrapFixture(root, { nested, version });
        const options = { expectedWebsiteRecordId: WEBSITE_ID, expectedBootstrapMajor };
        assert.deepEqual(validateProject(root, options), { siteType: 'declarative', errors: [] });
        assert.deepEqual(validateDeclarativeProject(root, options), []);
        const cli = runCli(root, [
          '--projectRoot', root, '--websiteRecordId', WEBSITE_ID,
          '--bootstrapVersion', String(expectedBootstrapMajor),
        ]);
        assert.equal(cli.status, 0, cli.stderr);
        assert.match(cli.stdout, /declarative site validation passed/);
        assert.equal(cli.stderr, '');
      }
    }
  }));

test('rejects a downloaded Bootstrap major that differs from the explicit creation target', () =>
  withTempDir((work) => {
    for (const [version, expectedBootstrapMajor, actual] of [['3.3.6', 5, 3], ['5.2.2', 3, 5]]) {
      const root = path.join(work, String(actual));
      bootstrapFixture(root, { version });
      const result = validateProject(root, { expectedBootstrapMajor });
      assert.match(
        result.errors.join('\n'),
        new RegExp(`Downloaded site uses Bootstrap ${actual}; expected Bootstrap ${expectedBootstrapMajor}`),
      );
      const cli = runCli(root, ['--projectRoot', root, '--bootstrapVersion', String(expectedBootstrapMajor)]);
      assert.equal(cli.status, 2);
      assert.match(cli.stderr, /declarative validation failed/);
      assert.equal(cli.stdout, '');
    }
  }));

test('Bootstrap settings and data-model metadata alone cannot satisfy asset verification', () =>
  withTempDir((work) => {
    for (const setting of [undefined, true, false]) {
      const root = path.join(work, String(setting));
      const site = bootstrapFixture(root, { version: null, setting });
      writeFile(site, 'website.yml', `id: ${WEBSITE_ID}\nname: Contoso\nmodelVersion: Enhanced\n`);
      const result = validateProject(root, { expectedBootstrapMajor: setting === false ? 3 : 5 });
      assert.match(result.errors.join('\n'), /Bootstrap asset evidence is missing, conflicting, or unsupported/);
      assert.deepEqual(validateProject(root).errors, []);
    }
  }));

test('unversioned or unsupported downloaded Bootstrap assets fail explicit verification', () =>
  withTempDir((work) => {
    for (const version of ['', '4.6.2']) {
      const root = path.join(work, version || 'unversioned');
      bootstrapFixture(root, { version, setting: true });
      assert.match(
        validateProject(root, { expectedBootstrapMajor: 5 }).errors.join('\n'),
        /Bootstrap asset evidence is missing, conflicting, or unsupported/,
      );
    }
  }));

test('rejects conflicting settings or conflicting downloaded asset versions', () =>
  withTempDir((work) => {
    for (const [version, setting, expectedBootstrapMajor] of [['3.3.6', true, 5], ['5.2.2', false, 5]]) {
      const root = path.join(work, String(setting));
      bootstrapFixture(root, { version, setting });
      assert.match(
        validateProject(root, { expectedBootstrapMajor }).errors.join('\n'),
        /Bootstrap asset evidence is missing, conflicting, or unsupported/,
      );
      assert.deepEqual(validateProject(root).errors, []);
    }
    for (const secondVersion of ['3.3.6', '5.3.0']) {
      const root = path.join(work, secondVersion);
      const site = bootstrapFixture(root);
      writeBootstrap(site, 'bootstrap.css', secondVersion, '66666666-6666-6666-6666-666666666666');
      assert.match(
        validateProject(root, { expectedBootstrapMajor: 5 }).errors.join('\n'),
        /Bootstrap asset evidence is missing, conflicting, or unsupported/,
      );
    }
  }));

test('accepts agreeing settings without requiring a Bootstrap setting to exist', () =>
  withTempDir((work) => {
    for (const [version, setting, expectedBootstrapMajor] of [['3.3.6', false, 3], ['5.2.2', true, 5]]) {
      const root = path.join(work, String(setting));
      bootstrapFixture(root, { version, setting });
      assert.deepEqual(validateProject(root, { expectedBootstrapMajor }).errors, []);
    }
  }));

test('inspects the selected nested download rather than unrelated wrapper assets', () =>
  withTempDir((root) => {
    bootstrapFixture(root, { version: '3.3.6' });
    bootstrapFixture(root, { nested: true });
    assert.deepEqual(validateProject(root, { expectedBootstrapMajor: 5 }).errors, []);
    assert.match(
      validateProject(root, { expectedBootstrapMajor: 3 }).errors.join('\n'),
      /Downloaded site uses Bootstrap 5/,
    );
  }));

test('turns shared inspector failures into ordinary validation errors only when Bootstrap was requested', () =>
  withTempDir((root) => {
    const site = bootstrapFixture(root);
    writeFile(site, path.join('web-pages', 'home.webpage.yml'), `id: ${HOME_ID}\nname: Home\n`);
    assert.deepEqual(validateProject(root).errors, []);
    assert.match(
      validateProject(root, { expectedBootstrapMajor: 5 }).errors.join('\n'),
      /Could not verify downloaded Bootstrap version: Could not resolve exactly one site root page/,
    );
  }));

test('Bootstrap validation never rewrites the downloaded asset or setting', () =>
  withTempDir((root) => {
    const site = bootstrapFixture(root, { version: '3.3.6', setting: false });
    const files = [
      path.join(site, 'website.yml'),
      path.join(site, 'web-files', 'bootstrap.min.css'),
      path.join(site, 'site-settings', 'bootstrap.sitesetting.yml'),
    ];
    const before = files.map((file) => fs.readFileSync(file));
    assert.ok(validateProject(root, { expectedBootstrapMajor: 5 }).errors.length > 0);
    assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
  }));

test('explicit Bootstrap verification still enforces expected website identity and optional Git checks', () =>
  withTempDir((root) => {
    bootstrapFixture(root, { nested: true });
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    assert.deepEqual(validateProject(root, { expectedBootstrapMajor: 5, skipGit: true }).errors, []);
    assert.match(
      validateProject(root, {
        expectedBootstrapMajor: 5,
        expectedWebsiteRecordId: '77777777-7777-7777-7777-777777777777',
        skipGit: true,
      }).errors.join('\n'),
      /does not match created website/,
    );
    assert.match(validateProject(root, { expectedBootstrapMajor: 5 }).errors.join('\n'), /Git repository not initialized/);
  }));

test('parses the optional Bootstrap CLI choice without changing omitted-flag arguments', () => {
  assert.deepEqual(parseArgs(['--projectRoot', 'site', '--skipGit', 'true']), { projectRoot: 'site', skipGit: 'true' });
  for (const [flag, version] of [['--bootstrapVersion', '5'], ['--bootstrap-version', '3']]) {
    assert.equal(parseArgs([flag, version]).bootstrapVersion, Number(version));
    assert.equal(parseArgs([`${flag}=${version}`]).bootstrapVersion, Number(version));
  }
});

test('rejects invalid Bootstrap module options and malformed or missing CLI values', () =>
  withTempDir((root) => {
    bootstrapFixture(root);
    for (const expectedBootstrapMajor of [0, 4, true, false, '', '5.0', '05', [5], {}]) {
      assert.match(
        validateProject(root, { expectedBootstrapMajor }).errors.join('\n'),
        /--bootstrapVersion must be 3 or 5/,
      );
    }
    for (const args of [
      ['--bootstrapVersion'],
      ['--bootstrapVersion', '--skipGit', 'true'],
      ['--bootstrapVersion', ''],
      ['--bootstrapVersion='],
      ['--bootstrapVersion', '4'],
      ['--bootstrapVersion', '5.0'],
      ['--bootstrap-version'],
      ['--bootstrapVersion', '5', '--bootstrap-version', '3'],
    ]) {
      assert.throws(() => parseArgs(args), /--bootstrapVersion must be/);
      const cli = runCli(root, ['--projectRoot', root, ...args]);
      assert.equal(cli.status, 2);
      assert.match(cli.stderr, /Power Pages site validation failed:\n- --bootstrapVersion must be/);
      assert.equal(cli.stdout, '');
    }
  }));

test('Bootstrap CLI selects direct validation even without --projectRoot', () =>
  withTempDir((work) => {
    for (const nested of [false, true]) {
      const root = path.join(work, String(nested));
      bootstrapFixture(root, { nested });
      const cli = runCli(root, ['--bootstrapVersion', '5']);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /declarative site validation passed/);
      const missing = runCli(root, ['--bootstrapVersion']);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /--bootstrapVersion must be/);
    }
  }));

test('keeps no-flag CLI and hook validation structural for existing sites', () =>
  withTempDir((root) => {
    bootstrapFixture(root, { nested: true, version: null, setting: true });
    const cli = runCli(root, ['--projectRoot', root]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /validation passed/);
    const hook = runCli(root, [], JSON.stringify({ cwd: root }));
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stderr, '');
    const explicit = runCli(root, ['--projectRoot', root, '--bootstrapVersion', '5']);
    assert.equal(explicit.status, 2);
    assert.match(explicit.stderr, /Bootstrap asset evidence is missing/);
  }));

test('does not silently approve explicit Bootstrap verification without a project', () =>
  withTempDir((root) => {
    assert.deepEqual(validateProject(null), { siteType: null, errors: [] });
    assert.deepEqual(validateProject(root), { siteType: null, errors: [] });
    for (const projectRoot of [null, root]) {
      assert.match(
        validateProject(projectRoot, { expectedBootstrapMajor: 5 }).errors.join('\n'),
        /Cannot verify Bootstrap without a declarative Power Pages project/,
      );
    }
    const cli = runCli(root, ['--projectRoot', root, '--bootstrapVersion', '5']);
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /No Power Pages project found/);
  }));
