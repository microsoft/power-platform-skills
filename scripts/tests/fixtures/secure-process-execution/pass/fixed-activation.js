'use strict';

const { execFileSync } = require('child_process');

function validate(checkScript, projectRoot) {
  return execFileSync(process.execPath, [checkScript, '--projectRoot', projectRoot], {
    encoding: 'utf8',
    timeout: 30000,
    shell: false,
  });
}

module.exports = { validate };
