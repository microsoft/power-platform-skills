'use strict';

const childProcess = require('node:child_process');

childProcess.spawn('tool', [process.argv[2]], { shell: true });
