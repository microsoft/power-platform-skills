'use strict';
// The texts of megabytes that tests/pcf-result-whole-before-exit.test.js has the plugin print, built the same way in the process that prints them and in the test that checks what arrived.
const NOTE = 'The platform answered with a diagnostic that says nothing about credentials.';

// A table of `count` rows, as a listing prints one: 30,000 rows are about 3.5 MB, some fifty times what a pipe takes at once (64 KiB on Linux).
const rows = (count) => Array.from({ length: count }, (_, i) => ({ id: i, name: `row ${i}`, note: NOTE }));
// A text of about the same size, as an error that quotes a service's answer is.
const longText = (count) => Array.from({ length: count }, (_, i) => `line ${i}: ${NOTE}`).join(' ');
// `count` custom controls as lib/pcf-dataverse.js listCustomControls returns them; every other one is managed.
const controls = (count) => Array.from({ length: count }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `contoso_Contoso.Controls.Control${i}`,
  version: '1.0.0',
  isManaged: i % 2 === 1,
  componentState: 0,
}));

module.exports = { rows, longText, controls };
