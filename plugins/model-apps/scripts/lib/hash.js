'use strict';
// Canonical content hash shared by the projection/verifier framework (projection.js) and the
// content-aware phase diff (content-hash.js). One definition so a page's `sourceSha` in the apply
// snapshot, the diff's content hash, and the post-apply verifier all agree byte-for-byte — a drift
// between two copies of "how we hash a page" would let a changed artifact read as unchanged.
//
// PURE + I/O-free. Accepts a string or a Buffer; strings are hashed as UTF-8 so the same text hashes
// identically whether the caller already read it as a Buffer (fs.readFileSync with no encoding) or as a
// string (encoding 'utf8').

const crypto = require('node:crypto');

function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = { sha256 };
