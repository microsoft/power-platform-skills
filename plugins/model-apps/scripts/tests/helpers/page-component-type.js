'use strict';
// The page table's solution component type, as a test's stand-in for the SDK's Dataverse client answers it. A generative page is a `uxagentproject` row, a
// custom table whose ObjectTypeCode — its solution component type — the environment allocates; every path that makes pages "in" a solution reads it to add
// them (lib/page-solution.js), so a stand-in that models an environment answers it as the platform does:
//   GET /EntityDefinitions(LogicalName='uxagentproject')?$select=ObjectTypeCode   ->   200 { "ObjectTypeCode": 10372, "MetadataId": "…" }
// (the number is an example: each environment has its own).
const PAGE_TYPE_PATH = "/EntityDefinitions(LogicalName='uxagentproject')?$select=ObjectTypeCode";
const PAGE_TYPE = 10372;

// `get` with the page table's component type answered in front of it; every other read is `get`'s.
function withPageType(get, componentType = PAGE_TYPE) {
  return async (url, ...rest) => (url === PAGE_TYPE_PATH
    ? { status: 200, headers: {}, body: { ObjectTypeCode: componentType, MetadataId: '0d0d0d0d-0000-4000-8000-00000000d0d0' } }
    : get(url, ...rest));
}

module.exports = { PAGE_TYPE_PATH, PAGE_TYPE, withPageType };
