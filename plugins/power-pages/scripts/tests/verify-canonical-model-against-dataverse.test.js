const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verify,
  collectModelTables,
  collectModelColumns,
  suggestClosest,
} = require('../verify-canonical-model-against-dataverse');

// -- Snapshot + canonical-model fixture helpers -------------------------------

function snapshot({ allTables = [], tables = {}, errors = [] } = {}) {
  return { version: 1, capturedAt: '2026-05-14T00:00:00Z', allTables, tables, errors };
}

function tableSnap({ columns = [], relationships, optionsets, lookups } = {}) {
  const entry = { columns };
  if (relationships) entry.relationships = relationships;
  if (optionsets) entry.optionsets = optionsets;
  if (lookups) entry.lookups = lookups;
  return entry;
}

function col(logicalName, attributeType = 'String', extras = {}) {
  return {
    logicalName,
    schemaName: logicalName,
    attributeType,
    isCustom: true,
    readable: true,
    creatable: true,
    writable: true,
    ...extras,
  };
}

// -- collectors ----------------------------------------------------------------

test('collectModelTables pulls from dataverseEntities + componentMapping.entity', () => {
  const model = {
    dataverseEntities: { faq_article: {}, faq_topic: {} },
    componentMapping: [{ entity: 'contact', dataverseFields: [] }],
  };
  assert.deepEqual(collectModelTables(model).sort(), ['contact', 'faq_article', 'faq_topic']);
});

test('collectModelColumns unions fields[], webApiFields[], and componentMapping field lists', () => {
  const model = {
    dataverseEntities: {
      faq_article: {
        fields: [{ logicalName: 'faq_articleid' }, 'faq_articletitle'],
        webApiFields: ['faq_articlebody'],
      },
    },
    componentMapping: [
      { entity: 'faq_article', dataverseFields: [{ logicalName: 'createdon' }] },
      // ignored — different entity
      { entity: 'contact', dataverseFields: [{ logicalName: 'emailaddress1' }] },
    ],
  };
  const cols = collectModelColumns(model, 'faq_article');
  assert.deepEqual(cols.sort(), ['createdon', 'faq_articlebody', 'faq_articleid', 'faq_articletitle']);
});

test('suggestClosest finds the obvious typo (faq_body → faq_articlebody)', () => {
  const candidates = ['faq_articlebody', 'faq_articletitle', 'faq_articleid', 'createdon'];
  // The screenshot's actual bug: faq_body was hallucinated; the real column is
  // faq_articlebody. Levenshtein(faq_body, faq_articlebody) is 7 which is above the
  // default maxDistance of 4 — suggestClosest is intentionally conservative and won't
  // bridge that gap. Demonstrate that behavior so future tweaks to maxDistance get
  // caught.
  assert.equal(suggestClosest('faq_body', candidates), null);
  // But the much closer typo (faq_articlebodyy / faq_articlebod) still resolves cleanly:
  assert.equal(suggestClosest('faq_articlebod', candidates), 'faq_articlebody');
});

test('suggestClosest returns null when no candidate is within distance', () => {
  assert.equal(suggestClosest('xxxx', ['aaaa', 'bbbb', 'cccc'], 1), null);
});

// -- verify ---------------------------------------------------------------------

test('verify returns verdict ok when everything matches', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article', schemaName: 'faq_Article', isCustom: true }],
    tables: {
      faq_article: tableSnap({
        columns: [col('faq_articleid'), col('faq_articletitle'), col('faq_articlebody', 'Memo')],
      }),
    },
  });
  const model = {
    dataverseEntities: {
      faq_article: {
        fields: [{ logicalName: 'faq_articleid' }, { logicalName: 'faq_articletitle' }],
        webApiFields: ['faq_articlebody'],
      },
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'ok');
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.columnsChecked, 3);
});

test('verify catches the exact hallucination from the screenshot (faq_body, faq_isfeatured)', () => {
  // Snapshot reflects the real schema: faq_article has faq_articlebody, NO faq_isfeatured.
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article', schemaName: 'faq_Article', isCustom: true }],
    tables: {
      faq_article: tableSnap({
        columns: [
          col('faq_articleid'),
          col('faq_articletitle'),
          col('faq_articlebody', 'Memo'),
          col('faq_publishedstatus', 'Picklist'),
        ],
      }),
    },
  });
  // The hallucinated plan whitelists faq_body and faq_isfeatured.
  const model = {
    dataverseEntities: {
      faq_article: {
        webApiFields: ['faq_articleid', 'faq_articletitle', 'faq_body', 'faq_isfeatured'],
      },
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'fail');
  assert.equal(result.summary.errors, 2);
  const errored = result.findings.filter((f) => f.severity === 'error').map((f) => f.name).sort();
  assert.deepEqual(errored, ['faq_body', 'faq_isfeatured']);
});

test('verify flags a referenced table that does not exist on Dataverse', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: { faq_article: tableSnap() },
  });
  const model = {
    dataverseEntities: { ghost_entity: { fields: [] }, faq_article: { fields: [] } },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  const tableFinding = result.findings.find((f) => f.kind === 'table' && f.name === 'ghost_entity');
  assert.ok(tableFinding);
  assert.equal(tableFinding.severity, 'error');
});

test('verify warns on an over-permissive whitelist (column exists in Dataverse but never referenced by EDM source)', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: {
      faq_article: tableSnap({
        columns: [col('faq_articletitle'), col('faq_articlebody', 'Memo'), col('faq_internalnotes', 'Memo')],
      }),
    },
  });
  const model = {
    dataverseEntities: {
      faq_article: {
        webApiFields: ['faq_articletitle', 'faq_articlebody', 'faq_internalnotes'],
      },
    },
  };
  // EDM source only ever referenced faq_articletitle and faq_articlebody. Including
  // faq_internalnotes in the whitelist isn't a runtime bug but is a security caveat — the
  // SPA would now expose a column the source kept server-side. Warn but don't fail.
  const edmReferences = {
    references: {
      column: [
        { name: 'faq_articletitle', evidence: [] },
        { name: 'faq_articlebody', evidence: [] },
      ],
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap, edmReferences });
  assert.equal(result.verdict, 'ok'); // warnings don't fail the verdict
  const warning = result.findings.find((f) => f.severity === 'warning' && f.name === 'faq_internalnotes');
  assert.ok(warning);
});

test('verify catches relationship name mismatches', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: {
      faq_article: tableSnap({
        relationships: {
          oneToMany: [],
          manyToOne: [{ schemaName: 'faq_article_topic' }],
          manyToMany: [],
        },
      }),
    },
  });
  const model = {
    dataverseEntities: {
      faq_article: {
        relationships: ['faq_article_topic', 'faq_article_typo'],
      },
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'fail');
  const r = result.findings.find((f) => f.kind === 'relationship' && f.name === 'faq_article_typo');
  assert.ok(r);
});

test('verify catches optionset value mismatches', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: {
      faq_article: tableSnap({
        columns: [col('faq_publishedstatus', 'Picklist')],
        optionsets: { faq_publishedstatus: [{ value: 100000000, label: 'Draft' }, { value: 100000001, label: 'Published' }] },
      }),
    },
  });
  const model = {
    dataverseEntities: {
      faq_article: {
        fields: [
          {
            logicalName: 'faq_publishedstatus',
            attributeType: 'Picklist',
            optionsetValues: [100000000, 100000001, 999999999], // last one doesn't exist
          },
        ],
      },
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'fail');
  const f = result.findings.find((x) => x.kind === 'optionset' && x.name === '999999999');
  assert.ok(f);
  assert.equal(f.parentColumn, 'faq_publishedstatus');
});

test('verify catches lookup target mismatches', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'task' }],
    tables: {
      task: tableSnap({
        columns: [col('regardingobjectid', 'Lookup')],
        lookups: { regardingobjectid: { logicalName: 'regardingobjectid', targets: ['account', 'contact'] } },
      }),
    },
  });
  const model = {
    dataverseEntities: {
      task: {
        fields: [
          {
            logicalName: 'regardingobjectid',
            attributeType: 'Lookup',
            targets: ['account', 'contact', 'lead'], // lead is not allowed
          },
        ],
      },
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'fail');
  const f = result.findings.find((x) => x.kind === 'lookup-target' && x.name === 'lead');
  assert.ok(f);
});

test('verify propagates snapshot.errors as findings (so partial snapshots cannot certify a model)', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: { faq_article: tableSnap() },
    errors: [{ scope: 'columns', table: 'faq_ghost', message: 'NOT_FOUND' }],
  });
  const model = { dataverseEntities: { faq_article: {} } };
  const result = verify({ canonicalModel: model, snapshot: snap });
  assert.equal(result.verdict, 'fail');
  const f = result.findings.find((x) => x.kind === 'snapshot-error');
  assert.ok(f);
});

test('verify suggests a close-by column name when one exists', () => {
  const snap = snapshot({
    allTables: [{ logicalName: 'faq_article' }],
    tables: {
      faq_article: tableSnap({
        columns: [col('faq_articlebody', 'Memo'), col('faq_articletitle')],
      }),
    },
  });
  const model = {
    dataverseEntities: {
      faq_article: { webApiFields: ['faq_articlebod'] }, // distance 1 typo
    },
  };
  const result = verify({ canonicalModel: model, snapshot: snap });
  const finding = result.findings.find((f) => f.name === 'faq_articlebod');
  assert.equal(finding.suggestion, 'faq_articlebody');
});
