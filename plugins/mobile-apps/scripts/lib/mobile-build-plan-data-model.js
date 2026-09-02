'use strict';

const { escapeHtml, statusLabel } = require('./mobile-build-plan-html');

function renderErDiagram(tables) {
  if (tables.length === 0) {
    return '<div class="empty"><strong>No entities to map</strong><span>The diagram will appear after the data model is authored.</span></div>';
  }
  const columns = Math.min(3, Math.max(1, tables.length));
  const cardWidth = 300;
  const cardHeight = 184;
  const gapX = 72;
  const gapY = 70;
  const width = columns * cardWidth + (columns - 1) * gapX + 48;
  const rows = Math.ceil(tables.length / columns);
  const height = rows * cardHeight + (rows - 1) * gapY + 48;
  const positions = new Map(tables.map((table, index) => [table.logicalName, {
    x: 24 + (index % columns) * (cardWidth + gapX),
    y: 24 + Math.floor(index / columns) * (cardHeight + gapY),
  }]));
  const relationshipLines = tables.flatMap((owner) => owner.relationships.map((relationship) => {
    const sourceName = relationship.kind === 'many-to-one'
      ? relationship.childTable || owner.logicalName
      : relationship.entity1;
    const targetName = relationship.kind === 'many-to-one'
      ? relationship.parentTable
      : relationship.entity2;
    const source = positions.get(sourceName);
    const target = positions.get(targetName);
    if (!source || !target) return '';
    const startX = source.x + cardWidth / 2;
    const startY = source.y + cardHeight / 2;
    const endX = target.x + cardWidth / 2;
    const endY = target.y + cardHeight / 2;
    return `<g class="er-edge"><line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" marker-end="url(#arrow)"></line><title>${escapeHtml(relationship.schemaName)}</title></g>`;
  })).join('');
  const tableNodes = tables.map((table) => {
    const position = positions.get(table.logicalName);
    const visibleColumns = table.columns.slice(0, 5);
    return `<g class="er-node decision-${escapeHtml(table.decision)}" transform="translate(${position.x} ${position.y})">
      <rect width="${cardWidth}" height="${cardHeight}" rx="6"></rect>
      <rect class="er-node-head" width="${cardWidth}" height="48" rx="6"></rect>
      <text class="er-node-title" x="16" y="23">${escapeHtml(table.displayName)}</text>
      <text class="er-node-name" x="16" y="39">${escapeHtml(table.logicalName)}</text>
      ${visibleColumns.map((column, index) => `<text class="er-column" x="16" y="${70 + index * 20}">${escapeHtml(column.primaryName ? 'PK  ' : column.type === 'lookup' ? 'FK  ' : '    ')}${escapeHtml(column.displayName || column.logicalName)} · ${escapeHtml(statusLabel(column.type))}</text>`).join('')}
      ${table.columns.length > visibleColumns.length ? `<text class="er-more" x="16" y="170">+ ${table.columns.length - visibleColumns.length} more columns</text>` : ''}
    </g>`;
  }).join('');
  const textualRelationships = tables.flatMap((owner) => owner.relationships.map(
    (relationship) => {
      const source = relationship.kind === 'many-to-one'
        ? relationship.childTable || owner.logicalName
        : relationship.entity1;
      const target = relationship.kind === 'many-to-one'
        ? relationship.parentTable
        : relationship.entity2;
      return `<li><strong>${escapeHtml(relationship.displayName || relationship.schemaName)}</strong><span>${escapeHtml(source)} ${relationship.kind === 'many-to-one' ? 'belongs to' : 'relates to'} ${escapeHtml(target)}</span></li>`;
    },
  ));
  return `<div class="er-layout"><div class="er-canvas" id="er-canvas"><div class="er-controls"><button type="button" id="er-zoom-in" title="Zoom in" aria-label="Zoom in">+</button><span id="er-zoom-level">100%</span><button type="button" id="er-zoom-out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" id="er-reset" title="Reset view" aria-label="Reset view">↺</button></div><svg id="er-stage" viewBox="0 0 ${width} ${height}" role="img" aria-label="Entity relationship diagram"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${relationshipLines}${tableNodes}</svg></div><section class="relationship-text" aria-labelledby="relationship-text-title"><h3 id="relationship-text-title">Relationships</h3>${textualRelationships.length ? `<ul>${textualRelationships.join('')}</ul>` : '<p>No relationships are planned.</p>'}</section></div>`;
}

function renderTableCards(model, editDisabled) {
  if (model.tables.length === 0) {
    return '<div class="empty"><strong>Data model not authored yet</strong><span>Tables and fields will appear here as planning progresses.</span></div>';
  }
  return model.tables.map((table) => {
    const scopeTable = table.scopeEvidence?.table;
    const scopeEntity = table.scopeEvidence?.entity;
    const ownership = table.ownershipType === 'OrganizationOwned'
      ? 'Shared by the organization'
      : table.ownershipType === 'UserOwned'
        ? 'Owned by individual users or teams'
        : 'Ownership pending review';
    const why = scopeTable?.lifecycleJustification?.statement
      || scopeEntity?.note
      || table.description
      || 'Purpose evidence is pending Product Scope review.';
    return `
    <details class="table-card" data-table="${escapeHtml(table.logicalName)}">
      <summary><span><strong>${escapeHtml(table.displayName)}</strong><small>${escapeHtml(scopeEntity ? `${statusLabel(scopeEntity.role)} · ${statusLabel(scopeEntity.realization)}` : statusLabel(table.decision))}</small></span><em>${escapeHtml(table.columns.length)} ${table.columns.length === 1 ? 'field' : 'fields'}</em></summary>
      <div class="table-body">
        <section class="table-purpose"><small>Why this table exists</small><p>${escapeHtml(why)}</p>${scopeTable?.jobIds?.length ? `<p><strong>Owning jobs:</strong> ${escapeHtml(scopeTable.jobIds.join(', '))}</p>` : ''}<p><strong>Record ownership:</strong> ${escapeHtml(ownership)}</p></section>
        <div class="column-head simple-columns"><span>Field</span><span>Type</span><span></span></div>
        ${table.columns.map((column) => `<div class="column-row simple-columns"><span><strong>${escapeHtml(column.displayName || column.schemaName || column.logicalName)}</strong>${column.options?.length ? `<small>${escapeHtml(column.options.map((option) => option.label).join(', '))}</small>` : ''}</span><span>${escapeHtml(statusLabel(column.type))}</span><span class="row-actions"><button class="row-action" type="button" data-edit-column="${escapeHtml(column.logicalName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}>Edit</button><button class="row-action danger" type="button" data-remove-column="${escapeHtml(column.logicalName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}>Remove</button></span></div>`).join('')}
        ${table.relationships.length > 0 ? `<div class="relationship-list"><h4>Relationships</h4>${table.relationships.map((relationship) => `<div class="relationship-row"><button type="button" data-edit-relationship="${escapeHtml(relationship.schemaName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}><span>${escapeHtml(relationship.displayName || statusLabel(relationship.kind))}</span><small>${escapeHtml(relationship.kind === 'many-to-one' ? `${relationship.childTable || table.displayName} belongs to ${relationship.parentTable}` : `${relationship.entity1} relates to ${relationship.entity2}`)}</small></button><button class="row-action danger" type="button" data-remove-relationship="${escapeHtml(relationship.schemaName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}>Remove</button></div>`).join('')}</div>` : ''}
        <details class="table-advanced"><summary>Advanced</summary><dl><div><dt>Logical name</dt><dd>${escapeHtml(table.logicalName)}</dd></div><div><dt>Schema name</dt><dd>${escapeHtml(table.schemaName)}</dd></div><div><dt>Plan decision</dt><dd>${escapeHtml(statusLabel(table.decision))}</dd></div><div><dt>Dependency tier</dt><dd>${escapeHtml(table.dependencyTier ?? 0)}</dd></div><div><dt>App data service</dt><dd>${table.serviceRequired ? 'Required' : 'Not required'}</dd></div><div><dt>Dataverse ownership</dt><dd>${escapeHtml(table.ownershipType || 'Pending')}</dd></div></dl><div class="advanced-column-list">${table.columns.map((column) => `<p><strong>${escapeHtml(column.logicalName)}</strong><span>${escapeHtml(statusLabel(column.requiredLevel || 'None'))} · ${escapeHtml(column.plannedDecision || 'unverified')}${column.precision !== undefined ? ` · precision ${escapeHtml(column.precision)}` : ''}</span></p>`).join('')}</div></details>
        <div class="card-actions"><button type="button" data-edit-table="${escapeHtml(table.logicalName)}"${editDisabled}>Edit table</button><button type="button" data-add-column="${escapeHtml(table.logicalName)}"${editDisabled}>Add field</button><button type="button" data-add-relationship="${escapeHtml(table.logicalName)}"${editDisabled}>Add relationship</button><button class="danger" type="button" data-remove-table="${escapeHtml(table.logicalName)}"${editDisabled}>Remove table</button></div>
      </div>
    </details>`;
  }).join('');
}

function renderDataModel(model, options) {
  const { canEdit, editDisabled } = options;
  const tableCards = renderTableCards(model, editDisabled);
  return `<section class="panel" id="panel-data" role="tabpanel" aria-labelledby="tab-data" hidden><div class="section-head"><span><h2>Data model</h2><p>${model.tables.length} planned ${model.tables.length === 1 ? 'table' : 'tables'} · Publisher ${escapeHtml(model.publisherPrefix || 'pending')}</p></span><span class="section-actions">${model.undo.available && canEdit ? `<button class="secondary" type="button" id="undo-edit">Undo ${escapeHtml(model.undo.target)}</button>` : ''}<button class="primary" type="button" data-add-table${editDisabled}>+ Add table</button></span></div>${!canEdit ? `<div class="notice">${model.dataModelEditable ? 'Open the live Build Plan URL to edit the model.' : 'Dataverse execution has started. Continue schema changes through /edit-app.'}</div>` : ''}<div class="view-switch" aria-label="Data model view"><button type="button" class="active" data-data-view="tables">Tables</button><button type="button" data-data-view="diagram">ER diagram</button></div><div class="data-view" id="data-view-tables"><div class="table-list">${tableCards}</div></div><div class="data-view" id="data-view-diagram" hidden>${renderErDiagram(model.tables)}</div></section>`;
}

module.exports = {
  renderDataModel,
};