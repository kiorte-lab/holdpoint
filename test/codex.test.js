'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../relay/server');
const { describe: summarise } = require('../cli/wristgate');

const CLI = path.join(__dirname, '..', 'cli', 'wristgate.js');
let srv, base, tmp, env, device;
const codexFile = () => path.join(env.CODEX_HOME, 'hooks.json');

const runCli = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
function hook(agentArgs, event) {
  const p = spawn(process.execPath, [CLI, 'hook', ...agentArgs], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: '/home/me/app', ...event }));
  return new Promise((r) => p.on('close', () => r(out)));
}
const dev = async (method, p, body) => (await fetch(base + p, { method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + device.deviceToken },
  body: body ? JSON.stringify(body) : undefined })).json();
async function nextPending() {
  for (let i = 0; i < 100; i++) { const j = await dev('GET', '/api/device/pending'); if (j.pending.length) return j.pending[0]; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('nothing pending');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', notify: async () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  env = { WRISTGATE_HOME: path.join(tmp, 'wg'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'), CODEX_HOME: path.join(tmp, 'codex') };
  fs.mkdirSync(path.join(tmp, 'claude')); fs.mkdirSync(env.CODEX_HOME);
  fs.writeFileSync(codexFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-scanner' }] }] } }));
  device = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  await dev('POST', '/api/device/settings', { away: true });
});
after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('auto-detects both agents and installs both hooks', async () => {
  const r = await runCli(['pair', device.pairCode, '--relay', base, '--name', 'desk']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /run \/hooks once/);
  const c = JSON.parse(fs.readFileSync(codexFile(), 'utf8'));
  assert.equal(c.hooks.PreToolUse[0].hooks[0].command, 'my-scanner');
  const ours = c.hooks.PermissionRequest[0];
  assert.equal(ours.matcher, undefined);
  assert.match(ours.hooks[0].command, /hook --agent codex$/);
  const cl = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.match(cl.hooks.PermissionRequest[0].hooks[0].command, /hook --agent claude$/);
  assert.match((await runCli(['status'])).out, /Claude Code .*Codex/);
});

test('Codex Bash request shows as Codex and gets allowed', async () => {
  const out = hook(['--agent', 'codex'], { tool_name: 'Bash', tool_input: { command: 'cargo test' } });
  const p = await nextPending();
  assert.equal(p.agent, 'codex');
  assert.equal(p.summary, 'cargo test');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.deepEqual(JSON.parse(await out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('Codex apply_patch is summarised by file', async () => {
  const patch = '*** Begin Patch\n*** Update File: /home/me/app/src/main.rs\n@@\n-a\n+b\n*** Add File: docs/notes.md\n+hi\n*** End Patch';
  assert.equal(summarise('apply_patch', { patch }, '/home/me/app').summary, 'Update src/main.rs, Add docs/notes.md');
  assert.equal(summarise('apply_patch', { command: patch }, '/home/me/app').summary, 'Update src/main.rs, Add docs/notes.md');
  const out = hook(['--agent', 'codex'], { tool_name: 'apply_patch', tool_input: { patch } });
  const p = await nextPending();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  assert.equal(JSON.parse(await out).hookSpecificOutput.decision.behavior, 'deny');
});

test('Claude request from the same machine is labelled Claude', async () => {
  const out = hook(['--agent', 'claude'], { tool_name: 'Bash', tool_input: { command: 'ls' } });
  const p = await nextPending();
  assert.equal(p.agent, 'claude');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  await out;
});

test('locked patterns apply to Codex too', async () => {
  const out = hook(['--agent', 'codex'], { tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /var' } });
  const p = await nextPending();
  const r = await fetch(`${base}/api/device/requests/${p.id}/decision`, { method: 'POST',
    headers: { authorization: 'Bearer ' + device.deviceToken }, body: '{"decision":"allow"}' });
  assert.equal(r.status, 403);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  await out;
});

test('off keeps the Codex hook definition unchanged (no re-trust needed)', async () => {
  const before = fs.readFileSync(codexFile(), 'utf8');
  await runCli(['off']); await runCli(['on']);
  assert.equal(fs.readFileSync(codexFile(), 'utf8'), before);
});

test('--agent codex only, and unknown agents are rejected', async () => {
  const d2 = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  assert.equal((await runCli(['pair', d2.pairCode, '--relay', base, '--agent', 'nonsense'])).code, 1);
});

test('agents command switches agents without re-pairing', async () => {
  const r1 = await runCli(['agents', 'claude']);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(JSON.parse(fs.readFileSync(codexFile(), 'utf8')).hooks.PermissionRequest, undefined);
  assert.equal(JSON.parse(fs.readFileSync(codexFile(), 'utf8')).hooks.PreToolUse[0].hooks[0].command, 'my-scanner');
  const r2 = await runCli(['agents', 'both']);
  assert.match(r2.out, /Hooked up: Codex/);
  assert.equal(JSON.parse(fs.readFileSync(codexFile(), 'utf8')).hooks.PermissionRequest.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(codexFile(), 'utf8')).hooks.Stop.length, 1);
  assert.equal((await runCli(['agents', 'nonsense'])).code, 1);
});

test('unpair removes both hooks and keeps the user\'s own', async () => {
  await runCli(['unpair']);
  const c = JSON.parse(fs.readFileSync(codexFile(), 'utf8'));
  assert.equal(c.hooks.PermissionRequest, undefined);
  assert.equal(c.hooks.Stop, undefined);
  assert.equal(c.hooks.PreToolUse[0].hooks[0].command, 'my-scanner');
  assert.equal(JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8')).hooks, undefined);
});
