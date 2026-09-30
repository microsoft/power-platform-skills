'use strict';

function booleanFlagError(flags, names) {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined && value !== true) return `--${name} does not take a value`;
  }
  return null;
}

module.exports = { booleanFlagError };
