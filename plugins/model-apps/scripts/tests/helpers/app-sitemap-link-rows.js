'use strict';

// The SDK proves a sitemap with a CURRENT app layer, its type-62 component and reverse owners:
//   appmodules/RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,componentstate&$filter=appmoduleid eq <id>
//   appmodulecomponents?$select=objectid&$filter=_appmoduleidunique_value eq <layer> and componenttype eq 62
//   appmodulecomponents?$select=_appmoduleidunique_value&$filter=componenttype eq 62 and objectid eq <sitemap>
// These small transport fixtures must filter real rows in both directions, not answer every component
// query with the owned sitemap. Other queries remain their caller's responsibility.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
function appSitemapLinkRows(url, { apps, components }) {
  const u = new URL(url);
  const route = u.pathname.replace(/^\/api\/data\/v\d+\.\d+/, '');
  const select = (u.searchParams.get('$select') || '').split(',').filter(Boolean);
  const filter = u.searchParams.get('$filter') || '';
  let rows;
  let fields;
  if (route === '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'
      && ((select.length === 3 && ['appmoduleid', 'appmoduleidunique', 'componentstate'].every((field) => select.includes(field)))
        || /\bappmoduleidunique eq /i.test(filter))) {
    rows = apps;
    fields = new Set(['appmoduleid', 'appmoduleidunique', 'componentstate']);
  } else if (route === '/appmodulecomponents' && /\bcomponenttype eq 62\b/i.test(filter)) {
    rows = components;
    fields = new Set(['objectid', 'componenttype', '_appmoduleidunique_value']);
  } else {
    return undefined;
  }
  if (!select.length || select.some((field) => !fields.has(field))) {
    throw new Error(`Unmodeled sitemap-link projection: ${url}`);
  }
  const predicates = filter.split(/\s+and\s+/i).map((part) => {
    const match = /^(\w+) eq ([0-9a-f-]{36}|62)$/i.exec(part);
    if (!match || !fields.has(match[1])) throw new Error(`Unmodeled sitemap-link filter: ${url}`);
    return [match[1], match[2].toLowerCase()];
  });
  return rows
    .filter((row) => predicates.every(([field, value]) => String(row[field]).toLowerCase() === value))
    .map((row) => Object.fromEntries(select.map((field) => [field, row[field] === undefined ? null : row[field]])));
}

module.exports = { appSitemapLinkRows };
