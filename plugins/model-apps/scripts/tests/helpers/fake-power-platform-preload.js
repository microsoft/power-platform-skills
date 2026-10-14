'use strict';
// A `node --require` preload for END-TO-END runs of list-connections.js, connector.js and solution-settings.js. It puts the fake Power Platform
// (helpers/fake-power-platform.js) where the network and the Azure CLI would be — in dataverse-auth.js, which every one of them reads its credentials
// and makes its requests through — so a real child process runs the real script, the real vendored bundle, the real az-token HttpClient, the real
// Power Apps service client and the real printer, with no Azure CLI and no network. Whatever is left to real code stays real: the host allowlist, the
// token checks on every request, the redirect and method rules.
//
// FAKE_PLATFORM names a JSON file, the configuration of createCloud() plus:
//   noPowerAppsToken, noDataverseToken   `az` cannot give that token
//   failures: [ { host, pathIncludes, method, status, body } | { host, pathIncludes, method, error } ]   requests the fake answers with that error — `error` is no
//                                       answer at all (a timeout, a dropped connection), as the transport reports it: { error: "<text>" }
//   hooks: [ { pathIncludes, method, writeFile, content } ]   when such a request arrives, write that file (a path relative to the run's folder, which is the
//                                       working directory) before the fake answers — what another program or a person does while a script waits for the service
// FAKE_PLATFORM_LOG names a file the requests, the state and the Azure CLI token reads ({ dataverse, powerApps }: one per call of getAuthToken[Async] /
// getPowerAppsToken[Async], that is one per `az` process a real run would start) are written to when the process exits. The connection-references read a
// script makes through `dataverseRequest` is answered without a token read here, so these counts are the reads of the SDK path and its preflight alone.
//
// This file must be loaded before the script: scripts destructure what they need from dataverse-auth.js when they load, which is after a preload.
const fs = require('node:fs');
const path = require('node:path');

const auth = require(path.resolve(__dirname, '..', '..', 'lib', 'dataverse-auth.js'));
const { createCloud } = require('./fake-power-platform.js');

const config = JSON.parse(fs.readFileSync(process.env.FAKE_PLATFORM, 'utf8'));
const failures = config.failures || [];
const hooks = config.hooks || [];
const matches = (rule, entry) => (!rule.host || rule.host === entry.host)
  && (!rule.pathIncludes || entry.path.includes(rule.pathIncludes))
  && (!rule.method || rule.method === entry.method);
const cloud = createCloud({
  ...config,
  override: (entry) => {
    for (const hook of hooks.filter((h) => matches(h, entry))) fs.writeFileSync(hook.writeFile, hook.content);
    const hit = failures.find((f) => matches(f, entry));
    return hit ? (hit.error !== undefined ? { error: hit.error } : { statusCode: hit.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(hit.body) }) : undefined;
  },
});

const tokenReads = { dataverse: 0, powerApps: 0 };
auth.makeRequest = cloud.request;
auth.getAuthToken = () => { tokenReads.dataverse += 1; return config.noDataverseToken ? null : cloud.tokens.dataverse; };
auth.getAuthTokenAsync = async () => auth.getAuthToken();
auth.getPowerAppsToken = () => { tokenReads.powerApps += 1; return config.noPowerAppsToken ? null : cloud.tokens.powerApps; };
auth.getPowerAppsTokenAsync = async () => auth.getPowerAppsToken();
auth.dataverseRequest = async (envUrl, method, apiPath) => cloud.dataverseCollection(apiPath);

process.on('exit', () => {
  if (process.env.FAKE_PLATFORM_LOG) fs.writeFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ requests: cloud.requests, state: cloud.state, tokenReads }));
});
