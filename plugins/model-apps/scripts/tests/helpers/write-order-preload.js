'use strict';
// Loaded with `node --require` — after helpers/queued-stdio-preload.js when a test uses both — by the tests that hold a printer to the ORDER of its
// last writes. It records each time this process makes its stdout or stderr blocking (`setBlocking(true)` on the stream's handle: what
// lib/output-redaction.js makeWritesBlocking calls) and each write to either, and when the process exits it writes the record to the file that
// WRITE_ORDER_FILE names, for example `{"code":1,"events":["blocking stdout","blocking stderr","write stderr"]}`.
//
// Why an order: it does not depend on the platform, the runtime or how far a reader reads ahead, so a printer that writes before it makes its stream
// blocking fails such a test on every run. A test of the text that arrives can pass by luck: a reader that pauses its stream still lets the runtime
// read ahead below it, and on Windows a printer that did not make its writes blocking delivered a megabyte whole to a held reader under Node 20 (and
// 65,536 characters of it under Node 22). Nothing else about the streams changes: their own `write` and `setBlocking` are called with what they
// were given, and what they answer is answered.
const fs = require('node:fs');

const file = process.env.WRITE_ORDER_FILE;
if (file) {
  const events = [];
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name];
    const handle = stream && stream._handle;
    if (handle && typeof handle.setBlocking === 'function') {
      const setBlocking = handle.setBlocking;
      handle.setBlocking = function setBlockingRecorded(flag, ...rest) {
        if (flag === true) events.push(`blocking ${name}`);
        return setBlocking.call(this, flag, ...rest);
      };
    }
    const write = stream.write;
    stream.write = function writeRecorded(...args) {
      events.push(`write ${name}`);
      return write.apply(this, args);
    };
  }
  // Added before anything the script adds, so it runs first: a write made by a later 'exit' listener is not the printer's, and is not recorded.
  process.on('exit', (code) => fs.writeFileSync(file, JSON.stringify({ code, events })));
}
