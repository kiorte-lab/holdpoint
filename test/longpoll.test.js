// The watch and phone page long-poll /api/device/pending instead of asking every few seconds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer } = require('../relay/server');

test('device pending long-poll waits for a change and wakes on a new request', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-lp-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataFile: path.join(tmp, 'd.json') });
  const base = 'http://127.0.0.1:' + srv.port;
  const j = async (m, p, body, tok) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  const dev = await j('POST', '/api/devices', { name: 'W' });
  const cli = await j('POST', '/api/pair', { code: dev.pairCode, name: 'pc' });
  const first = await j('GET', '/api/device/pending', null, dev.deviceToken);
  assert.ok(typeof first.version === 'number');

  // Stale version: answers at once.
  let t = Date.now();
  await j('GET', `/api/device/pending?wait=5&v=${first.version - 1}`, null, dev.deviceToken);
  assert.ok(Date.now() - t < 1000, 'stale version returns immediately');

  // Current version: waits until a request arrives, then returns it.
  t = Date.now();
  const waiting = j('GET', `/api/device/pending?wait=10&v=${first.version}`, null, dev.deviceToken);
  setTimeout(() => j('POST', '/api/client/requests', { kind: 'permission', tool: 'Bash', summary: 'ls', timeoutSec: 60 }, cli.clientToken), 400);
  const got = await waiting;
  const took = Date.now() - t;
  assert.ok(took >= 300 && took < 5000, 'woke on the new request, took ' + took);
  assert.strictEqual(got.pending.length, 1);
  assert.ok(got.version > first.version);

  // Nothing changes: times out after the wait with the same version.
  t = Date.now();
  const idle = await j('GET', `/api/device/pending?wait=1&v=${got.version}`, null, dev.deviceToken);
  assert.ok(Date.now() - t >= 900);
  assert.strictEqual(idle.version, got.version);

  // Deciding wakes a waiting poll too.
  const w2 = j('GET', `/api/device/pending?wait=10&v=${got.version}`, null, dev.deviceToken);
  setTimeout(() => j('POST', `/api/device/requests/${got.pending[0].id}/decision`, { decision: 'allow' }, dev.deviceToken), 300);
  const after = await w2;
  assert.strictEqual(after.pending.length, 0);
  await srv.close();
});
