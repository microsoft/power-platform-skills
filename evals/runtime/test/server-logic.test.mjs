import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectServerLogic } from '../server-logic-checks.mjs';
import { closeBrowser } from '../browser-checks.mjs';
import { validateContract } from '../artifacts.mjs';

after(closeBrowser);
const number = `function number(value) {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value))) throw new Error('Invalid input');
  return Number(value);
}`;
const sum = `${number}
function get() {
  return JSON.stringify({sum: number(Server.Context.QueryParameters.a) + number(Server.Context.QueryParameters.b)});
}`;
const weather = `${number}
async function get() {
  const q = Server.Context.QueryParameters;
  const latitude = number(q.latitude), longitude = number(q.longitude);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('Invalid coordinates');
  const response = await Server.Connector.HttpClient.GetAsync(
    'https://weather.example.invalid/current?' + new URLSearchParams({latitude, longitude}));
  if (response.StatusCode < 200 || response.StatusCode >= 300) throw new Error('Provider failed');
  const body = JSON.parse(response.Content);
  const temperatureC = body.current?.temperature_2m;
  if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC)) throw new Error('Missing temperature');
  return JSON.stringify({temperatureC});
}`;
const client = exercise => `async function loadResult(query) {
  const html = await (await fetch('/_layout/tokenhtml')).text();
  const token = new DOMParser().parseFromString(html, 'text/html').querySelector('input').value;
  const response = await fetch('/_api/serverlogics/${exercise}?' + new URLSearchParams(query), {
    headers: {'__RequestVerificationToken': token}
  });
  if (!response.ok) throw new Error('HTTP failed');
  const envelope = await response.json();
  if (!envelope.success || typeof envelope.data !== 'string') throw new Error('Platform failed');
  const feature = JSON.parse(envelope.data);
  if (typeof feature.${exercise === 'sum' ? 'sum' : 'temperatureC'} !== 'number') throw new Error('Feature failed');
  return feature;
}`;

async function grade(t, exercise, server, frontend = client(exercise)) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-server-grader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'server.js'), server);
  await writeFile(path.join(root, 'src/service.js'), frontend);
  return inspectServerLogic({
    workDir: root, spec: { server: 'server.js', client: 'src/service.js', exercise },
  });
}

test('valid endpoint/frontend pairs pass without any network or model', async t => {
  for (const [exercise, source] of [['sum', sum], ['weather', weather]]) {
    const checks = await grade(t, exercise, source);
    assert.ok(checks.length >= 15);
    assert.deepEqual(checks.filter(check => !check.passed), []);
  }
});

test('blank coercion, upstream status suppression and static demo values fail executable checks', async t => {
  for (const [exercise, source, failure] of [
    ['sum', sum.replace("value.trim() === '' || ", ''), 'invalid'],
    ['weather', weather.replace("if (response.StatusCode < 200 || response.StatusCode >= 300) throw new Error('Provider failed');", ''), 'provider unavailable'],
    ['weather', weather.replace('const temperatureC = body.current?.temperature_2m;', 'const temperatureC = 22;'), 'provider value'],
  ]) {
    // The failed HTTP response deliberately has a parseable JSON body. Rejecting
    // only malformed JSON must not masquerade as an upstream-status check.
    const checks = await grade(t, exercise, source);
    assert.ok(checks.some(check => !check.passed && check.name.includes(failure)), JSON.stringify(checks));
  }
});

test('wrong response layer, missing CSRF and helper-only frontend fail', async t => {
  for (const frontend of [
    client('sum').replace('JSON.parse(envelope.data)', 'envelope'),
    client('sum').replace("'__RequestVerificationToken': token", "'Accept': 'application/json'"),
    'async function loadResult() { return {sum: 1.5}; }',
  ]) {
    const checks = await grade(t, 'sum', sum, frontend);
    assert.ok(checks.some(check => !check.passed));
  }
});

test('arbitrary programs and escaping paths cannot be supplied as grader configuration', () => {
  assert.throws(() => validateContract({ serverLogic: { server: '../server.js', client: 'client.js', exercise: 'sum' } }));
  assert.throws(() => validateContract({ serverLogic: { server: 'server.js', client: 'client.js', exercise: 'custom-program' } }));
});
