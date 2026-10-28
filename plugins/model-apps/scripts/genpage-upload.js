#!/usr/bin/env node
'use strict';
// genpage-upload: deploy ONE generative page through the SDK, from a code file and the files that carry its text.
//
// WHY THIS SCRIPT EXISTS (#589). A prompt is arbitrary user text: it carries quotes, newlines,
// `%VAR%`, `&`, `|` and non-ASCII, and it used to reach the deploy as part of a command line the
// /genpage skill composed in Markdown — observed live to fail with
//
//   Error: Not a valid command.
//   Parse failed on: Inspection
//   Was it quote wrapped? No, be sure to wrap values that contain spaces.
//
// …for a prompt containing an ASCII-quoted multiword page name. The workaround people reach for is
// to EDIT the approved prompt (swap in typographic quotes), which silently breaks prompt
// provenance — the page is then built from text the user never approved.
//
// So this script is the one entry point both skills use, and the prompt never becomes part of a
// command line: it is read from a FILE and handed to the page backend (lib/genpage-sdk.js) as a value.
// The page is written through the SDK, so there is no longer a `pac` process whose arguments could
// mangle anything; the file inputs stay, because the agent that runs this writes text to files.
//
// Usage:
//   node scripts/genpage-upload.js --env <orgUrl> --code-file <path>
//        --prompt-file <path> --agent-message-file <path>
//        [--app-id <guid>] [--page-id <guid>] [--name <text>] [--data-sources <csv>]
//
//   `--app-id` is optional for a CREATE: a page needs no app, and one created without it is placed
//   later (by the app that is built around it, or by a later `--add-to-sitemap` upload of another).
//   An UPDATE (`--page-id`) needs it: the page must be proven to be in that app's navigation.
//
//   One update is different: `--page-id` for a page THIS TOOL created and did not finish — its publish failed, or the
//   `--add-to-sitemap` placement it was asked for did — completes it. The base marker beside the code file records that
//   (`unfinished`), the page is published and, with `--add-to-sitemap`, placed, and the proof of the page's place in the app's
//   navigation that every other update makes is replaced by that marker, for that page only. The failure that leaves a page
//   unfinished says to run the same command again with `--page-id <id>` added.
//
//   `--add-to-sitemap` writes the page's entry in the app's navigation with a title in the environment's BASE language (read with the
//   backend's `baseLanguage()`, as `genpage.js add-to-app` does; also when this completes a placement an earlier run began): a title in a
//   language the environment has not provisioned does not show. A language that cannot be read fails the placement before the app is
//   touched, and the report says only what is known — the page is written and published, its placement is unfinished, this run changed
//   nothing in the app's navigation (and, when it completes a placement an earlier run began, did not look at what that run saved there) —
//   and the page is completed by the same command with `--page-id` added.
//
//   `--prompt` / `--agent-message` are accepted for short, shell-safe text, but `--prompt-file` is
//   the documented path precisely because it cannot be mangled by a shell. `--compiled-code-file` is
//   refused (see main): the page is compiled from the checked `--code-file` itself.
//
//   `--solution <unique name>` is the solution the page joins (AB#6443257). A page made through the SDK joins none on its own, and nothing
//   else brings it into one — the add of an app brings its sitemap, never the pages its navigation opens — so a run that was given a
//   solution and made pages left them out of it. The solution is read BEFORE anything is written (a name that is no unmanaged solution, or
//   an environment that cannot say the page table's component type, refuses the upload with nothing made), and the page is added LAST,
//   once it is written, published and placed: the result then says `solution` and `addedToSolution: true`. A system solution (Default,
//   Active, Basic) holds every component already, so it is neither read nor added to (`addedToSolution: false`, `systemSolution: true`).
//   An add that fails is a failure (exit 1, `code: "solution-add-failed"`, the page's id): the page works and is not in the solution, and
//   the error names the one command that adds it (add-page-to-solution.js) — never a second create. An update may name it too: the page
//   then joins the solution once it is saved, which is how a create that did not finish, run again with `--page-id`, still joins it.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { makeGenpageSdk, suppliedButBlank, sourceText, dataSourcesOf } = require('./lib/genpage-sdk.js');
const { makeThrottleBudget } = require('./lib/throttle-budget.js');
const { leftOnDiskWarning } = require('./lib/left-on-disk.js');
const { griffelStyleProblems, griffelProblemsNotIn, describeGriffelRefusal, describeGriffelWarning } = require('./lib/griffel-styles.js');
const { commandArgOrPlaceholder } = require('./lib/cli-failure.js');
const genpageBase = require('./lib/genpage-base.js');
const { writeFileSafe } = require('./lib/safe-fs.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');

const KNOWN = ['env', 'app-id', 'code-file', 'compiled-code-file', 'page-id', 'name', 'name-file',
  'data-sources', 'clear-data-sources', 'prompt', 'prompt-file', 'agent-message', 'agent-message-file',
  'model', 'connectors', 'actions', 'add-to-sitemap', 'overwrite-deployed', 'solution'];
// Bare switches; every other flag carries a value.
const SWITCHES = ['add-to-sitemap', 'clear-data-sources', 'overwrite-deployed'];
const NEED_VALUE = KNOWN.filter((f) => !SWITCHES.includes(f));

const USAGE = 'Usage: node scripts/genpage-upload.js --env <orgUrl> --code-file <path> '
  + '--prompt-file <path> --agent-message-file <path> [--app-id <guid>] [--page-id <guid>] [--name-file <path> | --name <text>] '
  + '[--data-sources <csv>] [--clear-data-sources] [--model <id>] '
  + '[--connectors <path>] [--actions <path>] [--add-to-sitemap] [--overwrite-deployed] [--solution <unique name>]'
  + ' (--app-id is required with --page-id and with --add-to-sitemap; --page-id alone finishes a page this tool created and did not finish)';

// The skill writes these inputs — the prompt, agent-message and page-name files, connectors.json, actions.json —
// into the working directory just before the upload, and a write through a link left at one of those names (a
// symbolic link, a junction, or a hard link whose other name lives elsewhere) rewrites the file it points to,
// outside the working directory included. The skill checks each name before it writes (SKILL.md Phase 6); this is
// the check that holds when that step was skipped: the upload stops, and says the linked file may have been
// changed. Returns null for a plain file, and for a path that is not there (the read reports that).
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
    // download` (what an earlier release used) wrote the recovered `prompt.txt` starting `ef bb bf`,
    // and the documented edit flow re-feeds exactly that file through `--prompt-file`, so a folder
    // downloaded then still carries it. Node's 'utf8' decode keeps the BOM as U+FEFF, so the prompt
    // handed to the deploy would begin with an invisible character — silently altering the first
    // character of a prompt the user approved. Only the LEADING one is removed:
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

// Reads the deployed page once, for the update's guards: the base-marker comparison needs its source, and the Griffel check
// compares a file with it. It never rejects — a page that cannot be read is `deployedError`, and one that is not there says
// so (`notFound`), so the caller reaches its verdicts in its own order. `page` is the SDK's projection of the page (its
// `dataSources` are what an upload that names none leaves in place).
async function probeDeployedPage(genpage, pageId) {
  try {
    const page = await genpage.read(pageId);
    return { page, deployedText: page.source, deployedError: null, notFound: false };
  } catch (e) {
    return { page: null, deployedText: null, deployedError: (e && e.message) || String(e), notFound: !!(e && e.code === 'GENPAGE_NOT_FOUND') };
  }
}

// What a file holding a JSON array of bindings (--connectors / --actions) says, or why it cannot be used. The array goes to the
// page's config.json as it is: the SDK neither validates nor resolves a binding.
function readBindings(flag, file, readFile) {
  let parsed;
  try {
    // A BOM is not part of the JSON; an editor on Windows adds one.
    parsed = JSON.parse(String(readFile(path.resolve(file), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, error: `--${flag} could not be read as JSON: ${(e && e.message) || e}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `--${flag} must hold a JSON array (the bindings the page uses), not ${parsed === null ? 'null' : typeof parsed}` };
  return { ok: true, value: parsed };
}

// After a successful upload, record the hash of the file we sent. A readback whose hash equals
// that file (a BOM and a final CRLF are not a difference) confirms the service stored it:
// source 'upload'. A readback that differs must not become the trusted deployed hash — a save
// can land between the upload and the readback, and recording it would make the next update
// treat someone else's page as our base. Record the uploaded hash as 'upload-unverified', with
// the line delta, so the next update refuses deployed-changed until genpage-base.js check. A
// failed readback is the same unverified marker. The whole step is best-effort: the upload
// already succeeded, and a throw here would report that create as a failure without a page id,
// so a retry could create a second page. A failed marker write deletes any previous marker: a
// stale base is worse than no base. Answers the marker it wrote, or null when it wrote none.
//
// `unfinished` marks a page this upload CREATED and has not finished: it is recorded with the marker (lib/genpage-base.js) so that naming the page again completes it
// (completionMarker) — and a marker that could not be written is no way to complete anything, which the caller has to know to say so (hence the answer).
async function recordObservedBase(args) {
  try {
    return await writeObservedBase(args);
  } catch (e) {
    args.warnings.push(`could not record a base marker (${(e && e.message) || e}) — a later update will refuse no-base until the page is recorded`);
    return null;
  }
}

async function writeObservedBase({ genpage, flags, pageId, base, warnings, checkedText, unfinished }) {
  const codeFile = flags['code-file'];
  // The marker sits beside the file the caller named, which must still be a regular file with one name: readPlainText refuses a link, or a file
  // that is gone, as it always did. What the marker records is the hash of the bytes that were checked and sent (`checkedText`) — never a new
  // read of the file, which may have been saved again since; a later check then sees that save as a local change, which it is.
  try {
    base.readPlainText(path.resolve(codeFile));
  } catch (e) {
    warnings.push(`could not read ${codeFile} to record a base marker (${e.message}) — a later update will refuse no-base until the page is recorded`);
    try { base.deleteMarker(codeFile); } catch (del) {
      warnings.push(`the previous base marker could not be removed (${del.message})`);
    }
    return null;
  }
  const localText = checkedText;
  const localSha256 = base.pageHash(localText);
  let deployedSha256 = localSha256;
  let source = 'upload';
  try {
    const downloaded = (await genpage.read(pageId)).source;
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
  }
  try {
    return base.writeMarker(codeFile, {
      version: 1,
      pageId,
      // No app for a page created without one: the marker then records the page alone, and the first update that names
      // the app the page was placed in goes ahead on it (lib/genpage-base.js compareWithMarker) and records the app.
      ...(flags['app-id'] ? { appId: flags['app-id'] } : {}),
      deployedSha256,
      localSha256,
      source,
      ...(unfinished ? { unfinished } : {}),
    });
  } catch (e) {
    warnings.push(`could not write the base marker (${e.message}) — a later update will refuse no-base until the page is recorded again`);
    try { base.deleteMarker(codeFile); } catch (del) {
      warnings.push(`the previous base marker could not be removed (${del.message})`);
    }
    return null;
  }
}

// The base marker of the page this upload is COMPLETING, or null. Only an update that names a page can be one, and only a marker that says `unfinished` for exactly that
// page counts: another page's marker, a finished page's, none, or one that cannot be read is "not completing", and the ordinary rules apply, whatever they say.
function completionMarker(flags, base) {
  if (!flags['page-id'] || typeof flags['code-file'] !== 'string' || !flags['code-file']) return null;
  let marker;
  try { marker = base.readMarker(flags['code-file']); } catch { return null; }
  return marker && marker.unfinished && marker.pageId === String(flags['page-id']).toLowerCase() ? marker : null;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emit || emitResult;
  const readFile = deps.readFile || fs.readFileSync;
  const makeBackend = deps.makeGenpageSdk || makeGenpageSdk;

  const flagError = validateFlags(argv, { known: KNOWN, needValue: NEED_VALUE });
  if (flagError) return emit(false, { error: `${flagError}\n${USAGE}` });
  const { flags } = parseArgs(argv);

  for (const required of ['env', 'code-file']) {
    if (typeof flags[required] !== 'string' || !flags[required]) {
      return emit(false, { error: `--${required} is required\n${USAGE}` });
    }
  }
  const base = deps.base || genpageBase;
  // An upload that CREATED a page and did not finish it — the publish failed, or the placement it was asked for did — leaves a base marker that says so
  // (lib/genpage-base.js `unfinished`). Naming that page again with --page-id COMPLETES it: it is published and, with --add-to-sitemap, placed, without the proof an
  // ordinary update makes that the page is in the app's navigation — an unfinished page is not in it yet, so that proof could never be made. The marker is for one
  // page, so this is for that page alone; for any other the rules below apply as they always did.
  const completing = completionMarker(flags, base);
  // A create needs no app — a page is a row of its own, placed by whatever app names it — but an update must prove the page is in the app
  // it names, and a placement is an edit of that app: both need the app's id. A page that was created with no app and is being completed needs none either.
  if (flags['page-id'] && (typeof flags['app-id'] !== 'string' || !flags['app-id']) && !(completing && !completing.appId)) {
    return emit(false, { error: `--app-id is required with --page-id: an update must name the app the page is placed in\n${USAGE}` });
  }
  const addToSitemap = flags['add-to-sitemap'] === true || flags['add-to-sitemap'] === 'true';
  if (addToSitemap && (typeof flags['app-id'] !== 'string' || !flags['app-id'])) {
    return emit(false, { error: `--add-to-sitemap needs --app-id: the page is added to that app's navigation. Pass --app-id, or drop --add-to-sitemap to create the page with no app\n${USAGE}` });
  }
  // A page created with no app is completed into an app only by placing it there: an app named without a placement would attach the page's tables to an app
  // that does not hold the page, which is what an ordinary update proves it does not do.
  if (completing && !completing.appId && typeof flags['app-id'] === 'string' && flags['app-id'] && !addToSitemap) {
    return emit(false, { error: `page ${flags['page-id']} was created with no app, so completing it into app ${flags['app-id']} needs --add-to-sitemap: the page is placed in that app, not merely attached to it. Pass --add-to-sitemap, or drop --app-id to only publish the page\n${USAGE}` });
  }
  // A page whose create was asked to place it is not finished until it is placed. The marker keeps that, and the run that completes it has to ask for it again — it is
  // the one thing in the command that the marker cannot stand in for, and a run that left it out would clear the page's unfinished state with the placement undone,
  // leaving a page no later update could prove is in the app.
  if (completing && completing.unfinished === 'place' && !addToSitemap) {
    return emit(false, { error: `page ${flags['page-id']} was created to be placed in app ${completing.appId || flags['app-id']}, and it is not finished until it is placed: run the same command again with --page-id ${flags['page-id']} added and --add-to-sitemap kept\n${USAGE}` });
  }
  // Refused, not passed on. The page is compiled from the TypeScript in --code-file, which is what the Griffel check below reads; JavaScript
  // compiled elsewhere would be deployed in its place, and compiled output names makeStyles in ways the check does not read as Griffel's
  // (`(0, x.makeStyles)(…)` after a require), with nothing to tie the file to the source that was checked — so a page could ship a shorthand
  // Griffel drops with no check at all. No flow of this plugin sends it.
  if (flags['compiled-code-file'] !== undefined) {
    return emit(false, {
      error: '--compiled-code-file is not accepted: the Griffel check reads the TypeScript in --code-file, and JavaScript compiled '
        + 'elsewhere would be deployed without it. Leave it out — the page is compiled from the --code-file it is given.',
    });
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

  // An EMPTY prompt or agent-message is refused rather than defaulted. The page backend substitutes
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
  // REFUSED, not silently dropped. An update cannot add a sitemap entry, and one that quietly discards
  // the flag leaves the caller believing a placement happened. (Completing a page this tool created and did not finish is the one update that places it.)
  if (addToSitemap && flags['page-id'] && !completing) {
    return emit(false, {
      error: '--add-to-sitemap cannot be combined with --page-id: an update cannot add a sitemap '
        + 'entry, and the page it names is already placed. Drop one of the two.',
    });
  }

  // The two binding files are read here, as the page's `connectorBindings` / `actionBindings` (bare JSON arrays), and checked first for the
  // same reason as the text files (notPlainFile). An omitted flag leaves a page's bindings as they are; `[]` clears them.
  const bindings = {};
  for (const [flag, key] of [['connectors', 'connectorBindings'], ['actions', 'actionBindings']]) {
    if (typeof flags[flag] !== 'string' || !flags[flag]) continue;
    const linked = notPlainFile(path.resolve(flags[flag]));
    if (linked) return emit(false, { error: `--${flag} ${linked}` });
    const read = readBindings(flag, flags[flag], readFile);
    if (!read.ok) return emit(false, { error: read.error });
    bindings[key] = read.value;
  }

  // The page is read ONCE, here, and everything after is decided on these bytes: the Griffel check below, an update's comparison with the deployed page, the base marker's hash,
  // and what is written to the page. An update reads the deployed page before it writes — seconds in which the file can be saved again — and reading the file again then would
  // deploy bytes nothing here checked. A file that cannot be read is refused: there is nothing to check, or to send. The text is the bytes as they are, bar one leading BOM
  // (the maker stores none) — and bytes that are not UTF-8 are refused, since the page is stored as UTF-8 text and a decode that replaced a byte would send a page nobody checked.
  let checkedText;
  try {
    checkedText = sourceText(fs.readFileSync(path.resolve(flags['code-file'])));
  } catch (e) {
    return emit(false, { error: `--code-file ${e && e.code === 'GENPAGE_SOURCE_NOT_UTF8' ? 'is not usable: ' : 'could not be read: '}${(e && e.message) || e}` });
  }

  // The Griffel check (AB#6691124), where every page upload passes: a /genpage create, an edit-flow update and a browser-verify fix all go through this script, so a page whose
  // `makeStyles` writes one of the ten shorthands Griffel drops at runtime is refused here whether or not the skill's own gate (scripts/check-griffel-styles.js) was run before
  // it — the compile does not execute makeStyles, and the page would otherwise deploy and render without its border, colour or reset. It is made on the bytes read above,
  // which are the ones the page is written from.
  // A CREATE is refused here, before anything is read from the environment. An UPDATE is held to the check by what it ADDS: the page is already deployed, possibly with a key Griffel drops that an
  // earlier version of the plugin let through, and the same bytes sent again ship nothing new — so the file is compared with the deployed page, which an update reads anyway for
  // its base check, and only a key that page did not have stops the upload (below, once it is read).
  const styleProblems = griffelStyleProblems(checkedText).problems;
  // The checker command the message suggests names the file: as one argument no shell reads anything in, or — for a path a shell cannot be given literally — as a
  // placeholder, with the path named in a sentence instead (lib/cli-failure.js commandArg; a path can come from an untrusted checkout).
  const griffelFile = commandArgOrPlaceholder(flags['code-file'], '<file>');
  const griffelWords = { surface: 'upload', subject: flags['code-file'], command: `node scripts/check-griffel-styles.js --file ${griffelFile.arg}`, ...(griffelFile.note ? { note: griffelFile.note } : {}) };
  const stylesRefusal = (problems) => ({
    ok: false,
    code: 'griffel-shorthand',
    error: describeGriffelRefusal(problems, flags['code-file'], griffelWords),
    problems,
  });
  if (styleProblems.length && !flags['page-id']) return emit(false, stylesRefusal(styleProblems));

  // The waiting a run does for a throttled service is bounded at five minutes (lib/throttle-budget.js): this one budget is the page write's and the backend's HTTP client's alike — its reads and its publish wait out a throttle too. A wait of more
  // than a few seconds is announced on stderr — stdout carries the JSON result — so that a command that is silent for minutes is not mistaken for a hung one.
  const warn = (message) => process.stderr.write(`WARNING: ${message}\n`);
  const genpage = makeBackend(flags.env, { warn, throttle: makeThrottleBudget({ warn }) });
  // The backend's workspace is removed BEFORE anything is reported: emitResult calls process.exit, so a cleanup placed after an emit never
  // runs, and that workspace holds the page's source. dispose() answers when the storage calls the backend had under way have settled and the
  // folder is gone — or says, in `{ left }`, which folder is not (a handle a scanner holds), and that is reported with the result: a success that left
  // the page's source in the temp directory says so.
  let outcome;
  let leftOnDisk = null;
  try {
    outcome = await deploy({
      flags, genpage, base, completing, checkedText, styleProblems, griffelWords, stylesRefusal,
      prompt, agentMessage, pageName, bindings, clearDataSources, overwriteDeployed, addToSitemap,
    });
  } finally {
    try { leftOnDisk = leftOnDiskWarning(await genpage.dispose()); } catch { /* the backend's own folder; nothing to say when it cannot even answer */ }
    // A deploy that threw has no result to carry it: that failure reaches the caller as it is, so the warning goes to stderr beside it.
    if (leftOnDisk && !outcome) process.stderr.write(`WARNING: ${leftOnDisk}\n`);
  }
  if (leftOnDisk) outcome.payload = { ...outcome.payload, warnings: [...(outcome.payload.warnings || []), leftOnDisk] };
  return emit(outcome.ok, outcome.payload);
}

// Everything after the flags and the files have been read and checked: an update's guards, the write, the base marker and the placement in an
// app. It RETURNS what to report — { ok, payload } — instead of reporting it, so that main can remove the backend's workspace first.
async function deploy(context) {
  const { flags, genpage, base, completing, checkedText, styleProblems, griffelWords, stylesRefusal, prompt, agentMessage, pageName, bindings, clearDataSources, overwriteDeployed, addToSitemap } = context;
  const done = (ok, payload) => ({ ok, payload });
  let griffelWarnings = [];
  // The page's own checks, before anything is written. A CREATE has none left (its file was refused above if it was bad); an UPDATE reads the deployed page and compares.
  let overwroteDeployed = false;
  let deployed = null; // what the update's probe read: the page as the SDK projects it
  // The page's id as soon as it is known, kept outside the write's try: an update names it up front, and a create learns it from the backend — from its answer, or from the
  // error it raises once it has sent (`pageId`). Whatever fails after that, the failure carries it.
  let knownPageId = flags['page-id'] || null;
  // The solution the page joins (--solution), read before anything is read for the update or written: a name that is no unmanaged solution, or an environment that
  // cannot say the page table's component type, refuses the upload with nothing made. A system solution is not read (the backend answers it from its name).
  let solutionTarget = null;
  if (typeof flags.solution === 'string' && flags.solution.trim()) {
    try {
      solutionTarget = await genpage.solutionTarget(flags.solution);
    } catch (e) {
      return done(false, {
        ok: false,
        ...(e && typeof e.code === 'string' && e.code ? { code: e.code } : {}),
        error: `nothing was written: the solution ${JSON.stringify(flags.solution.trim())} the page is to join cannot be used — ${(e && e.message) || e}`,
      });
    }
  }
  if (flags['page-id']) {
    // An UPDATE must have a target that EXISTS, and it must be in the app it names: updating a real page through the wrong app would write
    // the page and attach its tables to an app that does not hold it. The page read is the existence proof — a page that is not there is a
    // 404, and an update of it is refused (it would never become a create, as an unknown id once did) — and the app's navigation is the
    // membership proof, SAVED layer included (what the designer holds is the app's page set the maker sees). The two are independent reads, so
    // they run together; the VERDICTS are still reached in order, existence first: a page that does not exist is reported as absent even if
    // the app listing also broke, and a listing that throws surfaces only when its verdict is reached.
    // A page this tool created and did not finish (`completing`) is not in the app's navigation yet — that is what is left to do — so for that page alone the base
    // marker is the proof, and the navigation is not read. Everything else about the update is as for any page.
    const settle = (fn) => Promise.resolve().then(fn).then((value) => ({ value }), (error) => ({ failed: true, error }));
    const [probeResult, membership] = await Promise.all([
      settle(() => probeDeployedPage(genpage, flags['page-id'])),
      completing ? { value: null } : settle(() => genpage.enumeratePages(flags['app-id'], { includeUnpublished: true })),
    ]);
    const probe = probeResult.value;
    if (probe.notFound) {
      return done(false, {
        error: `page ${flags['page-id']} does not exist in this environment — refusing to "update" it. Check the id, or drop `
          + '--page-id to create a page deliberately.',
      });
    }
    if (!completing) {
      if (membership.failed) throw membership.error;
      const appPages = membership.value;
      if (!appPages || appPages.ok !== true) {
        return done(false, {
          error: `cannot verify that page ${flags['page-id']} belongs to app ${flags['app-id']} `
            + `(${(appPages && appPages.error) || 'unknown reason'})`,
        });
      }
      const pages = Array.isArray(appPages.pages) ? appPages.pages : [];
      if (!pages.length) {
        return done(false, {
          error: `app ${flags['app-id']} has no generative pages, or could not be found — cannot verify `
            + `that page ${flags['page-id']} belongs to it`,
        });
      }
      const pageInApp = pages.some((p) => String(p && p.pageId || '').toLowerCase() === String(flags['page-id']).toLowerCase());
      if (!pageInApp) {
        return done(false, {
          error: `page ${flags['page-id']} is not in app ${flags['app-id']}'s navigation — updating it `
            + 'with this app id would attach its tables to that app; use the id of the app the page belongs to',
        });
      }
    }

    // The deployed page is read on EVERY update: the base-marker check needs its source, and so does the Griffel comparison. An unreadable
    // page is `deployed-unreadable`. `--overwrite-deployed` is the only bypass, and it is never the default. The read and the write are
    // separate calls; a save that lands between them (seconds) is not detected here — the write itself refuses a page whose version
    // moved after it was read.
    // An update that names no data sources, model, name or bindings leaves them as they are (the SDK writes only what differs), so nothing
    // of the page's own is read back and re-sent; `--clear-data-sources` unbinds on purpose.
    deployed = probe.page;
    if (probe.deployedError && !overwriteDeployed) {
      return done(false, {
        ok: false,
        code: 'deployed-unreadable',
        pageId: flags['page-id'],
        appId: flags['app-id'],
        error: `cannot read the deployed page ${flags['page-id']} (${probe.deployedError}) — refusing to update, `
          + 'because the page may have changed and this upload would replace it unseen. Pass --overwrite-deployed '
          + 'to replace it deliberately, or retry when the page can be read.',
      });
    }
    // The Griffel check for an UPDATE (see the create check above): what the deployed page already has ships nothing new. A file that IS the deployed page's text (a BOM and final
    // CRLF are not a difference) is a re-send as it is, so none of its problems is new; otherwise a key counts as already there when the deployed page has it (griffelProblemsNotIn).
    // Only a key, or a call the checker cannot read, that the deployed page did not have stops the upload — and --overwrite-deployed is no way past it: that flag is about edits made
    // to the deployed page, not about what this file writes. When the deployed page could not be read (possible only under --overwrite-deployed) nothing says which keys it had; the
    // page exists, and the release before this check updated it as it was, so the update goes on with a warning — as the build does for a page it has no record of.
    if (styleProblems.length) {
      if (probe.deployedText === null) {
        griffelWarnings = [describeGriffelWarning(styleProblems, flags['code-file'], { ...griffelWords, standing: 'undetermined' })];
      } else {
        const sameAsDeployed = base.pageHash(checkedText) === base.pageHash(probe.deployedText);
        const { added, inherited } = sameAsDeployed
          ? { added: [], inherited: styleProblems }
          : griffelProblemsNotIn(styleProblems, griffelStyleProblems(probe.deployedText).problems);
        if (added.length) return done(false, stylesRefusal(added));
        griffelWarnings = [describeGriffelWarning(inherited, flags['code-file'], { ...griffelWords, standing: 'inherited' })];
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
          ? `the base marker next to ${flags['code-file']} is for page ${marker.pageId}${marker.appId ? ` in app ${marker.appId}` : ''}, not page ${flags['page-id']} in app ${flags['app-id']}`
          : `no base marker for page ${flags['page-id']} in app ${flags['app-id']} next to ${flags['code-file']}`;
        return done(false, {
          ok: false,
          code: 'no-base',
          pageId: flags['page-id'],
          appId: flags['app-id'],
          error: `${why} — refusing to update, because the deployed page may have changed since this file was downloaded or generated. `
            + 'Record a base with genpage-base.js record, or pass --overwrite-deployed to replace the deployed page deliberately.',
        });
      }
      if (cmp.deployed === 'changed') {
        const lines = base.lineDelta(checkedText, probe.deployedText);
        let deployedCopy;
        let copyError;
        try {
          const copyPath = base.deployedCopyPath(flags['code-file']);
          writeFileSafe(copyPath, probe.deployedText, { encoding: 'utf8' });
          deployedCopy = copyPath;
        } catch (e) {
          copyError = e.message;
        }
        return done(false, {
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

  // The page is written from the bytes checked above — `checkedText` is what the Griffel check, the comparison with the deployed page and the base marker's hash were made on —
  // and never from a new read of the file, which may have been saved again since. There is no copy of it to stage for a process to read: the SDK takes the text.
  try {
    const written = flags['page-id']
      ? await genpage.update(flags['page-id'], {
        source: checkedText,
        name: pageName.value || undefined,
        prompt: prompt.value,
        agentMessage: agentMessage.value,
        // An omitted data-source list leaves the page's own; `--clear-data-sources` is the one way to empty it.
        dataSources: clearDataSources ? [] : (flags['data-sources'] || undefined),
        model: flags.model || undefined,
        ...bindings,
        caller: 'upload',
        appId: flags['app-id'],
        sourceFile: flags['code-file'],
      })
      : await genpage.create({
        source: checkedText,
        name: pageName.value || undefined,
        prompt: prompt.value,
        agentMessage: agentMessage.value,
        dataSources: flags['data-sources'] || undefined,
        model: flags.model || undefined,
        ...bindings,
      });
    const pageId = (written && (written.pageId || written.id)) || null;
    knownPageId = pageId || knownPageId;
    const warnings = [...griffelWarnings, ...((written && written.warnings) || [])];
    // The page is written (and may be published): from here on a failure is reported WITH the page's id, so the caller can go on from it.
    // `pageId` is the one value a caller needs in order to continue (placing the page in an app, a follow-up edit).
    const failed = (error) => ({ ok: false, pageId, ...(flags['app-id'] ? { appId: flags['app-id'] } : {}), error });
    // An upload that CREATED the page, or is completing one that was created, is not finished until the page is published and — when it was asked to place it — placed.
    // Until then the base marker says what is left (`unfinished`: `place`, or `publish`), and that is what lets the page be completed by naming it again (completionMarker).
    const creating = !flags['page-id'];
    const finishing = creating || !!completing;
    const publishFailed = !!(written && written.publish && written.publish.kind === 'failed');
    const placementWanted = addToSitemap && !!flags['app-id'];
    // After the write, not before it is reported: the readback inside recordObservedBase is a read like any other, and the backend is disposed only when this returns.
    const unfinished = finishing ? (placementWanted ? 'place' : (publishFailed ? 'publish' : undefined)) : undefined;
    const recorded = pageId ? await recordObservedBase({ genpage, flags, pageId, base, warnings, checkedText, unfinished }) : null;
    if (publishFailed) {
      const detail = written.publish.detail;
      if (!finishing) {
        return done(false, failed(`page ${pageId} was updated and saved, but publishing it failed (${detail}) — `
          + `the runtime still serves the previously published copy. Run the upload again as an update (--page-id ${pageId}) to publish it: a page that already holds the content is published, not written again.`));
      }
      // A page that was just created is in no app's navigation, so run as an update it would be refused for that; the marker is what lets exactly this page through.
      const way = recorded
        ? `To finish it, run the same command again with --page-id ${pageId} added and nothing else changed: the base marker beside ${flags['code-file']} records that this upload created the page and did not finish it, so that run publishes it${placementWanted ? ' and places it in the app' : ''} without the check of the app's navigation an ordinary update makes — for this page only — and a page that already holds the content is published, not written again.`
        : `The base marker that would let this tool finish it could not be written, so publish page ${pageId} in Maker, or delete it (after asking the user — it is permanent: node scripts/genpage.js delete --env ${flags.env} --page-id ${pageId} --allow-destructive) and create it again.`;
      return done(false, failed(`page ${pageId} was ${creating ? 'created' : 'saved'}, but publishing it failed (${detail}) — it is not live yet. ${way}`));
    }
    let placement = null;
    // Placing the page in an app is an edit of that app, which pac's `--add-to-sitemap` did with the upload: the page becomes a sub-area of the
    // app's navigation, and the default view of each table the page reads joins the app's components so the maker's "/" picker lists it.
    // An upload that names an app but no placement pins the views alone (as pac did). A failed PLACEMENT is a failure — the page is written but not
    // in the app — while failing to pin views is only a warning, since the page works without them. An upload with nothing to place and no table to pin
    // does not touch the app at all: placing reads it, and a read that was not needed could only fail.
    const tables = clearDataSources ? [] : (flags['data-sources'] || (deployed && deployed.dataSources) || []);
    // Completing a placement an earlier run began: that run may have SAVED the navigation and failed to publish the app, which leaves nothing to write and the app
    // still to publish — so the backend is told to finish it: publish the app, and check that the page shows in the navigation that runs. It throws when it cannot
    // (the publish failed, or the published navigation does not show the page), and the marker is cleared only after it returns.
    const finishingPlacement = !!(completing && completing.unfinished === 'place' && addToSitemap && flags['app-id']);
    if (pageId && flags['app-id'] && (addToSitemap || (dataSourcesOf(tables) || []).length)) {
      // The title of the page's entry in the navigation is written in the environment's BASE language: a title in a language the environment has not provisioned does not show, and the SDK
      // writes one in its own default, 1033, when it is told nothing — an English entry in a German-only environment, reported as a success. `genpage.js add-to-app` reads the language for the
      // same reason, with the same operation, and so does the run that completes a placement an earlier one began: it is this placement again. An unreadable language fails the placement,
      // nothing guessed in its place — as it fails `add-to-app`: the page is written and the marker says what is left. A pin has no title to write, so an upload that places no page asks the
      // environment nothing.
      let languageCode;
      if (addToSitemap) {
        try {
          languageCode = await genpage.baseLanguage();
        } catch (e) {
          // The READ failed, not the placement: the app was never read or touched, so the only thing known of its navigation is that this run changed nothing in it, and that is all this says. "NOT added … add
          // the page in Maker" would be false for a page an earlier run already put in the app's saved navigation (its publish is what failed) or even in the published one, and it would send the user to add
          // a page the navigation holds. Only the run that completes a placement an earlier one began (`finishingPlacement`) can be in that case, so only it says it did not look at what that run left; a page
          // this run created is in no navigation, and one created with no app begins its first placement here. `saved` is not set: it claims a saved navigation, which on a first attempt does not exist.
          // The marker was written before this (`unfinished: 'place'`), so the same command completes the placement once the language can be read. The read's own words
          // (`HTTP 503 from …/organizations?$select=languagecode: …`) do not say what was being read or why it matters here.
          const left = finishingPlacement ? ', and did not look at what an earlier run saved or published there, so the page may already be in it' : '';
          const verb = `node scripts/genpage.js add-to-app --env ${flags.env} --app-id ${flags['app-id']} --page-id ${pageId}`;
          const way = recorded
            ? `To finish it, run the same command again with --page-id ${pageId} added and nothing else changed, once the language can be read: the page is already published, so only its placement is made, for this page only (the base marker beside ${flags['code-file']} records that it is not done). Or run ${verb}, which places the page, or finishes a placement that was saved, whichever is left.`
            : `Once the language can be read, ${verb} places the page, or finishes a placement that was saved, whichever is left.`;
          return done(false, failed(`page ${pageId} was ${creating ? 'created' : 'saved'} and published, but its placement in app ${flags['app-id']}'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read (${(e && e.message) || e}); no other language is assumed in its place. This run changed nothing in the app's navigation${left}. ${way}`));
        }
      }
      try {
        placement = await genpage.placeInApp(flags['app-id'], {
          pages: addToSitemap ? [{ pageId, title: (written && written.name) || pageName.value || (deployed && deployed.name) }] : [],
          dataSources: tables,
          ...(languageCode === undefined ? {} : { languageCode }),
          ...(finishingPlacement ? { finish: true } : {}),
        });
        for (const w of placement.warnings || []) warnings.push(w);
      } catch (e) {
        if (addToSitemap) {
          // A placement the backend SAVED and could not publish, or whose publish it could not see in what runs (`saved: true`), did not fail: the page is in the app's saved navigation, and the app's publish
          // is what is left. "NOT added … add the page in Maker" sent the user to add a page the navigation already holds.
          if (e && e.saved === true) {
            const finish = recorded && finishing
              ? ` To finish it, run the same command again with --page-id ${pageId} added and nothing else changed: the page is already published and placed, so only the app is published again and checked (the base marker beside ${flags['code-file']} records that it is not done).`
              : '';
            return done(false, failed(`page ${pageId} was ${creating ? 'created' : 'saved'} and published, and it is placed in app ${flags['app-id']}'s saved navigation, but the app's publish is not finished: ${(e && e.message) || e}.${finish}`));
          }
          const again = recorded && finishing
            ? `, or run the same command again with --page-id ${pageId} added and nothing else changed: the page is already published, so only its placement is made, for this page only (the base marker beside ${flags['code-file']} records that it is not done)`
            : '';
          return done(false, failed(`page ${pageId} was ${creating ? 'created' : 'saved'} and published, but NOT added to app ${flags['app-id']}'s navigation: ${(e && e.message) || e}. `
            + `Add the page to the app navigation with node scripts/genpage.js add-to-app --env ${flags.env} --app-id ${flags['app-id']} --page-id ${pageId}${again}.`));
        }
        warnings.push(`the page was written, but its tables' default views could not be added to app ${flags['app-id']}'s components, so the maker's "/" picker may not list them (${(e && e.message) || e})`);
      }
    }
    // Published, and placed where it was asked to be: the page is finished, and the marker stops saying it is not.
    if (recorded && recorded.unfinished) {
      try { base.writeMarker(flags['code-file'], { ...recorded, unfinished: false }); } catch (e) {
        warnings.push(`could not clear the base marker's unfinished state (${(e && e.message) || e}) — running the same command with --page-id ${pageId} completes the page again, which changes nothing`);
      }
    }
    // The solution the page joins, last: the page is written, published and placed by now, so an add that fails leaves a page that works and is not in the
    // solution. That is a failure, said with the one command that adds the page — never a second create, which would make a second page.
    let solutionFacts = {};
    if (solutionTarget) {
      const where = solutionTarget.uniqueName;
      try {
        const joined = await genpage.addToSolution(pageId, solutionTarget);
        solutionFacts = { solution: where, addedToSolution: !!(joined && joined.added), ...(solutionTarget.systemSolution ? { systemSolution: true } : {}) };
      } catch (e) {
        const placedText = placement && placement.added && placement.added.length ? ` and placed in app ${flags['app-id']}'s navigation` : '';
        return done(false, {
          ...failed(`page ${pageId} was ${creating ? 'created' : 'saved'} and published${placedText}, but it was NOT added to solution ${where}: ${(e && e.message) || e}. `
            + `Do not create it again: add it with node scripts/add-page-to-solution.js ${flags.env} ${where} --page-ids ${pageId} (a page the solution already holds is accepted, so running it again changes nothing).`),
          code: 'solution-add-failed',
          solution: where,
          addedToSolution: false,
          ...(warnings.length ? { warnings } : {}),
        });
      }
    }
    return done(true, {
      ok: true,
      pageId,
      ...(flags['app-id'] ? { appId: flags['app-id'] } : {}),
      ...(overwroteDeployed ? { overwroteDeployed: true } : {}),
      updated: !!flags['page-id'],
      ...(written && written.unchanged ? { unchanged: true } : {}),
      ...(placement && placement.added && placement.added.length ? { addedToSitemap: true } : {}),
      ...solutionFacts,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e) {
    // Everything the backend knows about a failed write goes out with it: the page's id (an unknown outcome has one to look for), whether anything was written, and the SDK's own code.
    // The page's id is the one known BEFORE the try or learned in it — a failure after the write cannot drop it.
    const id = (e && e.pageId) || knownPageId;
    return done(false, {
      error: e && e.message ? e.message : String(e),
      ...(id ? { pageId: id, ...(flags['app-id'] ? { appId: flags['app-id'] } : {}) } : {}),
      ...(e && e.outcome ? { outcome: e.outcome } : {}),
      ...(e && typeof e.code === 'string' && e.code ? { code: e.code } : {}),
    });
  }
}

if (require.main === module) {
  main().catch((e) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
module.exports = { main, resolveText, notPlainFile };
