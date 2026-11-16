// Pairing under the new name removes hooks left behind by the old "wristgate" install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('../relay/server');

test('pair cleans up old wristgate hooks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-legacy-'));
  const claudeSettings = path.join(tmp, 'settings.json');
  const codexHome = path.join(tmp, 'codex'); fs.mkdirSync(codexHome);
  const old = (sub) => ({ hooks: [{ type: 'command', command: `node "/x/.config/wristgate/wristgate.js" ${sub} --agent claude` }] });
  const keep = { hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { PermissionRequest: [old('hook'), keep], Stop: [old('hook-stop')] } }));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PermissionRequest: [old('hook')] } }));

  const srv = await startServer({ port: 0, host: '127.0.0.1', dataFile: path.join(tmp, 'data.json') });
  const url = 'http://127.0.0.1:' + srv.port;
  const dev = await (await fetch(url + '/api/devices', { method: 'POST', body: '{"name":"W"}' })).json();
  const code = dev.pairCode;
  const env = { ...process.env, HOLDPOINT_HOME: path.join(tmp, 'hp'), CLAUDE_SETTINGS: claudeSettings, CODEX_HOME: codexHome };
  const exit = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(__dirname, '../cli/holdpoint.js'), 'pair', code, '--relay', url, '--agent', 'both'], { env, stdio: 'ignore' });
    p.on('exit', res);
  });
  await srv.close();
  assert.strictEqual(exit, 0);
  const s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
  const all = JSON.stringify(s) + fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8');
  assert.ok(!all.includes('wristgate'), 'old hooks gone');
  assert.ok(all.includes('holdpoint.js'), 'new hooks present');
  assert.ok(JSON.stringify(s.hooks.PermissionRequest).includes('echo mine'), 'user hooks kept');
});

test('a config on the old workers.dev relay moves to holdpoint.kiorte.com', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-relay-'));
  const home = path.join(tmp, 'hp'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ relay: 'https://holdpoint-relay.kiorte.workers.dev', clientToken: 't', agents: ['claude'], enabled: true }));
  const out = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(__dirname, '../cli/holdpoint.js'), 'status'], { env: { ...process.env, HOLDPOINT_HOME: home, CLAUDE_SETTINGS: path.join(tmp, 's.json'), CODEX_HOME: path.join(tmp, 'c') } });
    let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('exit', () => res(o));
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.relay, 'https://holdpoint.kiorte.com');
  assert.strictEqual(cfg.clientToken, 't', 'pairing kept');
});
