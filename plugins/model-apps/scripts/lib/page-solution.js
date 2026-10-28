'use strict';
// A generative page in a solution: the one definition of how a page joins one, shared by every path that makes pages —
// add-page-to-solution.js (an app and its pages, packaged), apps.js create (an app made around its pages), genpage-upload.js
// --solution (through the page backend, lib/genpage-sdk.js) and the build's pages phase (lib/sdk-build.js).
//
// A page is a `uxagentproject` row, and a solution holds it as a component of that table. It is a custom table, so its component
// type is the table's ObjectTypeCode, which Dataverse allocates per environment: it is read, never written down as a constant.
//   GET EntityDefinitions(LogicalName='uxagentproject')?$select=ObjectTypeCode
//   { "@odata.context": "…/$metadata#EntityDefinitions(ObjectTypeCode)/$entity", "ObjectTypeCode": 10372, "MetadataId": "…" }
// A page is added with AddRequiredComponents=true: measured live (add-page-to-solution.js), that brings its uxagentprojectfile rows —
// config.json with the page's bindings among them — so the page travels whole. Nothing else brings a page into a solution: the add of
// an app brings its sitemap and its app components, never the pages its navigation opens, and a page made by the SDK carries no
// solution of its own. So a run that was given a solution and made a page left that page out of it unless it added the page
// explicitly (AB#6443257). A system solution (Default, Active, Basic: lib/system-solutions.js) holds every component already, so no
// caller adds to one.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/addsolutioncomponent
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
const { odataLit } = require('./odata.js');

const UXAGENTPROJECT_LOGICAL_NAME = 'uxagentproject';
// AddRequiredComponents for a page: true, so its file rows come with it (above).
const PAGE_ADD_REQUIRED_COMPONENTS = true;

// The metadata read that answers a table's component type, below the API root (no leading slash: `dataverseRequest` takes it so).
function componentTypePath(logicalName) {
  return `EntityDefinitions(LogicalName='${odataLit(logicalName)}')?$select=ObjectTypeCode`;
}

// The ObjectTypeCode of a metadata answer: a positive whole number, or an error — a type that is not one would add the page as some
// other component, or as nothing at all.
function componentTypeOf(body, logicalName) {
  const componentType = Number(body && body.ObjectTypeCode);
  if (!Number.isInteger(componentType) || componentType <= 0) {
    throw Object.assign(new Error(`Entity '${logicalName}' did not return a valid ObjectTypeCode`), { code: 'GENPAGE_COMPONENT_TYPE_UNRESOLVED' });
  }
  return componentType;
}

// A generative page's component type, read through the SDK's own Dataverse client (`sdk.dataverse`). Its `get` answers
// `{ status, headers, body }` and does not throw for an HTTP failure, so the status is checked here. It throws when the type cannot be
// read: a page cannot be added to a solution without it, and a caller reports that rather than leave the page out quietly.
async function readPageComponentType(client) {
  if (!client || typeof client.get !== 'function') {
    throw Object.assign(new Error('the solution component type of a generative page cannot be read: no Dataverse client to read it with'), { code: 'GENPAGE_COMPONENT_TYPE_UNRESOLVED' });
  }
  const res = await client.get(`/${componentTypePath(UXAGENTPROJECT_LOGICAL_NAME)}`);
  const status = res && res.status;
  if (!(status >= 200 && status < 300)) {
    const said = res && res.body && res.body.error && res.body.error.message;
    throw Object.assign(new Error(`the solution component type of a generative page could not be read (HTTP ${status === undefined ? 'no answer' : status}${said ? `: ${said}` : ''})`), { code: 'GENPAGE_COMPONENT_TYPE_UNRESOLVED', ...(status === undefined ? {} : { statusCode: status }) });
  }
  return componentTypeOf(res.body, UXAGENTPROJECT_LOGICAL_NAME);
}

// The options the SDK's `addSolutionComponent` takes for one page.
function pageComponent(pageId, componentType, solutionUniqueName) {
  return { componentId: pageId, componentType, solutionUniqueName, addRequiredComponents: PAGE_ADD_REQUIRED_COMPONENTS };
}

// The unmanaged solution named `uniqueName`, as the platform spells it: the solution an app or a page is to join. Read before anything is
// written, so a name that is no unmanaged solution refuses the run with nothing made. Throws, with a code, when there is no such
// solution (SOLUTION_NOT_FOUND: the name given may be the display name) or it is managed (SOLUTION_MANAGED: a managed solution takes no
// new components). `sdk` is anything with the SDK's `queryRecords`; its answer is a list of rows:
//   [ { "solutionid": "…", "uniquename": "ContosoCore", "friendlyname": "Contoso Core", "ismanaged": false } ]
async function readTargetSolution(sdk, uniqueName) {
  const rows = await sdk.queryRecords('solution', {
    select: ['solutionid', 'uniquename', 'friendlyname', 'ismanaged'],
    filter: `uniquename eq '${odataLit(uniqueName)}'`,
    top: 1,
  });
  const solution = rows && rows[0];
  if (!solution) {
    throw Object.assign(new Error(
      `There is no solution with the unique name '${uniqueName}' in this environment. --solution takes a solution's unique name, not its display name; `
      + 'create the solution first (provision-solution.js) if it should exist.'), { code: 'SOLUTION_NOT_FOUND' });
  }
  if (solution.ismanaged === true) {
    throw Object.assign(new Error(`The solution '${solution.uniquename}' is managed, and a managed solution takes no new components. Use an unmanaged solution.`), { code: 'SOLUTION_MANAGED' });
  }
  return { uniqueName: solution.uniquename || uniqueName };
}

module.exports = {
  UXAGENTPROJECT_LOGICAL_NAME,
  PAGE_ADD_REQUIRED_COMPONENTS,
  componentTypePath,
  componentTypeOf,
  readPageComponentType,
  pageComponent,
  readTargetSolution,
};
