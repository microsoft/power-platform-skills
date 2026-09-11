'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ids = {
  site: '11111111-1111-4111-8111-111111111111',
  home: '22222222-2222-4222-8222-222222222222',
  locale: '33333333-3333-4333-8333-333333333333',
  section: '44444444-4444-4444-8444-444444444444',
  sectionLocale: '55555555-5555-4555-8555-555555555555',
  state: '66666666-6666-4666-8666-666666666666',
};

function fixture(t, { major = 3, prefix = 'adx_', nested = false, wrapped = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-style-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const project = path.join(work, 'site');
  const root = wrapped ? path.join(project, '.powerpages-site') : project;
  const put = (relative, content) => {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const yml = (kind, record) => Object.entries(record).map(([key, value]) => {
    const name = key === 'id' ? (prefix ? `${prefix}${kind}id` : 'id') : `${prefix}${key}`;
    return `${name}: ${value}`;
  }).join('\n') + '\n';
  put('website.yml', yml('website', { id: ids.site, name: 'Contoso demo site' }));
  put('web-pages/home/Home.webpage.yml', yml('webpage', { id: ids.home, name: 'Start', partialurl: '/', isroot: true, publishingstateid: ids.state }));
  const pagePath = nested ? 'web-pages/home/content-pages/en-US/Home.webpage.yml' : 'web-pages/home/content-pages/Home.en-US.webpage.yml';
  put(pagePath, yml('webpage', { id: ids.locale, name: 'Start', rootwebpageid: ids.home, partialurl: '/', isroot: false, publishingstateid: ids.state }));
  const copyPath = pagePath.replace(/\.yml$/, '.copy.html');
  const cssPath = pagePath.replace(/\.yml$/, '.custom_css.css');
  put(copyPath, '<div class="row sectionBlockLayout"><div class="container"><section class="pp-card"><h2>Local services</h2><p>Sample content</p><button class="btn btn-primary">Learn more</button></section></div></div>\n');
  put(cssPath, '/* Keep this existing rule. */\n.existing { color: #123456; }\n');
  put('web-pages/contact/Contact.webpage.yml', yml('webpage', { id: ids.section, parentpageid: ids.home, name: 'Contact', partialurl: 'contact', publishingstateid: ids.state }));
  put('web-pages/contact/content-pages/Contact.en-US.webpage.yml', yml('webpage', { id: ids.sectionLocale, rootwebpageid: ids.section, name: 'Contact', partialurl: 'contact', publishingstateid: ids.state }));
  const assets = {};
  for (const [index, [name, order]] of [['bootstrap.min.css', 1], ['theme.css', 2], ['custom.css', 5], ['portalbasictheme.css', 10]].entries()) {
    const folder = nested ? `web-files/${name}` : 'web-files';
    const id = `77777777-7777-4777-8777-77777777777${index}`;
    const assetPath = `${folder}/${name}`;
    put(`${assetPath}.webfile.yml`, yml('webfile', { id, name, partialurl: name, parentpageid: ids.home, publishingstateid: ids.state, displayorder: order }) + `filename: ${name}\nmimetype: text/css\nisdocument: true\n`);
    const content = name === 'bootstrap.min.css'
      ? `/*! Bootstrap v${major === 3 ? '3.3.6' : '5.2.2'} */\n.btn { padding: 6px 12px; }\n`
      : `/* ${name} */\n`;
    put(assetPath, content);
    assets[name] = { id, path: assetPath };
  }
  const request = {
    title: 'Service card decoration',
    pageId: ids.locale,
    components: [{ id: 'service-card', label: 'Service card', kind: 'card', className: 'pp-card', sourcePath: copyPath }],
    styles: [{
      id: 'card-shape', componentId: 'service-card', owner: 'custom', scope: 'page',
      declarations: { 'border-radius': '12px', 'box-shadow': '0 8px 24px #00000026' },
      rationale: 'The custom card has no Studio styling control for this reusable treatment.',
    }],
  };
  return { work, project, root, put, yml, request, pagePath, copyPath, cssPath, assets };
}

module.exports = { fixture, ids };
