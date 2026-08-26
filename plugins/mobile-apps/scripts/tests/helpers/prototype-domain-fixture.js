'use strict';

function prototypeDomainFixture() {
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    experienceContractSha256: 'a'.repeat(64),
    contextEnrichmentSha256: 'b'.repeat(64),
    entities: [{
      key: 'WorkItem', displayName: 'Work item', displayPluralName: 'Work items',
      description: 'A realistic item requiring a product decision.', primaryNameField: 'name', estimatedPrototypeRows: 2,
      fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Item name', type: 'text', required: true, maximumLength: 120 },
        { key: 'status', displayName: 'Current status', type: 'choice', required: true, choiceKey: 'WorkStatus' },
        { key: 'priority', displayName: 'Priority', type: 'whole-number', required: true, minimum: 1, maximum: 5 },
        { key: 'notes', displayName: 'Decision context', type: 'multiline-text', required: false, maximumLength: 500 },
      ],
    }],
    relationships: [],
    choices: [{ key: 'WorkStatus', options: [{ key: 'ready', label: 'Ready for review' }, { key: 'blocked', label: 'Blocked by required evidence' }] }],
    operations: [{
      key: 'listWorkItems', entity: 'WorkItem', kind: 'list', repository: 'WorkRepository', method: 'listWorkItems', hook: 'useWorkItems',
      selectFields: ['id', 'name', 'status', 'priority', 'notes'], filterFields: ['status'], sortFields: ['priority'],
      pagination: { mode: 'bounded', boundedReason: 'Two representative prototype records.', maximumExpectedCount: 2 },
    }],
    actors: [{ key: 'Operator', displayName: 'Operator' }],
    uxPermissions: [{ actor: 'Operator', operation: 'listWorkItems', allowed: true }],
    offlineUxIntent: { connectivity: 'network-optional', requiredOperations: [] },
    fixtureRequirements: [
      { key: 'work-populated', state: 'populated', description: 'Representative work records.', entity: 'WorkItem', minimumRecords: 2 },
      { key: 'work-loading', state: 'loading', description: 'Work records are loading.' },
      { key: 'work-empty', state: 'empty', description: 'No work records match.' },
      { key: 'work-error', state: 'error', description: 'Work records failed to load.' },
      { key: 'work-offline', state: 'offline', description: 'Work records are unavailable offline.' },
    ],
    mediaPolicy: { mode: 'not-applicable', requiredFields: [], requiresFallback: false },
    fixtures: {
      WorkItem: [
        { id: 'work-ready', name: 'North facility readiness review', status: 'ready', priority: 2, notes: 'Confirm ownership and the next safe action before the morning shift begins.' },
        { id: 'work-blocked', name: 'Evidence-dependent maintenance decision', status: 'blocked', priority: 1, notes: 'Photographic evidence and supervisor confirmation are required before this record can proceed.' },
      ],
    },
    fixtureScenarios: [
      { key: 'work-populated', state: 'populated', description: 'Representative work records.', entity: 'WorkItem', recordIds: ['work-ready', 'work-blocked'] },
      { key: 'work-loading', state: 'loading', description: 'Work records are loading.' },
      { key: 'work-empty', state: 'empty', description: 'No work records match.' },
      { key: 'work-error', state: 'error', description: 'Work records failed to load.' },
      { key: 'work-offline', state: 'offline', description: 'Work records are unavailable offline.' },
    ],
  };
}

module.exports = { prototypeDomainFixture };
