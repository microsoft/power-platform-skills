'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  buildInitArgs,
  initializeMobileApp,
} = require('../initialize-mobile-app');

const pluginRoot = path.resolve(__dirname, '../..');
const templateRoot = path.join(pluginRoot, 'template');

function copyTemplate() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-init-'));
  fs.cpSync(templateRoot, projectRoot, { recursive: true });
  return projectRoot;
}

function writePreparedName(projectRoot, displayName) {
  const appConfigPath = path.join(projectRoot, 'app.config.js');
  const source = fs.readFileSync(appConfigPath, 'utf8').replace(
    "const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';",
    `const APP_NAME = process.env.APP_DISPLAY_NAME || '${displayName.replace(/'/g, "\\'")}';`,
  );
  fs.writeFileSync(appConfigPath, source);
}

test('init arguments preserve apostrophes as one argument', () => {
  const args = buildInitArgs("Inspector's Workspace", 'env-123');
  assert.deepStrictEqual(args.slice(4, 6), [
    '--display-name',
    "Inspector's Workspace",
  ]);
});

test('prepared identity is not replaced by a caller environment override', () => {
  const projectRoot = copyTemplate();
  writePreparedName(projectRoot, 'Prepared App');
  const previousDisplayName = process.env.APP_DISPLAY_NAME;
  process.env.APP_DISPLAY_NAME = 'Machine Override';
  try {
    const result = initializeMobileApp({
      workingDir: projectRoot,
      environmentId: 'env-123',
      spawn(command, args) {
        assert.strictEqual(args[5], 'Prepared App');
        fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
          environmentId: 'env-123',
          appDisplayName: 'Prepared App',
        }));
        return { status: 0 };
      },
    });
    assert.strictEqual(result.displayName, 'Prepared App');
  } finally {
    if (previousDisplayName === undefined) delete process.env.APP_DISPLAY_NAME;
    else process.env.APP_DISPLAY_NAME = previousDisplayName;
  }
});

test('matching existing configuration skips initialization', () => {
  const projectRoot = copyTemplate();
  writePreparedName(projectRoot, 'Existing App');
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
    environmentId: 'ENV-123',
    appDisplayName: 'Existing App',
  }));

  const result = initializeMobileApp({
    workingDir: projectRoot,
    environmentId: 'env-123',
    spawn() {
      throw new Error('spawn must not run');
    },
  });
  assert.strictEqual(result.status, 'existing');
});

test('existing configuration must match the approved display name', () => {
  const projectRoot = copyTemplate();
  writePreparedName(projectRoot, 'Approved App');
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
    environmentId: 'env-123',
    appDisplayName: 'Different App',
  }));

  assert.throws(() => initializeMobileApp({
    workingDir: projectRoot,
    environmentId: 'env-123',
    spawn() {
      throw new Error('spawn must not run');
    },
  }), /identifies app "Different App", but the approved display name is "Approved App"/);
});

test('initialization uses an argument array and verifies generated identity', () => {
  const projectRoot = copyTemplate();
  writePreparedName(projectRoot, "Inspector's Workspace");

  const result = initializeMobileApp({
    workingDir: projectRoot,
    environmentId: 'env-123',
    npxCommand: 'npx-test',
    spawn(command, args, options) {
      assert.strictEqual(command, 'npx-test');
      assert.strictEqual(options.cwd, projectRoot);
      assert.strictEqual(options.shell, false);
      assert.deepStrictEqual(args.slice(4, 6), [
        '--display-name',
        "Inspector's Workspace",
      ]);
      fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
        environmentId: 'env-123',
        appDisplayName: "Inspector's Workspace",
      }));
      return { status: 0 };
    },
  });

  assert.strictEqual(result.status, 'initialized');
});
