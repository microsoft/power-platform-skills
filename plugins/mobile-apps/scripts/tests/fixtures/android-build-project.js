'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PACKAGE = 'com.contoso.fieldops';
const FIREBASE_PROJECT = 'field-ops-prod';
const FIREBASE_APP_ID = '1:123456789:android:abc123';
const SIGNER_SHA256 = 'ab'.repeat(32);
const INPUTS_CAPTURED = new Date('2026-08-24T09:59:59.000Z');
const BUILD_STARTED = new Date('2026-08-24T10:00:00.000Z');
const APK_MODIFIED = new Date('2026-08-24T10:00:05.000Z');
const VERIFIED_AT = new Date('2026-08-24T10:05:00.000Z');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([header, payload, checksum]);
}

function writePng(filePath, width = 432, height = 432) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeStoredZip(filePath, entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const checksum = crc32(data);
    const baseDataOffset = localOffset + 30 + nameBytes.length;
    const paddingLength = (4 - ((baseDataOffset + 4) % 4)) % 4;
    const extra = Buffer.alloc(4 + paddingLength);
    extra.writeUInt16LE(0xffff, 0);
    extra.writeUInt16LE(paddingLength, 2);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const localRecord = Buffer.concat([local, nameBytes, extra, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    locals.push(localRecord);
    centrals.push(Buffer.concat([central, nameBytes]));
    localOffset += localRecord.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([...locals, centralBytes, eocd]));
}

function addFakeApkSigningBlock(apkPath) {
  const archive = fs.readFileSync(apkPath);
  const eocdOffset = archive.length - 22;
  assertZipFooter(archive, eocdOffset);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    centralOffset >= 16
    && archive.subarray(centralOffset - 16, centralOffset).equals(Buffer.from('APK Sig Block 42'))
  ) {
    return;
  }
  const block = Buffer.alloc(32);
  block.writeBigUInt64LE(24n, 0);
  block.writeBigUInt64LE(24n, 8);
  Buffer.from('APK Sig Block 42').copy(block, 16);
  const result = Buffer.concat([
    archive.subarray(0, centralOffset),
    block,
    archive.subarray(centralOffset),
  ]);
  result.writeUInt32LE(centralOffset + block.length, eocdOffset + block.length + 16);
  fs.writeFileSync(apkPath, result);
}

function removeFakeApkSigningBlock(apkPath) {
  const archive = fs.readFileSync(apkPath);
  const eocdOffset = archive.length - 22;
  assertZipFooter(archive, eocdOffset);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    centralOffset < 24
    || !archive.subarray(centralOffset - 16, centralOffset).equals(Buffer.from('APK Sig Block 42'))
  ) {
    return;
  }
  const size = Number(archive.readBigUInt64LE(centralOffset - 24));
  const blockSize = size + 8;
  const blockOffset = centralOffset - blockSize;
  const result = Buffer.concat([
    archive.subarray(0, blockOffset),
    archive.subarray(centralOffset),
  ]);
  result.writeUInt32LE(blockOffset, eocdOffset - blockSize + 16);
  fs.writeFileSync(apkPath, result);
}

function assertZipFooter(archive, eocdOffset) {
  if (eocdOffset < 0 || archive.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error('test APK fixture ZIP footer is invalid');
  }
}

function createAndroidProject(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const iconPath = path.join(root, 'assets', 'icon.png');
  writePng(iconPath);
  writeJson(path.join(root, 'package.json'), {
    name: 'field-ops',
    version: '1.2.3',
    main: 'index.js',
    scripts: {
      'type-check': 'tsc --noEmit',
      'bundle:android': 'js-bundle android',
      'build:android': 'wrap android',
    },
  });
  writeJson(path.join(root, 'package-lock.json'), {
    name: 'field-ops',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {
      '': { name: 'field-ops', version: '1.2.3' },
    },
  });
  fs.writeFileSync(path.join(root, 'index.js'), "require('expo-router/entry');\n");
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', '(app)', 'home.tsx'),
    "export default function Home() { return null; }\n",
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'push.ts'),
    'export const pushConfigured = true;\n',
  );
  writeJson(path.join(root, 'firebase.json'), {
    'react-native': {
      messaging_auto_init_enabled: false,
    },
  });
  writeJson(path.join(root, 'auth.config.json'), {
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
  });
  writeJson(path.join(root, 'wrap.config.json'), {
    bundleIdentifier: PACKAGE,
    displayName: 'Field Ops',
    version: '1.2.3',
    versionCode: 7,
    iconPath: './assets/icon.png',
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
    outputPath: './dist',
  });
  fs.writeFileSync(path.join(root, 'app.config.js'), `
module.exports = {
  name: process.env.APP_DISPLAY_NAME,
  version: process.env.APP_VERSION,
  icon: process.env.APP_ICON_PATH,
  platforms: ['android'],
  android: {
    package: process.env.ANDROID_PACKAGE,
    versionCode: Number(process.env.APP_VERSION_CODE),
    googleServicesFile: './firebase/google-services.json',
    adaptiveIcon: { foregroundImage: process.env.APP_ICON_PATH },
  },
};
`);
  writeJson(path.join(root, 'firebase', 'google-services.json'), {
    project_info: { project_id: FIREBASE_PROJECT, project_number: '123456789' },
    client: [{
      client_info: {
        mobilesdk_app_id: FIREBASE_APP_ID,
        android_client_info: { package_name: PACKAGE },
      },
    }],
  });
  fs.writeFileSync(path.join(root, 'memory-bank.md'), [
    '| Display name | Field Ops |',
    `| Android bundle id | ${PACKAGE} |`,
    `| App registration (Entra) | ${CLIENT_ID} |`,
    `| Firebase project ID | ${FIREBASE_PROJECT} |`,
    `| Android Firebase app ID | ${FIREBASE_APP_ID} |`,
    `| Android package | ${PACKAGE} |`,
    '| Android client config path | firebase/google-services.json |',
    '| Android version name | 1.2.3 |',
    '| Android version code | 7 |',
    '| Android icon path | assets/icon.png |',
    `| Android icon SHA-256 | ${sha256File(iconPath)} |`,
    '| Brand tokens | primary, accent |',
    '',
  ].join('\n'));

  const hostRoot = path.join(
    root,
    'node_modules',
    '@microsoft',
    'power-apps-native-host',
  );
  writeJson(path.join(hostRoot, 'package.json'), {
    name: '@microsoft/power-apps-native-host',
    version: '0.2.25',
    bin: { wrap: 'scripts/wrap.js' },
  });
  fs.mkdirSync(path.join(hostRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'scripts', 'wrap.js'), [
    'const keystorePath = "";',
    'const keystorePassword = "";',
    'const keyAlias = "";',
    'const keyPassword = "";',
    'const command = "apksigner";',
    'const task = "assembleRelease";',
    '',
  ].join('\n'));

  const markerPath = path.join(root, '.tmp', 'android-build-start');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, '');
  fs.utimesSync(markerPath, BUILD_STARTED, BUILD_STARTED);
  const apkPath = path.join(root, 'dist', `${PACKAGE}.apk`);
  writeStoredZip(apkPath, {
    'res/mipmap-mdpi-v4/ic_launcher.png': Buffer.from('packaged-icon'),
  });
  fs.utimesSync(apkPath, APK_MODIFIED, APK_MODIFIED);

  const tools = {};
  const toolRoot = path.join(path.dirname(root), `${path.basename(root)}-tools`);
  for (const name of ['apksigner', 'aapt']) {
    const toolPath = path.join(toolRoot, 'android-sdk', 'build-tools', '35.0.0', name);
    fs.mkdirSync(path.dirname(toolPath), { recursive: true });
    fs.writeFileSync(toolPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    tools[name] = toolPath;
  }
  const unzipPath = path.join(toolRoot, 'bin', 'unzip');
  fs.mkdirSync(path.dirname(unzipPath), { recursive: true });
  fs.writeFileSync(unzipPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  tools.unzip = unzipPath;
  return { root, iconPath, markerPath, apkPath, tools, toolRoot };
}

function writeInputSnapshot(root, snapshot, options = {}) {
  const snapshotPath = path.join(root, '.tmp', 'android-build-inputs.json');
  writeJson(snapshotPath, snapshot);
  fs.utimesSync(snapshotPath, INPUTS_CAPTURED, INPUTS_CAPTURED);
  if (options.embedProof !== false) {
    const { embedAndroidInputProof } = require('../../validate-android-wrap-build');
    const apkPath = path.join(root, 'dist', `${PACKAGE}.apk`);
    embedAndroidInputProof(apkPath, snapshot);
    if (options.finalSign !== false) addFakeApkSigningBlock(apkPath);
    fs.utimesSync(apkPath, APK_MODIFIED, APK_MODIFIED);
  }
  return snapshotPath;
}

function mockAndroidToolSpawn(command, args, options = {}) {
  const name = path.basename(command);
  if (name === 'apksigner') {
    return {
      status: 0,
      stdout: [
        'Verifies',
        'Verified using v1 scheme (JAR signing): true',
        'Verified using v2 scheme (APK Signature Scheme v2): true',
        `Signer #1 certificate SHA-256 digest: ${SIGNER_SHA256}`,
      ].join('\n'),
      stderr: '',
    };
  }
  if (name === 'aapt' && args[1] === 'badging') {
    return {
      status: 0,
      stdout: [
        `package: name='${PACKAGE}' versionCode='7' versionName='1.2.3'`,
        "sdkVersion:'26'",
        "targetSdkVersion:'35'",
        "application-label:'Field Ops'",
        "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
      ].join('\n'),
      stderr: '',
    };
  }
  if (name === 'aapt' && args[1] === 'resources') {
    return {
      status: 0,
      stdout: [
        `resource 0x1 ${PACKAGE}:string/google_app_id:`,
        `  (string8) "${FIREBASE_APP_ID}"`,
        `resource 0x2 ${PACKAGE}:string/project_id:`,
        `  (string8) "${FIREBASE_PROJECT}"`,
      ].join('\n'),
      stderr: '',
    };
  }
  if (name === 'unzip' && options.encoding === null) {
    return { status: 0, stdout: Buffer.from('packaged-icon'), stderr: Buffer.alloc(0) };
  }
  return { status: 1, stdout: '', stderr: '' };
}

module.exports = {
  APK_MODIFIED,
  BUILD_STARTED,
  CLIENT_ID,
  FIREBASE_APP_ID,
  FIREBASE_PROJECT,
  INPUTS_CAPTURED,
  PACKAGE,
  SIGNER_SHA256,
  TENANT_ID,
  VERIFIED_AT,
  addFakeApkSigningBlock,
  createAndroidProject,
  mockAndroidToolSpawn,
  removeFakeApkSigningBlock,
  writeStoredZip,
  writeInputSnapshot,
};
