#!/usr/bin/env node
'use strict';
// genpage-upload: deploy ONE generative page through the shared, quoting-safe upload wrapper.
//
// WHY THIS SCRIPT EXISTS (#589). `makeGenpageCli().upload()` already writes the prompt and
// agent-message to temp files and passes `--prompt-file` / `--agent-message-file`, because a
// prompt is arbitrary user text: it carries quotes, newlines, `%VAR%`, `&`, `|` and non-ASCII.
// `/app-builder` went through that wrapper, but the standalone `/genpage` skill still told the
// orchestrator to compose a raw `pac model genpage upload --prompt "<text>"` command line in
// Markdown — so the same page content deployed one way and failed the other. Observed live:
//
//   Error: Not a valid command.
//   Parse failed on: Inspection
//   Was it quote wrapped? No, be sure to wrap values that contain spaces.
//
// …for a prompt containing an ASCII-quoted multiword page name. The workaround people reach for is
// to EDIT the approved prompt (swap in typographic quotes), which silently breaks prompt
// provenance — the page is then built from text the user never approved.
//
// So this script is the one entry point both skills use. The prompt never becomes part of a
// command line: it is read from a FILE and handed to the wrapper as a value.
//
// Usage:
//   node scripts/genpage-upload.js --env <orgUrl> --app-id <guid> --code-file <path>
//        --prompt-file <path> --agent-message-file <path>
//        [--page-id <guid>] [--name <text>] [--data-sources <csv>] [--compiled-code-file <path>]
//
//   `--prompt` / `--agent-message` are accepted for short, shell-safe text, but `--prompt-file` is
//   the documented path precisely because it cannot be mangled by a shell.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');

const KNOWN = ['env', 'app-id', 'code-file', 'compiled-code-file', 'page-id', 'name',
  'data-sources', 'prompt', 'prompt-file', 'agent-message', 'agent-message-file',
  'model', 'connectors', 'actions', 'add-to-sitemap'];
// `--add-to-sitemap` is a bare switch; every other flag carries a value.
const NEED_VALUE = KNOWN.filter((f) => f !== 'add-to-sitemap');

const USAGE = 'Usage: node scripts/genpage-upload.js --env <orgUrl> --app-id <guid> --code-file <path> '
  + '--prompt-file <path> --agent-message-file <path> [--page-id <guid>] [--name <text>] '
  + '[--data-sources <csv>] [--compiled-code-file <path>] [--model <id>] [--connectors <path>] '
  + '[--actions <path>] [--add-to-sitemap]';

// Resolve one text input that may arrive inline or by file. Returns { ok, value } or { ok:false,
// error }. Supplying BOTH is rejected rather than silently preferring one: the two would be
// different text, and quietly picking either means deploying a prompt the caller did not intend.
function resolveText(flags, inlineFlag, fileFlag, readFile) {
  const inline = flags[inlineFlag];
  const file = flags[fileFlag];
  const hasInline = typeof inline === 'string' && inline !== '';
  const hasFile = typeof file === 'string' && file !== '';
  if (hasInline && hasFile) {
    return { ok: false, error: `pass only one of --${inlineFlag} or --${fileFlag}, not both` };
  }
  if (hasFile) {
    // utf8, and NOT trimmed: a downloaded prompt is a multi-line conversation transcript whose
    // blank lines are part of the text. Only a trailing newline added by a text editor is dropped.
    //
    // A LEADING UTF-8 BOM is stripped. MEASURED against a live deployment: `pac model genpage
    // download` writes the recovered `prompt.txt` starting `ef bb bf`, and the documented edit flow
    // re-feeds exactly that file through `--prompt-file`. Node's 'utf8' decode keeps the BOM as
    // U+FEFF, so the prompt handed back to pac would begin with an invisible character — silently
    // altering the first character of a prompt the user approved. Only the LEADING one is removed:
    // a U+FEFF anywhere else is content, not an encoding marker.
    try {
      return {
        ok: true,
        value: String(readFile(path.resolve(file), 'utf8')).replace(/^\uFEFF/, '').replace(/\r?\n$/, ''),
      };
    } catch (e) {
      return { ok: false, error: `--${fileFlag} could not be read: ${e.message}` };
    }
  }
  return { ok: true, value: hasInline ? inline : undefined };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emit || emitResult;
  const readFile = deps.readFile || fs.readFileSync;
  const cliFactory = deps.makeGenpageCli || makeGenpageCli;

  const flagError = validateFlags(argv, { known: KNOWN, needValue: NEED_VALUE });
  if (flagError) return emit(false, { error: `${flagError}\n${USAGE}` });
  const { flags } = parseArgs(argv);

  for (const required of ['env', 'app-id', 'code-file']) {
    if (typeof flags[required] !== 'string' || !flags[required]) {
      return emit(false, { error: `--${required} is required\n${USAGE}` });
    }
  }

  const prompt = resolveText(flags, 'prompt', 'prompt-file', readFile);
  if (!prompt.ok) return emit(false, { error: prompt.error });
  const agentMessage = resolveText(flags, 'agent-message', 'agent-message-file', readFile);
  if (!agentMessage.ok) return emit(false, { error: agentMessage.error });

  const cli = cliFactory(flags.env);
  try {
    const res = await cli.upload({
      appId: flags['app-id'],
      pageId: flags['page-id'] || undefined,
      codeFile: flags['code-file'],
      compiledCodeFile: flags['compiled-code-file'] || undefined,
      name: flags.name || undefined,
      prompt: prompt.value,
      agentMessage: agentMessage.value,
      // Passed through as the CSV the caller typed; upload() normalizes array-or-string.
      dataSources: flags['data-sources'] || undefined,
      model: flags.model || undefined,
      connectors: flags.connectors || undefined,
      actions: flags.actions || undefined,
      // `--add-to-sitemap` is for the standalone skill, where nothing else writes the subarea.
      // upload() additionally refuses to send it alongside --page-id, so an update cannot
      // accidentally add a second sitemap entry.
      addToSitemap: flags['add-to-sitemap'] === true || flags['add-to-sitemap'] === 'true',
    });
    // `pageId` is the one value a caller needs in order to continue (sitemap wiring, a follow-up
    // edit). Echo the identity back rather than making the caller re-parse pac output.
    return emit(true, {
      ok: true,
      pageId: (res && (res.pageId || res.id)) || null,
      appId: flags['app-id'],
      updated: !!flags['page-id'],
    });
  } catch (e) {
    return emit(false, { error: e && e.message ? e.message : String(e) });
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
module.exports = { main, resolveText };
