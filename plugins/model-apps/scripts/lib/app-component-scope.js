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
// The SDK reads the app's tables back after the post and reports a table its sitemap opens that is not a component (`APP_COMPONENTS_NOT_PERSISTED`) as a warning of the push — which is
// what a page edit of an app whose navigation opens a table the app does not hold still says: the edit does not add it.
// An SDK lent to a backend (`deps.sdk`) keeps the lender's transport, so a page edit through it is NOT limited. The bundle's request is pinned by genpage-app-edit-real-bundle.test.js:
// a re-vendor that changes its shape fails there, instead of letting a pin silently go missing.
const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

// The SDK posts to <instance>/api/data/v9.2/AddAppComponents, with no query string. The request, as it sends it:
//   { "AppId": "<guid>", "Components": [
//       { "@odata.id": "accounts(<table MetadataId>)" },                                                      a table, by reference
//       { "@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": "<guid>" },                           a form, or a dashboard
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedquery", "savedqueryid": "<guid>" },                     a view
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedqueryvisualization", "savedqueryvisualizationid": "<guid>" } ] }   a chart
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents
const ADD_APP_COMPONENTS = /\/AddAppComponents(?:\?|$)/;

// AddAppComponents answers 204 No Content; the SDK reads nothing but the status of the answer.
const NO_CONTENT = () => ({ status: 204, headers: {}, body: undefined });

function makeAppComponentScope() {
  // app id (lower case) -> the ids of the views the edit under way owns
  const open = new Map();
  // app id -> the end of the last edit queued for it; edits of one app run one after the other, so an edit never reads another's list
  const queue = new Map();

  // The post for an app with an edit open, cut down to the views that edit owns: an entry that names a `savedqueryid` the edit pins stays, and a table, a form, a dashboard, a chart or
  // any other view does not. `null` when the request is not an AddAppComponents of an app with an edit open (or not the SDK's shape: a body with no list), which is nobody's to limit.
  function limited(url, body) {
    if (typeof url !== 'string' || !ADD_APP_COMPONENTS.test(url) || !body || !Array.isArray(body.Components)) return null;
    const owned = open.get(guidKey(body.AppId));
    if (!owned) return null;
    return { ...body, Components: body.Components.filter((component) => component && typeof component.savedqueryid === 'string' && owned.has(guidKey(component.savedqueryid))) };
  }

  return {
    // `client` as the SDK is given it: its own requests all go through, and its AddAppComponents for an app with an edit open is limited to what the edit owns. It is made by delegation — every
    // property is read from the client itself, and a method runs on it, so a client whose methods live on a prototype and keep state in `this` is wrapped as well as a plain object of closures
    // (which is what lib/sdk-http-client.js makes), and a frozen one: the proxy's own target is empty, so no property of the client constrains it.
    wrap(client) {
      if (!client || typeof client.post !== 'function') return client;
      const post = (url, body, options) => {
        const kept = limited(url, body);
        if (kept === null || kept.Components.length === body.Components.length) return client.post(url, body, options);
        return kept.Components.length ? client.post(url, kept, options) : Promise.resolve(NO_CONTENT());
      };
      return new Proxy({}, {
        get: (_, key) => {
          if (key === 'post') return post;
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
