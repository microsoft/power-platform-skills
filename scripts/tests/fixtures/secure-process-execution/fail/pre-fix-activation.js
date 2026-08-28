'use strict';

const { execSync } = require('child_process');

function validate(checkScript, projectRoot) {
  return execSync(`node "${checkScript}" --projectRoot "${projectRoot}"`, {
    encoding: 'utf8',
    timeout: 30000,
  });
}

module.exports = { validate };
