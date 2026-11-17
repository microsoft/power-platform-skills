'use strict';

// The one boolean-switch check every pcf CLI shares. parseArgs reads `--flag=value` and `--flag value`
// on any flag, so a switch given a value would otherwise read as true (`--apply=false` would apply).
// Switches are bare only: any string value, including an empty one, is a usage error. `names` is
// checked in its declared order, so the first refused switch in that list is the one reported.
function booleanFlagError(flags, names) {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined && value !== true) return `--${name} does not take a value`;
  }
  return null;
}

module.exports = { booleanFlagError };
