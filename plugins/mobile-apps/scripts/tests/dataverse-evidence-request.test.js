'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseEvidenceRequest,
  resolveEvidenceRequest,
  validateEvidenceResponse,
} = require('../resolve-dataverse-architect-evidence');

function snapshot(detailLevel = 'full') {
  return {
    generatedAt: '2026-08-29T00:00:00.000Z',
    tables: [{
      logicalName: 'systemuser',
      detailLevel,
      columns: [
        { logicalName: 'fullname', type: 'String', maxLength: 200 },
        { logicalName: 'internalemailaddress', type: 'String', maxLength: 100 },
      ],
      manyToOneRelationships: [],
      oneToManyRelationships: [{
        schemaName: 'lk_new_item_createdby',
        childTable: 'new_item',
        childLookupColumn: 'createdby',
        parentColumn: 'systemuserid',
        cascadeConfiguration: { Delete: 'NoCascade' },
      }],
      manyToManyRelationships: [],
      alternateKeys: [{
        logicalName: 'aadobjectid',
        schemaName: 'aadobjectid',
        columns: ['internalemailaddress'],
        status: 'Active',
      }],
    }],
  };
}

test('targeted evidence request returns exact full relationship metadata', () => {
  const request = parseEvidenceRequest(
    'NEEDS_CONTEXT: dataverse-evidence:systemuser:relationships:lk_new_item_createdby',
  );
  const response = resolveEvidenceRequest(snapshot(), request, 'a'.repeat(64));
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].schemaName, 'lk_new_item_createdby');
  assert.deepEqual(response.items[0].cascadeConfiguration, { Delete: 'NoCascade' });
  assert.deepEqual(response.absentNames, []);
});

test('targeted evidence request is bounded and validates names', () => {
  const names = Array.from({ length: 21 }, (_, index) => `column_${index}`).join(',');
  assert.throws(
    () => parseEvidenceRequest(`dataverse-evidence:systemuser:columns:${names}`),
    /1-20 names/,
  );
  assert.throws(
    () => parseEvidenceRequest('dataverse-evidence:systemuser:columns:not-valid!'),
    /logical or schema names/,
  );
});

test('targeted evidence extraction requires full source detail', () => {
  const request = parseEvidenceRequest(
    'dataverse-evidence:systemuser:columns:fullname',
  );
  assert.throws(
    () => resolveEvidenceRequest(snapshot('core'), request, 'a'.repeat(64)),
    /requires full detail/,
  );
});

test('targeted evidence response is snapshot-bound and tamper-evident', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-evidence-response-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotFile = path.join(directory, 'snapshot.json');
  const source = `${JSON.stringify(snapshot(), null, 2)}\n`;
  fs.writeFileSync(snapshotFile, source);
  const request = parseEvidenceRequest('dataverse-evidence:systemuser:keys:aadobjectid');
  const response = resolveEvidenceRequest(
    snapshot(),
    request,
    require('node:crypto').createHash('sha256').update(source).digest('hex'),
  );
  assert.deepEqual(validateEvidenceResponse(response, snapshotFile), {
    valid: true,
    errors: [],
  });
  response.items[0].status = 'Failed';
  assert.equal(validateEvidenceResponse(response, snapshotFile).valid, false);
});
