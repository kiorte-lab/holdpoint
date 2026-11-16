'use strict';
// "Finished" cards: the Stop hook, away mode, replies going back to the agent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../relay/server');
const { lastAssistantText } = require('../cli/wristgate');

const CLI = path.join(__dirname, '..', 'cli', 'wristgate.js');
let srv, base, tmp, env, device, transcript;

const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
function stopHook(event, agent = 'claude') {
  const p = spawn(process.execPath, [CLI, 'hook-stop', '--agent', agent], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: '/home/me/site', session_id: 's1', ...event }));
  return { proc: p, done: new Promise((r) => p.on('close', () => r(out))) };
}
const dev = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + device.deviceToken },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function nextPending() {
  for (let i = 0; i < 100; i++) { const { body } = await dev('GET', '/api/device/pending'); if (body.pending.length) return body.pending[0]; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('nothing pending');
}
const patchCfg = (patch) => { const f = path.join(env.WRISTGATE_HOME, 'config.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch })); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgs-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', notify: async () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  env = { WRISTGATE_HOME: path.join(tmp, 'wg'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'), CODEX_HOME: path.join(tmp, 'codex') };
  fs.mkdirSync(path.join(tmp, 'claude')); fs.mkdirSync(env.CODEX_HOME);
  device = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  assert.equal((await run(['pair', device.pairCode, '--relay', base, '--name', 'desk'])).code, 0);
  // A Claude Code-style transcript: JSONL, last assistant text is what the card should show.
  transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'fix the login bug' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking now.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the login bug in auth.ts. The 2 failing tests now pass.' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
});
after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('reads the last assistant text from a transcript, or Codex\'s field', () => {
  assert.equal(lastAssistantText({ transcript_path: transcript }), 'Fixed the login bug in auth.ts. The 2 failing tests now pass.');
  assert.equal(lastAssistantText({ last_assistant_message: 'Codex says hi' }), 'Codex says hi');
  assert.equal(lastAssistantText({ transcript_path: '/nope' }), '');
});

test('at the desk: Stop hook exits at once, no card', async () => {
  const t0 = Date.now();
  const out = await stopHook({ transcript_path: transcript }).done;
  assert.equal(out, '');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('away: finished card shows what Claude said, preset reply goes back as next instruction', async () => {
  await dev('POST', '/api/device/settings', { away: true });
  const h = stopHook({ transcript_path: transcript });
  const p = await nextPending();
  assert.equal(p.kind, 'stop');
  assert.equal(p.summary, 'Fixed the login bug in auth.ts. The 2 failing tests now pass.');
  assert.equal(p.cwd, 'site');
  const me = await dev('GET', '/api/device/pending');
  assert.deepEqual(me.body.presets, ['Continue', 'Run the tests', 'Commit and push', 'Summarise what you did']);
  assert.equal((await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' })).status, 400);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'reply', reply: 'Commit and push' });
  const out = JSON.parse(await h.done);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /"Commit and push"/);
});

test('free-text reply and custom presets', async () => {
  const set = await dev('POST', '/api/device/settings', { presets: ['Deploy to staging', '', 'Write a PR description'] });
  assert.deepEqual(set.body.presets, ['Deploy to staging', 'Write a PR description']);
  const h = stopHook({ transcript_path: transcript });
  const p = await nextPending();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'reply', reply: '  also bump the version  ' });
  assert.match(JSON.parse(await h.done).reason, /"also bump the version"/);
  assert.equal((await dev('POST', `/api/device/requests/x/decision`, { decision: 'reply', reply: '' })).status, 404);
});

test('"Done for now" lets the agent stop normally', async () => {
  const h = stopHook({ transcript_path: transcript });
  const p = await nextPending();
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'dismiss' });
  assert.equal(await h.done, '');
});

test('no reply in time -> agent stops normally', async () => {
  patchCfg({ replyTimeoutSec: 5 });
  const out = await stopHook({ transcript_path: transcript }).done;
  assert.equal(out, '');
  patchCfg({ replyTimeoutSec: 900 });
});

test('coming back to the desk releases a waiting finished card', async () => {
  const h = stopHook({ transcript_path: transcript });
  await nextPending();
  await dev('POST', '/api/device/settings', { away: false });
  assert.equal(await h.done, '');
  await dev('POST', '/api/device/settings', { away: true });
});

test('Codex Stop uses last_assistant_message and is labelled Codex', async () => {
  const h = stopHook({ last_assistant_message: 'All 40 tests green.' }, 'codex');
  const p = await nextPending();
  assert.equal(p.agent, 'codex');
  assert.equal(p.summary, 'All 40 tests green.');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'reply', reply: 'Continue' });
  assert.equal(JSON.parse(await h.done).decision, 'block');
});

test('empty transcript still gives a usable card', async () => {
  const h = stopHook({});
  const p = await nextPending();
  assert.equal(p.summary, 'Finished and waiting for you');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'dismiss' });
  await h.done;
});

test('SIGTERM (user typed in the terminal) clears the card', async () => {
  const h = stopHook({ transcript_path: transcript });
  await nextPending();
  h.proc.kill('SIGTERM');
  await h.done;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('typing in the terminal (UserPromptSubmit) clears a waiting finished card', async () => {
  const h = stopHook({ transcript_path: transcript });
  await nextPending();
  const p = spawn(process.execPath, [CLI, 'hook-prompt', '--agent', 'claude'], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'run git status' }));
  await new Promise((r) => p.on('close', r));
  assert.equal(out, '');                // nothing added to Claude's context
  assert.equal(await h.done, '');       // Stop hook lets Claude stop normally, queued message runs
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('UserPromptSubmit hook is installed and removed with the others', () => {
  const s = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /hook-prompt --agent claude$/);
});

test('--no-stop removes the Stop hook', async () => {
  const d2 = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  await run(['pair', d2.pairCode, '--relay', base, '--no-stop']);
  const s = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s.hooks.Stop, undefined);
  assert.equal(s.hooks.UserPromptSubmit, undefined);
  assert.equal(s.hooks.PermissionRequest.length, 1);
});
