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

function capturingCli(opts = {}) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      upload: async (o) => { calls.push(o); return { pageId: '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8' }; },
      // Default: the requested page exists. Tests that care override this.
      enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
      // An update reads the page's CURRENT bindings so omitting `--data-sources` preserves them
      // instead of persisting `[]`. pac writes this config UTF-8 with a BOM, so the fixture does too.
      download: async ({ outputDir, pageIds }) => {
        for (const pid of (pageIds || [])) {
          fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
          const body = JSON.stringify({ dataSources: opts.liveDataSources || ['contoso_ticket'] });
          fs.writeFileSync(path.join(outputDir, pid, 'config.json'), Buffer.from('\uFEFF' + body, 'utf8'));
        }
        return true;
      },
    }),
  };
}

// LIVE-REPRODUCED: pac treats an unknown `--page-id` as a CREATE and returns the NEW page's id, so
// the wrapper's identity guard (returned id === requested id) matched and a UUID proven absent
// beforehand became a brand-new, UNPLACED page reported as `updated: true`.
test('an update of a page that does not exist is refused instead of creating one', async () => {
  const calls = [];
  const factory = () => ({
    upload: async (o) => { calls.push(o); return { pageId: 'NEW' }; },
    enumerateEnvironment: async () => ({ ok: true, ids: ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'] }),
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /does not exist in this environment/);
  assert.strictEqual(calls.length, 0, 'nothing may be uploaded against an absent target');
});

// Fail CLOSED: an unreadable listing is not permission to write.
test('an unverifiable update target is refused rather than assumed present', async () => {
  const calls = [];
  const factory = () => ({
    upload: async (o) => { calls.push(o); return { pageId: 'NEW' }; },
    enumerateEnvironment: async () => ({ ok: false, error: 'pac genpage list failed after 3 attempts' }),
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /cannot verify that page/);
  assert.strictEqual(calls.length, 0);
});

// CONTROL — an update whose target DOES exist still proceeds, and a CREATE is never gated on a
// listing at all. Without these the rule above could be satisfied by refusing everything.
test('an update of an existing page, and any create, still proceed', async () => {
  const cli = capturingCli();
  const upd = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'], cli);
  assert.strictEqual(upd.ok, true, `an existing target must update: ${JSON.stringify(upd.payload)}`);
  assert.strictEqual(upd.payload.updated, true);

  const create = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--name', 'N', '--prompt', 'p'], cli);
  assert.strictEqual(create.ok, true, 'a create must not be gated on an existence check');
  assert.strictEqual(create.payload.updated, false);
});

// An explicitly EMPTY agent message deployed fabricated provenance ('Authored by app-builder'),
// while an empty PROMPT was already refused — the same fabrication, unguarded on the other field.
test('an explicitly empty agent-message file is refused rather than silently defaulted', async () => {
  const d = tmp();
  const af = path.join(d, 'agent.txt');
  fs.writeFileSync(af, '', 'utf8');
  const cli = capturingCli();
  const r = await runMain(['--env', 'https://x/', '--app-id', 'a1', '--code-file', 'p.tsx',
    '--name', 'N', '--prompt', 'p', '--agent-message-file', af], cli);
  assert.strictEqual(r.ok, false, 'an empty agent message must not become fabricated provenance');
  assert.match(r.payload.error, /resolved to empty/);
  assert.strictEqual(cli.calls.length, 0);
});

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
    '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt-file', pf, '--agent-message', 'Re-upload after edit'], cli);

  assert.strictEqual(r.ok, true);
  // \r\n is normalized by neither side: only a SINGLE trailing newline is stripped, so every
  // interior line break — which is what makes a transcript a transcript — is preserved.
  assert.strictEqual(cli.calls[0].prompt, TRANSCRIPT, 'the transcript must not be flattened');
  assert.strictEqual(cli.calls[0].pageId, '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d');
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

// astra MEDIUM 8 — the option tests above call the LIBRARY directly and mostly check flag presence.
// Astra mutated `main()` to drop forwarding of model/connectors/actions/addToSitemap, and replaced
// the library's model and file arguments with "WRONG", and every committed test stayed green. So the
// wiring from CLI flag → wrapper → actual pac invocation was unprotected.
//
// This drives the REAL wrapper through `main()` and asserts exact flag/value pairs on the captured
// pac argv, with values distinct enough that a swap cannot pass.
test('main forwards every option through the real wrapper to the pac invocation, by value', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, 'the approved prompt', 'utf8');

  const seen = [];
  // The wrapper deletes its temp dir in a `finally`, so the prompt file cannot be read after
  // upload() returns. Capture the contents DURING the invocation instead.
  let promptOnDisk = null;
  const factory = (env) => makeGenpageCli(env, {
    run: async (args) => {
      seen.push(args);
      const i = args.indexOf('--prompt-file');
      if (i !== -1) promptOnDisk = fs.readFileSync(args[i + 1], 'utf8');
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });

  const r = await new Promise((resolve) => {
    main([
      '--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'APPID-1', '--code-file', 'CODE.tsx',
      '--name', 'NamedPage', '--data-sources', 'account,contact',
      '--model', 'MODEL-9', '--connectors', 'CONN.json', '--actions', 'ACT.json',
      '--prompt-file', pf, '--agent-message', 'msg', '--add-to-sitemap',
    ], { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `expected success, got ${JSON.stringify(r.payload)}`);

  const args = seen.find((a) => a.includes('upload'));
  assert.ok(args, `pac upload should have been invoked; saw ${JSON.stringify(seen)}`);
  const valueOf = (flag) => args[args.indexOf(flag) + 1];

  // EXACT pairs. A dropped flag or a swapped value fails here, which is what the old tests missed.
  assert.strictEqual(valueOf('--environment'), 'https://contoso.crm.dynamics.com/');
  assert.strictEqual(valueOf('--app-id'), 'APPID-1');
  assert.strictEqual(valueOf('--code-file'), 'CODE.tsx');
  assert.strictEqual(valueOf('--name'), 'NamedPage');
  assert.strictEqual(valueOf('--data-sources'), 'account,contact');
  assert.strictEqual(valueOf('--model'), 'MODEL-9');
  assert.strictEqual(valueOf('--connectors'), 'CONN.json');
  assert.strictEqual(valueOf('--actions'), 'ACT.json');
  assert.ok(args.includes('--add-to-sitemap'), 'a create that asked for placement must carry the flag');

  // And the prompt still travels by FILE, with the file holding the approved text.
  assert.ok(args.includes('--prompt-file'), 'the prompt must be delivered by file');
  assert.strictEqual(promptOnDisk, 'the approved prompt',
    'the temp file must hold exactly what the caller supplied');
});
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

// --- The update guard must survive the REAL wrapper, not just a capturing stub --------------------
// Every negative test above supplies its OWN enumerator, so all of them keep passing even if the
// wrapper stops exporting one and the guard silently turns itself off. These drive main() through
// the real `makeGenpageCli` with only `run` faked, so the production handoff is what is asserted.

// pac's env-wide listing, in the LIVE shape (auto-sized fixed-width columns) — an invented format is
// correctly rejected as 'unrecognized', so a fixture that only LOOKS plausible tests the wrong path.
const envListing = (ids) => {
  const names = ids.map((_, i) => `Page${i}`);
  const nameW = Math.max(4, ...names.map((n) => n.length));
  const header = 'Page ID'.padEnd(37) + 'Name'.padEnd(nameW + 1) + 'Published';
  const body = ids.map((id, i) => `${id} ${names[i].padEnd(nameW)} -`).join('\n');
  return `Connected as tester@contoso.com\nRetrieving generated pages...\n`
    + `Found ${ids.length} generated page(s):\n\n${header}\n${body}\n`;
};

test('REAL wrapper: updating an id absent from the environment is refused and never uploads', async () => {
  const seen = [];
  const factory = (env) => makeGenpageCli(env, {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) return { status: 0, stdout: envListing(['9e1d3a20-0000-4000-8000-000000000001']), stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', 'deadbeef-0000-4000-8000-00000000ffff', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, `an absent target must be refused; got ${JSON.stringify(r.payload)}`);
  assert.match(r.payload.error, /does not exist in this environment/);
  assert.deepStrictEqual(seen.filter((a) => a.includes('upload')), [],
    'pac upload must never run — it would CREATE a new unplaced page and report it as an update');
});

test('REAL wrapper: a target that DOES exist still updates (the guard blocks nothing legitimate)', async () => {
  const id = '9e1d3a20-0000-4000-8000-000000000001';
  const seen = [];
  const factory = (env) => makeGenpageCli(env, {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) return { status: 0, stdout: envListing([id]), stderr: '' };
      // The update reads current bindings first, so the fake must produce what pac produces: a
      // per-page directory holding a BOM-prefixed config.json.
      if (args.includes('download')) {
        const out = args[args.indexOf('--output-directory') + 1];
        fs.mkdirSync(path.join(out, id), { recursive: true });
        fs.writeFileSync(path.join(out, id, 'config.json'),
          Buffer.from('\uFEFF' + JSON.stringify({ dataSources: ['contoso_ticket'] }), 'utf8'));
        return { status: 0, stdout: 'Downloaded 1 page(s)', stderr: '' };
      }
      return { status: 0, stdout: `Page ID: ${id}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', id.toUpperCase(), '--prompt', 'p'], // upper-case: pac's ids are case-insensitive
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `an existing target must update; got ${JSON.stringify(r.payload)}`);
  assert.ok(seen.some((a) => a.includes('upload')), 'pac upload must run for a real target');
});

test('a wrapper exposing NO environment listing is refused, not waved through', async () => {
  // Gating the guard on `typeof cli.enumerateEnvironment === 'function'` was fail-OPEN: an older or
  // custom wrapper skipped verification entirely and restored the original defect.
  let uploads = 0;
  const factory = () => ({ upload: async () => { uploads += 1; return { ok: true, pageId: 'x' }; } });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', 'deadbeef-0000-4000-8000-00000000ffff', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, `a wrapper that cannot prove existence must refuse; got ${JSON.stringify(r.payload)}`);
  assert.match(r.payload.error, /exposes no environment listing/);
  assert.strictEqual(uploads, 0, 'nothing may be uploaded when the target cannot be verified');
});

test('a wrapper exposing only the older enumerateEnv name is still verified', async () => {
  let uploads = 0;
  const factory = () => ({
    enumerateEnv: async () => ({ ok: true, ids: ['9e1d3a20-0000-4000-8000-000000000001'] }),
    upload: async () => { uploads += 1; return { ok: true, pageId: 'x' }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', 'deadbeef-0000-4000-8000-00000000ffff', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, 'the alternate enumerator name must be used, not ignored');
  assert.match(r.payload.error, /does not exist in this environment/);
  assert.strictEqual(uploads, 0);
});

// --- The provenance rule lives in the WRAPPER; assert it there ------------------------------------
// The standalone refusal is a second line of defence. /app-builder calls upload() directly, so the
// fabrication this fixes is only actually prevented by the wrapper's own fallback rule.
test('wrapper: an explicitly empty agent message is sent verbatim, never replaced with a default', async () => {
  const read = {};
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      const i = args.indexOf('--agent-message-file');
      if (i !== -1) read.text = fs.readFileSync(args[i + 1], 'utf8');
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: '' });
  assert.strictEqual(read.text, '', 'an empty agent message must reach pac as written, not as fabricated provenance');
});

test('wrapper: an OMITTED agent message still gets the default (that fallback is deliberate)', async () => {
  const read = {};
  const mk = () => makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      const i = args.indexOf('--agent-message-file');
      if (i !== -1) read.text = fs.readFileSync(args[i + 1], 'utf8');
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  await mk().upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p' });
  assert.strictEqual(read.text, 'Authored by app-builder', 'omission is not a claim, so the default applies');
  await mk().upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: null });
  assert.strictEqual(read.text, 'Authored by app-builder', 'null is omission too');
});

// --- #G1: an update must not silently UNBIND the page ---------------------------------------------
// LIVE-REPRODUCED: pac rewrites the binding list from the flags it is given, so an update that omits
// `--data-sources` persists `[]`. The page goes on querying the table while its stored binding is
// gone — and the Phase 7.5 fix-redeploy command in verify-flow.md omits exactly that flag.
test('an update that says nothing about data sources PRESERVES the existing bindings', async () => {
  const cli = capturingCli({ liveDataSources: ['contoso_ticket', 'contoso_asset'] });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'fix the sort handler'],
    { makeGenpageCli: cli.factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `the update must succeed; got ${JSON.stringify(r.payload)}`);
  assert.deepStrictEqual(cli.calls[0].dataSources, ['contoso_ticket', 'contoso_asset'],
    'the page\'s existing bindings must be re-sent, not dropped');
});

test('an explicit --data-sources still WINS over the preserved list', async () => {
  const cli = capturingCli({ liveDataSources: ['contoso_ticket'] });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p', '--data-sources', 'contoso_other'],
    { makeGenpageCli: cli.factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(cli.calls[0].dataSources, 'contoso_other', 'an explicit value is the caller\'s intent');
});

test('--clear-data-sources really unbinds, and does not read the old list first', async () => {
  let probed = false;
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
    download: async () => { probed = true; return true; },
    upload: async (o) => { probed = probed || false; return { pageId: o.pageId, _ds: o.dataSources }; },
  });
  const seen = [];
  const capture = () => {
    const f = factory();
    return { ...f, upload: async (o) => { seen.push(o); return { pageId: o.pageId }; } };
  };
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p', '--clear-data-sources'],
    { makeGenpageCli: capture, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `a deliberate unbind must be allowed; got ${JSON.stringify(r.payload)}`);
  assert.strictEqual(seen[0].dataSources, undefined, 'nothing is sent, so pac clears the bindings');
  assert.strictEqual(probed, false, 'a deliberate clear need not read the list it is discarding');
});

test('an unreadable current binding list refuses the update rather than unbinding the page', async () => {
  // Fail CLOSED: "I could not read it" must never become "it had none".
  let uploads = 0;
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
    download: async () => true, // writes nothing — the config is then missing
    upload: async () => { uploads += 1; return { pageId: 'x' }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, 'an unreadable binding list must not be treated as "no bindings"');
  assert.match(r.payload.error, /--clear-data-sources/, 'the refusal names the deliberate-unbind escape hatch');
  assert.strictEqual(uploads, 0);
});

test('a CREATE never probes for bindings (there is nothing to preserve)', async () => {
  let probed = false;
  const seen = [];
  const factory = () => ({
    download: async () => { probed = true; return true; },
    upload: async (o) => { seen.push(o); return { pageId: '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8' }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--name', 'New Page', '--prompt', 'p', '--data-sources', 'contoso_ticket'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `a create must not be gated; got ${JSON.stringify(r.payload)}`);
  assert.strictEqual(probed, false, 'a create has no existing bindings to read');
  assert.strictEqual(seen[0].dataSources, 'contoso_ticket');
});

// Mutation-exposed: an over-strict shape check refused a config that parses but carries no
// `dataSources` key. That is how a genuinely UNBOUND page looks, and `download-model-app.js` reads
// it as "no bindings" (`config.dataSources || []`) — so refusing here would have blocked updating
// any unbound page. Unknown means MISSING or UNPARSEABLE, nothing else.
test('a page whose config has no dataSources key updates normally (it simply has no bindings)', async () => {
  const seen = [];
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
    download: async ({ outputDir, pageIds }) => {
      for (const pid of (pageIds || [])) {
        fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
        fs.writeFileSync(path.join(outputDir, pid, 'config.json'),
          Buffer.from('\uFEFF' + JSON.stringify({ model: 'some-model' }), 'utf8'));
      }
      return true;
    },
    upload: async (o) => { seen.push(o); return { pageId: o.pageId }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `an unbound page must still be updatable; got ${JSON.stringify(r.payload)}`);
  assert.deepStrictEqual(seen[0].dataSources, [], 'nothing to preserve, so nothing is sent');
});

test('a config that is PRESENT but unparseable refuses the update', async () => {
  // The distinction that matters: corrupt or non-object bytes are UNKNOWN bindings, not absent ones.
  // `{ truncated` fails JSON.parse; `[]`, `null` and `42` parse but are not a config object, and
  // reading any of them as "no bindings" would silently unbind the page.
  for (const body of ['{ truncated', '[]', 'null', '42']) {
    let uploads = 0;
    const factory = () => ({
      enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
      download: async ({ outputDir, pageIds }) => {
        for (const pid of (pageIds || [])) {
          fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
          fs.writeFileSync(path.join(outputDir, pid, 'config.json'), Buffer.from(body, 'utf8'));
        }
        return true;
      },
      upload: async () => { uploads += 1; return { pageId: 'x' }; },
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await new Promise((resolve) => {
      main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
        '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
      { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
    });
    assert.strictEqual(r.ok, false, `config body ${JSON.stringify(body)} must not be read as "no bindings"`);
    assert.strictEqual(uploads, 0, `nothing may upload for config body ${JSON.stringify(body)}`);
  }
});

// Regression: pac names the downloaded directory with its own casing of the page id. Joining the
// CALLER's spelling passed on Windows (case-insensitive paths) and failed on Linux, where a
// differently-cased --page-id lost the config and refused a perfectly good update.
//
// NOTE: this test is VACUOUS on a case-insensitive filesystem — Windows resolves the path either
// way, so it passes there with or without the fix. It is a real guard only on Linux/macOS-CI, which
// is precisely where the defect surfaced. Do not read a local pass as proof.
test('the current bindings are found even when --page-id casing differs from pac\'s directory', async () => {
  const canonical = '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
  const seen = [];
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: [canonical] }),
    download: async ({ outputDir }) => {
      // pac writes the directory in ITS casing, not the caller's.
      fs.mkdirSync(path.join(outputDir, canonical), { recursive: true });
      fs.writeFileSync(path.join(outputDir, canonical, 'config.json'),
        Buffer.from('\uFEFF' + JSON.stringify({ dataSources: ['contoso_ticket'] }), 'utf8'));
      return true;
    },
    upload: async (o) => { seen.push(o); return { pageId: o.pageId }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', canonical.toUpperCase(), '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `casing must not lose the config; got ${JSON.stringify(r.payload)}`);
  assert.deepStrictEqual(seen[0].dataSources, ['contoso_ticket'], 'the bindings must still be preserved');
});

// --- Review follow-ups on the unbind guard --------------------------------------------------------

// `parseArgs` yields the STRING "false" for `--clear-data-sources=false`, which is truthy. Testing
// the raw flag read an explicit refusal to clear as permission to clear — unbinding the page the
// guard exists to protect.
test('--clear-data-sources=false does NOT authorise clearing; bindings are still preserved', async () => {
  const cli = capturingCli({ liveDataSources: ['contoso_ticket'] });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p', '--clear-data-sources=false'],
    { makeGenpageCli: cli.factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `the update must proceed; got ${JSON.stringify(r.payload)}`);
  assert.deepStrictEqual(cli.calls[0].dataSources, ['contoso_ticket'],
    'an explicit "false" must not be read as permission to unbind');
});

test('--clear-data-sources combined with --data-sources is refused, not silently resolved', async () => {
  let uploads = 0;
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
    upload: async () => { uploads += 1; return { pageId: 'x' }; },
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p',
      '--clear-data-sources', '--data-sources', 'contoso_other'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, 'one unbinds and the other binds — guessing is not an option');
  assert.match(r.payload.error, /cannot be combined/);
  assert.strictEqual(uploads, 0);
});

// A PRESENT but non-array `dataSources` is malformed, not absent. Reading it as "no bindings" would
// unbind the page on the strength of a value we could not interpret.
test('a dataSources value of the wrong type refuses the update, rather than unbinding', async () => {
  for (const bad of ['"contoso_ticket"', '42', '{"a":1}']) {
    let uploads = 0;
    const factory = () => ({
      enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
      download: async ({ outputDir, pageIds }) => {
        for (const pid of (pageIds || [])) {
          fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
          fs.writeFileSync(path.join(outputDir, pid, 'config.json'),
            Buffer.from(`{"dataSources":${bad}}`, 'utf8'));
        }
        return true;
      },
      upload: async () => { uploads += 1; return { pageId: 'x' }; },
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await new Promise((resolve) => {
      main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
        '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
      { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
    });
    assert.strictEqual(r.ok, false, `dataSources ${bad} is malformed, not empty`);
    assert.strictEqual(uploads, 0, `nothing may upload for dataSources ${bad}`);
  }
});

// The real `emitResult` calls process.exit(1), so a `return emit(...)` inside the try/finally never
// reaches the cleanup. The probe directory — holding the page's downloaded source and prompt — was
// left on disk. The error is recorded and emitted AFTER cleanup instead.
test('the probe directory is removed even when the read fails', async () => {
  const probes = [];
  const factory = () => ({
    enumerateEnvironment: async () => ({ ok: true, ids: ['9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'] }),
    download: async ({ outputDir }) => { probes.push(outputDir); return true; }, // writes no config
    upload: async () => ({ pageId: 'x' }),
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, false, 'the unreadable config still refuses');
  assert.strictEqual(probes.length, 1, 'a probe directory was created');
  assert.strictEqual(fs.existsSync(probes[0]), false,
    `the probe directory must be cleaned up on the failure path; ${probes[0]} survived`);
});

// Cleanup is best-effort: its failure must not replace the outcome of an otherwise good update.
test('a cleanup failure does not fail an update whose bindings were read', async () => {
  const cli = capturingCli({ liveDataSources: ['contoso_ticket'] });
  const realRm = fs.rmSync;
  fs.rmSync = () => { throw new Error('EPERM'); };
  let r;
  try {
    r = await new Promise((resolve) => {
      main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
        '--page-id', '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', '--prompt', 'p'],
      { makeGenpageCli: cli.factory, emit: (ok, payload) => resolve({ ok, payload }) });
    });
  } finally { fs.rmSync = realRm; }
  assert.strictEqual(r.ok, true, `a temp-dir cleanup failure must not abort the update; got ${JSON.stringify(r.payload)}`);
  assert.deepStrictEqual(cli.calls[0].dataSources, ['contoso_ticket']);
});

// --- PR review: --prompt-file must deliver the file byte-for-byte -------------------------------
// A trailing newline used to be stripped here while the direct /app-builder wrapper path preserved
// it, so the SAME text deployed differently depending on which path carried it. This transport
// exists precisely so an arbitrary prompt survives verbatim.
test('a prompt file reaches pac byte-for-byte, including a trailing newline', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const BODY = 'Conversation with 2 prompts:\n1. Build a list\n2. Add a search box\n';
  fs.writeFileSync(pf, BODY, 'utf8');

  let onDisk = null;
  const factory = (env) => makeGenpageCli(env, {
    run: async (args) => {
      const i = args.indexOf('--prompt-file');
      if (i !== -1) onDisk = fs.readFileSync(args[i + 1], 'utf8');
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  const r = await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--name', 'P', '--prompt-file', pf, '--agent-message', 'm'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(r.ok, true, `expected success, got ${JSON.stringify(r.payload)}`);
  assert.strictEqual(onDisk, BODY,
    'the prompt must reach pac exactly as written — no trailing-newline normalization');
});

// A BOM is an ENCODING MARKER, not content, so it is still removed — the one deliberate exception.
test('a BOM is still stripped even though the rest of the file is passed through', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, Buffer.from('\uFEFFkeep this\n', 'utf8'));
  let onDisk = null;
  const factory = (env) => makeGenpageCli(env, {
    run: async (args) => {
      const i = args.indexOf('--prompt-file');
      if (i !== -1) onDisk = fs.readFileSync(args[i + 1], 'utf8');
      if (args.includes('list')) return { status: 0, stdout: 'Found 0 generated page(s):\n', stderr: '' };
      return { status: 0, stdout: 'Page ID: 13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', stderr: '' };
    },
    sleep: async () => {},
  });
  await new Promise((resolve) => {
    main(['--env', 'https://contoso.crm.dynamics.com/', '--app-id', 'a1', '--code-file', 'c.tsx',
      '--name', 'P', '--prompt-file', pf, '--agent-message', 'm'],
    { makeGenpageCli: factory, emit: (ok, payload) => resolve({ ok, payload }) });
  });
  assert.strictEqual(onDisk, 'keep this\n', 'the BOM goes, the trailing newline stays');
});
