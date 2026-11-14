'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '../../skills/setup-auth');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const entry = read('SKILL.md');
const body = entry.split(/^---\r?$/m).slice(2).join('---');
const templateRuntime = {
  skip: typeof stripTypeScriptTypes !== 'function' && 'Template execution requires Node 22.13+; the workflow runs it in a separate Node 22 step.',
};

function typescriptBlocks(text) {
  // Windows checkouts can use CRLF: normalize before matching Markdown fences
  // so executable template coverage cannot silently lose all exported functions.
  text = text.replace(/\r\n/g, '\n');
  return [...text.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

test('executable Markdown templates are extracted identically with LF and CRLF', () => {
  for (const file of ['references/framework-react.md', 'references/external-confirmation.md']) {
    const lf = read(file).replace(/\r\n/g, '\n');
    const expected = typescriptBlocks(lf);
    assert.ok(expected.length > 0, file);
    assert.deepEqual(typescriptBlocks(lf.replace(/\n/g, '\r\n')), expected, file);
  }
});

test('setup-auth has portable metadata and bounded activation context', () => {
  const metadata = entry.split(/^---\r?$/m)[1];
  assert.deepEqual([...metadata.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]), ['name', 'description']);
  assert.match(metadata, /^name: setup-auth$/m);
  const description = metadata.split('description: >-')[1].trim().replace(/\s+/g, ' ');
  assert.ok(description.length <= 400);
  assert.ok(entry.split(/\r?\n/).length < 500);
  // This is a stable character-count budget, not a tokenizer measurement.
  assert.ok(body.length / 4 < 5000);
  assert.equal((body.match(/^## Phase [1-8]:/gm) || []).length, 8);
});

test('every instruction resource is directly reachable from the installed skill', () => {
  const links = [...entry.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  const plugin = path.resolve(root, '../..');
  for (const link of links) {
    const resolved = path.resolve(root, link);
    assert.ok(resolved.startsWith(plugin + path.sep), link);
    assert.ok(fs.statSync(resolved).isFile(), link);
  }
  for (const folder of ['references', 'assets']) {
    for (const file of fs.readdirSync(path.join(root, folder))) {
      if (file === 'auth-report.html') continue; // Runtime renderer owns this template.
      assert.ok(links.includes(`${folder}/${file}`), `unreachable resource: ${file}`);
    }
  }
});

test('instruction resources contain no host tool identifiers or dangling fences', () => {
  const files = ['SKILL.md', ...fs.readdirSync(path.join(root, 'references')).map((f) => `references/${f}`)];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /\b(?:AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TodoWrite|WebFetch|WebSearch)\b|mcp__|\$ARGUMENTS/);
    assert.doesNotMatch(text, /`(?:Read|Write|Edit|Glob|Grep|Bash|Skill|Task)`/);
    assert.doesNotMatch(text, /references\/references\/|\.cs:\d|idp-provisioning-reference\.md/);
    assert.equal((text.match(/^```/gm) || []).length % 2, 0, file);
  }
});

test('provider discovery and merge modes remain mandatory', () => {
  const discovery = read('references/discovery-workflow.md');
  assert.match(entry, /Follow discovery even if no SPA auth files exist/);
  for (const mode of ['keep-only', 'keep-and-add', 'replace-all']) assert.ok(entry.includes(mode));
  assert.match(discovery, /Authentication-OpenIdConnect/);
  assert.match(discovery, /custom|existingCaption/);
  assert.match(read('references/provider-entra-external-id.md'), /confirmed `REDIRECT_URI`/);
});

test('local and optional branches retain server contracts without forcing local auth', () => {
  const local = read('references/local-auth-workflow.md');
  assert.match(entry, /local accounts only when explicitly requested or already configured and retained/);
  assert.match(local, /Invitation-only \| `true` \| `false` \| `true`/);
  assert.match(local, /Both \| `true` \| `true` \| `true`/);
  assert.match(local, /Registration disabled \| `false`/);
  assert.match(local, /RequireInvitationCode.*NOT a real server setting/);
  const terms = read('references/terms-workflow.md');
  for (const marker of ['installed: true', 'installed: false', 'infrastructure failure', 'Cancel']) {
    assert.ok(terms.includes(marker));
  }
  assert.match(terms, /UseExternalSignInAsync/);
  assert.match(read('references/external-confirmation.md'), /opaqueredirect/);
  assert.match(read('references/invitations.md'), /fetchInvitationDetails/);
  assert.match(read('references/session-settings.md'), /SESSION_EXPIRE_MS \/ 3/);
  assert.match(read('references/session-settings.md'), /SESSION_EXPIRE_MS \* 0\.9/);
});

test('profile, secret and explicit completion-validation contracts remain discoverable', () => {
  const profile = read('references/user-profile.md');
  assert.match(profile, /contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country/);
  assert.match(profile, /756150004/);
  assert.match(profile, /applyContactUpdateLocally/);
  assert.match(entry, /applyContactUpdateLocally` before a refresh emitting a fresh user object/);
  assert.match(entry, /validate-auth\.js.*explicitly.*after the report exists/);
  const secrets = read('references/secrets-workflow.md');
  assert.match(secrets, /--type "secret"/);
  assert.match(secrets, /--solutionUniqueName/);
  assert.doesNotMatch(secrets, /PLACEHOLDER_SET_ACTUAL_VALUE|plain string type, not secret/);
  assert.doesNotThrow(() => JSON.parse(read('assets/auth-report-data.example.json')));
});

test('conditional examples agree with registration, callback and secret contracts', () => {
  assert.match(read('references/site-settings.md'), /derive `REGISTRATION_MODE`/);
  assert.match(read('references/external-confirmation.md'), /When terms are disabled, omit/);
  assert.match(read('references/discovery-workflow.md'), /MicrosoftAccount/);
  assert.match(read('references/local-auth-workflow.md'), /Skip the page and RegisterForm entirely/);
  assert.doesNotMatch(read('assets/local-auth-react-localloginform-component-local-auth-only.tsx.template'), /href="\/Account\/Login\/ForgotPassword"/);
  assert.match(read('references/provider-oidc.md'), /<approved-redirect-uri>/);
  assert.doesNotMatch(read('references/provider-entra-external-id.md'), /Public clients using PKCE|doesn't ask about custom domains/);
  assert.match(read('references/session-settings.md'), /astro:before-swap/);
  assert.doesNotMatch(read('references/invitations.md'), /provider\.providerIdentifier!/);
  const profilePage = read('assets/user-profile-react-userprofile-page.tsx.template');
  assert.match(profilePage, /My Profile \\u2014 <SITE_NAME>/);
  assert.match(profilePage, /accountFullName = \[user\?\.firstName, user\?\.lastName\]/);
  assert.match(read('references/framework-vue.md'), /removeEventListener\('powerpages:auth-user-changed'/);
});

test('React auth refresh reaches separate profile and header hook consumers', templateRuntime, () => {
  let source = typescriptBlocks(read('references/framework-react.md'))[0];
  source = source.replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '');
  const updates = new Map();
  const cleanups = [];
  let slot = 0;
  let user = { userName: 'maker', firstName: 'Before' };
  const context = {
    window: new EventTarget(), Event,
    useState: (initial) => {
      const key = slot++;
      const value = typeof initial === 'function' ? initial() : initial;
      updates.set(key, value);
      return [value, (value) => updates.set(key, value)];
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => cleanups.push(effect()),
    getCurrentUser: () => user,
    checkAuth: () => true,
    getUserDisplayName: () => user.firstName,
    getUserInitials: () => 'M',
    getAuthProvider: () => ({ type: 'oidc' }),
    authLogin: () => {}, authLogout: () => {},
  };
  vm.runInNewContext(stripTypeScriptTypes(source).replace(/^export /gm, '') + '\nglobalThis.hook = useAuth;', context);
  const profile = context.hook();
  assert.equal(profile.user.firstName, 'Before');
  assert.equal(profile.isLoading, false);
  context.hook();
  user.firstName = 'After';
  profile.refresh();
  assert.equal(updates.get(0).firstName, 'After');
  assert.equal(updates.get(2).firstName, 'After');
  assert.notEqual(updates.get(0), updates.get(2));
  assert.notEqual(updates.get(0), user);
  cleanups.forEach((cleanup) => cleanup());
});

test('report distinguishes an unknown terms prerequisite from a missing solution', () => {
  const helper = read('assets/auth-report.html').match(/function termsEnforcementNote\(features\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'report needs an explicit prerequisite-status formatter');
  const context = {};
  vm.runInNewContext(helper[0] + '\nglobalThis.note = termsEnforcementNote;', context);
  assert.match(context.note({ termsAndConditions: true, termsEnforced: false, termsPrerequisiteStatus: 'unverified' }), /unverified/i);
  assert.match(context.note({ termsAndConditions: true, termsEnforced: true, termsPrerequisiteStatus: 'unverified' }), /unverified/i);
  assert.match(context.note({ termsAndConditions: true, termsEnforced: false, termsPrerequisiteStatus: 'missing' }), /missing/i);
  assert.match(context.note({ termsAndConditions: true, termsEnforced: true, termsPrerequisiteStatus: 'detected' }), /solution detected/i);
});

function service({ local = false, profile = false, terms = false, external = false, fetch, user, DOMParser, document } = {}) {
  let source = read('assets/auth-service.ts.template');
  if (local) {
    source = source.replace(
      'export const AUTH_PROVIDERS: AuthProviderConfig[] = [',
      `export const AUTH_PROVIDERS: AuthProviderConfig[] = [
       { id: 'local', type: 'local', displayName: 'Email', loginByEmail: true },`
    );
    source = source.replace(
      "throw new Error('Add loginLocal from the local service template before enabling local authentication.');",
      `if (!options.credentials) throw new Error('Local login requires credentials.');
       return loginLocal(options.credentials.credential, options.credentials.password,
         options.credentials.rememberMe, options.returnUrl, options.invitationCode);`
    );
    source += '\n' + read('assets/local-auth-service.ts.template');
  }
  if (profile) source += '\n' + read('assets/user-profile-auth-service-additions.ts.template');
  if (terms) {
    const termsClass = typescriptBlocks(read('references/terms-workflow.md'))
      .find((block) => block.includes('export class TermsRequiredError'));
    assert.ok(termsClass, 'terms workflow must define TermsRequiredError');
    source += '\n' + termsClass + '\n' + read('assets/terms-auth-service-termsrequirederror-and-acceptterms.ts.template');
  }
  if (external) {
    const blocks = typescriptBlocks(read('references/external-confirmation.md'));
    source += '\n' + blocks.slice(0, 3).join('\n');
  }
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]);
  // Node's built-in type stripping parses the real template, without adding a
  // compiler dependency. Runtime assertions below do not claim a framework build.
  const js = stripTypeScriptTypes(source).replace(/^export /gm, '');
  const context = {
    URL, URLSearchParams, fetch, DOMParser, document,
    window: {
      location: { hostname: 'site.example.com', origin: 'https://site.example.com', pathname: '/', search: '', href: '/' },
      Microsoft: { Dynamic365: { Portal: { tenant: 'tenant-placeholder', User: user } } },
    },
  };
  vm.runInNewContext(`${js}\nglobalThis.api = {${names.join(',')}};`, context);
  return { ...context.api, window: context.window };
}

test('core template resolves workforce tenant at runtime and preserves external identifiers', templateRuntime, () => {
  const api = service();
  assert.equal(api.resolveProviderIdentifier({ id: 'work', type: 'entra-id' }), 'https://login.windows.net/tenant-placeholder/');
  assert.equal(api.resolveProviderIdentifier({ id: 'customer', type: 'oidc', providerIdentifier: 'https://login.contoso.com/customer' }), 'https://login.contoso.com/customer');
  assert.throws(() => api.resolveProviderIdentifier({ id: 'missing', type: 'oidc' }), /missing providerIdentifier/);
  assert.equal(api.getSessionExpiredMessage(), undefined);
  assert.equal(typeof api.login, 'function');
});

test('external login posts exact provider, CSRF, return URL and invitation', templateRuntime, async () => {
  const nodes = [];
  let submitted = false;
  const form = { appendChild: (node) => nodes.push(node), submit: () => { submitted = true; } };
  const api = service({
    fetch: async () => ({ ok: true, text: async () => '<input value="csrf-test">' }),
    document: { createElement: (tag) => tag === 'form' ? form : {}, body: { appendChild: () => {} } },
  });
  await api.loginExternal('https://issuer.example.com/', '/orders', 'invite + 1');
  assert.equal(form.action, '/Account/Login/ExternalLogin?InvitationCode=invite%20%2B%201');
  assert.equal(Object.fromEntries(nodes.map((n) => [n.name, n.value])).provider, 'https://issuer.example.com/');
  assert.equal(Object.fromEntries(nodes.map((n) => [n.name, n.value])).__RequestVerificationToken, 'csrf-test');
  assert.equal(submitted, true);
});

test('local login sends PasswordValue and selected credential field without a full-page form', templateRuntime, async () => {
  const calls = [];
  const api = service({
    local: true,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return options
        ? { ok: true, redirected: true, url: 'https://site.example.com/orders' }
        : { ok: true, text: async () => '<input value="csrf-test">' };
    },
  });
  await api.loginWithProvider(api.LOCAL_PROVIDER, {
    returnUrl: '/orders', invitationCode: 'invite-1', credentials: { credential: 'maker@contoso.com', password: 'test-only' },
  });
  const request = calls[1];
  assert.equal(request.url, '/SignIn?InvitationCode=invite-1');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('Email'), 'maker@contoso.com');
  assert.equal(body.get('PasswordValue'), 'test-only');
  assert.equal(body.has('Password'), false);
  assert.equal(body.get('InvitationCode'), 'invite-1');
  assert.equal(api.window.location.href, '/orders');
});

test('profile template patches only defined fields and refreshes the header snapshot', templateRuntime, async () => {
  const calls = [];
  const api = service({
    profile: true,
    user: { firstName: 'Old', lastName: 'Name', userName: 'opaque-id', email: 'maker@contoso.com' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => '<input value="csrf-test">' };
    },
  });
  await api.updateMyProfile('contact-placeholder', { firstname: 'New', lastname: null, mobilephone: undefined });
  assert.deepEqual(JSON.parse(calls[1].options.body), { firstname: 'New', lastname: null });
  assert.equal(calls[1].options.headers['If-Match'], '*');
  api.applyContactUpdateLocally({ firstname: 'New', lastname: null });
  assert.equal(api.getUserDisplayName(), 'New');
});

test('profile reads send the Power Pages verification token', templateRuntime, async () => {
  const calls = [];
  const api = service({
    profile: true,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return url === '/_layout/tokenhtml'
        ? { ok: true, text: async () => '<input value="csrf-test">' }
        : { ok: true, json: async () => ({ firstname: 'Maker' }) };
    },
  });
  const profile = await api.getMyProfile('contact-placeholder');
  assert.equal(profile.firstname, 'Maker');
  assert.equal(calls[0].url, '/_layout/tokenhtml');
  assert.equal(calls[1].options.headers.__RequestVerificationToken, 'csrf-test');
});

test('profile update preserves the server error message rather than catching its own throw', templateRuntime, async () => {
  const api = service({
    profile: true,
    fetch: async (_url, options) => options
      ? { ok: false, status: 403, json: async () => ({ error: { message: 'Contact write denied' } }) }
      : { ok: true, text: async () => '<input value="csrf-test">' },
  });
  await assert.rejects(api.updateMyProfile('contact-placeholder', { firstname: 'New' }), /Contact write denied/);
});

test('terms acceptance keeps external sign-in flags and surfaces a 200 validation error', templateRuntime, async () => {
  const calls = [];
  class Parser {
    parseFromString(html) {
      return {
        querySelector: () => ({ value: 'csrf-test' }),
        querySelectorAll: (selector) => html === 'rejected' && selector === '.validation-summary-errors li'
          ? [{ textContent: 'Terms acceptance rejected' }]
          : [],
      };
    }
  }
  const api = service({
    terms: true,
    DOMParser: Parser,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, redirected: false, url: 'https://site.example.com/Account/Login/TermsAndConditions',
        text: async () => options.method === 'POST' ? 'rejected' : 'form',
      };
    },
  });
  api.window.location.search = '?UseExternalSignInAsync=True&IsFacebook=True&ReturnUrl=%2Forders';
  await assert.rejects(api.acceptTerms(), /Terms acceptance rejected/);
  const posted = new URLSearchParams(calls[1].options.body);
  assert.equal(posted.get('UseExternalSignInAsync'), 'True');
  assert.equal(posted.get('IsFacebook'), 'True');
  assert.ok(calls[0].url.includes('UseExternalSignInAsync=True'));
});

test('terms acceptance rejects a non-OK response even when fetch followed a redirect', templateRuntime, async () => {
  class Parser {
    parseFromString() { return { querySelector: () => ({ value: 'csrf-test' }), querySelectorAll: () => [] }; }
  }
  const api = service({
    terms: true,
    DOMParser: Parser,
    fetch: async (_url, options) => options
      ? options.method === 'POST'
        ? { ok: false, status: 403, redirected: true, text: async () => 'forbidden' }
        : { ok: true, url: 'https://site.example.com/Account/Login/TermsAndConditions', text: async () => 'form' }
      : { ok: true, url: 'https://site.example.com/Account/Login/TermsAndConditions', text: async () => 'form' },
  });
  api.window.location.search = '?UseExternalSignInAsync=True&ReturnUrl=%2Forders';
  await assert.rejects(api.acceptTerms(), /403/);
  assert.equal(api.window.location.href, '/');
});

test('registration parses the server action, ViewState and full Web Forms control names', templateRuntime, async () => {
  const calls = [];
  const controls = {
    Register: { getAttribute: () => './Register?returnUrl=%2Forders' },
    __VIEWSTATE: { value: 'viewstate-test' },
    __VIEWSTATEGENERATOR: { value: 'generator-test' },
    EmailTextBox: { name: 'ctl00$ContentContainer$EmailTextBox' },
    UsernameTextBox: { name: 'ctl00$ContentContainer$UsernameTextBox' },
    PasswordTextBox: { name: 'ctl00$ContentContainer$PasswordTextBox' },
    ConfirmPasswordTextBox: { name: 'ctl00$ContentContainer$ConfirmPasswordTextBox' },
    SubmitButton: { name: 'ctl00$ContentContainer$SubmitButton', value: 'Register' },
  };
  class Parser {
    parseFromString() {
      return {
        getElementById: (id) => controls[id],
        querySelector: () => ({ value: 'hidden-test' }),
      };
    }
  }
  const api = service({
    local: true, DOMParser: Parser,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, redirected: options?.method === 'POST', url: '/orders', text: async () => 'form' };
    },
  });
  await api.register({ email: 'maker@contoso.com', username: 'maker', password: 'test-only', confirmPassword: 'test-only' }, '/orders', 'invite-1');
  assert.equal(calls[1].url, '/Account/Login/Register?returnUrl=%2Forders');
  const posted = new URLSearchParams(calls[1].options.body);
  assert.equal(posted.get('__VIEWSTATE'), 'viewstate-test');
  assert.equal(posted.get('ctl00$ContentContainer$EmailTextBox'), 'maker@contoso.com');
  assert.equal(posted.get('ctl00$ContentContainer$PasswordTextBox'), 'test-only');
  assert.equal(posted.has('Password'), false);
  assert.ok(calls[0].url.includes('invitationCode=invite-1'));
});

test('reset success is not an auth error, while actual errors remain visible', templateRuntime, () => {
  const api = service();
  api.window.location.search = '?message=password_reset_success';
  assert.equal(api.getAuthError(), undefined);
  api.window.location.search = '?message=password_reset_success&error=invalid_password';
  assert.ok(api.getAuthError());
  api.window.location.search = '?message=unknown_failure';
  assert.match(api.getAuthError(), /authentication error/);
});

for (const flow of ['forgotPassword', 'resetPassword']) test(`${flow} HTTP failures never report success or navigate, even after redirects`, templateRuntime, async () => {
  class Parser {
    parseFromString() { return { querySelectorAll: () => [] }; }
  }
  for (const status of [403, 500]) {
    for (const redirected of [false, true]) {
      const api = service({
        local: true, DOMParser: Parser,
        fetch: async (_url, options) => options
          ? { ok: false, status, redirected, text: async () => '<h1>Request failed</h1>' }
          : { ok: true, text: async () => '<input value="csrf-test">' },
      });
      const request = flow === 'forgotPassword'
        ? api.forgotPassword('maker@contoso.com')
        : api.resetPassword('contact-id', 'reset-code', 'test-only', 'test-only');
      await assert.rejects(request, new RegExp(String(status)));
      assert.equal(api.window.location.href, '/');
    }
  }
});

test('successful password requests retain their confirmation and navigation behavior', templateRuntime, async () => {
  class Parser {
    parseFromString() { return { querySelectorAll: () => [] }; }
  }
  for (const redirected of [false, true]) {
    const api = service({
      local: true, DOMParser: Parser,
      fetch: async (_url, options) => options
        ? { ok: true, status: 200, redirected, text: async () => 'confirmation' }
        : { ok: true, text: async () => '<input value="csrf-test">' },
    });
    await api.forgotPassword('maker@contoso.com');
    assert.equal(api.window.location.href, '/');
    await api.resetPassword('contact-id', 'reset-code', 'test-only', 'test-only');
    assert.equal(api.window.location.href, '/login?message=password_reset_success');
  }
});

test('external confirmation refetch preserves callback context and encoding', templateRuntime, async () => {
  let requested;
  class Parser {
    parseFromString() {
      return { querySelector: (selector) => selector === 'form'
        ? { getAttribute: () => `./ExternalLoginCallback${requested.split('ExternalLoginCallback')[1]}` }
        : { value: 'claim-value' } };
    }
  }
  const api = service({
    external: true, DOMParser: Parser,
    fetch: async (url) => {
      requested = url;
      return { ok: true, text: async () => 'confirmation form' };
    },
  });
  api.window.location.search = '?ReturnUrl=%2Forders%3Ftab%3Dopen&InvitationCode=invite%2B1';
  const details = await api.fetchExternalLoginDetails();
  assert.equal(requested, '/Account/Login/ExternalLoginCallback' + api.window.location.search);
  assert.equal(details.returnUrl, '/orders?tab=open');
});

test('external confirmation maps an expired callback cookie to the expired-session error', templateRuntime, async () => {
  class Parser {
    parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; }
  }
  const api = service({
    external: true,
    DOMParser: Parser,
    fetch: async () => ({ ok: true, type: 'basic', text: async () => '<h1>ExternalLoginFailure.aspx</h1>' }),
  });
  await assert.rejects(api.confirmExternalLogin({
    email: 'maker@contoso.com', firstName: 'Maker', lastName: 'User', username: 'maker',
    invitationCode: '', returnUrl: '/', antiForgeryToken: 'csrf-test',
  }), (error) => error instanceof api.ExternalLoginCookieExpiredError);
});

test('external terms errors preserve the server return URL, sign-in flags and invitation', templateRuntime, async () => {
  const termsAction = '/Account/Login/TermsAndConditions?ReturnUrl=%2Forders%3Ftab%3Dopen&UseExternalSignInAsync=True&IsFacebook=True&IsInternalAADUser=False&InvitationCode=invite%2B1';
  class Parser {
    parseFromString() {
      return {
        querySelector: (selector) => selector === 'form'
          ? { getAttribute: () => termsAction }
          : null,
        querySelectorAll: () => [],
      };
    }
  }
  const api = service({
    external: true, terms: true, DOMParser: Parser,
    fetch: async () => ({
      ok: true, type: 'basic', text: async () => '<form action="/Account/Login/TermsAndConditions">TermsAndConditions IsTermsAndConditionsAccepted</form>',
    }),
  });
  await assert.rejects(api.confirmExternalLogin({
    email: 'maker@contoso.com', firstName: 'Maker', lastName: 'User', username: 'maker',
    invitationCode: 'invite+1', returnUrl: '/orders?tab=open', antiForgeryToken: 'csrf-test',
  }), (error) => {
    assert.ok(error instanceof api.TermsRequiredError);
    const params = new URLSearchParams(error.search);
    assert.equal(params.get('ReturnUrl'), '/orders?tab=open');
    assert.equal(params.get('UseExternalSignInAsync'), 'True');
    assert.equal(params.get('IsFacebook'), 'True');
    assert.equal(params.get('IsInternalAADUser'), 'False');
    assert.equal(params.get('InvitationCode'), 'invite+1');
    return true;
  });
  assert.match(read('references/external-confirmation.md'), /navigate\(`\/terms\$\{err\.search\}`\)/);
});

test('username registration form submits separate required email with the chosen username', templateRuntime, async () => {
  const template = read('assets/local-auth-react-registerform-component-local-auth-only.tsx.template');
  const prefix = template.slice(template.indexOf('export function RegisterForm'), template.indexOf('\n  return ('));
  let submitted;
  let slot = 0;
  const states = [...prefix.matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map((match) => match[1]);
  const values = {
    credential: 'maker', email: 'maker@contoso.com',
    password: 'test-only', confirmPassword: 'test-only', error: '', isSubmitting: false,
  };
  const context = {
    useState: () => [values[states[slot++]], () => {}],
    useEffect: () => {},
    getAuthProvider: () => ({ loginByEmail: false }),
    register: async (fields) => { submitted = fields; },
    window: { location: { search: '' } }, URLSearchParams,
  };
  vm.runInNewContext(stripTypeScriptTypes(prefix + '\nreturn handleSubmit;\n}').replace(/^export /gm, '') + '\nglobalThis.submit = RegisterForm();', context);
  await context.submit({ preventDefault() {} });
  assert.equal(submitted.username, 'maker');
  assert.equal(submitted.email, 'maker@contoso.com');
  assert.equal(submitted.password, 'test-only');
  assert.match(template, /!isEmailMode &&[\s\S]*?type="email"[\s\S]*?required/);
});
