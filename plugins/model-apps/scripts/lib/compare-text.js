'use strict';

// The text order for any list a script WRITES and a person, or a diff between two runs, then reads: by UTF-16 code units
// after lower-casing, with the raw text breaking a tie between texts that differ only in case. It is a function of the
// strings alone, so it is the same on every machine and every Node version.
//
// `localeCompare` is not: it follows the host's ICU locale and ICU version (Swedish puts "ä" after "z"; the root locale
// puts "_" before a digit, code units after it), so a list sorted with it can come out differently on another machine.
// `toLowerCase`, unlike `toLocaleLowerCase`, is not locale-sensitive either. A missing value (undefined, null) reads as the
// empty text, so a record without a name sorts first instead of throwing.
function compareText(a, b) {
  const x = a === undefined || a === null ? '' : String(a);
  const y = b === undefined || b === null ? '' : String(b);
  const lx = x.toLowerCase();
  const ly = y.toLowerCase();
  if (lx !== ly) return lx < ly ? -1 : 1;
  return x < y ? -1 : (x > y ? 1 : 0);
}

module.exports = { compareText };
