'use strict';
// What a persistent `.maker-workspace` does when it meets an environment other than its own.
//
// The vendored SDK records the environment a workspace was created for in the workspace manifest, and an SDK
// for another environment is refused (`WORKSPACE_ORG_MISMATCH`) before anything is read from or written to the
// workspace. The reason is the one the SDK gives: the workspace's saved copies, baselines and cached metadata
// are the OTHER environment's, and out-of-box ids are equal across environments, so using it would read and
// write the wrong rows.
//
// The plugin hits this when an app folder that was built against one environment is pointed at another
// (`--env`, or `--workspace` naming another environment's folder). A build with --apply is the only entry point
// that opens the app folder's workspace — a dry run, download, ai-preflight, the provision-* scripts, teardown and
// verify work in throwaway ones, and read from the folder only its baseline file (a dry run also reads its manifest,
// to warn) — so --apply turns the refusal into the halt below, and a dry run turns what it finds into a warning.
//
// A dry run does not open the folder because opening binds it: the SDK writes the environment into the manifest
// the first time a workspace is opened. A preview builds nothing, so a folder it bound to the environment it only
// previewed would later refuse the environment the operator meant — with advice that sends them back to, or offers
// to tear down, an environment nothing was ever built in. A preview needs nothing from the folder either: the reads
// its live plan makes all go to the server.
//
// For the same reason the halt tells a folder that was only ever OPENED (the SDK's manifest listing no artifact, and
// its empty folders, with nothing else beside them) from one a build saved into. The first is what a preview of an
// earlier release, or a build that stopped at its start, leaves: no saved copy, receipt or baseline to lose and
// nothing built in that environment, so there is no environment to go back to and nothing to tear down. The check
// is conservative — any other file, a link, or anything it cannot read counts as saved work.
//
// The SDK's own remedy, `cleanWorkspace()`, discards the SDK's saved copies, metadata and baselines (only its own
// folders: the plugin's files beside them stay). The plugin never calls it, and the halt never offers to. Those
// copies can hold edits that were never pushed, and the page-ownership receipts and the baseline
// (last-applied.json) kept beside them belong to the other environment too, so whether to give them up is the
// operator's decision — made through `teardown-model-app.js --clear-workspace`, which already refuses while a
// receipt remains (see also RESET_WORKSPACE in entity-provision.js).
//
// Which spellings of ONE environment the halt has to tell apart from another environment. The SDK compares the
// recorded URL as text, after trimming, lower-casing and dropping trailing slashes, so those never meet it. `--env`
// takes `https://` + a Dataverse host and nothing else (createAzHttpClient refuses the rest), which leaves one way
// for a run of this plugin to meet a workspace recorded under another spelling of its own environment: the host's
// `.api.` form, `<org>.api.crm.dynamics.com` — the host the Web API documentation and the discovery service's
// `ApiUrl` give — against `<org>.crm.dynamics.com`, the host the environment is opened at. The plugin does not fold
// the two into one environment:
// it keys the baseline, the page-ownership receipts, the token it asks for and the origin its HTTP client accepts
// on the host it was given, so the SDK's refusal agrees with the rest of the plugin, and the way out is the host the
// folder was opened with. A manifest written by another tool can also carry a path or a port; no `--env` can match
// that, so only a fresh folder is offered for it.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/discovery-service (the `ApiUrl` of an environment)
const fs = require('node:fs');
const path = require('node:path');
const { dataverseOrigin } = require('./dataverse-auth.js');
const { WORKSPACE_MANIFEST } = require('./workspace-paths.js');

// The code of the SDK's refusal (`WorkspaceOrgMismatchError`, which also carries `workspaceInstanceUrl` and
// `instanceUrl`, the two URLs as they were written).
const WORKSPACE_ORG_MISMATCH = 'WORKSPACE_ORG_MISMATCH';
// The code of the SDK's answer to a folder with no manifest — a workspace that was never opened.
const WORKSPACE_NOT_INITIALIZED = 'WORKSPACE_NOT_INITIALIZED';
// The plugin's own: the halt for a manifest the SDK could not read at all (below). The SDK has no code for it.
const WORKSPACE_MANIFEST_INVALID = 'WORKSPACE_MANIFEST_INVALID';

function isWorkspaceOrgMismatch(err) {
  return !!err && typeof err === 'object' && err.code === WORKSPACE_ORG_MISMATCH;
}

// A manifest.json the JSON parser rejected. The SDK parses it with `JSON.parse` and lets the SyntaxError out as it is: no
// code, a position ("Unterminated string in JSON at position 36"), and on newer Node versions a quote of the file. Its
// name is the only stable mark — the message differs between Node versions — and it is a safe one here because this is
// only ever asked of what opening a workspace, or asking it for its manifest, threw; neither parses any other file.
// Listing artifacts is not such a call: it also parses each listed artifact's saved copy and its metadata (to flag the
// copies with unpushed edits), and a corrupt copy throws the very same SyntaxError. That is why the dry run asks for the
// manifest rather than for a listing (`workspaceBindingNote`).
function isManifestParseFailure(err) {
  return !!err && typeof err === 'object' && err.name === 'SyntaxError';
}

// The origin a URL names, as printable text, or null when it names none.
//
// `dataverseOrigin` is the plugin's definition of an environment, and the only thing printed for one it
// accepts. The workspace manifest is different: the SDK writes whatever URL its caller passed, so a workspace
// from an older plugin or another tool can name something the plugin would not accept today, and the text may
// carry more than an origin:
//   "instanceUrl": "https://user:secret@Contoso.crm.dynamics.com/main.aspx?token=abc"
// `URL.origin` drops credentials, path, query and fragment, so even then only scheme://host[:port] is shown.
function originOf(url) {
  if (typeof url !== 'string') return null;
  const strict = dataverseOrigin(url);
  if (strict) return strict;
  try {
    const parsed = new URL(url.trim());
    return /^https?:$/.test(parsed.protocol) ? parsed.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The host a URL names (lower case, without credentials, port, path, query or fragment), or null for text that is
// not an http(s) URL.
function hostOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

// `contoso.api.crm.dynamics.com` -> `contoso.crm.dynamics.com`: the label that makes a host the API host of the
// environment the host without it names (see the header).
function withoutApiLabel(host) {
  return host.replace(/^([^.]+)\.api\./, '$1.');
}

// How the environment a manifest records relates to the one this run targets:
//   'spelling' — the same host, recorded with more than its origin (a path, a port, credentials)
//   'api-host' — the same environment under its other host (`.api.`)
//   'other'    — another environment
// The `.api.` label is only read as "the API host of the same environment" on a Dataverse host: on any other it is
// just a label, and two such hosts are two places.
function relationOf(recordedUrl, runUrl) {
  const recorded = hostOf(recordedUrl);
  const run = hostOf(runUrl);
  if (!recorded || !run) return 'other';
  if (recorded === run) return 'spelling';
  const dataverse = (host) => dataverseOrigin(`https://${host}`) !== null;
  return dataverse(recorded) && dataverse(run) && withoutApiLabel(recorded) === withoutApiLabel(run) ? 'api-host' : 'other';
}

// The remedies as lines: one is a sentence, several are a list to choose from.
function remedyLines(choices) {
  return choices.length === 1
    ? [`${choices[0][0].toUpperCase()}${choices[0].slice(1)}.`]
    : ['Choose one:', ...choices.map((choice) => `  • ${choice}`)];
}

// Whether the manifest at `file` lists no artifact: the SDK writes `"artifacts": []` when it opens a workspace and
// adds an entry for every artifact it saves. A manifest that does not say it lists none, or cannot be read as one, is
// not "nothing".
function listsNoArtifact(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return !!manifest && typeof manifest === 'object' && Array.isArray(manifest.artifacts) && manifest.artifacts.length === 0;
  } catch {
    return false;
  }
}

// Whether `folder` holds nothing a build saved: the SDK's manifest listing no artifact, and otherwise only empty
// folders — what opening a workspace lays down (`manifest.json`, `.metadata/<type>/` and `<type>/` per artifact type;
// see the header). Conservative on purpose: "nothing" is only answered when every entry was seen and is one of those,
// so a file of any other name (a baseline, a receipt, a journal, an operator's note), a link, a manifest that lists an
// artifact, a tree deeper or larger than that scaffold, and anything that could not be read all count as something.
// Read-only.
function holdsNothing(folder) {
  const MAX_DEPTH = 4; // `.metadata/<type>` is two deep; the rest is margin
  const MAX_ENTRIES = 200; // the scaffold is about twenty folders
  let seen = 0;
  const onlyFolders = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    // `isDirectory()` is false for a link, so a link to a folder is not an empty folder.
    return entries.every((entry) => (seen += 1) <= MAX_ENTRIES && depth < MAX_DEPTH && entry.isDirectory() && onlyFolders(path.join(dir, entry.name), depth + 1));
  };
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return false;
  }
  let manifest = false;
  for (const entry of entries) {
    seen += 1;
    if (entry.isFile() && entry.name === WORKSPACE_MANIFEST) {
      if (!listsNoArtifact(path.join(folder, entry.name))) return false;
      manifest = true;
    } else if (!(entry.isDirectory() && onlyFolders(path.join(folder, entry.name), 1))) {
      return false;
    }
  }
  return manifest;
}

// What the halt, and the note a dry run prints, are written from: how the failure to open the folder relates to this
// run. `err` is what opening the workspace (or asking it for its manifest) threw; null when it is neither the SDK's refusal
// nor a manifest the JSON parser rejected — the caller handles that as it is.
//   relation 'other'     — the folder belongs to another environment (`onlyOpened`: and nothing was ever saved in it)
//   relation 'api-host'  — it belongs to this environment, under its other host name
//   relation 'spelling'  — it belongs to this host, recorded with more than an origin
//   relation 'none'      — its manifest names no usable environment
//   relation 'invalid'   — its manifest is not JSON
function bindingFacts(err, { env, workspaceDir }) {
  const refused = isWorkspaceOrgMismatch(err);
  if (!refused && !isManifestParseFailure(err)) return null;
  const runOrigin = (refused && originOf(err.instanceUrl)) || originOf(env);
  const workspaceOrigin = refused ? originOf(err.workspaceInstanceUrl) : null;
  let relation = 'invalid';
  if (refused) relation = workspaceOrigin ? relationOf(err.workspaceInstanceUrl, runOrigin) : 'none';
  // Absolute: it is printed for the operator to find the folder and to hand to teardown, which is run from wherever they are.
  const folder = path.resolve(workspaceDir);
  return {
    code: refused ? WORKSPACE_ORG_MISMATCH : WORKSPACE_MANIFEST_INVALID,
    runOrigin,
    workspaceOrigin,
    relation,
    folder,
    target: runOrigin || '(unknown)',
    // The `--env` that makes the SDK accept this folder again. The SDK matches the recorded text itself, so it is only
    // available when that text IS an origin the plugin takes; a path or a port on it has no `--env` spelling.
    goBackTo: refused ? dataverseOrigin(err.workspaceInstanceUrl) : null,
    onlyOpened: relation === 'other' && holdsNothing(folder),
  };
}

// The lines of the halt (`preview: false`: the build stopped) or of the dry run's note (`preview: true`: the preview
// ran, and an --apply would stop). They differ in how they open, and in the one remedy that DELETES from an
// environment — it belongs to the refusal an operator acts on, not to a preview.
//
// The folder is printed on a line of its own and never inside a command. It can be copied exactly from there, and no
// quoting of it is right for every shell (see `quoting` below).
function describeBinding(facts, { preview }) {
  const { folder, target, workspaceOrigin, goBackTo } = facts;
  const fresh = 'use a fresh app folder (copy app-spec.json and the files it names into it), or pass --workspace <a new folder>';
  // Said once for every case whose recorded URL is not an https origin: `--env` cannot be given one.
  const unspellable = 'recorded in a form --env cannot take (a path, a port, credentials or another scheme), so no --env value can match it';
  const stopped = preview
    ? 'this preview works in a temporary workspace, so it ran as normal; a build with --apply would stop before reading or writing anything in this app\'s workspace folder'
    : 'the build stopped before reading or writing anything in its workspace folder';
  const lead = (state) => `${stopped}, which ${state}:`;
  // A folder with no environment to go back to is moved, not deleted: it can hold what a new workspace does not get back.
  const noEnvironmentRemedies = [
    ...remedyLines([
      'move the folder aside (rename it) and run again: the build then opens a new workspace for this environment',
      fresh,
    ]),
    'Do not delete it: it can hold page-ownership receipts (the proof a rebuild needs to update pages it created) and the baseline (last-applied.json), which a new workspace does not get back. The build never clears or re-binds a workspace for you.',
  ];
  const lines = [];
  if (facts.relation === 'invalid') {
    lines.push(
      lead('has a manifest.json that is not valid JSON, so it names no environment'),
      `  ${folder}`,
      `  this run targets: ${target}`,
      'The SDK keeps the environment a workspace belongs to in that file, so it cannot tell whether this folder is this environment\u2019s. Nothing in it was read or changed.',
      ...noEnvironmentRemedies,
    );
  } else if (facts.relation === 'none') {
    lines.push(
      lead('records no usable environment in its manifest.json'),
      `  ${folder}`,
      `  this run targets: ${target}`,
      'It names no environment, so there is none to go back to. Nothing in it was read or changed.',
      ...noEnvironmentRemedies,
    );
  } else if (facts.relation === 'spelling') {
    lines.push(
      lead('records this environment\'s URL in a form --env cannot take (a path, a port, credentials or another scheme)'),
      `  ${folder}`,
      `  this run targets: ${target}`,
      `It is the same environment, but the SDK compares the recorded URL as text (ignoring only case and trailing slashes), so no --env value can match it. Nothing was changed.`,
      ...remedyLines([`${fresh} — the old folder is left as it is`]),
    );
  } else if (facts.relation === 'api-host') {
    lines.push(
      lead('was opened for this environment under its other host name'),
      `  ${folder}`,
      `  workspace was opened as: ${workspaceOrigin}`,
      `  this run targets:        ${target}`,
      `These are two host names of one environment (the .api. host is its API URL), but the SDK binds a workspace to the URL it was opened with, compared as text, and this plugin keeps the folder's page-ownership receipts and baseline (last-applied.json) under the host it was given as well, so it does not treat them as one.${goBackTo ? '' : ` The folder's URL is also ${unspellable}.`} Nothing was changed.`,
      ...remedyLines([
        ...(goBackTo ? [`run again with the host the folder was opened with: --env ${goBackTo}`] : []),
        `${fresh} — the old folder is left as it is`,
      ]),
    );
  } else if (facts.onlyOpened) {
    lines.push(
      lead('was only ever opened for another environment'),
      `  ${folder}`,
      `  workspace belongs to: ${workspaceOrigin}`,
      `  this run targets:     ${target}`,
      `It holds nothing a build saved — no saved copies, page-ownership receipts or baseline, only the manifest and the empty folders the SDK lays down when it opens a workspace — so it was only ever opened for ${workspaceOrigin} (an earlier preview, or a build that stopped at its start, leaves exactly this), and nothing was built there for a teardown to remove. The build never clears or re-binds a workspace for you, so the folder has to go by hand; nothing is lost by that.`,
      ...remedyLines([
        'delete the folder (it holds nothing), or move it aside, and run again: the build then opens a new workspace for this environment',
        fresh,
      ]),
    );
  } else {
    // Teardown clears `--workspace`, else the folder beside its spec — which need not be this one. The folder is the
    // line above, not an argument: a path can hold `$`, a backtick or a quote, and quoting that is right for one shell is
    // wrong for another. Inside double quotes PowerShell and POSIX shells still expand `$name`, so a command carrying the
    // path in them could clear a different folder, or none; single quotes are not quotes in cmd.exe.
    const teardown = `only if that environment's copy of the app is no longer wanted: node scripts/teardown-model-app.js --env ${goBackTo} --spec <app-spec.json> --workspace <the folder printed above> --apply --allow-destructive --clear-workspace — this DELETES what the spec declares from ${goBackTo}; the folder is removed only after a clean teardown, and kept while any page-ownership receipt remains`;
    const quoting = 'Pass --workspace the folder exactly as printed above, quoted for your shell: in single quotes in PowerShell, bash and zsh (double quotes there still expand $, so a folder named $work would point the delete somewhere else), in double quotes in cmd.exe (it has no single quotes). Without --workspace, teardown clears the folder beside its spec instead, which may be another one.';
    const withTeardown = !preview && !!goBackTo;
    lines.push(
      lead('belongs to a different environment'),
      `  ${folder}`,
      `  workspace belongs to: ${workspaceOrigin}`,
      `  this run targets:     ${target}`,
      `The SDK's saved copies of this app's artifacts, their metadata and baselines in that folder are ${workspaceOrigin}'s, and the ids in them are only valid there (out-of-box ids are equal across environments), so using them for another environment would read and write the wrong rows. The build never clears or re-binds the folder for you: clearing it discards those saved copies, including any edit made in them that was never pushed, and the page-ownership receipts and the baseline (last-applied.json) kept beside them are ${workspaceOrigin}'s too.${goBackTo ? '' : ` The folder's URL is ${unspellable}.`}`,
      ...remedyLines([
        ...(goBackTo ? [`build against the environment it belongs to: --env ${goBackTo}`] : []),
        fresh,
        ...(withTeardown ? [teardown] : []),
      ]),
      ...(withTeardown ? [quoting] : []),
    );
  }
  return lines;
}

// The halt as an Error (`code`, `environment` = this run's, `workspaceEnvironment` = the workspace's or null), or null
// when `err` is neither the SDK's refusal of the folder nor a manifest the JSON parser rejected — the caller rethrows
// that as it is. `err` is what opening the workspace threw, and nothing else.
//
// What it says depends on how the folder relates to this run (see `bindingFacts`): another environment (all three
// remedies, unless nothing was ever saved there), the same environment under its other host or recorded with more than
// an origin (never the teardown: the run's own environment is the one it would delete from), or no usable environment.
function workspaceBindingError(err, ctx) {
  const facts = bindingFacts(err, ctx);
  if (!facts) return null;
  return Object.assign(new Error(describeBinding(facts, { preview: false }).join('\n')), {
    code: facts.code,
    environment: facts.runOrigin,
    workspaceEnvironment: facts.workspaceOrigin,
  });
}

// What a DRY RUN says about the app folder's workspace, which it does not open: null when the folder is fine for this run
// (it belongs to this environment, or holds no workspace yet), else the note — the halt an --apply would meet, worded for
// a preview that ran as normal. `probeSdk` is an SDK over the folder, and it is asked for the workspace manifest and
// nothing else: `getManifest()` checks the manifest's environment like every other workspace entry point, parses
// manifest.json and no other file, and writes nothing. Advisory only: anything else that goes wrong in asking (a folder
// that cannot be read, a probe that cannot answer) gives no note, because nothing here may stop a preview.
//
// It is not asked to list the app artifacts, which checks the environment just as well. A listing also parses what it
// lists — each artifact's saved copy and the metadata kept beside it — to flag the copies that hold unpushed edits:
//   apps/<app id>.json                   {"name": "Support Desk     <- a copy cut short, or
//   .metadata/apps/<app id>.meta.json    {"etag":                   <- its metadata cut short
// Either throws the same SyntaxError as a manifest.json that is not JSON, so a folder that belongs to THIS environment
// would be reported as having an invalid manifest ("move the folder aside") when an --apply opens it without trouble.
// A saved copy says nothing about which environment a folder belongs to, so the preview reads none and says nothing
// about one.
async function workspaceBindingNote(probeSdk, ctx) {
  let failure;
  try {
    await probeSdk.getManifest();
    return null;
  } catch (err) {
    failure = err;
  }
  try {
    if (failure && failure.code === WORKSPACE_NOT_INITIALIZED) return null;
    const facts = bindingFacts(failure, ctx);
    return facts ? describeBinding(facts, { preview: true }).join('\n') : null;
  } catch {
    return null;
  }
}

module.exports = { WORKSPACE_ORG_MISMATCH, WORKSPACE_MANIFEST_INVALID, isWorkspaceOrgMismatch, workspaceBindingError, workspaceBindingNote };
