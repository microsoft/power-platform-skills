"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const pacAuth = require("../lib/pac-auth");

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

test("returns routing data and documented identifiers parsed from `pac auth who` output", () => {
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

test("returns available identifiers and leaves missing values empty", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () =>
      "Cloud: Public\n" +
      "Tenant Id: 11111111-1111-1111-1111-111111111111\n" +
      "Organization Id: 33333333-3333-3333-3333-333333333333\n",
  });
  assert.deepEqual(result, {
    orgId: "33333333-3333-3333-3333-333333333333",
    tenantId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    objectId: "",
    geoName: "",
  });
});

test("returns the cloud when only Cloud and Tenant Id are present", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () =>
      "Cloud: Public\nTenant Id: 11111111-1111-1111-1111-111111111111\n",
  });
  assert.deepEqual(result, {
    orgId: "",
    tenantId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    objectId: "",
    geoName: "",
  });
});

test("returns the cloud when only Cloud and Organization Id are present", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () =>
      "Cloud: Public\nOrganization Id: 33333333-3333-3333-3333-333333333333\n",
  });
  assert.deepEqual(result, {
    orgId: "33333333-3333-3333-3333-333333333333",
    tenantId: "",
    cloud: "Public",
    objectId: "",
    geoName: "",
  });
});

test("returns the cloud without requiring identity fields", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => "Type: Universal\nCloud: Public\n",
  });
  assert.deepEqual(result, {
    orgId: "",
    tenantId: "",
    cloud: "Public",
    objectId: "",
    geoName: "",
  });
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

test("returns null when pac auth who times out", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => {
      const e = new Error("ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    },
  });
  assert.equal(result, null);
});

test("returns null when pac exits non-zero", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () => {
      const e = new Error("Command failed");
      e.status = 1;
      throw e;
    },
  });
  assert.equal(result, null);
});

test("does not throw on unparseable / empty output", () => {
  pacAuth._resetCache();
  assert.doesNotThrow(() =>
    pacAuth.readPacAuth({ _exec: () => "" })
  );
  pacAuth._resetCache();
  assert.doesNotThrow(() =>
    pacAuth.readPacAuth({ _exec: () => null })
  );
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
  pacAuth.readPacAuth({ _exec: exec });
  assert.equal(calls, 1, "second + third calls should hit cache");
});

test("respects _exec=false short-circuit (returns null without forking)", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({ _exec: false });
  assert.equal(result, null);
});

test("returns null when Cloud is absent even if identity fields are present", () => {
  pacAuth._resetCache();
  const result = pacAuth.readPacAuth({
    _exec: () =>
      "tenant ID:   11111111-1111-1111-1111-111111111111\nORGANIZATION ID:    33333333-3333-3333-3333-333333333333\n",
  });
  assert.equal(result, null);
});

test("readPacAuth parses Cloud line", () => {
  pacAuth._resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n" +
    "Cloud:            Public\n";
  const result = pacAuth.readPacAuth({ _exec: fakeExec });
  assert.equal(result.cloud, "Public");
});

test("readPacAuth returns null when Cloud line is missing", () => {
  pacAuth._resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n";
  const result = pacAuth.readPacAuth({ _exec: fakeExec });
  assert.equal(result, null);
});

test("readPacAuth parses Cloud with sovereign values", () => {
  pacAuth._resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n" +
    "Cloud:            UsGovHigh\n";
  const result = pacAuth.readPacAuth({ _exec: fakeExec });
  assert.equal(result.cloud, "UsGovHigh");
});
