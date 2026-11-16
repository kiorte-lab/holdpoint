// Runs the Worker in Cloudflare's local emulator (wrangler dev) and drives it with the real CLI/hook.
// Usage: WRANGLER=/path/to/node_modules/.bin/wrangler node --test test/worker.smoke.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WRANGLER = process.env.WRANGLER;
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'wristgate.js');
const PORT = 8790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let wr, tmp, env, device;

async function startWrangler() {
  wr = spawn(WRANGLER, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', path.join(tmp, 'state')],
    { cwd: ROOT, env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false' } });
  let log = ''; wr.stdout.on('data', (d) => (log += d)); wr.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler did not start:\n' + log.slice(-2000));
}
const stopWrangler = () => new Promise((r) => { if (!wr || wr.exitCode !== null) return r(); wr.on('close', r); wr.kill('SIGINT'); });

const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
function hook(event) {
  const p = spawn(process.execPath, [CLI, 'hook', '--agent', 'claude'], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ cwd: '/w/proj', ...event }));
  return { proc: p, done: new Promise((r) => p.on('close', () => r(out))) };
}
const dev = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + device.deviceToken },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function nextPending() {
  for (let i = 0; i < 100; i++) { const { body } = await dev('GET', '/api/device/pending'); if (body.pending.length) return body.pending[0]; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('nothing pending');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgw-'));
  env = { WRISTGATE_HOME: path.join(tmp, 'wg'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'), CODEX_HOME: path.join(tmp, 'nocodex'),
    NO_PROXY: '127.0.0.1,localhost' };
  fs.mkdirSync(path.join(tmp, 'claude'));
  await startWrangler();
  device = await (await fetch(base + '/api/devices', { method: 'POST', body: '{"name":"Watch"}' })).json();
  await dev('POST', '/api/device/settings', { away: true });
}, { timeout: 90000 });
after(async () => { await stopWrangler(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('page served by the Worker', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Wristgate/);
});

test('pair against the Worker', async () => {
  const r = await run(['pair', device.pairCode, '--relay', base, '--name', 'worker-test']);
  assert.equal(r.code, 0, r.out);
});

test('allow round trip through the Durable Object long-poll', async () => {
  const h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  const p = await nextPending();
  assert.equal(p.summary, 'npm run build');
  await new Promise((r) => setTimeout(r, 1500)); // make sure the hook is parked in a long-poll
  const t0 = Date.now();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  const out = await h.done;
  assert.ok(Date.now() - t0 < 2000, 'long-poll should wake promptly');
  assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow');
});

test('deny and locked rules hold on the Worker', async () => {
  const h = hook({ tool_name: 'Bash', tool_input: { command: 'git push --force' } });
  const p = await nextPending();
  assert.equal((await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' })).status, 403);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  assert.equal(JSON.parse(await h.done).hookSpecificOutput.decision.behavior, 'deny');
});

test('timeout expires on the Worker', async () => {
  const cfgFile = path.join(env.WRISTGATE_HOME, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, timeoutSec: 5 }));
  const out = await hook({ tool_name: 'Bash', tool_input: { command: 'make' } }).done;
  assert.match(JSON.parse(out).hookSpecificOutput.decision.message, /No answer/);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
});

test('SIGTERM cancel on the Worker', async () => {
  const h = hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  await nextPending();
  h.proc.kill('SIGTERM');
  await h.done;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('pairings survive a Worker restart (Durable Object storage)', async () => {
  await stopWrangler();
  await startWrangler();
  const me = await dev('GET', '/api/device/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.clients.map((c) => c.name), ['worker-test']);
  const h = hook({ tool_name: 'Bash', tool_input: { command: 'echo after-restart' } });
  const p = await nextPending();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.equal(JSON.parse(await h.done).hookSpecificOutput.decision.behavior, 'allow');
});

test('finished card + reply through the Worker', async () => {
  const p = spawn(process.execPath, [CLI, 'hook-stop', '--agent', 'claude'], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ cwd: '/w/proj', last_assistant_message: 'Build is green.' }));
  const done = new Promise((r) => p.on('close', r));
  const r = await nextPending();
  assert.equal(r.kind, 'stop');
  await dev('POST', `/api/device/requests/${r.id}/decision`, { decision: 'reply', reply: 'Commit and push' });
  await done;
  assert.equal(JSON.parse(out).decision, 'block');
});

test('away toggle off releases waiting prompt on the Worker', async () => {
  const h = hook({ tool_name: 'Bash', tool_input: { command: 'make' } });
  await nextPending();
  await dev('POST', '/api/device/settings', { away: false });
  assert.equal(await h.done, '');
  await dev('POST', '/api/device/settings', { away: true });
});
