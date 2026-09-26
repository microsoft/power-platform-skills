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
const os = require('node:os');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { makeGenpageCli, suppliedButBlank } = require('./lib/genpage-cli.js');

const KNOWN = ['env', 'app-id', 'code-file', 'compiled-code-file', 'page-id', 'name', 'name-file',
  'data-sources', 'clear-data-sources', 'prompt', 'prompt-file', 'agent-message', 'agent-message-file',
  'model', 'connectors', 'actions', 'add-to-sitemap'];
// Bare switches; every other flag carries a value.
const SWITCHES = ['add-to-sitemap', 'clear-data-sources'];
const NEED_VALUE = KNOWN.filter((f) => !SWITCHES.includes(f));

const USAGE = 'Usage: node scripts/genpage-upload.js --env <orgUrl> --app-id <guid> --code-file <path> '
  + '--prompt-file <path> --agent-message-file <path> [--page-id <guid>] [--name-file <path> | --name <text>] '
  + '[--data-sources <csv>] [--clear-data-sources] [--compiled-code-file <path>] [--model <id>] '
  + '[--connectors <path>] [--actions <path>] [--add-to-sitemap]';

// The skill writes these inputs — the prompt, agent-message and page-name files, connectors.json, actions.json —
// into the working directory just before the upload, and a write through a link left at one of those names (a
// symbolic link, a junction, or a hard link whose other name lives elsewhere) rewrites the file it points to,
// outside the working directory included. The skill checks each name before it writes (SKILL.md Phase 6); this is
// the check that holds when that step was skipped: the upload stops, and says the linked file may have been
// changed. Returns null for a plain file, and for a path that is not there (the read or pac reports that).
//
// Scope: both checks close a link left in the folder BEFORE the run, such as one shipped in a cloned repository. A
// process racing the skill to plant one between its check and its write is out of their reach. Such a process
// already holds the user's rights over the whole working directory (its pages, plan and manifest), and no check
// inside the skill can stop it.
function notPlainFile(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) {
    return e && e.code === 'ENOENT' ? null : `${abs} could not be inspected (${(e && e.code) || e})`;
  }
  if (st.isFile() && st.nlink <= 1) return null;
  if (st.isSymbolicLink()) return `${abs} is a symbolic link or junction, not a file written in place — writing it may have changed the file it points to; check that file, remove the link and re-run`;
  if (st.isFile()) return `${abs} is a hard link (${st.nlink} names for one file), not a file written in place — writing it changed its other names too; check them, remove this one and re-run`;
  return `${abs} is not a plain file (a folder or a special file) — remove it and re-run`;
}

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
    // blank lines — and whose final newline — are part of the text.
    //
    // A LEADING UTF-8 BOM is stripped. MEASURED against a live deployment: `pac model genpage
    // download` writes the recovered `prompt.txt` starting `ef bb bf`, and the documented edit flow
    // re-feeds exactly that file through `--prompt-file`. Node's 'utf8' decode keeps the BOM as
    // U+FEFF, so the prompt handed back to pac would begin with an invisible character — silently
    // altering the first character of a prompt the user approved. Only the LEADING one is removed:
    // a U+FEFF anywhere else is content, not an encoding marker.
    // The bytes are otherwise passed through UNCHANGED — no trailing-newline normalization. This
    // transport exists precisely so an arbitrary prompt survives verbatim, and the direct
    // /app-builder wrapper path preserves a final newline, so stripping one here made the same text
    // deploy differently depending on which path carried it. A prompt that legitimately ends with a
    // newline (a downloaded transcript, a heredoc) keeps it.
    const linked = notPlainFile(path.resolve(file));
    if (linked) return { ok: false, error: `--${fileFlag} ${linked}` };
    try {
      return {
        ok: true,
        value: String(readFile(path.resolve(file), 'utf8')).replace(/^\uFEFF/, ''),
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
  // The page's display name travels by file too. It is the maker's text as well, and the skill substituted it
  // into `--name "<name>"`: PowerShell expanded `$(…)` in it before this script ran — a name could run a
  // command — and `Revenue $100` arrived as `Revenue `. By file it is never command text, and keeps every
  // character. Its trailing line break, which an editor adds, is not part of the name.
  const pageName = resolveText(flags, 'name', 'name-file', readFile);
  if (!pageName.ok) return emit(false, { error: pageName.error });
  if (typeof flags['name-file'] === 'string' && pageName.value !== undefined) pageName.value = pageName.value.replace(/(?:\r?\n)+$/, '');

  // An EMPTY prompt or agent-message is refused rather than defaulted. `upload()` substitutes
  // `Generative page <name>` for a blank prompt and `Authored by app-builder` for a blank agent
  // message, which is reasonable when nothing was supplied at all — but a caller who passed
  // `--prompt-file` / `--agent-message-file` asked for THAT text, and silently deploying generated
  // provenance instead is the failure this path exists to prevent. A file holding only whitespace,
  // only a newline, or only a BOM is the realistic way this happens.
  for (const [label, inlineFlag, fileFlag, resolved] of [
    ['prompt', 'prompt', 'prompt-file', prompt],
    ['agent message', 'agent-message', 'agent-message-file', agentMessage],
    ['page name', 'name', 'name-file', pageName],
  ]) {
    const given = typeof flags[inlineFlag] === 'string' || typeof flags[fileFlag] === 'string';
    if (given && suppliedButBlank(resolved.value === undefined ? '' : resolved.value)) {
      return emit(false, {
        error: `the ${label} resolved to empty — refusing to deploy generated text in place of the `
          + `${label} you supplied. Check the file is not blank, newline-only, or BOM-only.`,
      });
    }
  }

  const addToSitemap = flags['add-to-sitemap'] === true || flags['add-to-sitemap'] === 'true';
  // Same normalization as the switch above, and for the same reason: `parseArgs` yields the STRING
  // "false" for `--clear-data-sources=false`, which is truthy. Testing the raw flag would have read
  // an explicit refusal to clear as permission to clear — unbinding the page the guard protects.
  const clearDataSources = flags['clear-data-sources'] === true || flags['clear-data-sources'] === 'true';
  // A contradiction, not a precedence question: one says "remove every binding", the other names the
  // bindings to keep. Silently preferring either is a guess about intent on a destructive operation.
  if (clearDataSources && flags['data-sources']) {
    return emit(false, {
      error: '--clear-data-sources cannot be combined with --data-sources: one unbinds the page and '
        + 'the other sets its bindings. Drop whichever you did not mean.',
    });
  }
  // REFUSED, not silently dropped. pac rejects the combination, and an update that quietly discards
  // the flag leaves the caller believing a placement happened. The wrapper also omits it on an
  // update as a backstop, but a backstop is not an answer to an explicit contradictory request.
  if (addToSitemap && flags['page-id']) {
    return emit(false, {
      error: '--add-to-sitemap cannot be combined with --page-id: an update cannot add a sitemap '
        + 'entry, and the page it names is already placed. Drop one of the two.',
    });
  }

  // pac reads these two itself; they are checked here for the same reason as the text files (notPlainFile).
  for (const flag of ['connectors', 'actions']) {
    const linked = typeof flags[flag] === 'string' && flags[flag] ? notPlainFile(path.resolve(flags[flag])) : null;
    if (linked) return emit(false, { error: `--${flag} ${linked}` });
  }

  const cli = cliFactory(flags.env);

  // An UPDATE must have a target that EXISTS. pac treats an unknown `--page-id` as a CREATE and
  // returns the NEW page's id, and the wrapper's identity guard compares the returned id to the one
  // it just used — which matches, so a typo'd or stale id silently produced a brand-new, UNPLACED
  // page reported as `updated: true`. Live-reproduced: a UUID proven absent beforehand became a page.
  //
  // Checked here rather than inside `upload()` because this is where an ARBITRARY id enters: the
  // standalone CLI takes it straight from the caller. /app-builder's page updates carry ids from its
  // own manifest and reconcile, so they do not need an extra env-wide listing per page.
  //
  // Env-wide and including unpublished pages, because an app-scoped list is derived from the sitemap
  // and would miss exactly the unplaced page this defect creates. Fail CLOSED on an unreadable
  // listing: "cannot prove the target exists" must not license a write that might create a duplicate.
  if (flags['page-id']) {
    // Resolve the enumerator by EITHER of the wrapper's two exported names. A wrapper exposing
    // neither cannot prove the target exists, and skipping the check in that case would be
    // fail-OPEN exactly when the wrapper is unknown — the opposite of the policy this guard
    // implements. Gating on `typeof ... === 'function'` alone silently restored the original defect
    // for any older or custom wrapper.
    const enumerate = typeof cli.enumerateEnvironment === 'function' ? () => cli.enumerateEnvironment()
      : typeof cli.enumerateEnv === 'function' ? () => cli.enumerateEnv()
        : null;
    if (!enumerate) {
      return emit(false, {
        error: `cannot verify that page ${flags['page-id']} exists before updating it — this pac `
          + 'wrapper exposes no environment listing. Refusing to upload, because pac treats an '
          + 'unknown --page-id as a create and would make a new page and report it as an update.',
      });
    }
    const known = await enumerate();
    if (!known || known.ok !== true) {
      return emit(false, {
        error: `cannot verify that page ${flags['page-id']} exists before updating it `
          + `(${(known && known.error) || 'unknown reason'}) — refusing to upload, because pac treats an `
          + 'unknown --page-id as a create and would make a new page.',
      });
    }
    if (!(known.ids || []).includes(String(flags['page-id']).toLowerCase())) {
      return emit(false, {
        error: `page ${flags['page-id']} does not exist in this environment — refusing to "update" it. `
          + 'pac would create a NEW unplaced page and report it as an update. Check the id, or drop '
          + '--page-id to create a page deliberately.',
      });
    }
    // EXISTENCE is not enough for an update: pac accepts a real page id together with ANY app id
    // and then writes the page under that app context, which renames it and attaches its table
    // bindings to the wrong app. The app-scoped list is sitemap/navigation membership, so prove the
    // page is actually placed in THIS app before the binding probe downloads content or upload writes.
    const enumeratePages = typeof cli.enumeratePages === 'function' ? cli.enumeratePages.bind(cli) : null;
    if (!enumeratePages) {
      return emit(false, {
        error: `cannot verify that page ${flags['page-id']} belongs to app ${flags['app-id']} — this pac `
          + 'wrapper exposes no app-scoped page listing. Refusing to upload, because updating a '
          + 'page through the wrong app id would rename it and attach its tables to that app.',
      });
    }
    const appPages = await enumeratePages(flags['app-id'], { includeUnpublished: true });
    if (!appPages || appPages.ok !== true) {
      return emit(false, {
        error: `cannot verify that page ${flags['page-id']} belongs to app ${flags['app-id']} `
          + `(${(appPages && appPages.error) || 'unknown reason'})`,
      });
    }
    const pages = Array.isArray(appPages.pages) ? appPages.pages : [];
    if (!pages.length) {
      return emit(false, {
        error: `app ${flags['app-id']} has no generative pages, or could not be found — cannot verify `
          + `that page ${flags['page-id']} belongs to it`,
      });
    }
    const pageInApp = pages.some((p) => String(p && p.pageId || '').toLowerCase() === String(flags['page-id']).toLowerCase());
    if (!pageInApp) {
      return emit(false, {
        error: `page ${flags['page-id']} is not in app ${flags['app-id']}'s navigation — updating it `
          + 'with this app id would rename it and attach its tables to that app; use the id of the app the page belongs to',
      });
    }
  }

  // An UPDATE that says NOTHING about data sources must not DESTROY them. pac rewrites the page's
  // binding list from the flags it is given, so omitting `--data-sources` persists `[]` — the page
  // goes on querying the table while its stored binding disappears. Live-reproduced by following
  // the Phase 7.5 fix-redeploy command, which omits the flag.
  //
  // Same rule as an omitted cell span: absence is "no opinion", never "clear it". The current
  // bindings are read back and re-sent, so a fix-redeploy is non-destructive by default; pass
  // `--clear-data-sources` to actually unbind. A create has nothing to preserve.
  let preservedDataSources;
  if (flags['page-id'] && !flags['data-sources'] && !clearDataSources) {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-ds-'));
    // The failure is RECORDED and emitted after cleanup, never emitted from inside the try. The real
    // `emitResult` calls `process.exit(1)`, so a `return emit(...)` in the catch never reaches the
    // `finally` — leaving the probe directory, and the downloaded page source and prompt inside it,
    // on disk. The injected emitters used in tests return normally and hid that entirely.
    let probeError = null;
    try {
      await cli.download({ appId: flags['app-id'], outputDir: probe, pageIds: [flags['page-id']] });
      // pac names the downloaded directory with ITS OWN casing of the page id, which need not match
      // the casing the caller typed. Joining the caller's spelling works on a case-INSENSITIVE
      // filesystem and fails on Linux, where a differently-cased --page-id would "lose" the config
      // and refuse a perfectly good update. Resolve the directory case-insensitively instead.
      const wantDir = String(flags['page-id']).toLowerCase();
      const entry = fs.readdirSync(probe).find((d) => d.toLowerCase() === wantDir);
      if (!entry) throw new Error('pac wrote no directory for this page');
      // pac writes config.json UTF-8 WITH a BOM, which JSON.parse rejects outright — strip it first
      // or a perfectly good config reads as unparseable and the bindings are "lost" here too.
      const raw = fs.readFileSync(path.join(probe, entry, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('config.json is not a JSON object');
      }
      // An ABSENT `dataSources` key means the page HAS no bindings — the same reading the download
      // path uses (`config.dataSources || []`), and how an unbound page legitimately looks. A key
      // that is PRESENT but not an array is neither absent nor readable: it is malformed, and
      // treating it as "no bindings" would unbind the page on the strength of a value we could not
      // interpret. Only a MISSING or UNREADABLE config is unknown, and that is refused below.
      if (cfg.dataSources !== undefined && !Array.isArray(cfg.dataSources)) {
        throw new Error(`config.json dataSources is ${typeof cfg.dataSources}, not an array`);
      }
      if (Array.isArray(cfg.dataSources)) {
        const bad = cfg.dataSources.find((value) => typeof value !== 'string' || !value.trim());
        if (bad !== undefined) {
          throw new Error('config.json dataSources must be an array of non-empty table logical names');
        }
      }
      preservedDataSources = Array.isArray(cfg.dataSources) ? cfg.dataSources : [];
    } catch (e) {
      // Fail CLOSED: guessing "probably none" is exactly the silent unbinding this exists to stop.
      probeError = `cannot read the current data-source bindings for page ${flags['page-id']} (${e.message})`
        + ' — refusing to update, because pac would persist an EMPTY binding list and the page would'
        + ' keep querying a table it is no longer bound to. Pass --data-sources explicitly, or'
        + ' --clear-data-sources to unbind deliberately.';
    } finally {
      // Best-effort: a cleanup failure must not replace the outcome of the operation, nor abort an
      // update whose bindings were read successfully.
      try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* leave the temp dir */ }
    }
    if (probeError) return emit(false, { error: probeError });
  }

  try {
    const res = await cli.upload({
      appId: flags['app-id'],
      pageId: flags['page-id'] || undefined,
      codeFile: flags['code-file'],
      compiledCodeFile: flags['compiled-code-file'] || undefined,
      name: pageName.value || undefined,
      prompt: prompt.value,
      agentMessage: agentMessage.value,
      // Passed through as the CSV the caller typed; upload() normalizes array-or-string. When the
      // caller said nothing on an update, this carries the page's EXISTING bindings so they survive.
      dataSources: flags['data-sources'] || preservedDataSources || undefined,
      model: flags.model || undefined,
      connectors: flags.connectors || undefined,
      actions: flags.actions || undefined,
      addToSitemap,
    });
    const pageId = (res && (res.pageId || res.id)) || null;
    // A create that asked for placement, crashed mid-flight, and was recovered as an UPDATE leaves
    // the page deployed but NOT in the sitemap — invisible in the app's navigation. That is an
    // incomplete deployment, so it is reported as a failure WITH the page id, rather than as
    // success, so the operator can place it instead of discovering the gap later.
    if (res && res.sitemapPending) {
      return emit(false, {
        pageId,
        appId: flags['app-id'],
        error: `page ${pageId} was deployed but NOT added to the sitemap: the create was recovered as `
          + 'an update, which cannot carry --add-to-sitemap. Add the page to the app navigation manually.',
      });
    }
    // `pageId` is the one value a caller needs in order to continue (sitemap wiring, a follow-up
    // edit). Echo the identity back rather than making the caller re-parse pac output.
    return emit(true, {
      ok: true,
      pageId,
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
module.exports = { main, resolveText, notPlainFile };
