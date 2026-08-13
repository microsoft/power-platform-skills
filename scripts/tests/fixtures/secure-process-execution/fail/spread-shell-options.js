'use strict';

const { spawn } = require('child_process');
const inherited = { shell: true };

spawn('tool', [], { ...inherited });
