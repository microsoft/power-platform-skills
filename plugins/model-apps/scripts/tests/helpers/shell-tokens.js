'use strict';

// How PowerShell and a POSIX shell split a pasted command into arguments, for the quoting a printed `--authorize` hint uses
// (lib/cli-failure.js authorizeFlag): white space splits, a double or single quote groups, and the quotes themselves are not
// part of the argument. No escapes are modelled because no spelling the helper writes uses one.
function shellTokens(text) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur = cur === null ? '' : cur;
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur === null ? '' : cur) + ch;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

module.exports = { shellTokens };
