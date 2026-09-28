'use strict';

const { spawn } = require('child_process');

function launch(options) {
  spawn('tool', [process.env.INPUT], options);
}

module.exports = { launch };
