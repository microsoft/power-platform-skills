'use strict';

const childProcess = require('child_process');
const method = process.env.METHOD;

childProcess[method]('tool', []);
