'use strict';
// A second local process editing a workspace copy, as a maker's own authoring tool would while a build runs: the build's
// lease (lib/app-operation-lease.js) excludes another build, never another SDK writing the same workspace. It sets one element
// of the artifact through the SDK's public API and sends no request.
//   node edit-local-draft.js <workspaceDir> <instanceUrl> <kind> <id> <field> <value>
// Prints { "edited": true, "pid": <pid> } on success.
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');

const [dir, origin, kind, id, field, value] = process.argv.slice(2);
const neverSend = async () => { throw new Error('the local editor sends no request'); };

(async () => {
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(dir),
    instanceUrl: origin,
    httpClient: Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((m) => [m, neverSend])),
  });
  await sdk.initWorkspace();
  await sdk.updateElement(kind, id, `/${field}`, value);
  process.stdout.write(JSON.stringify({ edited: true, pid: process.pid }));
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err));
  process.exitCode = 1;
});
