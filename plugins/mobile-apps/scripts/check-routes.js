#!/usr/bin/env node

/**
 * scripts/check-routes.js — Route param contract doctor.
 *
 * Catches the "screen A sends, screen B ignores" bug class:
 * when multiple screens push to a shared destination with different param sets,
 * the destination's `useLocalSearchParams<{...}>()` may declare only one
 * sender's params. Other senders' params are then silently dropped at runtime.
 *
 * What it does:
 *   1. Walks <project>/app/ for .tsx files
 *   2. For each file, parses:
 *      - The route pattern (derived from file path, with [params])
 *      - The `useLocalSearchParams<{...}>()` type declaration (if any)
 *      - All `router.push(...)` / `router.replace(...)` / `<Link href={...}>`
 *        expressions targeting other routes (with their query/path params)
 *   3. For each route, computes the UNION of params any sender passes to it
 *   4. Reports a diff against what the destination declares
 *
 * Usage:
 *   node scripts/check-routes.js                # exit 1 if any drift
 *   node scripts/check-routes.js --json         # machine-readable output
 *   node scripts/check-routes.js --quiet        # only print failures
 *   node scripts/check-routes.js --fix-suggest  # print exact useLocalSearchParams type to use
 *
 * Wire as `npm run check-routes` (see package.json `scripts`).
 *
 * Exit codes:
 *   0 = all destinations declare every sender-passed param
 *   1 = drift detected (one or more destinations missing params)
 *   2 = couldn't parse some senders (regex didn't recognize the push form)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const FLAG_JSON = args.includes('--json');
const FLAG_QUIET = args.includes('--quiet');
const FLAG_FIX_SUGGEST = args.includes('--fix-suggest');

// ─── Walk app/ for .tsx files ────────────────────────────────────────────────

function findTsxFiles(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (e.isFile() && /\.tsx$/.test(e.name)) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out;
}

// ─── Convert file path → route pattern ───────────────────────────────────────
// app/(app)/inspections/[id]/defect.tsx → /inspections/[id]/defect
// app/(app)/_layout.tsx                  → null (layout, not a screen)
// app/(app)/inspections/index.tsx        → /inspections

function fileToRoute(filePath, appRoot) {
  const rel = path.relative(appRoot, filePath);
  const noExt = rel.replace(/\.tsx$/, '');
  if (/(^|\/)_layout$/.test(noExt)) return null;          // layouts aren't screens
  if (/(^|\/)\+not-found$/.test(noExt)) return null;      // not-found boundary
  // Strip group segments (parens) — they don't appear in URLs
  const segs = noExt.split('/').filter(s => !/^\(.+\)$/.test(s));
  // 'index' becomes empty
  const cleaned = segs
    .map(s => (s === 'index' ? '' : s))
    .filter((s, i, a) => !(s === '' && i < a.length - 1));
  let route = '/' + cleaned.join('/').replace(/\/$/, '');
  if (route === '/' && cleaned[cleaned.length - 1] === '') route = '/';
  return route || '/';
}

// ─── Parse useLocalSearchParams<{...}>() ─────────────────────────────────────
// Returns: { keys: { name: 'optional' | 'required' } } | null

function parseLocalSearchParams(content) {
  // Match useLocalSearchParams<{...}>() with possible whitespace + inline types
  const m = content.match(/useLocalSearchParams\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/);
  if (!m) return null;
  const body = m[1];
  const keys = {};
  // Split on commas/semicolons not inside generics
  const parts = body.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const km = p.match(/^([a-zA-Z_$][\w$]*)\s*(\?)?\s*:/);
    if (!km) continue;
    keys[km[1]] = km[2] ? 'optional' : 'required';
  }
  return { keys, raw: body };
}

// ─── Parse senders: router.push / router.replace / <Link href=...> ───────────
// Returns array of { route: '/path/[id]/...', params: { name: 'path'|'query' } }
//
// Handles three forms:
//   router.push('/inspections/[id]/defect')
//   router.push(`/inspections/${id}/defect?zone=${z}&editId=${eid}`)
//   <Link href={`/inspections/${id}/defect`}>
//   router.push({ pathname: '/inspections/[id]/defect', params: { id, zone } })

function parseSenders(content) {
  const senders = [];

  // Form 1+2: router.push|replace(...)  with string or template literal
  const pushRe = /router\.(?:push|replace|navigate)\s*\(\s*([`'"])([^`'"]*)\1/g;
  let m;
  while ((m = pushRe.exec(content))) {
    const url = m[2];
    const parsed = parseUrlPattern(url);
    if (parsed) senders.push(parsed);
  }

  // Form 3: <Link href={`...`}>  or  <Link href="...">
  const linkRe = /<Link[^>]*\bhref\s*=\s*\{?\s*([`'"])([^`'"]*)\1\s*\}?/g;
  while ((m = linkRe.exec(content))) {
    const url = m[2];
    const parsed = parseUrlPattern(url);
    if (parsed) senders.push(parsed);
  }

  // Form 4: router.push({ pathname: '...', params: {...} })
  const objRe = /router\.(?:push|replace|navigate)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = objRe.exec(content))) {
    const body = m[1];
    const pmm = body.match(/pathname\s*:\s*[`'"]([^`'"]*)[`'"]/);
    if (!pmm) continue;
    const route = normalizeRoute(pmm[1]);
    const params = {};
    // Parse params: { id, zone, editId } shorthand or { id: x, zone: y }
    const paramsBlockMatch = body.match(/params\s*:\s*\{([\s\S]*?)\}/);
    if (paramsBlockMatch) {
      const paramsBody = paramsBlockMatch[1];
      const keys = paramsBody.match(/\b([a-zA-Z_$][\w$]*)\b\s*[,:}]/g) || [];
      for (const k of keys) {
        const name = k.replace(/[,:}]/g, '').trim();
        if (name && !['true', 'false', 'null', 'undefined'].includes(name)) {
          params[name] = 'query';
        }
      }
    }
    // Path params (from [id] segments)
    const pathParamMatches = route.match(/\[([^\]]+)\]/g) || [];
    for (const seg of pathParamMatches) {
      const name = seg.slice(1, -1);
      params[name] = 'path';
    }
    senders.push({ route, params });
  }

  return senders;
}

function parseUrlPattern(rawUrl) {
  // Strip template literal interpolations: `/foo/${bar}/baz?x=${y}` → `/foo/[X]/baz?x=[X]`
  // Then extract path + query
  const cleaned = rawUrl.replace(/\$\{[^}]*\}/g, '__INTERP__');
  const [pathPart, queryPart] = cleaned.split('?');
  const params = {};

  // Path interpolations correspond to [param] segments in the destination
  // We can't know the destination param NAME from the sender side (it's an arbitrary var)
  // BUT we can count them and match positionally to the destination's [param] segments.
  // For now, mark interpolations as positional path params and resolve at match time.
  const interpCount = (pathPart.match(/__INTERP__/g) || []).length;

  // Query params
  if (queryPart) {
    const pairs = queryPart.split('&');
    for (const pair of pairs) {
      const [k] = pair.split('=');
      if (k && k !== '__INTERP__') {
        params[k] = 'query';
      }
    }
  }

  // Normalize path to comparison form: keep [param] segments, replace __INTERP__ with [X]
  const normalized = pathPart.replace(/__INTERP__/g, '[X]');

  return { route: normalized, params, _interpCount: interpCount, _rawUrl: rawUrl };
}

function normalizeRoute(route) {
  // Strip group segments
  const segs = route.split('/').filter(s => !/^\(.+\)$/.test(s));
  return segs.join('/').replace(/\/+/g, '/');
}

// ─── Match sender route to destination file route ────────────────────────────
// Sender: /inspections/[X]/defect  (positional)
// Dest:   /inspections/[id]/defect (named)
// Match: same number of segments, [X] aligns with [name] in dest

function matchSenderToDest(senderRoute, destRoutes) {
  const sNorm = normalizeRoute(senderRoute);
  const sSegs = sNorm.split('/').filter(Boolean);
  for (const d of destRoutes) {
    const dSegs = d.split('/').filter(Boolean);
    if (sSegs.length !== dSegs.length) continue;
    let allMatch = true;
    for (let i = 0; i < sSegs.length; i++) {
      const s = sSegs[i], dseg = dSegs[i];
      if (/^\[.+\]$/.test(dseg)) continue;     // dest is dynamic — sender can be anything
      if (s === dseg) continue;                // exact match
      allMatch = false;
      break;
    }
    if (allMatch) return d;
  }
  return null;
}

function destPathParams(destRoute) {
  const segs = destRoute.split('/').filter(Boolean);
  const out = [];
  for (const s of segs) {
    const m = s.match(/^\[(.+)\]$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const cwd = process.cwd();
  const appRoot = path.join(cwd, 'app');
  if (!fs.existsSync(appRoot)) {
    console.error(`Error: ${appRoot} does not exist. Run from a project root with an app/ directory.`);
    process.exit(2);
  }

  const files = findTsxFiles(appRoot);

  // Build dest registry: { route: { file, declaredKeys, declaredRaw } }
  const dests = {};
  // Collect senders: array of { fromFile, route, params }
  const allSenders = [];

  for (const file of files) {
    const route = fileToRoute(file, appRoot);
    const content = fs.readFileSync(file, 'utf8');

    if (route) {
      const declared = parseLocalSearchParams(content);
      dests[route] = {
        file,
        declaredKeys: declared ? declared.keys : null,
        declaredRaw: declared ? declared.raw : null,
      };
    }

    const senders = parseSenders(content);
    for (const s of senders) {
      allSenders.push({ fromFile: file, ...s });
    }
  }

  // For each dest, compute union of received params from all senders that target it
  const destRouteList = Object.keys(dests);
  const received = {};
  for (const r of destRouteList) received[r] = { params: {}, sources: [] };

  for (const s of allSenders) {
    const dest = matchSenderToDest(s.route, destRouteList);
    if (!dest) continue; // sender targets a route that doesn't exist in app/ — different bug class
    received[dest].sources.push(s.fromFile);
    // Path params from dest take dest's names
    const destPathNames = destPathParams(dest);
    for (const pname of destPathNames) {
      received[dest].params[pname] = 'path';
    }
    // Query params straight from sender
    for (const [pname, kind] of Object.entries(s.params)) {
      if (kind === 'query') received[dest].params[pname] = 'query';
    }
  }

  // Diff: for each dest, what's received but not declared?
  const findings = [];
  for (const r of destRouteList) {
    const d = dests[r];
    const r2 = received[r];
    if (r2.sources.length === 0) continue; // unreachable destination — different bug class
    if (!d.declaredKeys) {
      // Destination receives params but has NO useLocalSearchParams call.
      // That's a real issue if the screen uses any of those params.
      findings.push({
        route: r,
        file: d.file,
        kind: 'no-declaration',
        receivedParams: r2.params,
        sources: r2.sources.map(s => path.relative(cwd, s)),
        suggestion: buildSuggestedType(r2.params),
      });
      continue;
    }
    const missing = {};
    for (const [pname, kind] of Object.entries(r2.params)) {
      if (!(pname in d.declaredKeys)) missing[pname] = kind;
    }
    if (Object.keys(missing).length > 0) {
      findings.push({
        route: r,
        file: d.file,
        kind: 'missing-params',
        declaredRaw: d.declaredRaw,
        receivedParams: r2.params,
        missingParams: missing,
        sources: r2.sources.map(s => path.relative(cwd, s)),
        suggestion: buildSuggestedType({ ...d.declaredKeys, ...r2.params }, d.declaredKeys),
      });
    }
  }

  // Output
  if (FLAG_JSON) {
    console.log(JSON.stringify({ findings }, null, 2));
    process.exit(findings.length > 0 ? 1 : 0);
  }

  if (findings.length === 0) {
    if (!FLAG_QUIET) {
      console.log(`✓ check-routes: all destinations declare every sender-passed param.`);
      console.log(`  Scanned ${files.length} TSX file(s) in ${path.relative(cwd, appRoot)}/.`);
      console.log(`  ${destRouteList.length} routes, ${allSenders.length} push/replace/Link expressions.`);
    }
    process.exit(0);
  }

  console.error(`✗ check-routes: ${findings.length} destination(s) missing param declarations.\n`);
  for (const f of findings) {
    console.error(`  Route:  ${f.route}`);
    console.error(`  File:   ${path.relative(cwd, f.file)}`);
    if (f.kind === 'no-declaration') {
      console.error(`  Issue:  No useLocalSearchParams<>() call, but ${Object.keys(f.receivedParams).length} param(s) are sent here.`);
    } else {
      console.error(`  Issue:  Missing from useLocalSearchParams<>() type.`);
      console.error(`  Declared: { ${f.declaredRaw ? f.declaredRaw.replace(/\s+/g, ' ').trim() : '∅'} }`);
    }
    console.error(`  Sources: ${f.sources.join(', ')}`);
    console.error(`  Missing: ${Object.entries(f.missingParams || f.receivedParams).map(([k, v]) => `${k} (${v})`).join(', ')}`);
    if (FLAG_FIX_SUGGEST || !FLAG_QUIET) {
      console.error(`  Fix:    useLocalSearchParams<{ ${f.suggestion} }>();`);
    }
    console.error('');
  }
  process.exit(1);
}

function buildSuggestedType(allParams, alreadyDeclared = {}) {
  // alreadyDeclared has 'required'/'optional' info; new params default to optional ?: string
  const parts = [];
  for (const [k, kind] of Object.entries(allParams)) {
    if (alreadyDeclared[k] === 'required') {
      parts.push(`${k}: string`);
    } else {
      // Path params should be required; query params default to optional
      const isPath = kind === 'path';
      parts.push(`${k}${isPath ? '' : '?'}: string`);
    }
  }
  return parts.join('; ');
}

main();
