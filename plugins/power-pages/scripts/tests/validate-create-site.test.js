const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateProject,
  readWebsiteIdentity,
} = require('../../skills/create-site/scripts/validate-site');

const WEBSITE_ID = '33333333-3333-3333-3333-333333333333';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-create-site-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(root, relativePath, content = '') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('validates an EDM declarative project with matching identity and assets', () =>
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
  }));
