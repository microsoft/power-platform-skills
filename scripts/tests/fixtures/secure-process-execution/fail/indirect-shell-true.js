'use strict';

const { execFile } = require('child_process');
const options = {
  encoding: 'utf8',
  shell: true,
};

execFile('tool', [process.env.INPUT], options);
