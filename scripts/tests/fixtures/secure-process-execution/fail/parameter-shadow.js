'use strict';

const { exec } = require('child_process');
const command = 'pac env who';

function run(command) {
  exec(command);
}

module.exports = { run };
