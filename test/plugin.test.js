'use strict';
// Plugin mode: hooks come from the plugin, settings.json is left alone, /wristgate pair detaches.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../relay/server');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'wristgate.js');
let srv, base, tmp, env, device;

const run = (args, extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env, ...extra } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
// Run a hook exactly as the plugin's hooks.json would (with --plugin), or as settings.json would (without).
function hook(viaPlugin, event) {
  const args = [CLI, 'hook', '--agent', 'claude', ...(viaPlugin ? ['--plugin'] : [])];
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ cwd: '/x/proj', ...event }));
  return { proc: p, done: new Promise((r) => p.on('close', () => r(out))) };
}
const dev = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + device.deviceToken },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const pending = async () => (await dev('GET', '/api/device/pending')).body.pending;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgp-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', notify: async () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  env = { WRISTGATE_HOME: path.join(tmp, 'wg'), CLAUDE_SETTINGS: path.join(tmp, 'claude', 'settings.json'), CODEX_HOME: path.join(tmp, 'nocodex'),
    WRISTGATE_DEFAULT_RELAY: base };
  fs.mkdirSync(path.join(tmp, 'claude'));
  // pretend an older non-plugin install left hooks in settings.json
  fs.writeFileSync(env.CLAUDE_SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/old/wristgate.js" hook-stop --agent claude' }] }] } }));
  device = await (await fetch(base + '/api/devices', { method: 'POST', body: '{}' })).json();
  await dev('POST', '/api/device/settings', { away: true });
});
after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('/wristgate pair (detached) prints a code at once and finishes in the background', async () => {
  const t0 = Date.now();
  const r = await run(['pair', '--plugin', '--detach', '--name', 'plugin-pc']);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - t0 < 5000, 'must not wait for the claim');
  const code = r.out.match(/Pairing code:\s+(\d{3}) (\d{3})/).slice(1).join('');
  assert.match(r.out, /\/wristgate status/);
  assert.match((await run(['status'])).out, /Waiting for the pairing code/);
  assert.equal((await dev('POST', '/api/device/claim', { code })).status, 200);
  let cfg;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(env.WRISTGATE_HOME, 'config.json'))) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  cfg = JSON.parse(fs.readFileSync(path.join(env.WRISTGATE_HOME, 'config.json'), 'utf8'));
  assert.equal(cfg.viaPlugin, true);
  assert.equal(cfg.name, 'plugin-pc');
  assert.match((await run(['status'])).out, /Claude Code plugin/);
});

test('plugin mode removes old settings.json hooks so nothing fires twice', () => {
  const s = JSON.parse(fs.readFileSync(env.CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s.hooks, undefined);
});

test('in plugin mode only the plugin hook acts; a stray settings hook stays silent', async () => {
  const stray = await hook(false, { tool_name: 'Bash', tool_input: { command: 'ls' } }).done;
  assert.equal(stray, '');
  assert.equal((await pending()).length, 0);
  const h = hook(true, { tool_name: 'Bash', tool_input: { command: 'make' } });
  let p;
  for (let i = 0; i < 100 && !p; i++) { p = (await pending())[0]; if (!p) await new Promise((ok) => setTimeout(ok, 50)); }
  assert.ok(p);
  await dev('POST', `/api/device/requests/${p.id}/decision`, { decision: 'allow' });
  assert.equal(JSON.parse(await h.done).hookSpecificOutput.decision.behavior, 'allow');
});

test('plugin files are well formed and point at the CLI', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['PermissionRequest', 'Stop', 'UserPromptSubmit']) {
    const cmd = hooks[ev][0].hooks[0].command;
    assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/cli\/wristgate\.js/);
    assert.match(cmd, /--plugin$/);
  }
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pj.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  for (const c of ['pair', 'status', 'on', 'off', 'unpair'])
    assert.match(fs.readFileSync(path.join(ROOT, 'commands', c + '.md'), 'utf8'), new RegExp(`wristgate\\.js" ${c} --plugin --detach`));
});
