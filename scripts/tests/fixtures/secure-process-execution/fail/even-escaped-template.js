'use strict';

const { exec } = require('child_process');
const input = process.env.INPUT;

exec(`echo \\${input}`);
