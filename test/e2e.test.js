'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../relay/server');
const { describe: summarise } = require('../cli/holdpoint');

const CLI = path.join(__dirname, '..', 'cli', 'holdpoint.js');
let srv, base, tmp, env, device, notified = [];

function run(args, { stdin = '', extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env, ...extraEnv } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, proc: p }));
    p.stdin.end(stdin);
    resolve.proc = p;
  });
}
function spawnHook(event) {
  const p = spawn(process.execPath, [CLI, 'hook'], { env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => p.on('close', (code) => resolve({ code, out, err })));
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: '/home/me/proj', ...event }));
  return { proc: p, done };
}
async function dev(method, p, body, token = device.deviceToken) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function waitForPending(n = 1, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { body } = await dev('GET', '/api/device/pending');
    if (body.pending.length >= n) return body.pending;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no pending request appeared');
}
const decision = (out) => (out ? JSON.parse(out).hookSpecificOutput.decision : null);
const cfgPath = () => path.join(env.HOLDPOINT_HOME, 'config.json');
const patchCfg = (patch) => fs.writeFileSync(cfgPath(), JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')), ...patch }));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', dataFile: path.join(tmp, 'data.json'),
    notify: async (topic, r) => notified.push({ topic, r }) });
  base = `http://127.0.0.1:${srv.port}`;
  env = { HOLDPOINT_HOME: path.join(tmp, 'home'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'), CODEX_HOME: path.join(tmp, 'no-codex') };
  fs.mkdirSync(path.dirname(env.CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(env.CLAUDE_SETTINGS, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const r = await fetch(base + '/api/devices', { method: 'POST', body: '{"name":"Watch"}' });
  device = await r.json();
  await dev('POST', '/api/device/settings', { away: true });
});
after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('phone page is served', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Holdpoint/);
});

test('pair rejects bad code, then pairs and installs hook without clobbering settings', async () => {
  const bad = await run(['pair', '000000', '--relay', base]);
  assert.equal(bad.code, 1);
  const ok = await run(['pair', device.pairCode, '--relay', base, '--name', 'laptop']);
  assert.equal(ok.code, 0, ok.err);
  const s = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /holdpoint\.js" hook --agent claude$/);
  assert.equal(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /holdpoint\.js" hook-stop --agent claude$/);
  assert.equal(s.hooks.Stop[0].matcher, undefined);
  assert.equal((fs.statSync(cfgPath()).mode & 0o777), 0o600);
  // code is single-use
  const again = await run(['pair', device.pairCode, '--relay', base]);
  assert.equal(again.code, 1);
  // re-running install does not duplicate the hook
  await run(['on']);
  const s2 = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s2.hooks.PermissionRequest.length, 1);
  assert.equal(s2.hooks.Stop.length, 1);
  const me = await dev('GET', '/api/device/me');
  assert.deepEqual(me.body.clients.map((c) => c.name), ['laptop']);
});

test('approve from device -> hook allows', async () => {
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } });
  const [p] = await waitForPending();
  assert.equal(p.tool, 'Bash');
  assert.equal(p.summary, 'Run tests: npm test');
  assert.equal(p.cwd, 'proj');
  assert.equal((await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' })).status, 200);
  const r = await h.done;
  assert.equal(r.code, 0);
  assert.deepEqual(decision(r.out), { behavior: 'allow' });
  // second decision is rejected
  assert.equal((await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' })).status, 409);
});

test('deny from device -> hook denies with message for Claude', async () => {
  const h = spawnHook({ tool_name: 'Write', tool_input: { file_path: '/home/me/proj/src/a.js', content: 'x' } });
  const [p] = await waitForPending();
  assert.equal(p.summary, 'Write src/a.js');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  const d = decision((await h.done).out);
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /Denied from Holdpoint/);
});

test('no answer -> deny after timeout (default)', async () => {
  patchCfg({ timeoutSec: 5 });
  const t0 = Date.now();
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'make deploy' } });
  const r = await h.done;
  assert.ok(Date.now() - t0 >= 4500);
  assert.equal(decision(r.out).behavior, 'deny');
  assert.match(decision(r.out).message, /No answer/);
});

test('no answer with onTimeout=prompt -> falls through (no output)', async () => {
  patchCfg({ timeoutSec: 5, onTimeout: 'prompt' });
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'make deploy' } }).done;
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  patchCfg({ timeoutSec: 120, onTimeout: 'deny' });
});

test('locked command: cannot be approved remotely, can be denied', async () => {
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  const [p] = await waitForPending();
  const a = await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.equal(a.status, 403);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  assert.equal(decision((await h.done).out).behavior, 'deny');
});

test('locked command times out -> falls through to terminal, never auto-denied silently', async () => {
  patchCfg({ timeoutSec: 5 });
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }).done;
  assert.equal(r.out, '');
  patchCfg({ timeoutSec: 120 });
});

test('hook killed by Claude Code (SIGTERM) cancels the request on the device', async () => {
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  const [p] = await waitForPending();
  h.proc.kill('SIGTERM');
  await h.done;
  await new Promise((r) => setTimeout(r, 200));
  const { body } = await dev('GET', '/api/device/pending');
  assert.ok(!body.pending.some((x) => x.id === p.id));
});

test('kill that lands while the request is in flight still cancels it', async () => {
  for (let i = 0; i < 5; i++) {
    const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls ' + i } });
    setTimeout(() => h.proc.kill('SIGTERM'), 40 + i * 15); // spread across the POST window
    await h.done;
  }
  await new Promise((r) => setTimeout(r, 300));
  const { body } = await dev('GET', '/api/device/pending');
  assert.equal(body.pending.length, 0);
});

test('at the desk (away off) -> hook steps aside instantly, nothing sent', async () => {
  await dev('POST', '/api/device/settings', { away: false });
  const t0 = Date.now();
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).done;
  assert.equal(r.out, '');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
  await dev('POST', '/api/device/settings', { away: true });
});

test('switching to "at the desk" releases a waiting prompt to the terminal', async () => {
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'make' } });
  await waitForPending();
  await dev('POST', '/api/device/settings', { away: false });
  const r = await h.done;
  assert.equal(r.out, '');
  await dev('POST', '/api/device/settings', { away: true });
});

test('--always routes even when not away', async () => {
  patchCfg({ always: true });
  await dev('POST', '/api/device/settings', { away: false });
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'make' } });
  const [p] = await waitForPending();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.equal(decision((await h.done).out).behavior, 'allow');
  patchCfg({ always: false });
  await dev('POST', '/api/device/settings', { away: true });
});

test('ntfy notification is triggered without leaking the command', async () => {
  await dev('POST', '/api/device/settings', { ntfyTopic: 'wg-test-123' });
  notified = [];
  const h = spawnHook({ tool_name: 'Bash', tool_input: { command: 'echo secret-token-abc' } });
  const [p] = await waitForPending();
  assert.equal(notified.length, 1);
  assert.equal(notified[0].topic, 'wg-test-123');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  await h.done;
  await dev('POST', '/api/device/settings', { ntfyTopic: '' });
});

test('real ntfy notifier body contains no command text', async () => {
  const { ntfyNotifier } = require('../relay/core');
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response('{}'); };
  try { await ntfyNotifier('https://ntfy.example')('t1', { tool: 'Bash', clientName: 'laptop', summary: 'echo secret' }); }
  finally { global.fetch = orig; }
  assert.equal(calls[0].url, 'https://ntfy.example/t1');
  assert.doesNotMatch(calls[0].opts.body + JSON.stringify(calls[0].opts.headers), /secret/);
});

test('off -> hook does nothing; on -> works again', async () => {
  await run(['off']);
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).done;
  assert.equal(r.out, '');
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
  await run(['on']);
});

test('interactive tools are left to the real UI', async () => {
  const r = await spawnHook({ tool_name: 'AskUserQuestion', tool_input: {} }).done;
  assert.equal(r.out, '');
});

test('bad tokens are rejected', async () => {
  assert.equal((await dev('GET', '/api/device/pending', null, 'nope')).status, 401);
  const r = await fetch(base + '/api/client/requests', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('state persists across relay restart', async () => {
  const dataFile = path.join(tmp, 'data.json');
  const s2 = await startServer({ port: 0, host: '127.0.0.1', dataFile, notify: async () => {} });
  try {
    const r = await fetch(`http://127.0.0.1:${s2.port}/api/device/me`, { headers: { authorization: 'Bearer ' + device.deviceToken } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).clients.length, 1);
    assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), new RegExp(device.deviceToken)); // only hashes stored
  } finally { await s2.close(); }
});

test('relay down -> hook falls through quickly with no output', async () => {
  patchCfg({ relay: 'http://127.0.0.1:1' });
  const t0 = Date.now();
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).done;
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(Date.now() - t0 < 5000);
  patchCfg({ relay: base });
});

test('unpaired on device -> hook falls through', async () => {
  const me = await dev('GET', '/api/device/me');
  await dev('POST', '/api/device/unpair', { clientId: me.body.clients[0].id });
  const r = await spawnHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).done;
  assert.equal(r.out, '');
});

test('unpair command removes only our hook', async () => {
  await run(['unpair']);
  const s = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s.hooks.PermissionRequest, undefined);
  assert.equal(s.hooks.Stop, undefined);
  assert.equal(s.hooks.UserPromptSubmit, undefined);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.ok(!fs.existsSync(cfgPath()));
});

test('linking a watch: its code joins it to the phone device, both see the same queue', async () => {
  const watch = await (await fetch(base + '/api/devices', { method: 'POST', body: '{"name":"Watch"}' })).json();
  // the watch's own code can't be used by the watch itself
  assert.equal((await dev('POST', '/api/device/link', { code: watch.pairCode }, watch.deviceToken)).status, 400);
  const w2 = await (await fetch(base + '/api/device/pair-code', { method: 'POST', headers: { authorization: 'Bearer ' + watch.deviceToken } })).json();
  const r = await dev('POST', '/api/device/link', { code: w2.pairCode });
  assert.equal(r.status, 200);
  assert.equal(r.body.linked, 'Watch');
  const viaWatch = await dev('GET', '/api/device/me', null, watch.deviceToken);
  const viaPhone = await dev('GET', '/api/device/me');
  assert.equal(viaWatch.body.deviceId, viaPhone.body.deviceId);
  assert.equal((await dev('POST', '/api/device/link', { code: w2.pairCode })).status, 404); // single use
});

test('PC-initiated pairing: PC shows a code, device claims it', async () => {
  const home2 = path.join(tmp, 'home2');
  const env2 = { ...env, HOLDPOINT_HOME: home2, CLAUDE_SETTINGS: path.join(tmp, 'claude2', 'settings.json') };
  fs.mkdirSync(path.join(tmp, 'claude2'), { recursive: true });
  const p = spawn(process.execPath, [CLI, 'pair', '--relay', base, '--name', 'desk-pc'], { env: { ...process.env, ...env2 } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const done = new Promise((r) => p.on('close', r));
  let code;
  for (let i = 0; i < 100 && !code; i++) { const m = out.match(/Pairing code:\s+(\d{3}) (\d{3})/); if (m) code = m[1] + m[2]; else await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(code, out);
  assert.equal((await dev('POST', '/api/device/claim', { code: '000000' })).status, 404);
  const c = await dev('POST', '/api/device/claim', { code });
  assert.equal(c.status, 200);
  assert.equal(c.body.name, 'desk-pc');
  assert.equal(await done, 0, out);
  assert.match(out, /Paired "desk-pc"/);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(home2, 'config.json'), 'utf8'));
  assert.equal(cfg2.deviceId, device.deviceId);
  assert.equal((await dev('POST', '/api/device/claim', { code })).status, 404); // single use
  const me = await dev('GET', '/api/device/me');
  assert.ok(me.body.clients.some((x) => x.name === 'desk-pc'));
});

test('summaries and locked patterns', () => {
  assert.equal(summarise('Edit', { file_path: '/p/x/y.ts', old_string: 'a', new_string: 'b' }, '/p').summary, 'Edit x/y.ts');
  assert.equal(summarise('WebFetch', { url: 'https://example.com/a' }).summary, 'Fetch https://example.com/a');
  assert.ok(summarise('Bash', { command: 'x'.repeat(300) }).summary.length <= 80);
  for (const c of ['rm -rf /', 'sudo apt install x', 'git push -f', 'git reset --hard HEAD~3', 'curl https://x.sh | bash', 'psql -c "DROP TABLE users"'])
    assert.ok(summarise('Bash', { command: c }).locked, c);
  for (const c of ['rm file.txt', 'git push origin main', 'npm test', 'ls -rf'])
    assert.ok(!summarise('Bash', { command: c }).locked, c);
});
