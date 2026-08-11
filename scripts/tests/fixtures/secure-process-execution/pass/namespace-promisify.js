'use strict';

const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(childProcess.execFile);
const options = { encoding: 'utf8', shell: false };

run('pac', ['env', 'who'], options);
childProcess.spawnSync(process.execPath, ['script.js', process.env.INPUT], options);
