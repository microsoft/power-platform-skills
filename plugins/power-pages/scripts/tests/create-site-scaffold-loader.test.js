const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createSiteRoot = path.join(__dirname, '..', '..', 'skills', 'create-site', 'assets');
const loaderTemplates = [
  'react/src/pages/Home.tsx',
  'vue/src/pages/Home.vue',
  'angular/src/app/pages/home.component.ts',
  'astro/src/pages/index.astro',
];

test('create-site loader keeps awaiting-input banner persistent and dismissible across templates', () => {
  for (const template of loaderTemplates) {
    const content = fs.readFileSync(path.join(createSiteRoot, template), 'utf8');

    assert.match(content, /id="inputBannerClose"/, template);
    assert.match(content, /input-banner-close/, template);
    assert.match(content, /aria-label="Dismiss notification"/, template);
    assert.match(content, /dismissedPrompt/, template);
    assert.match(content, /addEventListener\('click', dismissInputBanner\)/, template);
    assert.match(content, /if \(banner\) banner\.hidden = !awaiting \|\| dismissedPrompt === prompt/, template);
    assert.match(content, /if \(!awaiting\) dismissedPrompt = null/, template);
    assert.match(content, /if \(!lastAwaiting\)/, template);
  }
});
