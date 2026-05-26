#!/usr/bin/env node
/**
 * website.js — Resolves a Power Pages website record against the Power Platform API.
 *
 * Two distinct identifiers float around in the codebase. They look the same
 * (both are GUIDs) but they are not interchangeable:
 *
 *   websiteId   The Dataverse website record id. This is what
 *               `.powerpages-site/website.yml` stores as `id`, what
 *               `pac pages list` surfaces as "Website Record ID", and
 *               therefore what user-facing CLI flags accept. It maps to the
 *               `WebsiteRecordId` field on the Power Platform API response.
 *
 *   portalId    The Power Platform API URL segment. Every per-site admin call
 *               (`/websites/{id}/...`) takes this value. It maps to the
 *               `Id` field on the Power Platform API response.
 *
 * The skill calls this helper once during prerequisites to translate the
 * Dataverse `websiteId` into the Power Platform API portalId for the rest of the run.
 *
 * Usage:
 *   node website.js --websiteId <guid>
 *
 * Stdout (JSON): the matching website record, or `null`.
 *
 * Exit codes:
 *   0 = success (including a `null` match)
 *   1 = invocation or service error
 *   2 = sign-in required
 */

const {
  resolveContext,
  request,
  parseCliArgs,
  fail,
  runCli,
} = require('./lib/power-platform-api');

// Hard cap on pagination — far above any realistic site count. Exists only
// so a misbehaving server cannot keep the helper looping forever.
const MAX_PAGES = 500;

// Field projection sent to the Power Platform API. Covers everything the skill needs
// from the response (portalId via `Id`, the websiteId echo via
// `WebsiteRecordId`, plus the metadata used for trial-site warnings, summaries,
// and the report header).
const FIELDS = [
  'Id',
  'Name',
  'WebsiteRecordId',
  'WebsiteUrl',
  'Type',
  'status',
  'Subdomain',
  'SiteVisibility',
  'PortalWAFStatus',
  'PortalAFDStatus',
  'TrialExpiringInDays',
].join(',');

const SIGN_IN_HINT = /CLI is not signed in|Failed to acquire access token/;

/**
 * Returns the next `skip` value embedded in an `@odata.nextLink`, or `null`
 * when the link is missing, malformed, or carries a non-positive offset.
 */
function nextSkipFrom(nextLink) {
  if (typeof nextLink !== 'string') return null;
  const match = nextLink.match(/[?&]skip=(\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Reads the Dataverse record id from a website record, tolerating PascalCase
 * (the documented shape) and any normalized casing a future server might use.
 */
function recordIdOf(website) {
  if (!website || typeof website !== 'object') return null;
  return website.WebsiteRecordId || website.websiteRecordId || null;
}

/**
 * Resolves a Dataverse `websiteId` to its full website record by paginating
 * `/websites` and matching on `WebsiteRecordId` (case-insensitive — tolerates
 * GUID casing differences between local YAML, `pac pages list`, and the
 * Power Platform API response).
 *
 * @param {string} websiteId
 * @returns {Promise<object|null>}
 */
async function findWebsite(websiteId) {
  if (typeof websiteId !== 'string' || websiteId.length === 0) {
    throw new Error('websiteId must be a non-empty string.');
  }
  const target = websiteId.toLowerCase();
  const context = resolveContext();
  if (context.error) throw new Error(context.error);

  let skip;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = { select: FIELDS };
    if (skip !== undefined) query.skip = String(skip);

    const response = await request({ context, method: 'GET', path: '/websites', query });
    if (!response.ok) {
      throw new Error(`List websites failed (${response.statusCode}): ${response.error?.message || ''}`);
    }

    const body = response.body && typeof response.body === 'object' ? response.body : {};
    for (const site of body.value || []) {
      const id = recordIdOf(site);
      if (typeof id === 'string' && id.toLowerCase() === target) return site;
    }

    const advance = nextSkipFrom(body['@odata.nextLink'] || body.nextLink);
    // null = no more pages; non-advancing = malformed server response → stop either way.
    if (advance == null || advance <= (skip ?? 0)) break;
    skip = advance;
  }

  return null;
}

async function main() {
  const args = parseCliArgs(process.argv);
  if (typeof args.websiteId !== 'string') {
    fail('Usage: node website.js --websiteId <guid>', 1);
  }
  try {
    const website = await findWebsite(args.websiteId);
    process.stdout.write(JSON.stringify(website, null, 2) + '\n');
  } catch (err) {
    const message = err.message || String(err);
    fail(message, SIGN_IN_HINT.test(message) ? 2 : 1);
  }
}

module.exports = { findWebsite, nextSkipFrom, recordIdOf };

runCli(module, main);
