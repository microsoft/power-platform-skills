'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Read once so every render deterministically inlines the same packaged stylesheet.
const styles = fs.readFileSync(path.join(__dirname, 'mobile-build-plan-styles.css'), 'utf8');

function renderStyles() {
  return `<style>\n${styles}\n</style>`;
}

module.exports = {
  renderStyles,
};