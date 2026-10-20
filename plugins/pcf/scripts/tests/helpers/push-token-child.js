'use strict';
// A REAL PROCESS that runs `pcf-push.js` end to end — the real SDK bundle, the production Azure CLI-token client and the real result printer — over a fake `pac` and a fake Dataverse that refuses the read that confirms the push
// (HTTP 403) with a diagnostic repeating the access token the process sent, folded onto several lines, so a test can read what reached the process's descriptors and its folders: stdout, stderr, the receipt
// `pcf-receipt.json` and the SDK's workspace. Run by tests/pcf-push-token.test.js:
//   node push-token-child.js <project folder> <how the diagnostic spells the token>
// `how` is `folded` (every eight characters, as a gateway wraps a long header), `plain`, `escaped-fold` (the fold written as the JSON escape `\r\n`, as a diagnostic that was itself JSON holds it) or `none` (a diagnostic with no token in it).
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SCRIPTS = path.resolve(__dirname, '..', '..');
const { createAzHttpClient } = require(path.join(SCRIPTS, 'lib', 'sdk-http-client.js'));
const data = require(path.join(SCRIPTS, 'lib', 'pcf-dataverse.js'));
const { TOKEN } = require('./push-token.js');

const [, , project, how = 'folded'] = process.argv;
const ORG = 'https://contoso.crm.dynamics.com';
const spelling = {
  plain: TOKEN,
  folded: TOKEN.match(/.{1,8}/g).join('\r\n '),
  'escaped-fold': TOKEN.match(/.{1,8}/g).join('\\r\\n '),
  none: 'nothing secret here',
}[how];
if (spelling === undefined) throw new Error(`unknown spelling ${how}`);

fs.mkdirSync(path.join(project, 'StarRating'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'token-receipt', version: '1.0.0' }));
fs.writeFileSync(path.join(project, 'StarRating.pcfproj'), '<Project Sdk="Microsoft.NET.Sdk"><Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" /><PropertyGroup><Name>StarRating</Name><PcfBuildMode>production</PcfBuildMode></PropertyGroup></Project>');
fs.writeFileSync(path.join(project, 'StarRating', 'ControlManifest.Input.xml'), '<manifest><control namespace="Contoso.Controls" constructor="StarRating" version="1.2.3" display-name-key="StarRating" description-key="StarRating description" control-type="standard"><property name="value" display-name-key="Value" of-type="Whole.None" usage="bound" required="false" /><resources><code path="index.ts" order="1" /></resources></control></manifest>');

// The service: the table's metadata answers, and the read of the registered controls is refused with the diagnostic.
const client = createAzHttpClient(ORG, {
  getToken: () => TOKEN,
  sleep: async () => {},
  request: async ({ method, url }) => {
    if (method !== 'GET') throw new Error('only reads are expected');
    if (/EntityDefinitions\(LogicalName='customcontrol'\)/.test(decodeURIComponent(url))) return { statusCode: 200, headers: {}, body: JSON.stringify({ EntitySetName: 'customcontrols' }) };
    if (/\/customcontrols(?:\?|$)/.test(url)) return { statusCode: 403, headers: {}, body: JSON.stringify({ error: { code: '0x80040220', message: `Header check failed for value ${spelling}` } }) };
    throw new Error(`unexpected read ${url}`);
  },
});

// pcf-push.js is loaded as the script would be, with the two things that would leave this machine replaced: the `pac pcf push` it runs (it succeeds) and the HttpClient its SDK is made with.
const filename = path.join(SCRIPTS, 'pcf-push.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(SCRIPTS);
const realRequire = loaded.require.bind(loaded);
loaded.require = (id) => {
  if (id === './lib/pac-exec.js') return { runPac: () => ({ status: 0, stdout: 'fake push succeeded', stderr: '' }) };
  if (id === './lib/pcf-dataverse.js') return { ...data, makePcfSdk: (env, workspace) => data.makePcfSdk(env, workspace, client) };
  return realRequire(id);
};
loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
loaded.exports.main(['--project', project, '--env', ORG, '--publisher-prefix', 'new']).catch((error) => {
  process.stderr.write(`the child failed: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 3;
});
