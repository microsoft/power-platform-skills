'use strict';
// Unique keys for a list whose keys a maker writes freely (a form's name, a command's caption), for the inputs that refuse
// a repeated key for the whole run (lib/push-preview.js, lib/feature-verify.js).
//
// The first item with a key keeps it; a repeat gets the first `#2`, `#3`, … that no item uses — neither one already
// emitted nor one a LATER item carries as its own. Counting repeats alone is not enough: names "Ticket", "Ticket",
// "Ticket#2" would give the second "Ticket" the key "Ticket#2", which the third item also has, and the whole input
// would then be refused. Reserving every original key up front keeps a maker's literal "Ticket#2" its own key, in any
// input order.
function uniqueKeys(items) {
  const originals = new Set(items.map((it) => it.key));
  const used = new Set();
  return items.map((it) => {
    if (!used.has(it.key)) {
      used.add(it.key);
      return it;
    }
    let n = 2;
    let key = `${it.key}#${n}`;
    while (used.has(key) || originals.has(key)) key = `${it.key}#${++n}`;
    used.add(key);
    return { ...it, key };
  });
}

module.exports = { uniqueKeys };
