const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  checkImage, inspectHostedImage, isPublicAddress, validateImageChecks, verifyPlanImages,
} = require('../lib/declarative-image-verification');
const { externalImagePlan: externalPlan, successfulImageCheck } = require('./customization-plan-test-helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAd8AAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>');
const PUBLIC_ADDRESS = { address: '93.184.215.14', family: 4 };
const publicDns = async () => [PUBLIC_ADDRESS];

function transport(responses) {
  const calls = [];
  const request = (url, options, callback) => {
    const entry = responses[calls.length];
    calls.push({ url: url.href, options });
    assert.ok(entry, 'unexpected extra HTTP request');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (entry.error) { req.emit('error', new Error(entry.error)); return; }
      if (entry.hang) return;
      const response = new PassThrough();
      response.statusCode = entry.status ?? 200;
      response.headers = entry.headers ?? { 'content-type': 'image/png' };
      callback(response);
      if (response.destroyed) return;
      if (entry.aborted) { response.emit('aborted'); return; }
      response.end(entry.body ?? PNG);
    });
    return req;
  };
  return { request, calls };
}

test('GET checks final image bytes, pins public DNS and sends no ambient credentials', async () => {
  const net = transport([{ headers: { 'content-type': 'image/png; charset=binary' } }]);
  const url = 'https://cdn.example.com/image?w=800&fit=crop';
  const result = await checkImage(url, { request: net.request, resolve: publicDns });
  assert.equal(result.url, url);
  assert.equal(result.statusCode, 200);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.sizeBytes, PNG.length);
  const options = net.calls[0].options;
  assert.equal(options.method, 'GET');
  assert.equal(options.agent, false);
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert.ok(!Object.keys(options.headers).some((key) => /authorization|cookie|referer/i.test(key)));
  options.lookup('cdn.example.com', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, PUBLIC_ADDRESS.address);
    assert.equal(family, 4);
  });
  options.lookup('cdn.example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [PUBLIC_ADDRESS]);
  });
});

test('404, HTML, mislabeled images and empty or partial responses cannot pass', async () => {
  const cases = [
    [{ status: 404 }, /HTTP 404/],
    [{ status: 403 }, /HTTP 403/],
    [{ status: 500 }, /HTTP 500/],
    [{ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>Not found</html>') }, /supported image/],
    [{ body: Buffer.from('<html>Not found</html>') }, /signature/],
    [{ headers: {}, body: PNG }, /no Content-Type/],
    [{ body: Buffer.alloc(0) }, /empty/],
    [{ body: PNG.subarray(0, 12) }, /truncated/],
    [{ aborted: true }, /before completion/],
    [{ error: 'certificate rejected' }, /certificate rejected/],
  ];
  for (const [response, error] of cases) {
    const net = transport([response]);
    await assert.rejects(checkImage('https://cdn.example.com/image', { request: net.request, resolve: publicDns }), error);
    assert.equal(net.calls.length, 1, 'Do not retry permanently invalid image URLs.');
  }
});

test('redirects are bounded and each new host is checked before any connection', async () => {
  const net = transport([
    { status: 302, headers: { location: 'https://cdn.example.com/actual.png' } },
    {},
  ]);
  const hosts = [];
  const result = await checkImage('https://images.unsplash.com/photo-example', {
    request: net.request,
    resolve: async (hostname) => { hosts.push(hostname); return [PUBLIC_ADDRESS]; },
  });
  assert.deepEqual(hosts, ['images.unsplash.com', 'cdn.example.com']);
  assert.equal(result.finalUrl, 'https://cdn.example.com/actual.png');
  for (const target of ['http://cdn.example.com/image', 'https://127.0.0.1/image', 'https://user:secret@cdn.example.com/image']) {
    const invalid = transport([{ status: 302, headers: { location: target } }]);
    await assert.rejects(checkImage('https://cdn.example.com/start', { request: invalid.request, resolve: publicDns }), /HTTPS|public|credentials/);
    assert.equal(invalid.calls.length, 1);
  }
  const privateRedirect = transport([{ status: 302, headers: { location: 'https://private.example.com/image' } }]);
  await assert.rejects(checkImage('https://cdn.example.com/start', {
    request: privateRedirect.request,
    resolve: async (host) => host === 'private.example.com' ? [{ address: '10.0.0.1', family: 4 }] : [PUBLIC_ADDRESS],
  }), /public/);
  assert.equal(privateRedirect.calls.length, 1);
  const missing = transport([{ status: 302, headers: {} }]);
  await assert.rejects(checkImage('https://cdn.example.com/start', { request: missing.request, resolve: publicDns }), /no Location/);
  const loop = transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
  await assert.rejects(checkImage('https://cdn.example.com/start', { request: loop.request, resolve: publicDns }), /redirect limit/);
  assert.equal(loop.calls.length, 4);
});

test('private, reserved, mapped and mixed public/private addresses fail closed', async () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::a00:1',
    '2001:db8::1', '2002:a00:1::1', '3fff::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of [PUBLIC_ADDRESS.address, '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  await assert.rejects(checkImage('https://cdn.example.com/image', {
    resolve: async () => [PUBLIC_ADDRESS, { address: '192.168.1.2', family: 4 }],
    request: () => assert.fail('No connection is allowed for mixed DNS answers.'),
  }), /public/);
});

test('byte and wall-clock limits stop large bodies, stalled connections and stalled DNS', async () => {
  for (const response of [
    { headers: { 'content-type': 'image/png', 'content-length': '1000' } },
    { body: Buffer.alloc(1000) },
  ]) {
    const net = transport([response]);
    await assert.rejects(checkImage('https://cdn.example.com/image', {
      request: net.request, resolve: publicDns, maxBytes: 100,
    }), /check limit/);
  }
  const stalled = transport([{ hang: true }]);
  await assert.rejects(checkImage('https://cdn.example.com/image', {
    request: stalled.request, resolve: publicDns, timeoutMs: 10,
  }), /timed out/);
  await assert.rejects(checkImage('https://cdn.example.com/image', {
    resolve: () => new Promise(() => {}), timeoutMs: 10,
    request: () => assert.fail('DNS timeout must not initiate an HTTP request.'),
  }), /timed out/);
  const encoded = transport([{ headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }]);
  await assert.rejects(checkImage('https://cdn.example.com/image', {
    request: encoded.request, resolve: publicDns,
  }), /Content-Encoding/);
});

test('hosted SVG and GIF keep their image semantics without inheriting Web File import restrictions', () => {
  inspectHostedImage(SVG, 'image/svg+xml');
  inspectHostedImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" style="color:blue"><circle r="2"/></svg>'), 'image/svg+xml');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  inspectHostedImage(gif, 'image/gif');
  assert.throws(() => inspectHostedImage(Buffer.from('<html><svg/></html>'), 'image/svg+xml'), /recognizable/);
  assert.throws(() => inspectHostedImage(PNG, 'image/gif'), /recognizable/);
});

test('AVIF and icon signatures are recognized without treating HTML as an image', () => {
  const avif = Buffer.alloc(24);
  avif.writeUInt32BE(24);
  avif.write('ftyp', 4);
  avif.write('avif', 8);
  inspectHostedImage(avif, 'image/avif');
  const ico = Buffer.alloc(22);
  ico.writeUInt32LE(0x00010000);
  ico.writeUInt16LE(1, 4);
  inspectHostedImage(ico, 'image/x-icon');
  assert.throws(() => inspectHostedImage(PNG, 'image/avif'), /recognizable/);
  assert.throws(() => inspectHostedImage(PNG, 'image/x-icon'), /recognizable/);
});

test('each exact URL is checked once with bounded concurrency, without mutating the plan', async () => {
  const urls = Array.from({ length: 7 }, (_, index) => `https://cdn.example.com/image-${index}?w=800&fit=crop`);
  const plan = externalPlan([...urls, urls[0]]);
  const before = JSON.stringify(plan);
  const calls = [];
  let active = 0;
  let peak = 0;
  const report = await verifyPlanImages(plan, { check: async (url) => {
    calls.push(url);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return successfulImageCheck(url);
  } });
  assert.deepEqual(calls, urls);
  assert.equal(report.images.length, 7);
  assert.ok(peak > 1 && peak <= 3);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(validateImageChecks(plan, report), report);
  const unchanged = { ...plan, assets: [] };
  const empty = await verifyPlanImages(unchanged, { check: () => assert.fail('No external images, no network.') });
  assert.deepEqual(empty.images, []);
});

test('failed sources identify every affected asset and cannot produce an approval report', async () => {
  const url = 'https://images.unsplash.com/photo-example?w=800';
  const plan = externalPlan([url, url]);
  let calls = 0;
  await assert.rejects(verifyPlanImages(plan, { check: async () => {
    calls += 1;
    throw new Error('Image URL returned HTTP 404.');
  } }), /Image 0, Image 1:.*HTTP 404[\s\S]*Choose a working direct image URL/);
  assert.equal(calls, 1);
});

test('changed plans, failed checks, duplicate results and malformed reports cannot authorize publication', async () => {
  const plan = externalPlan(['https://cdn.example.com/one', 'https://cdn.example.com/two']);
  const report = await verifyPlanImages(plan, { check: successfulImageCheck });
  for (const mutate of [
    (r) => { r.planHash = 'changed'; },
    (r) => { r.images.pop(); },
    (r) => { r.images[0].statusCode = 404; },
    (r) => { r.images[0].mimeType = 'text/html'; },
    (r) => { r.images[0].sizeBytes = 0; },
    (r) => { r.images[0].checkedAt = 'invalid'; },
    (r) => { r.images[1] = r.images[0]; },
    (r) => { r.images[0].finalUrl = 'http://cdn.example.com/image'; },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateImageChecks(plan, invalid), /image checks|Image checks|HTTPS/);
  }
  plan.summary = 'Changed after verification';
  assert.throws(() => validateImageChecks(plan, report), /stale image checks/);
});
