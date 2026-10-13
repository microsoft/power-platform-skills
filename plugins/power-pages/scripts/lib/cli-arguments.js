'use strict';

const path = require('path');

function parseOptionalProjectRootArgs(argv, usage) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--projectRoot') {
      throw new Error(`Unknown or misplaced argument "${arg}".\n${usage}`);
    }
    if (parsed.projectRoot) {
      throw new Error(
        `Argument "${arg}" may be specified only once.\n${usage}`
      );
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() ||
        value.startsWith('--')) {
      throw new Error(`Argument "${arg}" requires a value.\n${usage}`);
    }
    parsed.projectRoot = path.resolve(value);
    index += 1;
  }
  return parsed;
}

module.exports = {
  parseOptionalProjectRootArgs,
};
