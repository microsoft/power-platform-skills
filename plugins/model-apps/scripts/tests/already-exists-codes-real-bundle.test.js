'use strict';
// A create that Dataverse refuses because what it asks for already exists is a skip — or, for a table and a relationship, the cue to
// read what exists — and that answer is recognised by its error CODE, which is the same in every language, as well as by its English
// words. The words alone halted a rebuild on an environment whose language is Spanish: the platform words its refusals in the caller's
// language, and an alternate key the build had to create again (it could not prove the key from its table read) was answered
//   HTTP 400 {"error":{"code":"0x80060893","message":"Ya existe una clave de entidad con el nombre contoso_codekey en la entidad contoso_project."}}
// (live-captured, with the names replaced), which the English words cannot read.
//
// Each create that reads such an answer is run here twice through the real vendored SDK, over a transport that answers only what a test
// models: once answered in English and once in another language, with the same code. The other language must come to the same outcome
// — the same steps, warnings, requests and result. Only the key's Spanish text is the platform's own; the other non-English texts are
// written for these tests, to be words the English rule cannot read. The codes are the ones lib/entity-provision.js documents
// (ALREADY_EXISTS_CODES). What must not move: a code of ANOTHER create, a generic code, and a code that the words only quote do not by
// themselves make an answer an already-exists one — given words the English rule cannot read, such an answer stops the build (the 409
// and English-word rules are unchanged and still apply whatever code an answer carries); and the reads that decide a table and a
// relationship are made as before.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { makeRunner, provisionDataModel, BuildHalt, ALREADY_EXISTS_CODES } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ORG = 'https://contoso.crm.dynamics.com';

const ok = (body) => ({ status: 200, body });
// The platform's OData error envelope, as the SDK receives it.
const answer = (status, code, message) => ({ status, body: { error: { code, message } } });
const refused = (code, message) => answer(400, code, message);
// What the platform answers a read of something it does not hold.
const absent = (message) => answer(404, '0x80060888', message);
// The generic code, documented as "An unexpected error occurred." — it says nothing about what failed.
const GENERIC = '0x80040216';

// The real SDK over a transport that answers only the requests a test models. Every request is recorded; one that no test models is a
// failure of the test (`unmodelled`), never an answer the build could read as a success or as the refusal under test.
async function realSdk(route) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const requests = [];
  const unmodelled = [];
  const send = async (method, url, body) => {
    const asked = decodeURIComponent(String(url)).replace(/^https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d+/, '');
    requests.push(`${method} ${asked}`);
    const reply = route(method, asked, body);
    if (!reply) {
      unmodelled.push(`${method} ${asked}`);
      throw new Error(`the test does not model ${method} ${asked}`);
    }
    return { status: reply.status, headers: {}, body: reply.body };
  };
  const httpClient = {
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, body),
    put: (url, body) => send('PUT', url, body),
    patch: (url, body) => send('PATCH', url, body),
    delete: (url) => send('DELETE', url),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('already-exists-codes-')), instanceUrl: ORG, httpClient });
  await sdk.initWorkspace();
  return { sdk, requests, unmodelled };
}

// The data-model phase of a build in an environment whose only language is Spanish (3082), over the routes given.
async function build(spec, route) {
  const { sdk, requests, unmodelled } = await realSdk(route);
  const events = [];
  const warnings = [];
  let result;
  let error;
  try {
    result = await provisionDataModel({
      sdk, provision: sdk, runner: makeRunner({ emit: (event) => events.push(event), total: 20 }), spec, apply: true,
      preResolvedLanguageCode: 3082, provisionedLanguages: async () => [3082], sleep: async () => {}, warn: (message) => warnings.push(message),
    });
  } catch (err) { error = err; }
  const steps = events.filter((event) => event.status !== 'start').map((event) => `${event.status} ${event.label}`);
  return { result, error, steps, warnings, requests, unmodelled };
}

// What two runs must share to have come to the same outcome.
const outcomeOf = (run) => ({ steps: run.steps, warnings: run.warnings, requests: run.requests, result: run.result });

// The build stops at `step` — the create under test, which is not skipped — with the platform's own words.
function assertStopsAt(run, step, words, what) {
  assert.deepStrictEqual(run.unmodelled, [], `${what}: every request was one the test models`);
  assert.ok(run.error instanceof BuildHalt, `${what}: the build stops — ${run.error && run.error.message}`);
  assert.strictEqual(run.error.phase, 'data-model', what);
  assert.ok(run.error.message.includes(words), `${what}: with the platform's own words — ${run.error.message}`);
  assert.strictEqual(run.steps[run.steps.length - 1], `error ${step}`, `${what}: at that step — ${run.steps.join(' | ')}`);
}

const SOLUTION = { uniqueName: 'Proyectos', publisherPrefix: 'contoso' };
const project = (more) => ({ schemaName: 'contoso_Project', displayName: 'Proyecto', pluralName: 'Proyectos', primaryAttribute: { schemaName: 'contoso_Name' }, columns: [], ...more });
const PROJECT_COLUMNS = ok({ value: [{ LogicalName: 'contoso_name', RequiredLevel: { Value: 'None' } }, { LogicalName: 'contoso_code', RequiredLevel: { Value: 'None' } }] });
const PROBE = "/EntityDefinitions(LogicalName='contoso_project')?$select=LogicalName,EntitySetName";
const COLUMN_LIST = "/EntityDefinitions(LogicalName='contoso_project')/Attributes?$select=LogicalName,RequiredLevel";

// --- an alternate key the build cannot prove from its table read -------------------------------------------------------------------
// The keys ride the read that finds the table (`$expand=Keys`), and a key that read shows over the same columns is not sent again. When
// that read fails, the table is found by the list of tables, which carries no keys: the key cannot be proven, so it is created, and the
// platform answers that it exists — the path a rebuild on the Spanish environment halted on, live.
const KEYED = { solution: SOLUTION, relationships: [], entities: [project({
  columns: [{ schemaName: 'contoso_Code', type: 'Text' }],
  alternateKeys: [{ schemaName: 'contoso_CodeKey', displayName: 'Clave de codigo', columns: ['contoso_code'] }],
})] };
const KEYS = "/EntityDefinitions(LogicalName='contoso_project')/Keys";
const keyRefusedWith = (keyAnswer) => (method, asked) => {
  if (method === 'GET' && asked === `${PROBE}&$expand=Keys($select=SchemaName,KeyAttributes)`) return answer(500, GENERIC, 'An unexpected error occurred.');
  if (method === 'GET' && asked === '/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity') {
    return ok({ value: [{ LogicalName: 'contoso_project', SchemaName: 'contoso_Project', EntitySetName: 'contoso_projects', IsCustomEntity: true }] });
  }
  if (method === 'GET' && asked === COLUMN_LIST) return PROJECT_COLUMNS;
  if (method === 'POST' && asked === KEYS) return keyAnswer;
  return undefined;
};
const KEY_IN_ENGLISH = refused('0x80060893', 'An entity key with the name contoso_codekey already exists on entity contoso_project.');

test('an alternate key the build cannot prove, refused in Spanish because it exists (0x80060893), is skipped exactly as the English refusal is', async () => {
  const english = await build(KEYED, keyRefusedWith(KEY_IN_ENGLISH));
  assert.deepStrictEqual(english.unmodelled, []);
  assert.strictEqual(english.error, undefined, english.error && english.error.message);
  assert.ok(english.steps.includes('skip alt key contoso_Project.contoso_CodeKey (exists)'), english.steps.join(' | '));
  assert.strictEqual(english.requests.filter((request) => request === `POST ${KEYS}`).length, 1, 'the key could not be proven, so it was asked for once');
  for (const [language, words] of [
    // The platform's own Spanish text (live-captured, names replaced).
    ['Spanish', 'Ya existe una clave de entidad con el nombre contoso_codekey en la entidad contoso_project.'],
    // Any other language is read the same way: the code decides, not the words.
    ['German', 'Ein Entitaetsschluessel mit dem Namen contoso_codekey ist fuer die Entitaet contoso_project bereits vorhanden.'],
  ]) {
    const run = await build(KEYED, keyRefusedWith(refused('0x80060893', words)));
    assert.strictEqual(run.error, undefined, `${language}: ${run.error && run.error.message}`);
    assert.deepStrictEqual(outcomeOf(run), outcomeOf(english), `${language}: the same steps, warnings, requests and result as the English answer`);
  }
});

test('an alternate key refused in another language with a code that does not say the key exists stops the build, as before', async () => {
  for (const [what, keyAnswer] of [
    // Another create's code: a column of that name exists — nothing about this key.
    ['the code of a column that exists', refused('0x80060304', 'Ya existe el atributo contoso_code para la entidad contoso_project.')],
    // A record already holds the key's values: the code of a data write, not of a key create.
    ['the code of a record that holds the key\'s values', refused('0x80060892', 'Ya existe un registro con el mismo valor para contoso_code.')],
    ['the generic code', refused(GENERIC, 'Ya existe una clave de entidad con el nombre contoso_codekey en la entidad contoso_project.')],
    // The code is read from the answer's `error.code`, never from its words.
    ['a code the words only quote', refused(GENERIC, 'Error 0x80060893: ya existe una clave de entidad con el nombre contoso_codekey.')],
  ]) {
    const run = await build(KEYED, keyRefusedWith(keyAnswer));
    assertStopsAt(run, 'alt key contoso_Project.contoso_CodeKey', keyAnswer.body.error.message, what);
  }
});

// --- a status reason whose value is already taken ---------------------------------------------------------------------------------
// The build pins each status reason's value, so a second insert of it is refused because an option already holds that value. A table
// that exists has its reasons read first, and only a reason the read does not show is inserted; when the read fails, every reason is
// inserted and the refusal is what keeps the build from making one twice.
const STATUSED = { solution: SOLUTION, relationships: [], entities: [project({ statusReasons: [{ label: 'En revision', state: 'Active' }] })] };
const statusRefusedWith = (statusAnswer) => (method, asked) => {
  if (method === 'GET' && asked === PROBE) return ok({ LogicalName: 'contoso_project', EntitySetName: 'contoso_projects' });
  if (method === 'GET' && asked === COLUMN_LIST) return PROJECT_COLUMNS;
  if (method === 'GET' && asked === "/EntityDefinitions(LogicalName='contoso_project')/Attributes/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)") {
    return answer(500, GENERIC, 'An unexpected error occurred.');
  }
  if (method === 'POST' && asked === '/InsertStatusValue') return statusAnswer;
  return undefined;
};

test('a status reason refused in Spanish because its value is taken (0x80044310) is skipped exactly as the English refusal is', async () => {
  // The English text is the platform's own (live-captured, the option set's id replaced).
  const english = await build(STATUSED, statusRefusedWith(refused('0x80044310', 'The picklist or status value 100000000 is invalid for optionSet 00000000-0000-0000-0000-000000000001 because another picklist or status option for this optionSet already exists with that value')));
  assert.deepStrictEqual(english.unmodelled, []);
  assert.strictEqual(english.error, undefined, english.error && english.error.message);
  assert.ok(english.steps.includes('skip status reason contoso_Project: En revision (exists)'), english.steps.join(' | '));
  assert.deepStrictEqual(english.result.statusReasonValues, { contoso_project: { 'En revision': { value: 100000000, stateCode: 0 } } }, 'the pinned value is kept for the sample data');
  const spanish = await build(STATUSED, statusRefusedWith(refused('0x80044310', 'El valor de estado 100000000 no es valido para el conjunto de opciones 00000000-0000-0000-0000-000000000001 porque ya existe otra opcion con ese valor')));
  assert.strictEqual(spanish.error, undefined, spanish.error && spanish.error.message);
  assert.deepStrictEqual(outcomeOf(spanish), outcomeOf(english), 'the same steps, warnings, requests and result as the English answer');
});

test('a status reason refused in another language with a code that does not say its value is taken stops the build, as before', async () => {
  for (const [what, statusAnswer] of [
    ['the code of an alternate key that exists', refused('0x80060893', 'Ya existe una clave de entidad con el nombre contoso_codekey en la entidad contoso_project.')],
    ['the generic code', refused(GENERIC, 'Ya existe otra opcion con ese valor.')],
  ]) {
    const run = await build(STATUSED, statusRefusedWith(statusAnswer));
    assertStopsAt(run, 'status reason contoso_Project: En revision', statusAnswer.body.error.message, what);
  }
});

// --- a table the probe did not find, and that exists when it is created --------------------------------------------------------------
// The read that looks for the table answers that it is not there, the create answers that it is (a create whose earlier answer was lost,
// or another maker's), and the build reads the table again: found, it is reused; not found, the create's own error stops the build.
const TABLE = { solution: SOLUTION, relationships: [], entities: [project()] };
const tableRefusedWith = (tableAnswer, { foundAfter = true } = {}) => {
  let probes = 0;
  return (method, asked) => {
    if (method === 'GET' && asked === PROBE) {
      probes += 1;
      return probes > 1 && foundAfter ? ok({ LogicalName: 'contoso_project', EntitySetName: 'contoso_projects' }) : absent("EntityMetadata With Id = LogicalName='contoso_project' does not exist.");
    }
    if (method === 'POST' && asked === '/EntityDefinitions') return tableAnswer;
    return undefined;
  };
};

test('a table create refused in Spanish because the table exists (0x8009050d, 0x8004700b) is followed by the read that finds it, exactly as the English refusal is', async () => {
  // The English text and its code are the platform's own (live-captured, the table's name replaced); 0x8004700b is the documented
  // "An entity with the specified name already exists".
  const english = await build(TABLE, tableRefusedWith(refused('0x8009050d', 'Entities already exist: contoso_Project.')));
  assert.deepStrictEqual(english.unmodelled, []);
  assert.strictEqual(english.error, undefined, english.error && english.error.message);
  assert.deepStrictEqual(english.steps, ['ok table contoso_Project'], 'the table is taken as it is found, and nothing else is made');
  assert.deepStrictEqual(english.requests, [`GET ${PROBE}`, 'POST /EntityDefinitions', `GET ${PROBE}`]);
  assert.deepStrictEqual(english.result.entities, { contoso_Project: { logicalName: 'contoso_project', entitySetName: 'contoso_projects' } });
  for (const tableAnswer of [refused('0x8009050d', 'Ya existen las entidades: contoso_Project.'), refused('0x8004700b', 'Ya existe una entidad con el nombre especificado. Especifique un nombre unico.')]) {
    const run = await build(TABLE, tableRefusedWith(tableAnswer));
    const code = tableAnswer.body.error.code;
    assert.strictEqual(run.error, undefined, `${code}: ${run.error && run.error.message}`);
    assert.deepStrictEqual(outcomeOf(run), outcomeOf(english), `${code}: the same steps, warnings, requests and result as the English answer`);
  }
});

test('a table create refused in Spanish as existing, whose table the next read does not find, stops the build with the create\'s own error, as the English one does', async () => {
  for (const [language, words] of [['English', 'Entities already exist: contoso_Project.'], ['Spanish', 'Ya existen las entidades: contoso_Project.']]) {
    const run = await build(TABLE, tableRefusedWith(refused('0x8009050d', words), { foundAfter: false }));
    assertStopsAt(run, 'table contoso_Project', words, language);
    assert.deepStrictEqual(run.requests, [`GET ${PROBE}`, 'POST /EntityDefinitions', `GET ${PROBE}`], `${language}: the table was looked for again, and only once`);
  }
});

test('a table create refused in another language with a code that does not say the table exists stops the build, as before', async () => {
  for (const [what, tableAnswer] of [
    ['the code of a relationship that exists', refused('0x8004432b', 'Ya existe una relacion con el nombre especificado.')],
    ['the code of a column that exists', refused('0x80047013', 'Ya existe un atributo con el nombre especificado.')],
    ['the generic code', refused(GENERIC, 'Ya existen las entidades: contoso_Project.')],
  ]) {
    const run = await build(TABLE, tableRefusedWith(tableAnswer));
    assertStopsAt(run, 'table contoso_Project', tableAnswer.body.error.message, what);
    assert.deepStrictEqual(run.requests, [`GET ${PROBE}`, 'POST /EntityDefinitions'], `${what}: the table is not looked for again`);
  }
});

// --- a column of a table whose columns could not be read ---------------------------------------------------------------------------
// When the read of an existing table's columns fails, every declared column is taken for new, and the create of one that exists is
// refused: that refusal is the skip that keeps the column from being made twice. A Customer column is made by its own request.
const COLUMNED = { solution: SOLUTION, relationships: [], entities: [project({
  columns: [{ schemaName: 'contoso_Code', type: 'Text' }, { schemaName: 'contoso_Customer', type: 'Customer', displayName: 'Cliente' }],
})] };
const ATTRIBUTES = "/EntityDefinitions(LogicalName='contoso_project')/Attributes";
const columnsRefusedWith = (columnAnswer, customerAnswer) => (method, asked) => {
  if (method === 'GET' && asked === PROBE) return ok({ LogicalName: 'contoso_project', EntitySetName: 'contoso_projects' });
  if (method === 'GET' && asked === COLUMN_LIST) return answer(500, GENERIC, 'An unexpected error occurred.');
  if (method === 'POST' && asked === ATTRIBUTES) return columnAnswer;
  if (method === 'POST' && asked === '/CreateCustomerRelationships') return customerAnswer;
  return undefined;
};

test('columns refused in Spanish because they exist (0x80060304, 0x80047013) are skipped exactly as the English refusals are', async () => {
  const english = await build(COLUMNED, columnsRefusedWith(
    refused('0x80060304', 'Attribute contoso_code already exists for entity contoso_project.'),
    refused('0x80047013', 'An attribute with the specified name contoso_customer already exists.'),
  ));
  assert.deepStrictEqual(english.unmodelled, []);
  assert.strictEqual(english.error, undefined, english.error && english.error.message);
  assert.ok(english.steps.includes('skip column contoso_Project.contoso_Code (Text) (exists)'), english.steps.join(' | '));
  assert.ok(english.steps.includes('skip column contoso_Project.contoso_Customer (Customer) (exists)'), english.steps.join(' | '));
  assert.strictEqual(english.warnings.length, 1, 'the failed read of the columns is said, once');
  const spanish = await build(COLUMNED, columnsRefusedWith(
    refused('0x80060304', 'El atributo contoso_code ya existe para la entidad contoso_project.'),
    refused('0x80047013', 'Ya existe un atributo con el nombre especificado contoso_customer.'),
  ));
  assert.strictEqual(spanish.error, undefined, spanish.error && spanish.error.message);
  assert.deepStrictEqual(outcomeOf(spanish), outcomeOf(english), 'the same steps, warnings, requests and result as the English answers');
});

test('a column refused in another language with a code that does not say the column exists stops the build, as before', async () => {
  const created = ok({});
  for (const [what, columnAnswer] of [
    // A choice whose values repeat is refused with the code of a taken option value: the column was NOT made.
    ['the code of a taken option value', refused('0x80044310', 'Ya existe el valor de la lista desplegable. Los valores deben ser unicos.')],
    ['the code of an alternate key that exists', refused('0x80060893', 'Ya existe una clave de entidad con el nombre contoso_code en la entidad contoso_project.')],
    ['the code of a relationship that exists', refused('0x8004432b', 'Ya existe una relacion con el nombre especificado.')],
    ['the generic code', refused(GENERIC, 'El atributo contoso_code ya existe para la entidad contoso_project.')],
  ]) {
    const run = await build(COLUMNED, columnsRefusedWith(columnAnswer, created));
    assertStopsAt(run, 'column contoso_Project.contoso_Code (Text)', columnAnswer.body.error.message, what);
  }
});

// --- a relationship the probe did not see -----------------------------------------------------------------------------------------
// The probe reads the referenced table's relationships and does not list it (a read that lags), the create answers that the name is
// taken, and the build reads the relationship that holds the name: the declared one is reused, another one stops the build. The lookup
// column is part of what a 1:N create makes, and the build looks for the relationship that owns it when the name is free.
const SCHEMA = 'contoso_project_contoso_task';
const RELATED = { solution: SOLUTION, entities: [], relationships: [{
  type: 'OneToMany', schemaName: SCHEMA, referenced: 'contoso_project', referencing: 'contoso_task', lookup: { schemaName: 'contoso_ProjectId', displayName: 'Proyecto' },
}] };
const HELD = { SchemaName: SCHEMA, ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' };
// `holder` is what the read of the name answers (none: the name is free), `owners` the relationships the referencing table lists.
const relationshipRefusedWith = (relationshipAnswer, { holder = HELD, owners = [] } = {}) => (method, asked) => {
  let m;
  if (method === 'GET' && (m = /^\/EntityDefinitions\(LogicalName='(contoso_project|contoso_task)'\)\/(OneToMany|ManyToOne|ManyToMany)Relationships\?\$select=[\w,]+$/.exec(asked))) {
    return ok({ value: m[1] === 'contoso_task' && m[2] === 'ManyToOne' ? owners : [] });
  }
  if (method === 'GET' && asked === `/RelationshipDefinitions(SchemaName='${SCHEMA}')?$select=SchemaName,RelationshipType`) {
    return holder ? ok({ SchemaName: SCHEMA, RelationshipType: 'OneToManyRelationship' }) : absent(`RelationshipMetadataBase With Id = SchemaName='${SCHEMA}' does not exist.`);
  }
  if (method === 'GET' && holder && asked === `/RelationshipDefinitions(SchemaName='${SCHEMA}')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute`) {
    return ok(holder);
  }
  if (method === 'POST' && asked === '/RelationshipDefinitions') return relationshipAnswer;
  return undefined;
};

test('a relationship create refused in Spanish because the name is taken (0x8004432B) reuses the declared relationship, exactly as the English refusal does', async () => {
  const english = await build(RELATED, relationshipRefusedWith(refused('0x8004432B', 'A relationship with the specified name already exists. Please specify a unique name.')));
  assert.deepStrictEqual(english.unmodelled, []);
  assert.strictEqual(english.error, undefined, english.error && english.error.message);
  assert.deepStrictEqual(english.steps, ['skip relationship 1:N contoso_project->contoso_task (exists)'], 'the relationship that holds the name is the declared one');
  // The platform's reference spells the code with a capital B; an answer may spell it either way.
  for (const code of ['0x8004432B', '0x8004432b']) {
    const run = await build(RELATED, relationshipRefusedWith(refused(code, 'Ya existe una relacion con el nombre especificado. Especifique un nombre unico.')));
    assert.strictEqual(run.error, undefined, `${code}: ${run.error && run.error.message}`);
    assert.deepStrictEqual(outcomeOf(run), outcomeOf(english), `${code}: the same steps, warnings, requests and result as the English answer`);
  }
});

test('a relationship refused in Spanish because the name is taken by ANOTHER relationship stops the build and names it, as the English refusal does: the code is not a proof', async () => {
  const other = { ...HELD, ReferencingAttribute: 'contoso_ownerid' };
  const english = await build(RELATED, relationshipRefusedWith(refused('0x8004432B', 'A relationship with the specified name already exists. Please specify a unique name.'), { holder: other }));
  const spanish = await build(RELATED, relationshipRefusedWith(refused('0x8004432B', 'Ya existe una relacion con el nombre especificado. Especifique un nombre unico.'), { holder: other }));
  for (const [language, run] of [['English', english], ['Spanish', spanish]]) {
    assert.deepStrictEqual(run.unmodelled, [], language);
    assert.ok(run.error instanceof BuildHalt, `${language}: ${run.error && run.error.message}`);
    assert.match(run.error.message, /relationship schema name 'contoso_project_contoso_task' is already used by 1:N contoso_project -> contoso_task \(lookup contoso_ownerid\)/, language);
    assert.deepStrictEqual(run.steps, ['error relationship 1:N contoso_project->contoso_task'], language);
  }
  assert.deepStrictEqual(spanish.requests, english.requests, 'the same reads identify the relationship');
});

test('a relationship refused in Spanish because its lookup column exists (0x80060304) looks for the relationship that owns the column, as the English refusal does', async () => {
  // The name is free; the lookup column belongs to a relationship of another name, which the build names so the spec can reuse it.
  const owners = [{ SchemaName: 'contoso_task_project', ReferencedEntity: 'contoso_project', ReferencingAttribute: 'contoso_projectid' }];
  const english = await build(RELATED, relationshipRefusedWith(refused('0x80060304', 'Attribute contoso_projectid already exists for entity contoso_task.'), { holder: null, owners }));
  const spanish = await build(RELATED, relationshipRefusedWith(refused('0x80060304', 'El atributo contoso_projectid ya existe para la entidad contoso_task.'), { holder: null, owners }));
  for (const [language, run] of [['English', english], ['Spanish', spanish]]) {
    assert.deepStrictEqual(run.unmodelled, [], language);
    assert.ok(run.error instanceof BuildHalt, `${language}: ${run.error && run.error.message}`);
    assert.match(run.error.message, /lookup 'contoso_projectid' on 'contoso_task' already belongs to relationship 'contoso_task_project' .*set relationships\[0\]\.schemaName to 'contoso_task_project' to reuse it/, language);
    assert.deepStrictEqual(run.steps, ['error relationship 1:N contoso_project->contoso_task'], language);
  }
  assert.deepStrictEqual(spanish.requests, english.requests, 'the same reads look for the owner');
});

test('a relationship refused in another language with a code that does not say the relationship or its lookup exists stops the build at once, as before', async () => {
  for (const [what, relationshipAnswer] of [
    // An N:N makes a table for its links; the build does not look for a relationship behind a table that exists.
    ['the code of a table that exists', refused('0x8009050d', 'Ya existen las entidades: contoso_project_contoso_task.')],
    ['the code of an alternate key that exists', refused('0x80060893', 'Ya existe una clave de entidad con el nombre contoso_projectid en la entidad contoso_task.')],
    ['the generic code', refused(GENERIC, 'Ya existe una relacion con el nombre especificado.')],
  ]) {
    const run = await build(RELATED, relationshipRefusedWith(relationshipAnswer));
    assertStopsAt(run, 'relationship 1:N contoso_project->contoso_task', relationshipAnswer.body.error.message, what);
    assert.ok(!run.requests.some((request) => request.startsWith('GET /RelationshipDefinitions(')), `${what}: the holder of the name is not read — ${run.requests.join(' | ')}`);
  }
});

// The codes are compared as the plugin reads them from an answer — lower case (the platform writes them in either case) — so a code
// written in capitals here would never match. Each create that reads an already-exists answer has its own list.
test('each create\'s already-exists codes are written as the plugin reads them: lower-case 0x and eight hex digits, none listed for a create it does not answer', () => {
  assert.deepStrictEqual(Object.keys(ALREADY_EXISTS_CODES).sort(), ['alternateKey', 'column', 'relationship', 'statusReason', 'table']);
  for (const [create, codes] of Object.entries(ALREADY_EXISTS_CODES)) {
    assert.ok(codes.size > 0, create);
    for (const code of codes) assert.match(code, /^0x[0-9a-f]{8}$/, `${create}: ${code}`);
    assert.ok(!codes.has(GENERIC), `${create}: the generic code says nothing about what failed`);
  }
  assert.deepStrictEqual([...ALREADY_EXISTS_CODES.alternateKey], ['0x80060893']);
  assert.deepStrictEqual([...ALREADY_EXISTS_CODES.statusReason], ['0x80044310']);
  assert.deepStrictEqual([...ALREADY_EXISTS_CODES.table].sort(), ['0x8004700b', '0x8009050d']);
  assert.deepStrictEqual([...ALREADY_EXISTS_CODES.column].sort(), ['0x80047013', '0x80060304']);
  assert.deepStrictEqual([...ALREADY_EXISTS_CODES.relationship].sort(), ['0x8004432b', '0x80047013', '0x80060304']);
});
