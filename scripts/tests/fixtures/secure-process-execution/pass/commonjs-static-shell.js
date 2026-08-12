'use strict';

const { execSync: run } = require('child_process');

run(
  'pac env who',
  {
    encoding: 'utf8',
  }
);
