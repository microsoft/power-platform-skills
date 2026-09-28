'use strict';

const { spawn } = require('child_process');

function launch(options) {
  spawn('tool', options);
}

module.exports = { launch };
