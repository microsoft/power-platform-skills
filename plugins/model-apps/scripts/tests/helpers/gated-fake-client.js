'use strict';
// The fake org's client (helpers/fake-app-build-org.js) with every request passed through the build's publication barrier,
// as the CLI's transport is (build-model-app.js gates its client with the same barrier it hands the build): a plain publish of
// a routed or withheld table is screened at the send, exactly as in production. The barrier's transport shape is
// { method, url, headers, body } answering { statusCode, headers, body } (lib/dataverse-auth.js makeRequest); the fake's is
// (url, body, options) answering { status, headers, body } with the body parsed. A request the gate rewrote (a partly withheld
// publish) carries new text.
// With `observer` (managed-feature-contract.js createAttemptSendObserver) the attempt send observer sits INSIDE the gate,
// as build-model-app.js nests it.
function gatedClient(org, barrier, observer = null) {
  const text = (b) => (b == null ? '' : typeof b === 'string' ? b : JSON.stringify(b));
  const transport = async (req) => {
    const m = req.method.toLowerCase();
    let body = req.raw;
    if (req.body !== text(req.raw)) { try { body = JSON.parse(req.body); } catch { body = req.body; } }
    const res = m === 'get' ? await org.httpClient.get(req.url, req.options) : await org.httpClient[m](req.url, body, req.options);
    return { statusCode: res.status, headers: res.headers || {}, body: text(res.body), res };
  };
  const gated = barrier.gateRequest(observer ? observer.wrap(transport) : transport);
  const send = async (method, url, raw, options) => {
    const answer = await gated({ method, url, headers: (options && options.headers) || {}, body: text(raw), raw, options });
    if (answer.res) return answer.res;
    let body = answer.body;
    try { body = body ? JSON.parse(body) : null; } catch { /* kept as text */ }
    return { status: answer.statusCode, headers: answer.headers || {}, body };
  };
  return Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((m) => [m,
    (url, ...args) => (m === 'get' ? send('GET', url, undefined, args[0]) : send(m.toUpperCase(), url, args[0], args[1])),
  ]));
}

module.exports = { gatedClient };
