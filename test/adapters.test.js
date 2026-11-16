'use strict';
// Copilot CLI and Antigravity CLI: install format, their own payload shapes, and the answer dialect each expects.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../relay/server');

const CLI = path.join(__dirname, '..', 'cli', 'wristgate.js');
let srv, base, tmp, env, device;

const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
function hookRun(sub, agent, payload) {
  const p = spawn(process.execPath, [CLI, sub, '--agent', agent], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify(payload));
  return { proc: p, done: new Promise((r) => p.on('close', () => r(out))) };
}
const dev = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + device.deviceToken },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function next() {
  for (let i = 0; i < 100; i++) { const p = (await dev('GET', '/api/device/pending')).body.pending[0]; if (p) return p; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('nothing pending');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', notify: async () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  env = { WRISTGATE_HOME: path.join(tmp, 'wg'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'),
    CODEX_HOME: path.join(tmp, 'nocodex'), COPILOT_HOME: path.join(tmp, 'copilot'), GEMINI_HOME: path.join(tmp, 'gemini') };
  fs.mkdirSync(path.join(tmp, 'claude')); fs.mkdirSync(env.COPILOT_HOME); fs.mkdirSync(path.join(env.GEMINI_HOME, 'config'), { recursive: true });
  // someone else's Antigravity hook that must survive
  fs.writeFileSync(path.join(env.GEMINI_HOME, 'config', 'hooks.json'), JSON.stringify({ 'my-linter': { PostToolUse: [{ matcher: 'run_command', command: './lint.sh' }] } }));
  device = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  await dev('POST', '/api/device/settings', { away: true });
});
after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('detects Copilot and Antigravity and installs both in their own formats', async () => {
  const r = await run(['pair', device.pairCode, '--relay', base, '--name', 'multi']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Copilot CLI/); assert.match(r.out, /Antigravity CLI/);
  const cp = JSON.parse(fs.readFileSync(path.join(env.COPILOT_HOME, 'hooks', 'wristgate.json'), 'utf8'));
  assert.equal(cp.version, 1);
  assert.match(cp.hooks.permissionRequest[0].command, /hook --agent copilot$/);
  assert.equal(cp.hooks.permissionRequest[0].timeoutSec, 150);
  assert.match(cp.hooks.Stop[0].command, /hook-stop --agent copilot$/);
  assert.match(cp.hooks.UserPromptSubmit[0].command, /hook-prompt --agent copilot$/);
  const ag = JSON.parse(fs.readFileSync(path.join(env.GEMINI_HOME, 'config', 'hooks.json'), 'utf8'));
  assert.equal(ag['my-linter'].PostToolUse[0].command, './lint.sh');
  assert.equal(ag.wristgate.PreToolUse[0].matcher, '*');
  assert.match(ag.wristgate.PreToolUse[0].command, /hook --agent antigravity$/);
  assert.match(ag.wristgate.Stop[0].command, /hook-stop --agent antigravity$/);
});

test('Copilot permissionRequest (camelCase, toolArgs as JSON string) -> allow in Copilot dialect', async () => {
  const h = hookRun('hook', 'copilot', { sessionId: 's', timestamp: Date.now(), cwd: '/home/me/api', toolName: 'bash', toolArgs: JSON.stringify({ command: 'npm publish' }) });
  const p = await next();
  assert.equal(p.agent, 'copilot');
  assert.equal(p.tool, 'Bash');
  assert.equal(p.summary, 'npm publish');
  assert.equal(p.cwd, 'api');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  const out = JSON.parse(await h.done);
  assert.equal(out.behavior, 'allow');
  assert.equal(out.permissionDecision, 'allow');
});

test('Copilot deny carries a reason for the agent', async () => {
  const h = hookRun('hook', 'copilot', { cwd: '/x/web', tool_name: 'write', tool_input: { path: '/x/web/index.html', content: '<h1>' } });
  const p = await next();
  assert.equal(p.summary, 'Write index.html');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  const out = JSON.parse(await h.done);
  assert.equal(out.behavior, 'deny');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Denied from Wristgate/);
});

test('Antigravity PreToolUse: run_command approved from the wrist -> auto_approve', async () => {
  const h = hookRun('hook', 'antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'pytest -q', Cwd: '/home/me/svc' } }, stepIdx: 3, workspacePaths: ['/home/me/svc'] });
  const p = await next();
  assert.equal(p.agent, 'antigravity');
  assert.equal(p.summary, 'pytest -q');
  assert.equal(p.cwd, 'svc');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.deepEqual(JSON.parse(await h.done), { decision: 'auto_approve' });
});

test('Antigravity: reads never reach the wrist and get an explicit allow', async () => {
  const out = await hookRun('hook', 'antigravity', { toolCall: { name: 'view_file', args: { AbsolutePath: '/x/a.py' } } }).done;
  assert.deepEqual(JSON.parse(out), { decision: 'allow' });
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('Antigravity: locked command can only be denied, deny is a hard block', async () => {
  const h = hookRun('hook', 'antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'git push --force', Cwd: '/x' } } });
  const p = await next();
  assert.equal(p.locked, true);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'deny' });
  const out = JSON.parse(await h.done);
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /Denied from Wristgate/);
});

test('Antigravity: at the desk, an explicit allow so its own policy applies', async () => {
  await dev('POST', '/api/device/settings', { away: false });
  const out = await hookRun('hook', 'antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }).done;
  assert.deepEqual(JSON.parse(out), { decision: 'allow' });
  await dev('POST', '/api/device/settings', { away: true });
});

test('Stop replies: Copilot gets block+reason, Antigravity gets continue+reason', async () => {
  const h1 = hookRun('hook-stop', 'copilot', { hook_event_name: 'Stop', stop_reason: 'end_turn', cwd: '/x/api' });
  const p1 = await next();
  assert.equal(p1.kind, 'stop'); assert.equal(p1.agent, 'copilot');
  await dev('POST', `/api/device/requests/${p1.id}/decision`, { decision: 'reply', reply: 'Run the tests' });
  const o1 = JSON.parse(await h1.done);
  assert.equal(o1.decision, 'block'); assert.match(o1.reason, /"Run the tests"/);

  const h2 = hookRun('hook-stop', 'antigravity', { executionNum: 2, terminationReason: 'done', fullyIdle: true, workspacePaths: ['/x/svc'] });
  const p2 = await next();
  assert.equal(p2.agent, 'antigravity'); assert.equal(p2.cwd, 'svc');
  await dev('POST', `/api/device/requests/${p2.id}/decision`, { decision: 'reply', reply: 'Continue' });
  const o2 = JSON.parse(await h2.done);
  assert.equal(o2.decision, 'continue'); assert.match(o2.reason, /"Continue"/);
});

test('Gemini-style AfterAgent text (prompt_response) shows on the card', async () => {
  const h = hookRun('hook-stop', 'antigravity', { prompt: 'fix it', prompt_response: 'Fixed the flaky test in auth_test.go.' });
  const p = await next();
  assert.equal(p.summary, 'Fixed the flaky test in auth_test.go.');
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'dismiss' });
  assert.equal(await h.done, '');
});

test('a turn that was only a /wristgate command makes no finished card', async () => {
  const t = path.join(tmp, 't.jsonl');
  fs.writeFileSync(t, [
    { type: 'user', message: { role: 'user', content: '<command-name>/wristgate:on</command-name>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Wristgate on.' }] } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const out = await hookRun('hook-stop', 'claude', { transcript_path: t, cwd: '/x' }).done;
  assert.equal(out, '');
  assert.equal((await dev('GET', '/api/device/pending')).body.pending.length, 0);
});

test('aliases and unpair: gemini means antigravity; unpair removes only ours', async () => {
  const r = await run(['agents', 'claude,gemini']);
  assert.match(r.out, /Antigravity CLI/);
  assert.ok(!fs.existsSync(path.join(env.COPILOT_HOME, 'hooks', 'wristgate.json')));
  await run(['unpair']);
  const ag = JSON.parse(fs.readFileSync(path.join(env.GEMINI_HOME, 'config', 'hooks.json'), 'utf8'));
  assert.equal(ag.wristgate, undefined);
  assert.equal(ag['my-linter'].PostToolUse[0].command, './lint.sh');
});
