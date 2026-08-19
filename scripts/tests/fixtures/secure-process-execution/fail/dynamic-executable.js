'use strict';

const { spawnSync } = require('child_process');

spawnSync(process.env.TOOL, ['--version'], { shell: false });
