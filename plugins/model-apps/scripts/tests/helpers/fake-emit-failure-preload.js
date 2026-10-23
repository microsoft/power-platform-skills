'use strict';
// `node --require` for a test of a script's own failure handling: `emitResult`, where every script ends, throws — with a message that names a secret — so that what the script
// prints for a failure of ITS OWN (not a failure of the work it was asked to do) is what the test reads. FAKE_EMIT_SECRET is what the message names.
const auth = require('../../lib/dataverse-auth.js');

auth.emitResult = () => {
  throw new TypeError(`the result could not be written (${process.env.FAKE_EMIT_SECRET})`);
};
