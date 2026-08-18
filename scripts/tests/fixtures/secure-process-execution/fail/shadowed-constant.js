'use strict';

const { exec } = require('child_process');
const command = process.env.COMMAND;
exec(command);

{
  const command = 'pac env who';
  void command;
}
