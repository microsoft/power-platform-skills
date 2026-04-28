const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const createSiteRoot = path.join(__dirname, '..', '..', 'skills', 'create-site', 'assets');
const loaderTemplates = [
  'react/src/pages/Home.tsx',
  'vue/src/pages/Home.vue',
  'angular/src/app/pages/home.component.ts',
  'astro/src/pages/index.astro',
];

test('create-site loader keeps awaiting-input banner persistent across templates', () => {
  for (const template of loaderTemplates) {
    const content = fs.readFileSync(path.join(createSiteRoot, template), 'utf8');

    assert.match(content, /if \(banner\) banner\.hidden = !awaiting/, template);
    assert.match(content, /if \(!lastAwaiting\)/, template);
    assert.doesNotMatch(content, /inputBannerClose|input-banner-close|userDismissed|dismissedPrompt/, template);
  }
});
