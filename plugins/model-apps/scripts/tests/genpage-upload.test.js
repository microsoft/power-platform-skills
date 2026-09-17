'use strict';
// #589 — the standalone /genpage skill composed a raw `pac model genpage upload --prompt "<text>"`
// command line in Markdown, while /app-builder went through the quoting-safe wrapper. Same upload
// contract, two transports, and only one of them survives a realistic prompt.
//
// Observed live, for a prompt containing an ASCII-quoted multiword page name:
//   Error: Not a valid command.
//   Parse failed on: Inspection
//   Was it quote wrapped? No, be sure to wrap values that contain spaces.
//
// The dangerous "fix" is to edit the approved prompt until it parses, which deploys text the user
// never approved. These tests pin the transport instead: the prompt must reach pac BY FILE and
// arrive byte-identical, and it must never appear on the command line at all.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { main } = require('../genpage-upload.js');
const { buildPacInvocation, makeGenpageCli } = require('../lib/genpage-cli.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gp589-'));
  dirs.push(d);
  return d;
}

// Every hazard the live failure and the issue name, in one string:
//   multi-line, ASCII-quoted multiword name, Unicode, and shell metacharacters.
const HOSTILE_PROMPT = [
  'Create and LIVE DEPLOY one isolated generative page named "Facilities Inspection Live Overview"',
  'with a résumé of 100% & <b>bold</b> | piped ^ caret %PATH% $(whoami) `backtick`',
  '',
  "and a trailing line with an apostrophe's quote",
].join('\n');

// What a DOWNLOADED page prompt actually looks like — a conversation transcript whose line breaks
// are the content. Passed inline these are collapsed to spaces and the transcript is destroyed.
const TRANSCRIPT = 'Conversation with 3 prompts:\r\n1. Build a list of inspections\r\n2. Add a search box\r\n3. Sort by "Company Name" desc';

function capturingCli() {
  const calls = [];
  return {
    calls,
    factory: () => ({
      upload: async (opts) => { calls.push(opts); return { pageId: '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8' }; },
    }),
  };
}

function runMain(argv, cli) {
  return new Promise((resolve) => {
    main(argv, { makeGenpageCli: cli.factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
}

test('a hostile multi-line prompt reaches upload() byte-identical when passed by file', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const af = path.join(d, 'agent.txt');
  fs.writeFileSync(pf, HOSTILE_PROMPT, 'utf8');
  fs.writeFileSync(af, 'Initial deploy of the inspection page', 'utf8');

  const cli = capturingCli();
  const r = await runMain(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'page.tsx',
    '--prompt-file', pf, '--agent-message-file', af, '--name', 'Facilities Inspection Live Overview'], cli);

  assert.strictEqual(r.ok, true, `upload should succeed; got ${JSON.stringify(r.payload)}`);
  assert.strictEqual(cli.calls.length, 1);
  assert.strictEqual(cli.calls[0].prompt, HOSTILE_PROMPT,
    'the prompt must arrive VERBATIM — quotes, newlines, Unicode and metacharacters intact');
  assert.strictEqual(cli.calls[0].name, 'Facilities Inspection Live Overview');
  assert.strictEqual(r.payload.pageId, '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8');
});

test('a downloaded conversation transcript survives an update by file', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, TRANSCRIPT, 'utf8');

  const cli = capturingCli();
  const r = await runMain(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'page.tsx',
    '--page-id', 'p1', '--prompt-file', pf, '--agent-message', 'Re-upload after edit'], cli);

  assert.strictEqual(r.ok, true);
  // \r\n is normalized by neither side: only a SINGLE trailing newline is stripped, so every
  // interior line break — which is what makes a transcript a transcript — is preserved.
  assert.strictEqual(cli.calls[0].prompt, TRANSCRIPT, 'the transcript must not be flattened');
  assert.strictEqual(cli.calls[0].pageId, 'p1');
  assert.strictEqual(r.payload.updated, true, 'an upload carrying --page-id is an update');
});

// Prompt provenance: two different texts, one deploy. Silently preferring either means building the
// page from text the caller did not intend, which is the failure this whole issue is about.
test('passing both an inline prompt and a prompt file is refused rather than silently resolved', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, 'from the file', 'utf8');
  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--prompt', 'inline text', '--prompt-file', pf], cli);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /only one of --prompt or --prompt-file/);
  assert.strictEqual(cli.calls.length, 0, 'nothing may be uploaded when the prompt is ambiguous');
});

// LIVE-VERIFICATION FINDING, not a hypothetical. Deploying a page for real and then running
// `pac model genpage download` showed pac writes the recovered `prompt.txt` with a UTF-8 BOM
// (measured: first bytes `ef bb bf`). The documented edit flow re-feeds exactly that file through
// `--prompt-file`, and Node's 'utf8' decode does NOT strip a BOM — so the prompt handed to pac
// began with an invisible U+FEFF. That silently alters the first character of a prompt the user
// approved, which is the same prompt-provenance failure this whole path exists to prevent.
test('a BOM written by `pac genpage download` is stripped, not sent as part of the prompt', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const body = 'Create a read-only overview page named "Live Check Overview".';
  fs.writeFileSync(pf, '\uFEFF' + body, 'utf8');
  // The fixture really is BOM-prefixed on disk, so this cannot pass by writing a plain file.
  assert.deepStrictEqual([...fs.readFileSync(pf).slice(0, 3)], [0xef, 0xbb, 0xbf]);

  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--prompt-file', pf, '--agent-message', 'm'], cli);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(cli.calls[0].prompt.charCodeAt(0) !== 0xFEFF, true,
    'the prompt must not start with a BOM');
  assert.strictEqual(cli.calls[0].prompt, body, 'and the rest must be untouched');
});

// A BOM in the MIDDLE is content, not an encoding marker, so it must survive — stripping every
// U+FEFF would be a different bug in the same place.
test('a U+FEFF inside the prompt body is preserved', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const body = 'Line one\nmid\uFEFFdle\nLine three';
  fs.writeFileSync(pf, body, 'utf8');
  const cli = capturingCli();
  await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx', '--prompt-file', pf], cli);
  assert.strictEqual(cli.calls[0].prompt, body, 'only a LEADING BOM is an encoding marker');
});

// Adversarial review (astra HIGH 3 / grok MEDIUM 4). The wrapper OMITS `--add-to-sitemap` on an
// update as a backstop, but omission is not an answer to an explicit contradictory request: the
// caller believes a placement happened and it never did. The docs claimed "refused"; now it is.
test('--add-to-sitemap combined with --page-id is refused, not silently dropped', async () => {
  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p', '--add-to-sitemap'], cli);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /cannot be combined with --page-id/);
  assert.strictEqual(cli.calls.length, 0, 'nothing may be uploaded on a contradictory request');
});

// grok MEDIUM 5 — `upload()` substitutes `Generative page <name>` for a blank prompt. That is fine
// when no prompt was supplied, but a caller who passed --prompt-file asked for THAT text, and
// deploying a generated placeholder instead is exactly the provenance break this path exists to
// prevent. A blank, newline-only or BOM-only file is the realistic way it happens.
test('a prompt file that resolves to empty is refused rather than silently defaulted', async () => {
  const d = tmp();
  for (const [label, body] of [['blank', ''], ['newline-only', '\n'], ['BOM-only', '\uFEFF'], ['whitespace', '   \n  ']]) {
    const pf = path.join(d, `p-${label}.txt`);
    fs.writeFileSync(pf, body, 'utf8');
    const cli = capturingCli();
    const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
      '--name', 'NamedPage', '--prompt-file', pf], cli);
    assert.strictEqual(r.ok, false, `${label} must be refused`);
    assert.match(r.payload.error, /resolved to empty/);
    assert.strictEqual(cli.calls.length, 0, `${label}: nothing may be uploaded`);
  }
  // CONTROL: a file with real content still deploys, so this is not a blanket refusal.
  const good = path.join(d, 'good.txt');
  fs.writeFileSync(good, 'A real approved prompt', 'utf8');
  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx', '--prompt-file', good], cli);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(cli.calls[0].prompt, 'A real approved prompt');
});

// astra HIGH 3b — the worse half. A CREATE that asked for placement, crashed mid-flight and was
// recovered as an UPDATE leaves the page deployed but absent from the app's navigation, and the old
// code returned plain success. An unreachable page is an incomplete deployment, not a success.
test('a page deployed but left out of the sitemap is reported as incomplete, with its id', async () => {
  const cli = {
    calls: [],
    factory: () => ({ upload: async (o) => { cli.calls.push(o); return { pageId: 'f3ea07fc-bd57-4d73-af69-b2b64d3ccd85', sitemapPending: true }; } }),
  };
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--name', 'N', '--prompt', 'p', '--add-to-sitemap'], cli);
  assert.strictEqual(r.ok, false, 'an unplaced page is not a successful deployment');
  assert.strictEqual(r.payload.pageId, 'f3ea07fc-bd57-4d73-af69-b2b64d3ccd85',
    'the id must still be reported so the operator can place it');
  assert.match(r.payload.error, /NOT added to the sitemap/);
});

test('an unreadable prompt file fails closed instead of deploying a default prompt', async () => {  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--prompt-file', path.join(tmp(), 'missing.txt')], cli);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /could not be read/);
  assert.strictEqual(cli.calls.length, 0);
});

// The POINT of the file transport. Even with the hostile text, the Windows command line pac is
// handed must not contain the prompt — if it does, cmd.exe gets to reinterpret it and the live
// "Parse failed on: Inspection" failure is back.
test('WINDOWS: the prompt never appears on the command line pac is invoked with', async () => {
  const seen = [];
  // upload() snapshots the environment with `genpage list` before creating, so the double has to
  // answer that too — an empty-but-VALID listing, otherwise it fails closed before ever uploading.
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) {
        return { status: 0, stdout: 'Connected as maker@contoso.com\nRetrieving generated pages...\nFound 0 generated page(s):\n', stderr: '' };
      }
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  await cli.upload({ appId: 'a1', codeFile: 'page.tsx', name: 'Facilities Inspection Live Overview', prompt: HOSTILE_PROMPT, agentMessage: 'msg' });

  const args = seen.find((a) => a.includes('upload'));
  assert.ok(args, `pac upload should have been invoked; saw ${JSON.stringify(seen)}`);
  assert.ok(args.includes('--prompt-file'), `prompt must be delivered by file; got ${JSON.stringify(args)}`);
  assert.ok(!args.includes('--prompt'), 'the inline --prompt flag must not be used');

  // Render the ACTUAL Windows command line and prove the hostile text is absent from it.
  // Fragments must be unique to the PROMPT: `--name` is legitimately passed inline (a short,
  // caller-controlled value), and the first version of this test matched the quoted name instead
  // of the prompt — a test that would have failed on correct code.
  const win = buildPacInvocation(args, 'win32');
  for (const fragment of ['résumé', '$(whoami)', '<b>bold</b>', '%PATH%', "apostrophe's"]) {
    assert.ok(!win.command.includes(fragment),
      `prompt fragment ${JSON.stringify(fragment)} leaked onto the command line:\n${win.command}`);
  }
  // Controls, so this cannot pass merely because the command line is empty or the probe is reading
  // the wrong string: the inline name IS there, and so is the file flag that replaced --prompt.
  assert.ok(win.command.includes('Facilities Inspection Live Overview'),
    `expected the inline --name on the command line, got:\n${win.command}`);
  assert.ok(win.command.includes('--prompt-file'), `expected --prompt-file, got:\n${win.command}`);
});

// The standalone skill needs flags /app-builder must never send. They are opt-in for that reason,
// and `--add-to-sitemap` carries an extra rule: pac rejects it together with --page-id, and adding
// a sitemap entry on an UPDATE would duplicate the subarea. Enforced in the wrapper so every caller
// inherits it rather than each one restating the rule in prose.
test('the standalone flags are emitted, and --add-to-sitemap only on a create', async () => {
  const seen = [];
  // The double must echo back the page id it was given: upload() refuses an UPDATE whose returned
  // Page ID differs from the one requested (a real guard against pac silently writing a different
  // page), so a fixed id would fail the update leg for the wrapper's own correct reason.
  const mk = () => makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      const i = args.indexOf('--page-id');
      const id = i === -1 ? '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8' : args[i + 1];
      return { status: 0, stdout: `Page ID: ${id}`, stderr: '' };
    },
    sleep: async () => {},
  });

  await mk().upload({
    appId: 'a1', codeFile: 'p.tsx', name: 'New Page', prompt: 'p', agentMessage: 'm',
    dataSources: 'account,contact', model: 'gpt-x', connectors: 'c.json', actions: 'a.json', addToSitemap: true,
  });
  const create = seen.find((a) => a.includes('upload'));
  assert.deepStrictEqual(
    ['--data-sources', '--model', '--connectors', '--actions', '--add-to-sitemap'].filter((f) => !create.includes(f)),
    [], `a create should carry every requested flag; got ${JSON.stringify(create)}`);
  // A CSV STRING must survive: the build passes an array, a CLI caller passes a string, and
  // `dataSources.join(',')` on a string throws rather than degrading.
  assert.strictEqual(create[create.indexOf('--data-sources') + 1], 'account,contact');

  seen.length = 0;
  // A REAL GUID: parsePageId only recognises a 36-char id, so a placeholder like 'p1' makes the
  // wrapper report "returned no Page ID" — a failure of the double, not of the code under test.
  const EXISTING = '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
  await mk().upload({
    appId: 'a1', pageId: EXISTING, codeFile: 'p.tsx', name: 'New Page', prompt: 'p', agentMessage: 'm',
    dataSources: ['account', 'contact'], addToSitemap: true,
  });
  const update = seen.find((a) => a.includes('upload'));
  assert.ok(!update.includes('--add-to-sitemap'),
    `an UPDATE must not add a sitemap entry even when asked; got ${JSON.stringify(update)}`);
  assert.ok(update.includes('--page-id'), 'and it must still be an update');
  // The ARRAY shape still works — normalizing for strings must not break the build's caller.
  assert.strictEqual(update[update.indexOf('--data-sources') + 1], 'account,contact');
});

// /app-builder must be unaffected: it never asks for these, so none may appear by default.
test('an /app-builder-shaped upload sends none of the standalone flags', async () => {
  const seen = [];
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm', dataSources: ['account'] });
  const args = seen.find((a) => a.includes('upload'));
  for (const f of ['--add-to-sitemap', '--model', '--connectors', '--actions']) {
    assert.ok(!args.includes(f), `${f} must not appear unless asked; got ${JSON.stringify(args)}`);
  }
});
