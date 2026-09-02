'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusLabel(value) {
  return String(value || 'pending').replace(/[-_]/g, ' ');
}

module.exports = {
  escapeHtml,
  statusLabel,
};