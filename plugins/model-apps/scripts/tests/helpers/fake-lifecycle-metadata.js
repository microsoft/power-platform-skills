'use strict';
// The METADATA half of helpers/fake-lifecycle-org.js: tables (`EntityDefinitions`), their columns (`Attributes`, typed) and alternate keys
// (`Keys`), relationships (`RelationshipDefinitions`) and global option sets (`GlobalOptionSetDefinitions`), stored as the Web API
// returns them and answered with `$select`, `$filter` and `$expand` honoured. The shapes, abridged:
//
//   GET EntityDefinitions(LogicalName='contoso_item')?$select=LogicalName,EntitySetName
//     -> { "LogicalName": "contoso_item", "EntitySetName": "contoso_items", "MetadataId": "<guid>" }        (MetadataId always comes back)
//   GET EntityDefinitions(LogicalName='contoso_item')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet
//     -> { "value": [ { "@odata.type": "#Microsoft.Dynamics.CRM.PicklistAttributeMetadata", "LogicalName": "contoso_kind", "MetadataId": "<guid>",
//                       "OptionSet": { "Options": [ { "Value": 100000000, "Label": { "LocalizedLabels": [...], "UserLocalizedLabel": {...} } } ] } } ] }
//   a label   { "LocalizedLabels": [ { "Label": "Item", "LanguageCode": 1033, "IsManaged": false, "MetadataId": "<guid>", "HasChanged": null } ],
//               "UserLocalizedLabel": { "Label": "Item", "LanguageCode": 1033, … } }       — the user's language, else the first label
//
// A create is answered as the platform answers it: 204 with `OData-EntityId` naming the new definition by its MetadataId.
// What the platform makes beside what was asked is made here too, because the plugin reads it back and acts on it:
//   - a table gets its primary id column (`<table>id`), the ownership and audit columns a user-owned table has, `statecode` and
//     `statuscode` with their two states, `versionnumber`, and the `<lookup>name` / `<lookup>yominame` companions of its lookups;
//   - a Choice, MultiChoice or Boolean column gets its `<name>name` companion, a lookup its `<name>name` and `<name>yominame` (each
//     `AttributeOf` the column, which is how a reader tells them from real columns), and a Money column its `<name>_base` twin — a
//     physical column with no AttributeOf, told apart only by `IsBaseCurrency: true` (measured; see companionsOf);
//   - a File column gets `<name>_name` (`AttributeOf` the File column, logical); an Image column gets `<name>id`, `<name>_timestamp`
//     and `<name>_url` — and here the platform turns it round (MEASURED on a live environment): the Image column is itself the logical
//     projection of `<name>id` (`AttributeOf: "<name>id"`, `IsLogical: true`), `<name>id` is a custom Uniqueidentifier with no
//     `AttributeOf`, and `_timestamp` / `_url` are `AttributeOf` `<name>id`. The File column is neither logical nor `AttributeOf` anything;
//   - the first Image column a table gets becomes its primary image (`IsPrimaryImage: true`, the table's `PrimaryImageAttribute`)
//     whatever the create sent — MEASURED: a create sending `false` read back `true` — and a later one does not, `true` sent or not
//     (Microsoft Learn: "ignored if set to true when creating a new image column" while another exists). Deleting the primary one
//     makes the next the primary (Learn: "another image column for the table is selected automatically");
//   - a 1:N relationship creates its lookup column on the referencing table; an N:N its intersect table.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-relationships-using-web-api
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-attributes#update-image-columns
const { randomUUID } = require('node:crypto');
const { compileFilter, describeFilter, evaluateFilter } = require('./odata-filter.js');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const lc = (value) => String(value == null ? '' : value).toLowerCase();
const bare = (id) => lc(id).replace(/[{}]/g, '');
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AttributeType and AttributeTypeName of each typed metadata class the build sends.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributetypecode
const TYPE_OF = {
  StringAttributeMetadata: ['String', 'StringType'],
  MemoAttributeMetadata: ['Memo', 'MemoType'],
  IntegerAttributeMetadata: ['Integer', 'IntegerType'],
  BigIntAttributeMetadata: ['BigInt', 'BigIntType'],
  DecimalAttributeMetadata: ['Decimal', 'DecimalType'],
  DoubleAttributeMetadata: ['Double', 'DoubleType'],
  MoneyAttributeMetadata: ['Money', 'MoneyType'],
  BooleanAttributeMetadata: ['Boolean', 'BooleanType'],
  DateTimeAttributeMetadata: ['DateTime', 'DateTimeType'],
  PicklistAttributeMetadata: ['Picklist', 'PicklistType'],
  MultiSelectPicklistAttributeMetadata: ['Virtual', 'MultiSelectPicklistType'],
  LookupAttributeMetadata: ['Lookup', 'LookupType'],
  UniqueIdentifierAttributeMetadata: ['Uniqueidentifier', 'UniqueidentifierType'],
  ImageAttributeMetadata: ['Virtual', 'ImageType'],
  FileAttributeMetadata: ['Virtual', 'FileType'],
  StateAttributeMetadata: ['State', 'StateType'],
  StatusAttributeMetadata: ['Status', 'StatusType'],
  EntityNameAttributeMetadata: ['EntityName', 'EntityNameType'],
};
const classOf = (attribute) => String(attribute['@odata.type'] || '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');

// THE READ CONTRACT of the metadata half: the properties a read may name, per metadata type, EXPLICITLY. A `$select`, `$filter` or
// `$expand` that names anything else — and a path segment, a key, a cast or a navigation outside the lists below — is refused as
// unmodelled (501, recorded in `org.unexpected`) BEFORE a single definition is looked at, so a changed read can never pass as "nothing
// there". A property on the list that a definition does not hold is answered `null`, as the platform answers an unset property.
// OData types the properties: one a DERIVED type declares (a string column's `MaxLength`) is readable only through a cast to that type
// (`Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength`), never on the base collection.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/entitymetadata
const TABLE_PROPS = ['MetadataId', 'LogicalName', 'SchemaName', 'EntitySetName', 'LogicalCollectionName', 'CollectionSchemaName', 'ObjectTypeCode',
  'IsCustomEntity', 'IsManaged', 'IsActivity', 'IsIntersect', 'TableType', 'OwnershipType', 'HasNotes', 'HasActivities', 'DisplayName',
  'DisplayCollectionName', 'Description', 'PrimaryIdAttribute', 'PrimaryNameAttribute', 'PrimaryImageAttribute', 'IconVectorName',
  'IconSmallName', 'IconMediumName', 'IconLargeName', 'ChangeTrackingEnabled', 'IsQuickCreateEnabled', 'Privileges'];
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributemetadata
const ATTRIBUTE_BASE = ['MetadataId', 'LogicalName', 'SchemaName', 'EntityLogicalName', 'AttributeType', 'AttributeTypeName', 'DisplayName',
  'Description', 'RequiredLevel', 'IsCustomAttribute', 'IsCustomizable', 'IsManaged', 'IsPrimaryId', 'IsPrimaryName', 'IsLogical',
  'IsValidForCreate', 'IsValidForRead', 'IsValidForUpdate', 'AttributeOf', 'SourceType'];
// What each derived column type adds; the enum-valued ones (a choice, a Boolean, a state or status) also navigate to their option set.
const ATTRIBUTE_PROPS = {
  AttributeMetadata: [],
  StringAttributeMetadata: ['MaxLength', 'FormatName', 'Format', 'AutoNumberFormat'],
  MemoAttributeMetadata: ['MaxLength', 'FormatName', 'Format'],
  IntegerAttributeMetadata: ['MinValue', 'MaxValue', 'Format'],
  BigIntAttributeMetadata: ['MinValue', 'MaxValue'],
  DecimalAttributeMetadata: ['MinValue', 'MaxValue', 'Precision'],
  DoubleAttributeMetadata: ['MinValue', 'MaxValue', 'Precision'],
  MoneyAttributeMetadata: ['MinValue', 'MaxValue', 'Precision', 'PrecisionSource', 'IsBaseCurrency'],
  BooleanAttributeMetadata: ['DefaultValue'],
  DateTimeAttributeMetadata: ['Format', 'DateTimeBehavior'],
  PicklistAttributeMetadata: ['DefaultFormValue'],
  MultiSelectPicklistAttributeMetadata: ['DefaultFormValue'],
  LookupAttributeMetadata: ['Targets'],
  UniqueIdentifierAttributeMetadata: [],
  ImageAttributeMetadata: ['MaxSizeInKB', 'CanStoreFullImage', 'IsPrimaryImage'],
  FileAttributeMetadata: ['MaxSizeInKB'],
  StateAttributeMetadata: ['DefaultFormValue'],
  StatusAttributeMetadata: ['DefaultFormValue'],
  EntityNameAttributeMetadata: [],
};
const ENUM_CLASSES = new Set(['BooleanAttributeMetadata', 'PicklistAttributeMetadata', 'MultiSelectPicklistAttributeMetadata', 'StateAttributeMetadata', 'StatusAttributeMetadata']);
const KEY_PROPS = ['MetadataId', 'LogicalName', 'SchemaName', 'EntityLogicalName', 'DisplayName', 'KeyAttributes', 'EntityKeyIndexStatus', 'IsManaged'];
const RELATIONSHIP_BASE = ['MetadataId', 'SchemaName', 'RelationshipType', 'IsCustomRelationship', 'IsManaged', 'IsValidForAdvancedFind'];
const RELATIONSHIP_PROPS = {
  OneToManyRelationshipMetadata: ['ReferencedEntity', 'ReferencingEntity', 'ReferencedAttribute', 'ReferencingAttribute',
    'ReferencedEntityNavigationPropertyName', 'ReferencingEntityNavigationPropertyName', 'CascadeConfiguration', 'AssociatedMenuConfiguration'],
  ManyToManyRelationshipMetadata: ['Entity1LogicalName', 'Entity2LogicalName', 'Entity1IntersectAttribute', 'Entity2IntersectAttribute',
    'IntersectEntityName', 'Entity1NavigationPropertyName', 'Entity2NavigationPropertyName', 'Entity1AssociatedMenuConfiguration',
    'Entity2AssociatedMenuConfiguration'],
};
const OPTIONSET_PROPS = ['MetadataId', 'Name', 'IsGlobal', 'IsCustomOptionSet', 'IsManaged', 'OptionSetType', 'DisplayName', 'Description', 'Options', 'TrueOption', 'FalseOption'];
const OPTIONSET_CASTS = new Set(['OptionSetMetadata', 'BooleanOptionSetMetadata']);
// A table's collection-valued navigations, and the type each leads to.
const TABLE_NAVIGATIONS = {
  Attributes: { kind: 'attribute', cls: null },
  Keys: { kind: 'key' },
  OneToManyRelationships: { kind: 'relationship', cls: 'OneToManyRelationshipMetadata' },
  ManyToOneRelationships: { kind: 'relationship', cls: 'OneToManyRelationshipMetadata' },
  ManyToManyRelationships: { kind: 'relationship', cls: 'ManyToManyRelationshipMetadata' },
};
// The alternate key a path may name a definition by, per collection (beside its MetadataId).
const KEY_NAMES = { EntityDefinitions: 'LogicalName', Attributes: 'LogicalName', Keys: 'LogicalName', RelationshipDefinitions: 'SchemaName', GlobalOptionSetDefinitions: 'Name' };
// The query options each read takes; a nested `$expand` takes `$select` and, on a collection, `$filter`.
const COLLECTION_OPTIONS = ['$select', '$filter', '$expand'];
const SINGLE_OPTIONS = ['$select', '$expand'];

// The properties a type answers, and its single- or collection-valued navigations.
function propsOf(type) {
  if (type.kind === 'table') return TABLE_PROPS;
  if (type.kind === 'attribute') return [...ATTRIBUTE_BASE, ...(type.cls ? ATTRIBUTE_PROPS[type.cls] : [])];
  if (type.kind === 'key') return KEY_PROPS;
  if (type.kind === 'relationship') return [...RELATIONSHIP_BASE, ...(type.cls ? RELATIONSHIP_PROPS[type.cls] : [])];
  if (type.kind === 'optionset') return OPTIONSET_PROPS;
  throw new Error(`fake-lifecycle-metadata: no properties for ${type.kind}`);
}
function navigationsOf(type) {
  if (type.kind === 'table') return TABLE_NAVIGATIONS;
  if (type.kind === 'attribute' && ENUM_CLASSES.has(type.cls)) return { OptionSet: { kind: 'optionset', single: true }, GlobalOptionSet: { kind: 'optionset', single: true } };
  return {};
}
const typeName = (type) => (type.cls || { table: 'EntityMetadata', attribute: 'AttributeMetadata', key: 'EntityKeyMetadata', relationship: 'RelationshipMetadataBase', optionset: 'OptionSetMetadataBase' }[type.kind]);
const listOf = (text) => String(text).split(',').map((x) => x.trim()).filter(Boolean);

// Refuses a read that names anything the type does not have: an option, a property (in `$select` or `$filter`), a navigation (in
// `$expand`, with its own options checked against the type it leads to). The filter is parsed here, once, whatever the collection holds.
function checkMetadataQuery(type, query, options, where) {
  for (const option of Object.keys(query || {})) if (!options.includes(option)) throw new Error(`fake-lifecycle-metadata: the query option ${option} is not modelled on ${where}`);
  const props = propsOf(type);
  const navigations = navigationsOf(type);
  if (query.$select !== undefined) {
    for (const name of listOf(query.$select)) if (!props.includes(name)) throw new Error(`fake-lifecycle-metadata: ${typeName(type)} has no property ${name} ($select on ${where})`);
  }
  if (query.$filter !== undefined) {
    const read = describeFilter(compileFilter(query.$filter));
    if (read.paths.length || read.lambdas.length) throw new Error(`fake-lifecycle-metadata: a navigation in $filter on ${where} is not modelled (${query.$filter})`);
    for (const name of read.fields) if (!props.includes(name)) throw new Error(`fake-lifecycle-metadata: ${typeName(type)} has no property ${name} ($filter on ${where})`);
  }
  if (query.$expand !== undefined) {
    for (const item of parseExpandText(query.$expand)) {
      const target = navigations[item.name];
      if (!target) throw new Error(`fake-lifecycle-metadata: ${typeName(type)} has no navigation ${item.name} ($expand on ${where})`);
      checkMetadataQuery(target, item.opts, target.single ? ['$select'] : ['$select', '$filter'], `${where} $expand=${item.name}`);
    }
  }
}

// `$expand=Attributes($select=LogicalName,AttributeType;$filter=IsCustomAttribute eq true),OptionSet,Keys` -> [{ name, opts }].
function parseExpandText(text) {
  const items = [];
  let depth = 0;
  let start = 0;
  const s = String(text || '');
  for (let i = 0; i <= s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if ((ch === ',' && depth === 0) || i === s.length) {
      const part = s.slice(start, i).trim();
      if (part) {
        const open = part.indexOf('(');
        const name = open === -1 ? part : part.slice(0, open);
        const inner = open === -1 ? '' : part.slice(open + 1, -1);
        const opts = {};
        let d = 0;
        let from = 0;
        for (let j = 0; j <= inner.length; j += 1) {
          const c = inner[j];
          if (c === '(') d += 1;
          else if (c === ')') d -= 1;
          else if ((c === ';' && d === 0) || j === inner.length) {
            const opt = inner.slice(from, j).trim();
            if (opt) {
              const eq = opt.indexOf('=');
              opts[opt.slice(0, eq)] = opt.slice(eq + 1);
            }
            from = j + 1;
          }
        }
        items.push({ name, opts });
      }
      start = i + 1;
    }
  }
  return items;
}

function createMetadataStore({ baseLanguage = 1033, userLanguage = baseLanguage, solutionOf, addComponent, removeComponents, onTableCreated, onTableDeleted } = {}) {
  const tables = new Map(); // logical -> definition (see makeTable); `Attributes`/`Keys` are Maps
  const relationships = new Map(); // lower-cased SchemaName -> definition
  const optionSets = new Map(); // lower-cased Name -> definition
  let nextObjectTypeCode = 10300;

  // ------------------------------------------------------------------------------------------------------------------------
  // Labels.
  const localized = (label, code) => ({ Label: label, LanguageCode: code, IsManaged: false, MetadataId: randomUUID(), HasChanged: null });
  // A label as sent (`{ LocalizedLabels: [{ Label, LanguageCode }] }`) or plain text, stored as the platform returns it.
  function label(sent) {
    if (sent == null) return { LocalizedLabels: [], UserLocalizedLabel: null };
    const list = typeof sent === 'string' ? [localized(sent, baseLanguage)] : (sent.LocalizedLabels || []).map((l) => localized(l.Label, l.LanguageCode));
    return { LocalizedLabels: list, UserLocalizedLabel: clone(list.find((l) => l.LanguageCode === userLanguage) || list[0] || null) };
  }
  const textOf = (stored) => (stored && stored.UserLocalizedLabel ? stored.UserLocalizedLabel.Label : null);

  // ------------------------------------------------------------------------------------------------------------------------
  // Columns.
  function makeAttribute(table, sent, extra = {}) {
    const cls = classOf(sent) || 'StringAttributeMetadata';
    const [type, typeName] = TYPE_OF[cls] || [null, null];
    if (!type) throw new Error(`fake-lifecycle-metadata: column class ${cls} is not modelled (${sent.SchemaName})`);
    const logical = lc(sent.SchemaName || sent.LogicalName);
    const attribute = {
      ...clone(sent),
      '@odata.type': `#Microsoft.Dynamics.CRM.${cls}`,
      MetadataId: randomUUID(),
      LogicalName: logical,
      SchemaName: sent.SchemaName || logical,
      EntityLogicalName: table.LogicalName,
      AttributeType: type,
      AttributeTypeName: { Value: typeName },
      DisplayName: label(sent.DisplayName),
      Description: label(sent.Description),
      RequiredLevel: { Value: (sent.RequiredLevel && sent.RequiredLevel.Value) || 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
      IsCustomAttribute: extra.IsCustomAttribute !== undefined ? extra.IsCustomAttribute : true,
      IsCustomizable: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'iscustomizable' },
      IsManaged: false,
      IsPrimaryId: false,
      IsPrimaryName: !!sent.IsPrimaryName,
      IsLogical: false,
      IsValidForCreate: sent.IsValidForCreate !== undefined ? sent.IsValidForCreate : true,
      IsValidForRead: sent.IsValidForRead !== undefined ? sent.IsValidForRead : true,
      IsValidForUpdate: sent.IsValidForUpdate !== undefined ? sent.IsValidForUpdate : true,
      AttributeOf: null,
      SourceType: sent.SourceType !== undefined ? sent.SourceType : 0,
      ...extra,
    };
    delete attribute['@odata.context'];
    if (cls === 'StringAttributeMetadata' && attribute.MaxLength === undefined) attribute.MaxLength = 100;
    if (cls === 'StringAttributeMetadata' && !attribute.FormatName) attribute.FormatName = { Value: (sent.FormatName && sent.FormatName.Value) || 'Text' };
    if (cls === 'MemoAttributeMetadata' && attribute.MaxLength === undefined) attribute.MaxLength = 2000;
    // The column a Money column converts is not its base-currency twin (companionsOf makes that one).
    if (cls === 'MoneyAttributeMetadata' && attribute.IsBaseCurrency === undefined) attribute.IsBaseCurrency = false;
    if (attribute.OptionSet) attribute.OptionSet = storedOptionSet(attribute.OptionSet, { local: true });
    // MEASURED: an Image column is the logical projection of its `<name>id` (see companionsOf); `IsPrimaryImage` is decided in addAttribute.
    if (cls === 'ImageAttributeMetadata' && extra.AttributeOf === undefined) Object.assign(attribute, { AttributeOf: `${logical}id`, IsLogical: true });
    return attribute;
  }

  // An option set as stored: every option's labels as labels, the set's own metadata. A global set's bind replaces the local one.
  function storedOptionSet(sent, { local }) {
    const set = clone(sent) || {};
    delete set['@odata.type'];
    const options = (set.Options || []).map((o) => ({
      Value: o.Value,
      Label: label(o.Label),
      Description: label(o.Description),
      Color: o.Color === undefined ? null : o.Color,
      IsManaged: false,
      ExternalValue: o.ExternalValue === undefined ? null : o.ExternalValue,
      ...(o.State !== undefined ? { State: o.State } : {}),
      ...(o.DefaultStatus !== undefined ? { DefaultStatus: o.DefaultStatus } : {}),
    }));
    return {
      MetadataId: set.MetadataId || randomUUID(),
      Name: set.Name || null,
      IsGlobal: !local,
      IsCustomOptionSet: true,
      IsManaged: false,
      OptionSetType: set.OptionSetType || 'Picklist',
      DisplayName: label(set.DisplayName),
      Description: label(set.Description),
      ...(set.TrueOption ? { TrueOption: { Value: 1, Label: label(set.TrueOption.Label) }, FalseOption: { Value: 0, Label: label(set.FalseOption.Label) } } : {}),
      Options: options,
    };
  }

  // The companions the platform makes beside a column: what a reader must tell from a real column. Each is `AttributeOf` the column
  // — but an Image column's are not (MEASURED live): `<name>id` is a custom Uniqueidentifier that is `AttributeOf` nothing and is not
  // logical, `_timestamp` and `_url` are `AttributeOf` `<name>id`, and it is the Image column that is `AttributeOf` `<name>id`.
  function companionsOf(attribute) {
    const name = attribute.LogicalName;
    const cls = classOf(attribute);
    const virtual = (logical, type = 'Virtual', typeName = 'VirtualType', of = name) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.AttributeMetadata', MetadataId: randomUUID(), LogicalName: logical, SchemaName: logical, EntityLogicalName: attribute.EntityLogicalName, AttributeType: type, AttributeTypeName: { Value: typeName }, AttributeOf: of, IsCustomAttribute: attribute.IsCustomAttribute, IsLogical: true, IsPrimaryId: false, IsPrimaryName: false, IsValidForCreate: false, IsValidForRead: true, IsValidForUpdate: false, DisplayName: label(null), Description: label(null), RequiredLevel: { Value: 'None', CanBeChanged: false, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' }, SourceType: 0 });
    if (['PicklistAttributeMetadata', 'MultiSelectPicklistAttributeMetadata', 'BooleanAttributeMetadata', 'StateAttributeMetadata', 'StatusAttributeMetadata'].includes(cls)) return [virtual(`${name}name`)];
    // A Money column's base-currency twin is a PHYSICAL column, not a shadow: it carries no AttributeOf, is not logical and reports
    // IsCustomAttribute like the column it converts — only `IsBaseCurrency: true` tells it apart (measured on stock
    // `opportunity.estimatedvalue_base`; download-model-app.test.js pins the same live shape, and the download filters on it).
    if (cls === 'MoneyAttributeMetadata') {
      return [{ ...virtual(`${name}_base`, 'Money', 'MoneyType'), '@odata.type': '#Microsoft.Dynamics.CRM.MoneyAttributeMetadata', AttributeOf: null, IsLogical: false, IsBaseCurrency: true }];
    }
    if (cls === 'LookupAttributeMetadata') return [virtual(`${name}name`, 'String', 'StringType'), virtual(`${name}yominame`, 'String', 'StringType')];
    if (cls === 'FileAttributeMetadata') return [virtual(`${name}_name`, 'String', 'StringType')];
    if (cls === 'ImageAttributeMetadata') {
      const id = `${name}id`;
      return [
        { ...virtual(id, 'Uniqueidentifier', 'UniqueidentifierType', null), IsLogical: false },
        virtual(`${name}_timestamp`, 'BigInt', 'BigIntType', id),
        virtual(`${name}_url`, 'String', 'StringType', id),
      ];
    }
    return [];
  }

  const isImage = (attribute) => classOf(attribute) === 'ImageAttributeMetadata';

  function addAttribute(table, attribute) {
    // The platform's choice of a table's primary image (see the header): the first Image column it gets, whatever was sent.
    if (isImage(attribute)) {
      const first = ![...table.Attributes.values()].some(isImage);
      attribute.IsPrimaryImage = first;
      if (first) table.PrimaryImageAttribute = attribute.LogicalName;
    }
    table.Attributes.set(attribute.LogicalName, attribute);
    for (const companion of companionsOf(attribute)) if (!table.Attributes.has(companion.LogicalName)) table.Attributes.set(companion.LogicalName, companion);
    return attribute;
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Tables.
  const systemColumn = (table, logical, cls, extra = {}) => addAttribute(table, makeAttribute(table, { '@odata.type': `Microsoft.Dynamics.CRM.${cls}`, SchemaName: logical, DisplayName: logical }, { IsCustomAttribute: false, IsValidForCreate: false, IsValidForUpdate: false, ...extra }));
  const lookupTo = (targets) => ({ Targets: targets });
  // What a user-owned table holds from its creation, whatever the request said (the columns the platform adds; abridged to the ones a
  // reader meets: ownership, audit, state and the row version).
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/entity-metadata#table-type-and-ownership
  function addSystemColumns(table) {
    const id = `${table.LogicalName}id`;
    addAttribute(table, makeAttribute(table, { '@odata.type': 'Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata', SchemaName: `${table.SchemaName}Id`, DisplayName: table.SchemaName }, { LogicalName: id, IsCustomAttribute: true, IsPrimaryId: true, IsValidForUpdate: false }));
    systemColumn(table, 'createdon', 'DateTimeAttributeMetadata');
    systemColumn(table, 'modifiedon', 'DateTimeAttributeMetadata');
    systemColumn(table, 'overriddencreatedon', 'DateTimeAttributeMetadata', { IsValidForCreate: true });
    systemColumn(table, 'createdby', 'LookupAttributeMetadata', lookupTo(['systemuser']));
    systemColumn(table, 'modifiedby', 'LookupAttributeMetadata', lookupTo(['systemuser']));
    systemColumn(table, 'createdonbehalfby', 'LookupAttributeMetadata', lookupTo(['systemuser']));
    systemColumn(table, 'modifiedonbehalfby', 'LookupAttributeMetadata', lookupTo(['systemuser']));
    systemColumn(table, 'ownerid', 'LookupAttributeMetadata', { AttributeType: 'Owner', AttributeTypeName: { Value: 'OwnerType' }, Targets: ['systemuser', 'team'], IsValidForCreate: true, IsValidForUpdate: true });
    systemColumn(table, 'owningbusinessunit', 'LookupAttributeMetadata', lookupTo(['businessunit']));
    systemColumn(table, 'owninguser', 'LookupAttributeMetadata', lookupTo(['systemuser']));
    systemColumn(table, 'owningteam', 'LookupAttributeMetadata', lookupTo(['team']));
    systemColumn(table, 'statecode', 'StateAttributeMetadata', { IsValidForUpdate: true, OptionSet: storedOptionSet({ OptionSetType: 'State', Options: [{ Value: 0, Label: 'Active', DefaultStatus: 1 }, { Value: 1, Label: 'Inactive', DefaultStatus: 2 }] }, { local: true }) });
    systemColumn(table, 'statuscode', 'StatusAttributeMetadata', { IsValidForCreate: true, IsValidForUpdate: true, OptionSet: storedOptionSet({ OptionSetType: 'Status', Options: [{ Value: 1, Label: 'Active', State: 0 }, { Value: 2, Label: 'Inactive', State: 1 }] }, { local: true }) });
    systemColumn(table, 'versionnumber', 'BigIntAttributeMetadata');
    systemColumn(table, 'importsequencenumber', 'IntegerAttributeMetadata', { IsValidForCreate: true });
    systemColumn(table, 'timezoneruleversionnumber', 'IntegerAttributeMetadata', { IsValidForCreate: true, IsValidForUpdate: true });
    systemColumn(table, 'utcconversiontimezonecode', 'IntegerAttributeMetadata', { IsValidForCreate: true, IsValidForUpdate: true });
  }

  // A table definition from a create request (or a seed). `sent` is the EntityMetadata body: its `Attributes` hold the primary name column.
  function makeTable(sent, { custom = true } = {}) {
    const logical = lc(sent.SchemaName || sent.LogicalName);
    const table = {
      ...clone(sent),
      MetadataId: sent.MetadataId || randomUUID(),
      LogicalName: logical,
      SchemaName: sent.SchemaName || logical,
      EntitySetName: sent.EntitySetName || `${logical}s`,
      LogicalCollectionName: sent.LogicalCollectionName || `${logical}s`,
      CollectionSchemaName: sent.CollectionSchemaName || `${sent.SchemaName || logical}s`,
      ObjectTypeCode: sent.ObjectTypeCode || nextObjectTypeCode++,
      IsCustomEntity: custom,
      IsManaged: false,
      IsActivity: !!sent.IsActivity,
      IsIntersect: !!sent.IsIntersect,
      TableType: 'Standard',
      OwnershipType: sent.OwnershipType || 'UserOwned',
      HasNotes: !!sent.HasNotes,
      HasActivities: !!sent.HasActivities,
      DisplayName: label(sent.DisplayName),
      DisplayCollectionName: label(sent.DisplayCollectionName),
      Description: label(sent.Description),
      PrimaryIdAttribute: `${logical}id`,
      PrimaryNameAttribute: null,
      PrimaryImageAttribute: null,
      IconVectorName: sent.IconVectorName || null,
      IconSmallName: sent.IconSmallName || null,
      IconMediumName: sent.IconMediumName || null,
      IconLargeName: sent.IconLargeName || null,
      ChangeTrackingEnabled: false,
      IsQuickCreateEnabled: !!sent.IsQuickCreateEnabled,
      Attributes: new Map(),
      Keys: new Map(),
    };
    delete table['@odata.type'];
    for (const key of ['Attributes', 'Keys']) if (Array.isArray(sent[key])) table[key] = new Map();
    // The eight privileges the platform makes for a user- or organization-owned table (`prv<Type><SchemaName>`), which a role grants.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/security-roles#privileges
    const ownedByUser = table.OwnershipType === 'UserOwned';
    table.Privileges = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share']
      .filter((type) => ownedByUser || !['Assign', 'Share'].includes(type))
      .map((type) => ({ PrivilegeId: randomUUID(), Name: `prv${type}${table.SchemaName}`, PrivilegeType: type, CanBeBasic: ownedByUser, CanBeLocal: ownedByUser, CanBeDeep: ownedByUser, CanBeGlobal: true, CanBeEntityReference: false, CanBeParentEntityReference: false }));
    addSystemColumns(table);
    for (const attribute of sent.Attributes || []) {
      const made = addAttribute(table, makeAttribute(table, attribute));
      if (made.IsPrimaryName) table.PrimaryNameAttribute = made.LogicalName;
    }
    return table;
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Relationships. A 1:N is stored with its lookup made on the referencing table; an N:N with its intersect table.
  function makeOneToMany(sent) {
    const referencing = tables.get(lc(sent.ReferencingEntity));
    const referenced = tables.get(lc(sent.ReferencedEntity));
    if (!referencing || !referenced) return { error: `the table ${!referencing ? sent.ReferencingEntity : sent.ReferencedEntity} does not exist` };
    const lookupSent = sent.Lookup || {};
    const lookup = makeAttribute(referencing, { ...lookupSent, '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata' }, { Targets: [referenced.LogicalName] });
    if (referencing.Attributes.has(lookup.LogicalName)) return { error: `Attribute ${lookup.LogicalName} already exists for entity ${referencing.LogicalName}.`, code: '0x80060304' };
    addAttribute(referencing, lookup);
    const relationship = {
      ...clone(sent),
      '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      MetadataId: randomUUID(),
      RelationshipType: 'OneToManyRelationship',
      IsCustomRelationship: true,
      IsManaged: false,
      IsValidForAdvancedFind: true,
      ReferencedEntity: referenced.LogicalName,
      ReferencingEntity: referencing.LogicalName,
      ReferencedAttribute: referenced.PrimaryIdAttribute,
      ReferencingAttribute: lookup.LogicalName,
      ReferencedEntityNavigationPropertyName: sent.ReferencedEntityNavigationPropertyName || sent.SchemaName,
      ReferencingEntityNavigationPropertyName: sent.ReferencingEntityNavigationPropertyName || lookup.LogicalName,
      CascadeConfiguration: clone(sent.CascadeConfiguration) || { Assign: 'NoCascade', Delete: 'RemoveLink', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade' },
      AssociatedMenuConfiguration: clone(sent.AssociatedMenuConfiguration) || { Behavior: 'UseCollectionName', Group: 'Details', Label: label(null), Order: 10000 },
    };
    delete relationship.Lookup;
    relationships.set(lc(relationship.SchemaName), relationship);
    return { relationship, lookup };
  }

  function makeManyToMany(sent) {
    const one = tables.get(lc(sent.Entity1LogicalName));
    const two = tables.get(lc(sent.Entity2LogicalName));
    if (!one || !two) return { error: `the table ${!one ? sent.Entity1LogicalName : sent.Entity2LogicalName} does not exist` };
    const intersect = lc(sent.IntersectEntityName || sent.SchemaName);
    const relationship = {
      ...clone(sent),
      '@odata.type': '#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
      MetadataId: randomUUID(),
      RelationshipType: 'ManyToManyRelationship',
      IsCustomRelationship: true,
      IsManaged: false,
      IsValidForAdvancedFind: true,
      Entity1LogicalName: one.LogicalName,
      Entity2LogicalName: two.LogicalName,
      Entity1IntersectAttribute: `${one.LogicalName}id`,
      Entity2IntersectAttribute: one.LogicalName === two.LogicalName ? `${two.LogicalName}idtwo` : `${two.LogicalName}id`,
      IntersectEntityName: intersect,
      Entity1NavigationPropertyName: sent.Entity1NavigationPropertyName || sent.SchemaName,
      Entity2NavigationPropertyName: sent.Entity2NavigationPropertyName || sent.SchemaName,
      Entity1AssociatedMenuConfiguration: clone(sent.Entity1AssociatedMenuConfiguration) || { Behavior: 'UseCollectionName', Group: 'Details', Label: label(null), Order: 10000 },
      Entity2AssociatedMenuConfiguration: clone(sent.Entity2AssociatedMenuConfiguration) || { Behavior: 'UseCollectionName', Group: 'Details', Label: label(null), Order: 10000 },
    };
    relationships.set(lc(relationship.SchemaName), relationship);
    // The intersect table the platform makes (not customizable, no primary name): it exists while the relationship does.
    const table = makeTable({ SchemaName: intersect, EntitySetName: `${intersect}set`, IsIntersect: true, DisplayName: intersect, DisplayCollectionName: intersect }, { custom: true });
    tables.set(intersect, table);
    return { relationship };
  }

  // The relationships a table takes part in, from one side: what `<table>/OneToManyRelationships` (the table is the referenced one),
  // `ManyToOneRelationships` (the referencing one) and `ManyToManyRelationships` (either entity) answer.
  function relationshipsOf(logical, kind) {
    const all = [...relationships.values()];
    if (kind === 'OneToManyRelationships') return all.filter((r) => r.RelationshipType === 'OneToManyRelationship' && r.ReferencedEntity === logical);
    if (kind === 'ManyToOneRelationships') return all.filter((r) => r.RelationshipType === 'OneToManyRelationship' && r.ReferencingEntity === logical);
    return all.filter((r) => r.RelationshipType === 'ManyToManyRelationship' && (r.Entity1LogicalName === logical || r.Entity2LogicalName === logical));
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Reads: `$select`, `$filter` and `$expand` over the stored definitions, each already checked against the read contract above
  // (checkMetadataQuery) before any definition is looked at.
  const parseExpand = parseExpandText;
  // A filter reads a metadata property's value: an enum-valued one (`AttributeType eq 'Picklist'`) is text, a BooleanManagedProperty its `Value`.
  const flatForFilter = (def) => Object.fromEntries(Object.entries(def).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && 'Value' in v ? v.Value : v]));
  const filtered = (list, text) => (text === undefined ? list : list.filter((def) => evaluateFilter(compileFilter(text), flatForFilter(def), {})));

  // The properties a definition is answered with: with `$select`, exactly those (an unset one as `null`, as the platform answers it) and
  // `MetadataId`; without, every property it holds but its collection-valued navigations, which come back only when expanded. The
  // `@odata.type` of a derived type always comes back.
  function project(def, query, type) {
    const select = query.$select !== undefined ? listOf(query.$select) : null;
    const navigations = navigationsOf(type);
    const out = {};
    if (def['@odata.type']) out['@odata.type'] = def['@odata.type'];
    if (select) {
      for (const name of new Set(['MetadataId', ...select])) out[name] = def[name] === undefined ? null : clone(def[name]);
    } else {
      for (const [key, value] of Object.entries(def)) {
        if (key === '@odata.type' || value instanceof Map) continue;
        if (TABLE_NAVIGATIONS[key] && type.kind === 'table') continue;
        if (key === 'GlobalOptionSet' && type.kind === 'attribute') continue;
        out[key] = clone(value);
      }
    }
    for (const item of parseExpand(query.$expand)) out[item.name] = expandOf(def, type, navigations[item.name], item);
    return out;
  }
  function expandOf(def, type, target, item) {
    if (type.kind === 'table') {
      if (item.name === 'Attributes') return listAttributes(def, item.opts, null);
      if (item.name === 'Keys') return filtered([...def.Keys.values()], item.opts.$filter).map((k) => project(k, item.opts, target));
      return filtered(relationshipsOf(def.LogicalName, item.name), item.opts.$filter).map((r) => project(r, item.opts, target));
    }
    // An enum-valued column's option set: `GlobalOptionSet` is the global set it binds (null for a local one).
    const set = item.name === 'GlobalOptionSet' ? (def.GlobalOptionSet || (def.OptionSet && def.OptionSet.IsGlobal ? def.OptionSet : null)) : def.OptionSet;
    return set ? project(set, item.opts, target) : null;
  }
  // The columns of a table, of one derived type when the path casts (`Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata` —
  // a Customer or Owner lookup is a LookupAttributeMetadata too).
  function listAttributes(table, query, cast) {
    let list = [...table.Attributes.values()];
    if (cast) list = list.filter((a) => classOf(a) === cast);
    return filtered(list, query.$filter).map((a) => project(a, query, { kind: 'attribute', cls: cast || null }));
  }

  // `LogicalName='x'` / `<MetadataId>` / `SchemaName='x'` / `Name='x'`, as the key of a definition in a path. The alternate key a
  // collection takes is its own (KEY_NAMES): any other is unmodelled.
  function keyed(map, key, collection) {
    const named = /^(\w+)='((?:[^']|'')*)'$/.exec(key);
    if (named) {
      if (collection && named[1] !== KEY_NAMES[collection]) throw new Error(`fake-lifecycle-metadata: ${collection} is not keyed by ${named[1]}`);
      const value = lc(named[2].replace(/''/g, "'"));
      return [...map.values()].find((d) => lc(d[named[1]]) === value) || null;
    }
    if (!GUID_RE.test(bare(key))) throw new Error(`fake-lifecycle-metadata: the key (${key}) of ${collection || 'a definition'} is not modelled`);
    const id = bare(key);
    return [...map.values()].find((d) => bare(d.MetadataId) === id) || null;
  }
  const tableAt = (key) => keyed(tables, key, 'EntityDefinitions');

  // ------------------------------------------------------------------------------------------------------------------------
  // The router. `path` is below the API root, decoded, without the query; `query` the query's parameters. Answers
  // `{ status, body, headers }`, or null when the path is not a metadata path. `solution` is the `MSCRM.SolutionUniqueName` header.
  const ok = (body, headers = {}) => ({ status: 200, body, headers });
  const created = (location) => ({ status: 204, body: undefined, headers: { 'odata-entityid': location } });
  const fail = (status, message, code = '0x80040203') => ({ status, body: { error: { code, message } }, headers: {} });
  const missing = (what) => fail(404, `Could not find ${what}.`, '0x80040217');
  const collection = (value) => ok({ value });
  const CAST = /^Microsoft\.Dynamics\.CRM\.(\w+)$/;

  function handle(method, path, query, body, headers, apiRoot) {
    const segments = splitPath(path);
    if (!segments.length) return null;
    const head = segments[0];
    const solution = headers && Object.entries(headers).find(([k]) => k.toLowerCase() === 'mscrm.solutionuniquename');
    const solutionName = solution ? solution[1] : null;
    if (head.name === 'CreateCustomerRelationships' && method === 'POST') return createCustomer(body, solutionName);
    if (!['EntityDefinitions', 'RelationshipDefinitions', 'GlobalOptionSetDefinitions'].includes(head.name)) return null;
    if (head.name === 'EntityDefinitions') return entityDefinitions(method, segments, query, body, solutionName, apiRoot, headers);
    if (head.name === 'RelationshipDefinitions') return relationshipDefinitions(method, segments, query, body, solutionName, apiRoot);
    return optionSetDefinitions(method, segments, query, body, solutionName, apiRoot);
  }

  // `EntityDefinitions(LogicalName='x')/Attributes(LogicalName='y')/Microsoft.Dynamics.CRM.StringAttributeMetadata` ->
  // [{ name: 'EntityDefinitions', key: "LogicalName='x'" }, { name: 'Attributes', key: "LogicalName='y'" }, { name: 'Microsoft.Dynamics.CRM.StringAttributeMetadata' }]
  function splitPath(path) {
    const out = [];
    let i = 1;
    while (i < path.length) {
      let name = '';
      while (i < path.length && path[i] !== '(' && path[i] !== '/') name += path[i++];
      let key = null;
      if (path[i] === '(') {
        let depth = 0;
        let start = i + 1;
        for (; i < path.length; i += 1) {
          if (path[i] === "'") { i += 1; while (i < path.length && !(path[i] === "'" && path[i + 1] !== "'")) i += path[i] === "'" ? 2 : 1; continue; }
          if (path[i] === '(') depth += 1;
          if (path[i] === ')') { depth -= 1; if (depth === 0) break; }
        }
        key = path.slice(start, i);
        i += 1;
      }
      out.push({ name, key });
      if (path[i] === '/') i += 1;
    }
    return out;
  }

  // The paths under EntityDefinitions, every one of them (anything else is refused, naming it):
  //   EntityDefinitions                                              GET (collection) · POST
  //   EntityDefinitions(K)                                           GET · PUT · DELETE
  //   EntityDefinitions(K)/Attributes[/<attribute cast>]             GET (collection) · POST (uncast)
  //   EntityDefinitions(K)/Attributes(K)[/<attribute cast>]          GET · PUT · DELETE (uncast)
  //   EntityDefinitions(K)/Attributes(K)/<enum cast>/OptionSet       GET (and GlobalOptionSet)
  //   EntityDefinitions(K)/Keys · Keys(K)                            GET · POST · DELETE
  //   EntityDefinitions(K)/OneToManyRelationships | ManyToOneRelationships | ManyToManyRelationships   GET (collection)
  // K is `LogicalName='x'` or a MetadataId. A cast names a type the fake models (ATTRIBUTE_PROPS); a cast to the wrong type of the
  // column a path names is the platform's 400.
  const castOf = (segment, allowed, where) => {
    const cast = segment && CAST.exec(segment.name);
    if (!cast || segment.key !== null) throw new Error(`fake-lifecycle-metadata: ${where}/${segment ? segment.name : ''} is not modelled`);
    if (!allowed(cast[1])) throw new Error(`fake-lifecycle-metadata: the cast ${cast[1]} on ${where} is not modelled`);
    return cast[1];
  };
  const isAttributeClass = (name) => Object.prototype.hasOwnProperty.call(ATTRIBUTE_PROPS, name);
  const unmodelled = (method, where) => { throw new Error(`fake-lifecycle-metadata: ${method} ${where} is not modelled`); };

  function entityDefinitions(method, segments, query, body, solutionName, apiRoot, headers) {
    const [head, sub, third, fourth, ...rest] = segments;
    const table = { kind: 'table' };
    if (rest.length) unmodelled(method, segments.map((x) => x.name).join('/'));
    if (!head.key) {
      if (sub) unmodelled(method, `EntityDefinitions/${sub.name}`);
      if (method === 'GET') {
        checkMetadataQuery(table, query, COLLECTION_OPTIONS, 'EntityDefinitions');
        return collection(filtered([...tables.values()], query.$filter).map((t) => project(t, query, table)));
      }
      if (method === 'POST') return createTable(body, solutionName, apiRoot);
      unmodelled(method, 'EntityDefinitions');
    }
    const where = `EntityDefinitions(${head.key})`;
    const found = tableAt(head.key);
    if (!sub) {
      if (method === 'GET') { checkMetadataQuery(table, query, SINGLE_OPTIONS, where); return found ? ok(project(found, query, table)) : missing(`entity ${head.key}`); }
      if (method === 'PUT') return found ? updateTable(found, body, headers) : missing(`entity ${head.key}`);
      if (method === 'DELETE') return found ? deleteTable(found) : missing(`entity ${head.key}`);
      unmodelled(method, where);
    }
    if (!TABLE_NAVIGATIONS[sub.name]) unmodelled(method, `${where}/${sub.name}`);
    if (sub.name === 'Attributes') {
      if (!sub.key) {
        if (fourth) unmodelled(method, `${where}/Attributes/${third.name}/${fourth.name}`);
        const cast = third ? castOf(third, isAttributeClass, `${where}/Attributes`) : null;
        if (method === 'GET') {
          checkMetadataQuery({ kind: 'attribute', cls: cast }, query, COLLECTION_OPTIONS, `${where}/Attributes${cast ? `/${cast}` : ''}`);
          return found ? collection(listAttributes(found, query, cast)) : missing(`entity ${head.key}`);
        }
        if (method === 'POST' && !cast) return found ? createColumn(found, body, solutionName, apiRoot) : missing(`entity ${head.key}`);
        unmodelled(method, `${where}/Attributes`);
      }
      const at = `${where}/Attributes(${sub.key})`;
      const cast = third ? castOf(third, isAttributeClass, at) : null;
      if (fourth) {
        // An enum-valued column's option set, through the cast that declares the navigation.
        const navigation = navigationsOf({ kind: 'attribute', cls: cast })[fourth.name];
        if (!navigation || fourth.key !== null || method !== 'GET') unmodelled(method, `${at}/${third.name}/${fourth.name}`);
        checkMetadataQuery(navigation, query, ['$select'], `${at}/${fourth.name}`);
      } else if (method === 'GET') {
        checkMetadataQuery({ kind: 'attribute', cls: cast }, query, SINGLE_OPTIONS, at);
      }
      if (!found) return missing(`entity ${head.key}`);
      const attribute = keyed(found.Attributes, sub.key, 'Attributes');
      if (!attribute) return missing(`attribute ${sub.key} on ${found.LogicalName}`);
      if (cast && classOf(attribute) !== cast) return fail(400, `The attribute ${attribute.LogicalName} is not a ${cast}.`, '0x80060888');
      if (method === 'GET') {
        if (fourth) return ok(expandOf(attribute, { kind: 'attribute', cls: cast }, navigationsOf({ kind: 'attribute', cls: cast })[fourth.name], { name: fourth.name, opts: query }));
        return ok(project(attribute, query, { kind: 'attribute', cls: cast }));
      }
      if (method === 'PUT' && !fourth) return updateColumn(found, attribute, body, headers);
      if (method === 'DELETE' && !cast) return deleteColumn(found, attribute);
      unmodelled(method, at);
    }
    if (third) unmodelled(method, `${where}/${sub.name}/${third.name}`);
    if (sub.name === 'Keys') {
      const keyType = { kind: 'key' };
      if (!sub.key) {
        if (method === 'GET') { checkMetadataQuery(keyType, query, COLLECTION_OPTIONS, `${where}/Keys`); return found ? collection(filtered([...found.Keys.values()], query.$filter).map((k) => project(k, query, keyType))) : missing(`entity ${head.key}`); }
        if (method === 'POST') return found ? createKey(found, body, apiRoot) : missing(`entity ${head.key}`);
        unmodelled(method, `${where}/Keys`);
      }
      if (method === 'GET') checkMetadataQuery(keyType, query, SINGLE_OPTIONS, `${where}/Keys(${sub.key})`);
      if (!found) return missing(`entity ${head.key}`);
      const key = keyed(found.Keys, sub.key, 'Keys');
      if (method === 'GET') return key ? ok(project(key, query, keyType)) : missing(`key ${sub.key}`);
      if (method === 'DELETE') { if (!key) return missing(`key ${sub.key}`); found.Keys.delete(key.LogicalName); return { status: 204, headers: {} }; }
      unmodelled(method, `${where}/Keys(${sub.key})`);
    }
    // OneToManyRelationships / ManyToOneRelationships / ManyToManyRelationships: a collection, read only.
    if (sub.key || method !== 'GET') unmodelled(method, `${where}/${sub.name}${sub.key ? `(${sub.key})` : ''}`);
    const type = TABLE_NAVIGATIONS[sub.name];
    checkMetadataQuery(type, query, COLLECTION_OPTIONS, `${where}/${sub.name}`);
    if (!found) return missing(`entity ${head.key}`);
    return collection(filtered(relationshipsOf(found.LogicalName, sub.name), query.$filter).map((r) => project(r, query, type)));
  }

  function createTable(body, solutionName, apiRoot) {
    const logical = lc(body.SchemaName);
    if (tables.has(logical)) return fail(400, `Entities already exist: ${body.SchemaName}`, '0x80047013');
    const table = makeTable(body);
    if (!table.PrimaryNameAttribute) return fail(400, 'A primary name attribute is required.', '0x80047013');
    tables.set(logical, table);
    if (addComponent) addComponent(solutionName, { objectid: table.MetadataId, componenttype: 1, rootcomponentbehavior: 0 });
    if (onTableCreated) onTableCreated(table, solutionName);
    return created(`${apiRoot}/EntityDefinitions(${table.MetadataId})`);
  }

  // A PUT replaces the definition; `MSCRM.MergeLabels: true` keeps the labels of the languages the request does not carry.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#update-table-definitions
  function mergeLabels(stored, sent, merge) {
    const next = label(sent);
    if (!merge) return next;
    const kept = stored.LocalizedLabels.filter((l) => !next.LocalizedLabels.some((n) => n.LanguageCode === l.LanguageCode));
    const list = [...kept, ...next.LocalizedLabels];
    return { LocalizedLabels: list, UserLocalizedLabel: clone(list.find((l) => l.LanguageCode === userLanguage) || list[0] || null) };
  }
  const isMerge = (headers) => !!headers && Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'mscrm.mergelabels' && String(v) === 'true');
  const LABEL_KEYS = ['DisplayName', 'DisplayCollectionName', 'Description'];
  function updateTable(table, body, headers) {
    for (const [key, value] of Object.entries(body || {})) {
      if (key.startsWith('@odata') || ['MetadataId', 'LogicalName', 'Attributes', 'Keys'].includes(key)) continue;
      table[key] = LABEL_KEYS.includes(key) ? mergeLabels(table[key], value, isMerge(headers)) : clone(value);
    }
    return { status: 204, headers: {} };
  }

  function createColumn(table, body, solutionName, apiRoot) {
    const logical = lc(body.SchemaName);
    if (table.Attributes.has(logical)) return fail(400, `Attribute ${logical} already exists for entity ${table.LogicalName}.`, '0x80060304');
    const bind = body['GlobalOptionSet@odata.bind'];
    const sent = { ...body };
    delete sent['GlobalOptionSet@odata.bind'];
    const attribute = makeAttribute(table, sent);
    if (bind) {
      const set = keyed(optionSets, (/GlobalOptionSetDefinitions\((.+)\)$/.exec(bind) || [])[1] || '');
      if (!set) return fail(400, `The global option set ${bind} does not exist.`);
      attribute.OptionSet = clone(set);
      attribute.GlobalOptionSet = clone(set);
    }
    addAttribute(table, attribute);
    if (addComponent) addComponent(solutionName, { objectid: attribute.MetadataId, componenttype: 2, parentTable: table.LogicalName });
    return created(`${apiRoot}/EntityDefinitions(${table.MetadataId})/Attributes(${attribute.MetadataId})`);
  }

  function updateColumn(table, attribute, body, headers) {
    for (const [key, value] of Object.entries(body || {})) {
      if (key.startsWith('@odata') || ['MetadataId', 'LogicalName', 'AttributeType', 'AttributeTypeName'].includes(key)) continue;
      if (LABEL_KEYS.includes(key)) attribute[key] = mergeLabels(attribute[key], value, isMerge(headers));
      else if (key === 'OptionSet') attribute.OptionSet = { ...attribute.OptionSet, ...storedOptionSet(value, { local: !attribute.OptionSet || !attribute.OptionSet.IsGlobal }), MetadataId: attribute.OptionSet ? attribute.OptionSet.MetadataId : randomUUID() };
      else attribute[key] = clone(value);
    }
    if (attribute.IsPrimaryName) table.PrimaryNameAttribute = attribute.LogicalName;
    return { status: 204, headers: {} };
  }

  function deleteColumn(table, attribute) {
    table.Attributes.delete(attribute.LogicalName);
    for (const [name, other] of [...table.Attributes]) if (other.AttributeOf === attribute.LogicalName) table.Attributes.delete(name);
    // The base-currency twin has no AttributeOf to follow (see companionsOf): it goes by its name, as the platform deletes it.
    const twin = table.Attributes.get(`${attribute.LogicalName}_base`);
    if (classOf(attribute) === 'MoneyAttributeMetadata' && attribute.IsBaseCurrency !== true && twin && twin.IsBaseCurrency === true) table.Attributes.delete(twin.LogicalName);
    // An Image column's companions hang off its `<name>id` (companionsOf), which goes with it; and the next Image column becomes the
    // table's primary image when this one was it (see the header).
    if (isImage(attribute)) {
      const id = `${attribute.LogicalName}id`;
      for (const [name, other] of [...table.Attributes]) if (name === id || other.AttributeOf === id) table.Attributes.delete(name);
      if (table.PrimaryImageAttribute === attribute.LogicalName) {
        const next = [...table.Attributes.values()].find(isImage);
        table.PrimaryImageAttribute = next ? next.LogicalName : null;
        if (next) next.IsPrimaryImage = true;
      }
    }
    if (removeComponents) removeComponents([attribute.MetadataId]);
    return { status: 204, headers: {} };
  }

  function createKey(table, body, apiRoot) {
    const logical = lc(body.SchemaName);
    if (table.Keys.has(logical)) return fail(400, `A key with the same name already exists on ${table.LogicalName}.`);
    for (const column of body.KeyAttributes || []) if (!table.Attributes.has(lc(column))) return fail(400, `The key column ${column} does not exist on ${table.LogicalName}.`);
    const key = { ...clone(body), MetadataId: randomUUID(), LogicalName: logical, EntityLogicalName: table.LogicalName, DisplayName: label(body.DisplayName), EntityKeyIndexStatus: 'Active', IsManaged: false };
    delete key['@odata.type'];
    table.Keys.set(logical, key);
    return created(`${apiRoot}/EntityDefinitions(${table.MetadataId})/Keys(${key.MetadataId})`);
  }

  // Deleting a table removes everything that is part of it: its columns, its keys, the relationships it takes part in (with the lookups
  // they made on the other side), its rows and its views, forms and charts (`onTableDeleted`) and its solution components.
  function deleteTable(table) {
    for (const r of [...relationships.values()]) {
      const involved = r.RelationshipType === 'OneToManyRelationship' ? [r.ReferencedEntity, r.ReferencingEntity] : [r.Entity1LogicalName, r.Entity2LogicalName];
      if (involved.includes(table.LogicalName)) removeRelationship(r);
    }
    tables.delete(table.LogicalName);
    if (removeComponents) removeComponents([table.MetadataId, ...[...table.Attributes.values()].map((a) => a.MetadataId)]);
    if (onTableDeleted) onTableDeleted(table);
    return { status: 204, headers: {} };
  }

  function removeRelationship(r) {
    relationships.delete(lc(r.SchemaName));
    if (r.RelationshipType === 'OneToManyRelationship') {
      const referencing = tables.get(r.ReferencingEntity);
      const lookup = referencing && referencing.Attributes.get(r.ReferencingAttribute);
      if (lookup) deleteColumn(referencing, lookup);
    } else {
      const intersect = tables.get(r.IntersectEntityName);
      if (intersect) { tables.delete(intersect.LogicalName); if (onTableDeleted) onTableDeleted(intersect); }
    }
    if (removeComponents) removeComponents([r.MetadataId]);
  }

  // RelationshipDefinitions[/<relationship cast>] (GET; POST uncast) and RelationshipDefinitions(K)[/<cast>] (GET, PUT; DELETE
  // uncast), K being `SchemaName='x'` or a MetadataId.
  const isRelationshipClass = (name) => Object.prototype.hasOwnProperty.call(RELATIONSHIP_PROPS, name);
  function relationshipDefinitions(method, segments, query, body, solutionName, apiRoot) {
    const [head, sub, ...rest] = segments;
    if (rest.length) unmodelled(method, segments.map((x) => x.name).join('/'));
    const cast = sub ? castOf(sub, isRelationshipClass, `RelationshipDefinitions${head.key ? `(${head.key})` : ''}`) : null;
    const type = { kind: 'relationship', cls: cast };
    if (!head.key) {
      if (method === 'GET') {
        checkMetadataQuery(type, query, COLLECTION_OPTIONS, `RelationshipDefinitions${cast ? `/${cast}` : ''}`);
        const list = [...relationships.values()].filter((r) => !cast || r['@odata.type'] === `#Microsoft.Dynamics.CRM.${cast}`);
        return collection(filtered(list, query.$filter).map((r) => project(r, query, type)));
      }
      if (method === 'POST' && !cast) {
        if (relationships.has(lc(body.SchemaName))) return fail(400, `A relationship with the name ${body.SchemaName} already exists.`, '0x80047007');
        const many = /ManyToManyRelationshipMetadata$/.test(String(body['@odata.type']));
        const made = many ? makeManyToMany(body) : makeOneToMany(body);
        if (made.error) return fail(400, made.error, made.code || '0x80040203');
        if (addComponent) addComponent(solutionName, { objectid: made.relationship.MetadataId, componenttype: 10 });
        return created(`${apiRoot}/RelationshipDefinitions(${made.relationship.MetadataId})`);
      }
      unmodelled(method, 'RelationshipDefinitions');
    }
    if (method === 'GET') checkMetadataQuery(type, query, ['$select'], `RelationshipDefinitions(${head.key})`);
    const r = keyed(relationships, head.key, 'RelationshipDefinitions');
    if (!r) return missing(`relationship ${head.key}`);
    if (cast && r['@odata.type'] !== `#Microsoft.Dynamics.CRM.${cast}`) return fail(400, `The relationship ${r.SchemaName} is not a ${cast}.`, '0x80060888');
    if (method === 'GET') return ok(project(r, query, { kind: 'relationship', cls: cast || r['@odata.type'].replace(/^#Microsoft\.Dynamics\.CRM\./, '') }));
    if (method === 'PUT') {
      for (const [key, value] of Object.entries(body || {})) if (!key.startsWith('@odata') && key !== 'MetadataId') r[key] = clone(value);
      return { status: 204, headers: {} };
    }
    if (method === 'DELETE' && !cast) { removeRelationship(r); return { status: 204, headers: {} }; }
    unmodelled(method, `RelationshipDefinitions(${head.key})`);
  }

  // GlobalOptionSetDefinitions (GET, POST) and GlobalOptionSetDefinitions(K)[/<option set cast>] (GET; PUT and DELETE uncast), K being
  // `Name='x'` or a MetadataId. A global option set cannot be deleted while a column binds it (the platform names the dependency).
  function optionSetDefinitions(method, segments, query, body, solutionName, apiRoot) {
    const [head, sub, ...rest] = segments;
    if (rest.length || (sub && !head.key)) unmodelled(method, segments.map((x) => x.name).join('/'));
    const cast = sub ? castOf(sub, (name) => OPTIONSET_CASTS.has(name), `GlobalOptionSetDefinitions(${head.key})`) : null;
    const type = { kind: 'optionset', cls: cast };
    if (!head.key) {
      if (method === 'GET') {
        checkMetadataQuery(type, query, ['$select', '$filter'], 'GlobalOptionSetDefinitions');
        return collection(filtered([...optionSets.values()], query.$filter).map((set) => project(set, query, type)));
      }
      if (method === 'POST') {
        if (optionSets.has(lc(body.Name))) return fail(400, `An option set with the name ${body.Name} already exists.`, '0x80047008');
        const set = { ...storedOptionSet(body, { local: false }), Name: body.Name };
        optionSets.set(lc(body.Name), set);
        if (addComponent) addComponent(solutionName, { objectid: set.MetadataId, componenttype: 9 });
        return created(`${apiRoot}/GlobalOptionSetDefinitions(${set.MetadataId})`);
      }
      unmodelled(method, 'GlobalOptionSetDefinitions');
    }
    if (method === 'GET') checkMetadataQuery(type, query, ['$select'], `GlobalOptionSetDefinitions(${head.key})`);
    const set = keyed(optionSets, head.key, 'GlobalOptionSetDefinitions');
    if (!set) return missing(`option set ${head.key}`);
    if (method === 'GET') return ok(project(set, query, type));
    if (method === 'DELETE' && !cast) {
      const binders = [...tables.values()].flatMap((t) => [...t.Attributes.values()].filter((a) => a.OptionSet && bare(a.OptionSet.MetadataId) === bare(set.MetadataId)));
      if (binders.length) return fail(400, `The OptionSet(${set.MetadataId}) component cannot be deleted because it is referenced by ${binders.length} other components.`, '0x8004f01f');
      optionSets.delete(lc(set.Name));
      if (removeComponents) removeComponents([set.MetadataId]);
      return { status: 204, headers: {} };
    }
    if (method === 'PUT' && !cast) {
      Object.assign(set, storedOptionSet({ ...set, ...body }, { local: false }), { MetadataId: set.MetadataId, Name: set.Name });
      return { status: 204, headers: {} };
    }
    unmodelled(method, `GlobalOptionSetDefinitions(${head.key})`);
  }

  // CreateCustomerRelationships { Lookup: { "@odata.type": "Microsoft.Dynamics.CRM.ComplexLookupAttributeMetadata", SchemaName, Targets },
  // OneToManyRelationships: [ { SchemaName, ReferencedEntity: "account", ReferencingEntity }, { … "contact" … } ] }: one Customer lookup
  // on the referencing table (with its `<name>name`, `<name>yominame` and `<name>idtype` companions) and a 1:N from each target, answered
  // `{ "AttributeId": "<guid>", "RelationshipIds": [ "<guid>", "<guid>" ] }`.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/createcustomerrelationships
  function createCustomer(body, solutionName) {
    const rels = body.OneToManyRelationships || [];
    const referencing = tables.get(lc(rels[0] && rels[0].ReferencingEntity));
    if (!referencing) return fail(400, `the table ${rels[0] && rels[0].ReferencingEntity} does not exist`);
    const logical = lc(body.Lookup.SchemaName);
    if (referencing.Attributes.has(logical)) return fail(400, `Attribute ${logical} already exists for entity ${referencing.LogicalName}.`, '0x80060304');
    const lookup = makeAttribute(referencing, { ...body.Lookup, '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata' }, { AttributeType: 'Customer', AttributeTypeName: { Value: 'CustomerType' }, Targets: clone(body.Lookup.Targets) });
    addAttribute(referencing, lookup);
    const idtype = { ...companionsOf(lookup)[0], LogicalName: `${logical}idtype`, SchemaName: `${logical}idtype`, AttributeType: 'EntityName', AttributeTypeName: { Value: 'EntityNameType' }, MetadataId: randomUUID() };
    referencing.Attributes.set(idtype.LogicalName, idtype);
    const ids = [];
    for (const r of rels) {
      const referenced = tables.get(lc(r.ReferencedEntity));
      if (!referenced) return fail(400, `the table ${r.ReferencedEntity} does not exist`);
      const relationship = {
        ...clone(r), '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', MetadataId: randomUUID(), RelationshipType: 'OneToManyRelationship', IsCustomRelationship: true, IsManaged: false,
        ReferencedEntity: referenced.LogicalName, ReferencingEntity: referencing.LogicalName, ReferencedAttribute: referenced.PrimaryIdAttribute, ReferencingAttribute: logical,
        CascadeConfiguration: { Assign: 'NoCascade', Delete: 'RemoveLink', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade' },
      };
      relationships.set(lc(relationship.SchemaName), relationship);
      ids.push(relationship.MetadataId);
      if (addComponent) addComponent(solutionName, { objectid: relationship.MetadataId, componenttype: 10 });
    }
    if (addComponent) addComponent(solutionName, { objectid: lookup.MetadataId, componenttype: 2, parentTable: referencing.LogicalName });
    return ok({ AttributeId: lookup.MetadataId, RelationshipIds: ids });
  }

  return { tables, relationships, optionSets, label, textOf, makeAttribute, storedOptionSet, companionsOf, addAttribute, makeTable, makeOneToMany, makeManyToMany, relationshipsOf, project, listAttributes, parseExpand, keyed, tableAt, flatForFilter, handle, splitPath, deleteTable, removeRelationship };
}

module.exports = { createMetadataStore, TYPE_OF, classOf };
