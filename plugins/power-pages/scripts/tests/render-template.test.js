const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderTemplate } = require('../lib/render-template');

test('renderTemplate encodes each placeholder for its declared output context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-template-'));
  const templatePath = path.join(tempDir, 'template.html');
  const outputPath = path.join(tempDir, 'output.html');
  const attack = '<img src=x onerror="alert(1)"> </script><script>alert(2)</script> ` ${alert(3)} \'';

  fs.writeFileSync(templatePath, [
    '<title>__TEXT__</title>',
    '<div data-value="__ATTR_ATTRIBUTE__"></div>',
    '<script nonce="__ATTR_CSP_NONCE__">',
    'const value = __JSON_SCRIPT_VALUE__;',
    'const data = __JSON_STRUCTURED__;',
    '</script>',
    '<div>__RAW_TRUSTED_HTML__</div>',
  ].join('\n'));

  renderTemplate({
    templatePath,
    outputPath,
    dataObject: {
      TEXT: attack,
      ATTRIBUTE: attack,
      SCRIPT_VALUE: attack,
      STRUCTURED: { nested: attack },
      TRUSTED_HTML: '<strong>Code-owned markup</strong>',
    },
    requiredKeys: ['TEXT', 'ATTRIBUTE', 'SCRIPT_VALUE', 'STRUCTURED', 'TRUSTED_HTML'],
  });

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<title>&lt;img src=x onerror="alert\(1\)"&gt;/);
  assert.match(html, /data-value="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;[^"]*&#96;[^"]*&#39;"/);
  assert.doesNotMatch(html, /<\/script><script>alert\(2\)<\/script>/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(2\)\\u003c\/script\\u003e/);
  assert.match(html, /<strong>Code-owned markup<\/strong>/);

  const valueLiteral = html.match(/const value = (".*");/)[1];
  assert.equal(JSON.parse(valueLiteral), attack);

  const nonce = html.match(/<script nonce="([^"]+)">/)[1];
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
});
