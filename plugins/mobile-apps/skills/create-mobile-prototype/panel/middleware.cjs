'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./panel-core.cjs');
const projectDir = path.resolve(__dirname, '..');

function send(res, status, value, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let input = '';
    req.on('data', (chunk) => { input += chunk; if (input.length > 65536) reject(new Error('request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(input || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

module.exports = function handlePanel(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && pathname === '/panel') {
    send(res, 200, fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && pathname === '/panel/state') {
    send(res, 200, core.loadState(projectDir));
    return true;
  }
  if (req.method === 'POST' && (pathname === '/panel/model' || pathname === '/panel/screens')) {
    body(req).then((value) => send(res, 200, pathname.endsWith('/model') ? core.modelEdit(projectDir, value) : core.screenEdit(projectDir, value))).catch((error) => send(res, 400, { ok: false, error: error.message }));
    return true;
  }
  return false;
};