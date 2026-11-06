'use strict';

function readUtf8Stream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Hook payloads are JSON and can include generated page text. Node's stream decoder buffers an
    // incomplete UTF-8 sequence between `data` events, so a page containing e.g. `東京` or `😀` is not
    // rewritten as U+FFFD when the host splits the pipe in the middle of a multibyte character.
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

module.exports = { readUtf8Stream };
