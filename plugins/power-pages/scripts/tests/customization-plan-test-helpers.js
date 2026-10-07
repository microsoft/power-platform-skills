const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run the generated document's real script without a browser or remote image
// requests. Browser layout is checked separately; these stubs expose its output
// and let tests drive image load/error events deterministically.
function renderDocument(html, images = []) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], { innerHTML: '', textContent: '' }]));
  for (const match of html.matchAll(/<script id="([^"]+)" type="application\/json">([\s\S]*?)<\/script>/g)) {
    elements.get(match[1]).textContent = match[2];
  }
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === '.asset-preview img' ? images : [],
    createElement: () => ({
      set textContent(value) {
        // textContent escapes markup, not quotes in attribute values. The
        // production renderer must perform attribute escaping itself.
        this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      },
    }),
  };
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInNewContext(script[1], { document, URL });
  }
  return elements;
}

function successfulImageCheck(url) {
  return {
    url, finalUrl: url, statusCode: 200, mimeType: 'image/png',
    sizeBytes: 68, checkedAt: '2026-01-01T00:00:00.000Z',
  };
}

function externalImagePlan(urls = ['https://images.unsplash.com/photo-example?w=800']) {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'customize-declarative-site-plan.json')));
  const asset = plan.assets[0];
  plan.operations = [{
    ...plan.operations[1], dependsOn: [], outputBindings: {},
    inputs: { images: urls },
  }];
  plan.assets = urls.map((url, index) => ({
    ...asset, id: `image-${index}`, name: `Image ${index}`, delivery: 'external-url',
    source: { type: 'user-provided', license: 'User-approved image' },
    externalUrl: url, preparation: { status: 'remote' },
  }));
  for (const image of plan.assets) delete image.webFileOperationId;
  return plan;
}

module.exports = { externalImagePlan, renderDocument, successfulImageCheck };
