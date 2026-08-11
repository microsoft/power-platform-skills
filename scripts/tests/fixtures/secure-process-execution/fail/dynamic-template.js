'use strict';

const { execSync: run } = require('node:child_process');

run(`pac pages upload --path ${process.env.SITE_PATH}`);
