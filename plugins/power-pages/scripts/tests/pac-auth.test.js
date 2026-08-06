"use strict";

// Unit coverage for the bundled telemetry pac-auth copy. The plugin ships a
// physical copy of shared/telemetry/lib/pac-auth.js (no symlink), so this test
// asserts the copy parses `pac auth who` the same way — including the optional
// "Entra ID Object Id" line surfaced as `objectId`. The emit-* hook tests are
// spawn-based integration tests that call real `pac`, so they can't inject a
// fake object id; this is the deterministic seam for that field.

const test = require("node:test");
const assert = require("node:assert/strict");

const pacAuth = require("../lib/telemetry/lib/pac-auth");

const SAMPLE_OUTPUT = `Type:                Universal
Cloud:               Public
Tenant Id:           11111111-1111-1111-1111-111111111111
Tenant Country:      US
User:                user@example.com
Entra ID Object Id:  aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
PUID:                10000000ABCDEF01
User Country/Region: US
Token Expires:       2026-05-05T18:00:00Z
Authority:           https://login.microsoftonline.com/...
Environment Geo:     NorthAmerica
Environment Id:      22222222-2222-2222-2222-222222222222
Environment Type:    Sandbox
Organization Id:     33333333-3333-3333-3333-333333333333
Organization Unique Name:    contoso
Organization Friendly Name:  Contoso
`;

test("parses orgId, tenantId, cloud, and Entra ID objectId", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({ _exec: () => SAMPLE_OUTPUT });
  assert.deepEqual(result, {
    orgId: "33333333-3333-3333-3333-333333333333",
    tenantId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    objectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
});

test("objectId is '' when the Entra ID Object Id line is missing", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () =>
      "Cloud: Public\n" +
      "Tenant Id: 11111111-1111-1111-1111-111111111111\n" +
      "Organization Id: 33333333-3333-3333-3333-333333333333\n",
  });
  assert.equal(result.objectId, "");
});

test("returns null when neither Tenant Id nor Organization Id is found", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => "Type: Universal\nCloud: Public\n",
  });
  assert.equal(result, null);
});

test("returns null when pac is missing (ENOENT)", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => {
      const e = new Error("spawn pac ENOENT");
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(result, null);
});

test("caches result across calls (single fork per process)", () => {
  pacAuth._resetCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return SAMPLE_OUTPUT;
  };
  pacAuth.readPacAuth({ _exec: exec });
  pacAuth.readPacAuth({ _exec: exec });
  assert.equal(calls, 1, "second call should hit cache");
});
