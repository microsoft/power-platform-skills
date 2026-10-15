'use strict';
// What an edit of an app that is not about its components may ADD to them — held at the SDK's transport, because the SDK offers no push that leaves them alone.
//
// WHAT THE SDK DOES. Every `pushArtifact('app', id)` of an app that exists (the bundle's `appApi.update`) PATCHes the sitemap and then posts ONE AddAppComponents whose
// list it DERIVES, not the list the caller edited:
//   every sub-area of type Entity    the table (by reference), EVERY active Main form of it (type 2, formactivationstate 1), EVERY active public view of it
//                                    (querytype 0, statecode 0) and EVERY chart of it — the app has them or not
//   every DashBoard sub-area         the dashboard
//   the artifact's own `components`  its forms, views, charts and dashboards
// Nothing in the artifact turns the derivation off. `components.mainFormsByTable` (applyAppMainForms, lib/app-components.js) narrows the Main forms and only them: the views and
// the charts always come. AddAppComponents only ADDS, so for an app that offers all of that the post is a no-op, and for one whose maker took a Main form, a view or a chart out
// of it in the designer the push puts it back — and the publish that follows makes it live. A page edit used to end that way, with no warning:
//   placing a page (`add-to-app`, an upload's `--add-to-sitemap`), taking one out (`remove-from-app`), and the pin of the default view of a page's tables that the build
//   and an upload that names an app make.
//
// WHAT A PAGE EDIT OWNS. A page is a GenPage sub-area of the navigation, which needs nothing from the app's components, so the edit changes the sitemap — the SDK's PATCH, kept
// as it is: its serialization of a sub-area is not to be copied — and adds the views it was asked to pin (the maker's "/" picker lists a page's tables from them): nothing else.
// Every component the SDK derives belongs to a sub-area that was in the navigation before the edit, so none of them is the edit's.
//
// WHAT THIS DOES. The bundle is never patched (the next re-vendor would silently undo it) and a push cannot be told to skip the derivation, so the SDK's own request is limited where
// it leaves the process: `wrap` returns an HttpClient — the SDK's documented transport seam — whose AddAppComponents, for an app with an edit open (`limit`), carries only the views
// that edit owns. The rest of the post is dropped; when nothing is left, nothing is sent (an empty list is not a request the service is known to accept) and the SDK is answered
// with the 204 the service gives. A post for an app with no edit open, and every other request, goes through untouched — the build owns the whole app (its spec says what the app holds,
// and `app.mainForms` narrows the Main forms the SDK derives for it), so it never opens an edit.
//
// WHAT IT DOES NOT READ. The limit knows the one request the bundle sends today (below), and it finds the action by the PATH of the address, never by text elsewhere in it. While an edit is
// open, a request that IS the action but not in that shape is REFUSED — the action in another spelling (lower case, a trailing slash, a namespace), a body that is JSON text or has no list, a
// view that is only a reference — and so is one that does not carry every view the edit pins. It is not forwarded: that would send the SDK's whole derived list, which is what this holds back.
// And it is not answered as done: a pin it could not read would be dropped and reported as made. It is refused with the bundle's SdkError (`APP_COMPONENTS_NOT_LIMITED`). The SDK catches every
// error of that request and reports it as a warning of the push ("one or more components were not pinned (…)"), so the navigation the edit saved stays saved, the warning says what was not added,
// and nothing unlimited reaches the app. A `$batch` (`postRaw`) is not parsed — its parts are text in a multipart envelope — so while an edit is open one that names the action is refused too:
// a part of a batch cannot be limited, the bundle does not send this action in one, and passing it on would send the SDK's whole derived list.
//
// The SDK reads the app's tables back after the post and reports a table its sitemap opens that is not a component (`APP_COMPONENTS_NOT_PERSISTED`) as a warning of the push — which is
// what a page edit of an app whose navigation opens a table the app does not hold still says: the edit does not add it.
// An SDK lent to a backend (`deps.sdk`) keeps the lender's transport, so a page edit through it is NOT limited. The bundle's request is pinned by genpage-app-edit-real-bundle.test.js:
// a re-vendor that changes its shape fails there, instead of letting a pin silently go missing.
const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

// The SDK posts to <instance>/api/data/v9.0/AddAppComponents — v9.0 is the API root its client uses — with no query string. The request, as it sends it:
//   { "AppId": "<guid>", "Components": [
//       { "@odata.id": "accounts(<table MetadataId>)" },                                                      a table, by reference
//       { "@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": "<guid>" },                           a form, or a dashboard
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedquery", "savedqueryid": "<guid>" },                     a view
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedqueryvisualization", "savedqueryvisualizationid": "<guid>" } ] }   a chart
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents

// The action's address is told by its PATH. What follows the path — a query string, a fragment — is not part of it, so another request that merely mentions the name there is not the action:
//   https://contoso.crm.dynamics.com/api/data/v9.0/AddAppComponents          the SDK's address
//   https://contoso.crm.dynamics.com/api/data/v9.0/AddAppComponents?x=1      the same action, with a query string
//   https://contoso.crm.dynamics.com/api/data/v9.0/OtherAction?note=/AddAppComponents      not the action: its path is /api/data/v9.0/OtherAction
//   /AddAppComponents                                                         relative, as a client that adds the API root itself would send it
//   https://crm.contoso.com/org/api/data/v9.0/AddAppComponents               a deployment with a path before the API root
const ACTION_PATH = /^(?:.*\/api\/data\/v\d+(?:\.\d+)?)?\/AddAppComponents$/;
// The last segment of a path that is some other spelling of the action — `addappcomponents`, `%41ddAppComponents`, `Microsoft.Dynamics.CRM.AddAppComponents`, any of them with a trailing slash — which
// the service may well accept as the action and this does not read.
const ACTION_NAME = /(?:^|\.)addappcomponents$/i;

// The path of an address given as text or as a URL: relative addresses are read against a placeholder, and one that cannot be read is no path at all.
function pathOf(address) {
  try {
    return (address instanceof URL ? address : new URL(String(address), 'https://placeholder.invalid')).pathname;
  } catch {
    return null;
  }
}

// 'action' (the address the SDK uses), 'lookalike' (the action in a spelling this does not read) or 'other' (not the action).
function kindOf(address) {
  const path = pathOf(address);
  if (path === null) return 'other';
  if (ACTION_PATH.test(path)) return 'action';
  let last = path.replace(/\/+$/, '').split('/').pop();
  try {
    last = decodeURIComponent(last);
  } catch {
    // A malformed escape (`%ZZ`) is left as it is: it is not a spelling of the name.
  }
  return ACTION_NAME.test(last) ? 'lookalike' : 'other';
}

// AddAppComponents answers 204 No Content; the SDK reads nothing but the status of the answer.
const NO_CONTENT = () => ({ status: 204, headers: {}, body: undefined });

// The error of a request this will not send. It is the bundle's own class, loaded when the first one is made: the SDK's client passes an SdkError on as it is and re-wraps an error of any other class
// as a failure to reach the service (`Transport failure reaching …`), which this is not.
function refusal(why) {
  const { SdkError } = require('./maker-sdk.js');
  return new SdkError('APP_COMPONENTS_NOT_LIMITED', `the request to add components to the app was NOT sent: ${why}. A page edit adds only the views it pins, so a request this tool cannot limit is refused instead of being sent whole, and nothing was added to the app's components`);
}
const UNREADABLE_BODY = 'its body is not the { AppId, Components: [...] } object the SDK posts';

// Whether the body of a `$batch` — multipart text, or bytes, or a JSON batch — names the action anywhere. Nothing in it is parsed: a part cannot be limited, so a batch that may carry the action is not sent
// while an edit is open, and a page's own writes, which never name it, are not affected.
function namesAction(body) {
  const text = typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('latin1') : '';
  return /addappcomponents/i.test(text);
}

function makeAppComponentScope() {
  // app id (lower case) -> the ids of the views the edit under way owns
  const open = new Map();
  // app id -> the end of the last edit queued for it; edits of one app run one after the other, so an edit never reads another's list
  const queue = new Map();

  // What to send for a post while some edit is open: `{ send }` — the body to send, or null when nothing is left to send — or a throw, for a request that is the action and that this cannot limit.
  // Only an entry that names a `savedqueryid` the edit pins stays: a table, a form, a dashboard, a chart or any other view does not. A request that is not the action, or is another app's, is sent as it is.
  function limited(address, body) {
    const kind = kindOf(address);
    if (kind === 'other') return { send: body };
    if (kind === 'lookalike') throw refusal(`its address (${pathOf(address)}) is not the SDK's /api/data/v<version>/AddAppComponents, though it names that action`);
    // Whose it is comes first: another app's request is not this edit's to limit, in any shape. A body this cannot even attribute to an app (JSON text, no `AppId`) could be anyone's, so it is refused.
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.AppId !== 'string') throw refusal(UNREADABLE_BODY);
    const owned = open.get(guidKey(body.AppId));
    if (!owned) return { send: body };
    if (!Array.isArray(body.Components)) throw refusal(UNREADABLE_BODY);
    const kept = body.Components.filter((component) => component && typeof component.savedqueryid === 'string' && owned.has(guidKey(component.savedqueryid)));
    // Every pin the edit owns must be in what is sent. A view the request names another way (`{ "@odata.id": "savedqueries(<guid>)" }`), or leaves out, would otherwise be dropped with the rest and the SDK
    // told it was done: the no-op answer below is true only for an edit that owns nothing.
    const carried = new Set(kept.map((component) => guidKey(component.savedqueryid)));
    const missing = [...owned].filter((id) => !carried.has(id));
    if (missing.length) {
      const many = missing.length > 1;
      throw refusal(`its list does not carry the view${many ? 's' : ''} ${missing.join(', ')} the edit pins, as ${many ? 'entries' : 'an entry'} with a savedqueryid`);
    }
    if (!kept.length) return { send: null };
    return { send: kept.length === body.Components.length ? body : { ...body, Components: kept } };
  }

  return {
    // `client` as the SDK is given it: its own requests all go through, and its AddAppComponents for an app with an edit open is limited to what the edit owns. It is made by delegation — every
    // property is read from the client itself, and a method runs on it, so a client whose methods live on a prototype and keep state in `this` is wrapped as well as a plain object of closures
    // (which is what lib/sdk-http-client.js makes), and a frozen one: the proxy's own target is empty, so no property of the client constrains it.
    wrap(client) {
      if (!client || typeof client.post !== 'function') return client;
      const post = async (url, body, options) => {
        // With no edit open nothing is read: the build owns the whole app and sends what the SDK derives, in whatever shape the bundle gives it.
        if (open.size === 0) return client.post(url, body, options);
        const { send } = limited(url, body);
        return send === null ? NO_CONTENT() : client.post(url, send, options);
      };
      const postRaw = typeof client.postRaw === 'function' ? async (url, body, options) => {
        if (open.size !== 0 && namesAction(body)) throw refusal('it is part of a $batch that names that action, and a batch cannot be limited part by part');
        return client.postRaw(url, body, options);
      } : undefined;
      return new Proxy({}, {
        get: (_, key) => {
          if (key === 'post') return post;
          if (key === 'postRaw' && postRaw) return postRaw;
          const value = client[key];
          return typeof value === 'function' ? value.bind(client) : value;
        },
        has: (_, key) => key in client,
      });
    },

    // Runs `work` — a push of the app — with the post limited to `owned.views`, the ids of the views the edit pins. It answers what `work` answers, and the limit is lifted when
    // `work` ends, by an answer or a failure.
    limit(appId, owned, work) {
      const key = guidKey(appId);
      const turn = (queue.get(key) || Promise.resolve()).then(async () => {
        open.set(key, new Set(((owned && owned.views) || []).map(guidKey)));
        try {
          return await work();
        } finally {
          open.delete(key);
        }
      });
      const end = turn.then(() => undefined, () => undefined);
      queue.set(key, end);
      end.then(() => { if (queue.get(key) === end) queue.delete(key); });
      return turn;
    },
  };
}

module.exports = { makeAppComponentScope };
