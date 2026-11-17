'use strict';
// Send-once scope for the configuration writes (lib/configuration-artifacts.js): environment variables,
// connection references, Custom APIs, duplicate-detection rules, their solution membership and the solution's
// version number.
//
// Why a scope and not a URL filter: the maker SDK writes these kinds through more than one path. A Custom API with
// its parameters, or a duplicate rule with its conditions, can go out as one `POST /$batch` (postRaw), a definition
// change as a PATCH, a cleared value as a DELETE, and the solution membership as an action POST. The HTTP client
// (lib/sdk-http-client.js) sends a request again on a transport failure, a transient status (429, 5xx) or a token
// refresh. For a create, a second send can make a second row; for a PATCH or a DELETE it can answer for the second
// send and hide that the first one's outcome was never seen. Only the code that starts the write knows the request
// belongs to this feature, so it opens the scope (`withConfigurationWrite`) around exactly that SDK call, and the
// client asks `configurationSendOnce(method, url)` for every request it sends:
//   - inside the scope, every mutating request (POST, PATCH, PUT, DELETE; a POST to `/$batch` included) is sent once,
//     and the first answer is handed to the SDK as it came, so a lost answer stays an unknown outcome;
//   - inside the scope a GET keeps its ordinary retry: a read changes nothing;
//   - outside the scope the answer is always false, so every other request of the build keeps exactly the retry
//     behaviour it had. An App Spec without configuration fields never enters the scope.
// The scope is an AsyncLocalStorage context, so it follows the awaited work of the call it wraps and nothing else: two
// writes running side by side do not share it, and it closes when the wrapped promise settles, by value or by throw.
// See: https://nodejs.org/api/async_context.html#class-asynclocalstorage
//
// The build composes this predicate with any it already has (the translation export's), e.g.
//   createAzHttpClient(env, { sendOnce: (m, u) => isTranslationExport(m, u) || configurationSendOnce(m, u) })
// so an earlier predicate is never replaced.

const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Run `fn` inside the send-once scope and return (or throw) exactly what it does.
function withConfigurationWrite(fn) {
  if (typeof fn !== 'function') throw new TypeError('withConfigurationWrite: fn must be a function');
  return scope.run({ configurationWrite: true }, fn);
}

// The HTTP client's question: must this request be sent exactly once? `url` is not inspected: inside the scope the
// method alone decides, so a write the SDK sends on a path this module never heard of is still covered.
function configurationSendOnce(method) {
  const store = scope.getStore();
  if (!store || store.configurationWrite !== true) return false;
  return MUTATING.has(String(method).toUpperCase());
}

const inConfigurationWrite = () => !!(scope.getStore() && scope.getStore().configurationWrite === true);

module.exports = { withConfigurationWrite, configurationSendOnce, inConfigurationWrite };
