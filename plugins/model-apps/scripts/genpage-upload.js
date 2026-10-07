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
const { makeGenpageCli, suppliedButBlank, unescapePacName } = require('./lib/genpage-cli.js');
const genpageBase = require('./lib/genpage-base.js');
const { writeFileSafe } = require('./lib/safe-fs.js');

const KNOWN = ['env', 'app-id', 'code-file', 'compiled-code-file', 'page-id', 'name', 'name-file',
  'data-sources', 'clear-data-sources', 'prompt', 'prompt-file', 'agent-message', 'agent-message-file',
  'model', 'connectors', 'actions', 'add-to-sitemap', 'overwrite-deployed'];
// Bare switches; every other flag carries a value.
const SWITCHES = ['add-to-sitemap', 'clear-data-sources', 'overwrite-deployed'];
const NEED_VALUE = KNOWN.filter((f) => !SWITCHES.includes(f));

const USAGE = 'Usage: node scripts/genpage-upload.js --env <orgUrl> --app-id <guid> --code-file <path> '
  + '--prompt-file <path> --agent-message-file <path> [--page-id <guid>] [--name-file <path> | --name <text>] '
  + '[--data-sources <csv>] [--clear-data-sources] [--compiled-code-file <path>] [--model <id>] '
  + '[--connectors <path>] [--actions <path>] [--add-to-sitemap] [--overwrite-deployed]';

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

function bindingRefusal(pageId, why) {
  return `cannot read the current data-source bindings for page ${pageId} (${why})`
    + ' — refusing to update, because pac would persist an EMPTY binding list and the page would'
    + ' keep querying a table it is no longer bound to. Pass --data-sources explicitly, or'
    + ' --clear-data-sources to unbind deliberately.';
}

// Every update downloads the deployed page once, both to preserve omitted bindings/model and to
// hash page.tsx against the base marker. The directory is removed before this returns: the caller
// emits afterwards, and the real emitter calls process.exit, so a cleanup after emit never runs.
async function probeDeployedPage(cli, flags) {
  const result = { deployedText: null, deployedError: null, cfg: null, configError: null };
  let probe;
  try {
    probe = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-ds-'));
    if (typeof cli.download !== 'function') {
      throw new Error('this pac wrapper exposes no page download');
    }
    await cli.download({ appId: flags['app-id'], outputDir: probe, pageIds: [flags['page-id']] });
    // pac names the downloaded directory with its own casing of the page id.
    const pageDir = genpageBase.findDownloadedPageDir(probe, flags['page-id']);
    if (!pageDir) throw new Error('pac wrote no directory for this page');
    try {
      result.deployedText = fs.readFileSync(path.join(pageDir, 'page.tsx'), 'utf8');
    } catch (e) {
      result.deployedError = `pac wrote no readable page.tsx (${e.message})`;
    }
    try {
      // pac writes config.json UTF-8 WITH a BOM, which JSON.parse rejects outright.
      const raw = fs.readFileSync(path.join(pageDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('config.json is not a JSON object');
      }
      result.cfg = cfg;
    } catch (e) {
      result.configError = e;
    }
  } catch (e) {
    result.deployedError = (e && e.message) || String(e);
    if (!result.configError) result.configError = e;
  } finally {
    if (probe) {
      try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* leave the temp dir */ }
    }
  }
  return result;
}

// Page-name failures are warnings, never refusals — the same as when this read ran on its own.
// A throw must not replace an earlier divergence verdict, so the caller settles the promise.
function noteCurrentName(nameResult, cli) {
  if (!nameResult) return {};
  if (nameResult.missing) return { nameUnread: 'this pac wrapper cannot read a page name' };
  if (nameResult.failed) {
    return { nameUnread: (nameResult.error && nameResult.error.message) || String(nameResult.error) };
  }
  const current = nameResult.value;
  if (typeof current !== 'string' || !current.trim()) return {};
  const name = unescapePacName(current);
  const refusal = typeof cli.argumentRefusal === 'function' ? cli.argumentRefusal(name) : null;
  if (refusal) return { nameUnsent: { current, refusal } };
  const out = { preservedName: name };
  // Only a `"` pac did not write (no backslash before it) cannot be kept as it is.
  if (/(?:^|[^\\])"/.test(current)) out.nameChanged = current;
  return out;
}

// After a successful upload, record the hash of the file we sent. A readback whose hash equals
// that file (pac's BOM and final CRLF are not a difference) confirms the service stored it:
// source 'upload'. A readback that differs must not become the trusted deployed hash — a save
// can land between the upload and the download, and recording it would make the next update
// treat someone else's page as our base. Record the uploaded hash as 'upload-unverified', with
// the line delta, so the next update refuses deployed-changed until genpage-base.js check. A
// failed readback is the same unverified marker. The whole step is best-effort: the upload
// already succeeded, and a throw here would report that create as a failure without a page id,
// so a retry could create a second page. A failed marker write deletes any previous marker: a
// stale base is worse than no base.
async function recordObservedBase(args) {
  try {
    await writeObservedBase(args);
  } catch (e) {
    args.warnings.push(`could not record a base marker (${(e && e.message) || e}) — a later update will refuse no-base until the page is recorded`);
  }
}

async function writeObservedBase({ cli, flags, pageId, base, warnings, mkdtempSync, rmSync }) {
  const codeFile = flags['code-file'];
  const mkdtemp = mkdtempSync || fs.mkdtempSync;
  const rm = rmSync || fs.rmSync;
  let localText;
  try {
    localText = base.readPlainText(path.resolve(codeFile));
  } catch (e) {
    warnings.push(`could not read ${codeFile} to record a base marker (${e.message}) — a later update will refuse no-base until the page is recorded`);
    try { base.deleteMarker(codeFile); } catch (del) {
      warnings.push(`the previous base marker could not be removed (${del.message})`);
    }
    return;
  }
  const localSha256 = base.pageHash(localText);
  let deployedSha256 = localSha256;
  let source = 'upload';
  let probe;
  try {
    probe = mkdtemp(path.join(os.tmpdir(), 'genpage-base-'));
    if (typeof cli.download !== 'function') throw new Error('this pac wrapper exposes no page download');
    await cli.download({ appId: flags['app-id'], outputDir: probe, pageIds: [pageId] });
    const pageDir = base.findDownloadedPageDir(probe, pageId);
    if (!pageDir) throw new Error('pac wrote no directory for this page');
    const downloaded = fs.readFileSync(path.join(pageDir, 'page.tsx'), 'utf8');
    if (base.pageHash(downloaded) === localSha256) {
      source = 'upload';
      deployedSha256 = localSha256;
    } else {
      source = 'upload-unverified';
      deployedSha256 = localSha256;
      const lines = base.lineDelta(localText, downloaded);
      warnings.push(`the deployed page differs from what was just uploaded (${lines.added} lines added, ${lines.removed} removed) — the service rewrote it or another save landed right after, so the base marker records the uploaded file's hash as unverified. The next update will refuse deployed-changed until the page is compared with genpage-base.js check`);
    }
  } catch (e) {
    source = 'upload-unverified';
    deployedSha256 = localSha256;
    warnings.push(`could not re-read the deployed page to confirm its hash (${(e && e.message) || e}), so the base marker records the uploaded file's hash as unverified — a later update may refuse deployed-changed if the service rewrote the page`);
  } finally {
    if (probe) {
      try { rm(probe, { recursive: true, force: true }); } catch { /* leave the temp dir */ }
    }
  }
  try {
    base.writeMarker(codeFile, {
      version: 1,
      pageId,
      appId: flags['app-id'],
      deployedSha256,
      localSha256,
      source,
    });
  } catch (e) {
    warnings.push(`could not write the base marker (${e.message}) — a later update will refuse no-base until the page is recorded again`);
    try { base.deleteMarker(codeFile); } catch (del) {
      warnings.push(`the previous base marker could not be removed (${del.message})`);
    }
  }
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
  // An ASCII double quote cannot be deployed in a page name: pac stores every `"` in it as `\"` — in the page
  // row AND in the navigation title it writes, which the app then shows (live-measured: `Say "hi" now` became
  // `Say \"hi\" now` in both). No other character is changed — backslashes, typographic quotes, apostrophes
  // and non-ASCII text all arrive exactly — so the name is refused before anything is deployed, and the
  // message names the characters that do survive.
  if (typeof pageName.value === 'string' && pageName.value.includes('"')) {
    return emit(false, {
      error: `the page name ${JSON.stringify(pageName.value)} contains an ASCII double quote ("), which the page would `
        + 'show as \\" — pac stores every " in a page name that way, in the navigation title too. Use typographic '
        + 'quotes (“ ”) or an apostrophe instead; they are stored exactly.',
    });
  }

  const addToSitemap = flags['add-to-sitemap'] === true || flags['add-to-sitemap'] === 'true';
  // Same normalization as the switch above, and for the same reason: `parseArgs` yields the STRING
  // "false" for `--clear-data-sources=false`, which is truthy. Testing the raw flag would have read
  // an explicit refusal to clear as permission to clear — unbinding the page the guard protects.
  const clearDataSources = flags['clear-data-sources'] === true || flags['clear-data-sources'] === 'true';
  // Same normalization as the switches above: `parseArgs` yields the STRING "false" for
  // `--overwrite-deployed=false`, which is truthy. An explicit refusal must not authorize an overwrite.
  const overwriteDeployed = flags['overwrite-deployed'] === true || flags['overwrite-deployed'] === 'true';
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
  const base = deps.base || genpageBase;

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
    const enumeratePages = typeof cli.enumeratePages === 'function' ? cli.enumeratePages.bind(cli) : null;
    // The existence and membership listings are independent reads, each its own pac process of about
    // five seconds, so they run together. Measured live: a pair run one after the other averaged
    // 10.6 s and an overlapped pair 5.6 s, and all 20 overlapped listings succeeded. The VERDICTS are
    // still reached in the original order (existence first), so a given failure is reported as it
    // was before, and a listing that throws surfaces only when its verdict is reached: a page that
    // does not exist is reported as absent even if the app listing also broke.
    const settle = (fn) => Promise.resolve().then(fn).then((value) => ({ value }), (error) => ({ failed: true, error }));
    const [existence, membership] = await Promise.all([
      settle(enumerate),
      enumeratePages ? settle(() => enumeratePages(flags['app-id'], { includeUnpublished: true })) : null,
    ]);
    if (existence.failed) throw existence.error;
    const known = existence.value;
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
    if (!enumeratePages) {
      return emit(false, {
        error: `cannot verify that page ${flags['page-id']} belongs to app ${flags['app-id']} — this pac `
          + 'wrapper exposes no app-scoped page listing. Refusing to upload, because updating a '
          + 'page through the wrong app id would rename it and attach its tables to that app.',
      });
    }
    if (membership.failed) throw membership.error;
    const appPages = membership.value;
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
  //
  // The page's MODEL follows the same rule: pac stores whatever `--model` an upload sends, and an update
  // without one wiped the deployed model id to "" (live-measured). So an update that omits it re-sends the
  // one config.json records — read from the same download.
  //
  // That download now runs on EVERY update, not only when a binding or the model was omitted: the
  // base-marker check needs page.tsx whether or not the caller named those flags. An unreadable
  // page is `deployed-unreadable`, independent of the binding options — a model-only miss used to
  // be a warning, and that must not become the policy for a snapshot we could not take.
  // `--overwrite-deployed` is the only bypass, and it is never the default. The download and the
  // upload are separate pac calls; a save that lands between them (seconds) is not detected.
  let preservedDataSources;
  let preservedModel;
  let modelUnread = null; // why the page's current model could not be read, when it could not
  let preservedName;
  let nameUnread = null;
  let nameChanged = null;
  let nameUnsent = null;
  let overwroteDeployed = false;
  if (flags['page-id']) {
    const preserveBindings = !flags['data-sources'] && !clearDataSources;
    const preserveModel = !flags.model;
    // The page-name read is its own Dataverse call. Start it with the probe download, after the
    // existence and membership guards above have passed, so a guard failure is still the verdict
    // and neither call is made. Name failures stay warnings, reached only if the update proceeds.
    // An update without a name keeps the page's current name. pac otherwise renames it to its
    // navigation title — live-reproduced: a renamed page reverted when a later update omitted
    // --name. The name is read from the page row and sent again, unescaped, so pac stores the
    // same value. A name this installation cannot hand to pac (a pac.cmd shim and `%` or `"`)
    // is not sent; the update still proceeds and says so. Metadata, like the model: not knowing
    // the name never blocks the update.
    const wantName = pageName.value === undefined;
    const settle = (p) => Promise.resolve(p).then((value) => ({ value }), (error) => ({ failed: true, error }));
    const nameTask = !wantName ? Promise.resolve(null)
      : typeof cli.pageName !== 'function' ? Promise.resolve({ missing: true })
        : settle(cli.pageName(flags['page-id']));
    const probeTask = settle(probeDeployedPage(cli, flags));
    const [nameResult, probeResult] = await Promise.all([nameTask, probeTask]);
    ({ preservedName, nameUnread, nameChanged, nameUnsent } = {
      preservedName, nameUnread, nameChanged, nameUnsent, ...noteCurrentName(nameResult, cli),
    });
    const probe = probeResult.failed
      ? { deployedText: null, deployedError: (probeResult.error && probeResult.error.message) || String(probeResult.error), cfg: null, configError: probeResult.error }
      : probeResult.value;
    // Recorded here, emitted below — never from inside the probe. emitResult calls process.exit.
    if (probe.deployedError && !overwriteDeployed) {
      return emit(false, {
        ok: false,
        code: 'deployed-unreadable',
        pageId: flags['page-id'],
        appId: flags['app-id'],
        error: `cannot read the deployed page ${flags['page-id']} (${probe.deployedError}) — refusing to update, `
          + 'because the page may have changed and this upload would replace it unseen. Pass --overwrite-deployed '
          + 'to replace it deliberately, or retry when the page can be downloaded.',
      });
    }
    if (preserveBindings) {
      let why = null;
      if (probe.configError || !probe.cfg) {
        why = (probe.configError && probe.configError.message) || probe.deployedError || 'pac wrote no directory for this page';
      } else if (probe.cfg.dataSources !== undefined && !Array.isArray(probe.cfg.dataSources)) {
        why = `config.json dataSources is ${typeof probe.cfg.dataSources}, not an array`;
      } else if (Array.isArray(probe.cfg.dataSources)) {
        const bad = probe.cfg.dataSources.find((value) => typeof value !== 'string' || !value.trim());
        if (bad !== undefined) why = 'config.json dataSources must be an array of non-empty table logical names';
        else preservedDataSources = probe.cfg.dataSources;
      } else {
        // An ABSENT dataSources key means the page HAS no bindings.
        preservedDataSources = [];
      }
      if (why) return emit(false, { error: bindingRefusal(flags['page-id'], why) });
    }
    if (preserveModel) {
      if (probe.configError || !probe.cfg) {
        modelUnread = (probe.configError && probe.configError.message) || probe.deployedError || 'pac wrote no directory for this page';
      } else if (typeof probe.cfg.model === 'string' && probe.cfg.model.trim()) {
        preservedModel = probe.cfg.model.trim();
      } else if (probe.cfg.model !== undefined && probe.cfg.model !== null && probe.cfg.model !== '') {
        modelUnread = `config.json model is ${typeof probe.cfg.model}, not a string`;
      }
    }
    if (overwriteDeployed) {
      overwroteDeployed = true;
    } else {
      const marker = base.readMarker(flags['code-file']);
      const cmp = base.compareWithMarker(marker, {
        pageId: flags['page-id'],
        appId: flags['app-id'],
        deployedText: probe.deployedText,
      });
      if (cmp.marker !== 'present') {
        const why = marker
          ? `the base marker next to ${flags['code-file']} is for page ${marker.pageId} in app ${marker.appId}, not page ${flags['page-id']} in app ${flags['app-id']}`
          : `no base marker for page ${flags['page-id']} in app ${flags['app-id']} next to ${flags['code-file']}`;
        return emit(false, {
          ok: false,
          code: 'no-base',
          pageId: flags['page-id'],
          appId: flags['app-id'],
          error: `${why} — refusing to update, because the deployed page may have changed since this file was downloaded or generated. `
            + 'Record a base with genpage-base.js record, or pass --overwrite-deployed to replace the deployed page deliberately.',
        });
      }
      if (cmp.deployed === 'changed') {
        let localText = '';
        try { localText = base.readPlainText(path.resolve(flags['code-file'])); } catch { /* summary against an unreadable local file */ }
        const lines = base.lineDelta(localText, probe.deployedText);
        let deployedCopy;
        let copyError;
        try {
          const copyPath = base.deployedCopyPath(flags['code-file']);
          writeFileSafe(copyPath, probe.deployedText, { encoding: 'utf8' });
          deployedCopy = copyPath;
        } catch (e) {
          copyError = e.message;
        }
        return emit(false, {
          ok: false,
          code: 'deployed-changed',
          pageId: flags['page-id'],
          appId: flags['app-id'],
          deployedCopy,
          lines,
          error: `the deployed page ${flags['page-id']} has changed since the base marker was recorded `
            + `(${lines.added} lines added, ${lines.removed} removed versus ${flags['code-file']}) — refusing to update, `
            + 'because this upload would discard those edits. '
            + (deployedCopy ? `A copy of the deployed page is at ${deployedCopy}. ` : '')
            + (copyError ? `The deployed copy could not be written (${copyError}). ` : '')
            + 'Merge it, or pass --overwrite-deployed to replace the deployed page deliberately.',
        });
      }
    }
  }

  try {
    const res = await cli.upload({
      appId: flags['app-id'],
      pageId: flags['page-id'] || undefined,
      codeFile: flags['code-file'],
      compiledCodeFile: flags['compiled-code-file'] || undefined,
      name: pageName.value || preservedName || undefined,
      prompt: prompt.value,
      agentMessage: agentMessage.value,
      // Passed through as the CSV the caller typed; upload() normalizes array-or-string. When the
      // caller said nothing on an update, this carries the page's EXISTING bindings so they survive.
      dataSources: flags['data-sources'] || preservedDataSources || undefined,
      model: flags.model || preservedModel || undefined,
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
    const warnings = [
      ...(modelUnread ? [`could not read page ${flags['page-id']}'s current model (${modelUnread}), so this update stored it empty — pass --model to set it`] : []),
      ...(nameUnread ? [`could not read page ${flags['page-id']}'s current name (${nameUnread}), so pac may have renamed it to its navigation title — pass --name-file to set it`] : []),
      ...(nameChanged ? [`page ${flags['page-id']}'s name ${JSON.stringify(nameChanged)} has a double quote (") pac cannot store as it is, so the page now shows \\" there — pass --name-file with typographic quotes (“ ”) or an apostrophe to fix it`] : []),
      ...(nameUnsent ? [`page ${flags['page-id']}'s name ${JSON.stringify(nameUnsent.current)} could not be sent to keep it (${nameUnsent.refusal}), so pac may have renamed the page to its navigation title — give it a name without % or a double quote, or install pac as a .NET tool, which receives any name`] : []),
    ];
    // After the upload, not before emit's caller returns. The post-upload probe is removed inside
    // recordObservedBase, so this emit — which may process.exit — does not leak it.
    if (pageId) await recordObservedBase({ cli, flags, pageId, base, warnings, mkdtempSync: deps.mkdtempSync, rmSync: deps.rmSync });
    return emit(true, {
      ok: true,
      pageId,
      appId: flags['app-id'],
      ...(overwroteDeployed ? { overwroteDeployed: true } : {}),
      updated: !!flags['page-id'],
      ...(warnings.length ? { warnings } : {}),
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
