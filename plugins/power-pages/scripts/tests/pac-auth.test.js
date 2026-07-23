"use strict";

// Unit coverage for the bundled telemetry pac-auth copy. The plugin ships a
// physical copy of shared/telemetry/lib/pac-auth.js (no symlink), so this test
// asserts the copy keeps the routing fields and documented identifiers.

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

test("parses routing fields and documented identifiers", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({ _exec: () => SAMPLE_OUTPUT });
  assert.deepEqual(result, {
    orgId: "33333333-3333-3333-3333-333333333333",
    tenantId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    objectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    geoName: "NorthAmerica",
  });
});

test("returns a cloud without requiring tenant or organization identifiers", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => "Cloud: Public\n",
  });
  assert.deepEqual(result, {
    orgId: "",
    tenantId: "",
    cloud: "Public",
    objectId: "",
    geoName: "",
  });
});

test("returns null when Cloud is missing", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => "Type: Universal\nTenant Id: tenant-id\n",
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
