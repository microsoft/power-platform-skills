# Column Analysis Rules

Use these rules to determine the smallest explicit field list that preserves
each Power Pages Web API operation. Read every call chain and consumer; static
search results are an inventory, not the final answer.

## Contents

- [Evidence priority](#evidence-priority)
- [Endpoint mapping](#endpoint-mapping)
- [Read operations](#read-operations)
- [Write operations](#write-operations)
- [File and image operations](#file-and-image-operations)
- [Dynamic code](#dynamic-code)
- [Configuration proposal](#configuration-proposal)

## Evidence priority

Prefer evidence in this order:

1. Request syntax: `$select`, `$expand`, property paths, FetchXML, `$filter`,
   `$orderby`, and `$apply`.
2. Write payloads: POST, PATCH, PUT, deep inserts, and `@odata.bind`.
3. Response consumers: property access, destructuring, mappers, templates,
   framework bindings, and TypeScript interfaces.
4. Shared builders: callers, defaults, conditional branches, and runtime
   configuration.
5. Dataverse schema: canonical attributes, entity sets, lookups, and
   navigation properties.
6. User-confirmed integration contracts when repository evidence is
   incomplete.

Do not mark a proposal ready while a source wrapper, branch, or response
consumer remains unread. Never substitute compiled or generated code for
missing source.

## Endpoint mapping

Power Pages request paths use `EntitySetName`.
`Webapi/<table>/fields` settings use the table logical name. These names are
not reliably related by pluralization, so map them through the schema snapshot.

Classify search, summarization, cloud-flow, and server-logic routes under
`/_api/` as non-table endpoints only after confirming their public API shape.
Do not silently omit an unfamiliar endpoint.

## Read operations

For each table-returning GET:

- include root `$select` columns;
- include columns used by `$filter` and `$orderby`;
- include lookup read properties such as `_<lookup-column-name-1>_value` when
  consumed;
- include the source lookup attribute for single-valued `$expand` navigation;
- assign nested `$select`, filter, and order columns to the expanded table;
- include FetchXML attributes, conditions, ordering, grouping, and aggregate
  inputs on their owning entity or link-entity;
- include `$apply` group, filter, and aggregate inputs, excluding output
  aliases;
- add `$select` when a normal record GET omits it, deriving the projection from
  every response consumer.

Maintain two separate results:

- the response projection contains only columns returned to consumers;
- the fields-setting allowlist contains projection, filter, order, aggregate,
  lookup, property-route, and write requirements.

Do not widen an existing `$select` with a filter-only, order-only,
grouping-only, or write-only column.

`$top`, `$skip`, `$count`, paging cookies, aggregate aliases, formatted-value
annotations, and filter literals are not Dataverse columns.

## Write operations

For POST, PATCH, and PUT:

- include every payload property mapped to a Dataverse attribute;
- resolve `navigation@odata.bind` to the underlying lookup attribute;
- trace variables passed to `JSON.stringify`, HTTP clients, and custom
  wrappers;
- inspect conditional properties and every object spread source;
- assign deep-insert object fields to their related target table.

For property PUT or DELETE routes, include the property named in the URL. A
record DELETE adds no field requirement by itself, but the table setting still
needs a nonempty, evidence-backed field list.

## File and image operations

Treat file and image endpoints as explicit-column operations:

- include the file or image column in the route;
- include file name, size, MIME type, or image metadata only when separately
  read;
- never retain `*` as a compatibility workaround.

## Dynamic code

Trace dynamic entity sets, column arrays, URL fragments, query strings,
request bodies, and FetchXML through every caller and runtime branch.

When values come from external configuration, obtain the owning contract or
user confirmation. Do not infer fields from labels, singularization, naming
conventions, or likely primary keys.

## Configuration proposal

For each logical table and configuration scope, compute the sorted union of
proven columns across all reads and writes. Every proposed column needs:

- a relative source path and line, or a user-confirmed contract;
- the operation requiring it;
- its exact metadata-canonical name.

Then apply `${PLUGIN_ROOT}/references/webapi-field-allowlist.md`: every required
attribute contributes its LogicalName and SchemaName, and every lookup also
contributes `_<LogicalName>_value`. Keep request projections separate; the
metadata pair expansion applies to the fields setting, not automatically to
`$select`.

Do not add every metadata attribute, speculative identifiers, unrelated
server-side fields, or columns owned by expanded target tables.
