// Wristgate relay core: devices (watch/phone), clients (Claude Code machines), approval requests.
// No dependencies. State is in memory, optionally persisted to a JSON file.
'use strict';
const crypto = require('node:crypto');

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_S = 3600; // 'stop' cards can wait up to an hour for a reply
const MAX_WAIT_S = 30;
const MAX_PENDING_PER_DEVICE = 50;
const DEFAULT_PRESETS = ['Continue', 'Run the tests', 'Commit and push', 'Summarise what you did'];
const MAX_REPLY = 500;

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// initialState / persist(state) let the host decide where state lives:
// a JSON file (Node server) or Durable Object storage (Cloudflare Worker).
function createRelay({ initialState = null, persist = () => {}, notify = async () => {}, now = () => Date.now(),
  sweepTimer = true } = {}) {
  const state = { devices: {}, clients: {} }; // persisted
  const pairCodes = new Map(); // code -> { deviceId, expires }   (watch shows code, PC types it)
  const pcPairs = new Map();   // id -> { code, pollHash, name, expires, result }  (PC shows code, watch/phone claims it)
  const requests = new Map(); // id -> request
  const waiters = new Map(); // id -> Set<fn>

  if (initialState) Object.assign(state, initialState);
  // token hash -> id, so auth is a map lookup rather than a scan
  const index = { device: new Map(), client: new Map() };
  const reindex = () => {
    // A device can have several tokens: its own, plus any watch or phone linked to it.
    index.device = new Map(Object.entries(state.devices).flatMap(([id, d]) =>
      [d.tokenHash, ...(d.extraTokens || [])].map((h) => [h, id])));
    index.client = new Map(Object.entries(state.clients).map(([id, c]) => [c.tokenHash, id]));
  };
  reindex();
  // persist(state, change): change = { kind: 'device'|'client', id, rec|null } for stores that write per record.
  const save = (kind, id) => {
    reindex();
    const rec = (kind === 'device' ? state.devices : state.clients)[id] || null;
    return persist(state, { kind, id, rec });
  };

  function newPairCode(deviceId) {
    let code;
    do code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    while (pairCodes.has(code) || pcCodeTaken(code));
    for (const [c, v] of pairCodes) if (v.deviceId === deviceId) pairCodes.delete(c);
    const expires = now() + PAIR_CODE_TTL_MS;
    pairCodes.set(code, { deviceId, expires });
    return { pairCode: code, pairExpires: expires };
  }

  function pcCodeTaken(code) {
    for (const p of pcPairs.values()) if (p.code === code && !p.result && now() < p.expires) return true;
    return false;
  }

  function auth(req, kind) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return null;
    // Comparing SHA-256 digests via a map is safe against timing attacks:
    // an attacker can't steer the hash of their guess towards a real token.
    const id = index[kind].get(hash(token));
    const rec = id && (kind === 'device' ? state.devices : state.clients)[id];
    return rec ? { id, rec } : null;
  }

  function expireIfDue(r) {
    if (r.status === 'pending' && now() >= r.expires) settle(r, 'expired', null);
  }

  function settle(r, status, by, reply = null) {
    r.status = status;
    r.reply = reply;
    r.decidedAt = now();
    r.decidedBy = by;
    const ws = waiters.get(r.id);
    if (ws) { for (const fn of ws) fn(); waiters.delete(r.id); }
  }

  function publicReq(r) {
    return { id: r.id, kind: r.kind, agent: r.agent, tool: r.tool, summary: r.summary, detail: r.detail, cwd: r.cwd,
      clientName: r.clientName, created: r.created, expires: r.expires, status: r.status, locked: r.locked };
  }

  // Sweep: expire due requests and drop old ones. Node runs it on a timer;
  // the Worker calls it on each request (waiters have their own timeouts either way).
  let lastSweep = 0;
  function sweepNow() {
    lastSweep = now();
    for (const r of requests.values()) {
      expireIfDue(r);
      if (r.status !== 'pending' && now() - r.decidedAt > 60 * 60 * 1000) requests.delete(r.id);
    }
    for (const [c, v] of pairCodes) if (now() > v.expires) pairCodes.delete(c);
    for (const [id, p] of pcPairs) if (now() > p.expires + 60000) pcPairs.delete(id);
  }
  const sweep = sweepTimer ? setInterval(sweepNow, 1000) : null;
  sweep?.unref?.();

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const err = (status, message) => json({ error: message }, status);
  const body = async (req) => { try { return await req.json(); } catch { return {}; } };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

  async function handle(req) {
    if (!sweepTimer && now() - lastSweep > 1000) sweepNow();
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // --- Devices (watch / phone page) ---
    if (m === 'POST' && p === '/api/devices') {
      const b = await body(req);
      const id = 'dev_' + rand(9);
      const token = rand();
      state.devices[id] = { tokenHash: hash(token), name: str(b.name, 40) || 'Device',
        ntfyTopic: null, away: false, presets: [...DEFAULT_PRESETS], created: now() };
      await save('device', id);
      return json({ deviceId: id, deviceToken: token, ...newPairCode(id) }, 201);
    }

    if (p.startsWith('/api/device/')) {
      const a = auth(req, 'device');
      if (!a) return err(401, 'bad device token');
      const dev = a.rec;

      if (m === 'GET' && p === '/api/device/me') {
        const clients = Object.entries(state.clients)
          .filter(([, c]) => c.deviceId === a.id).map(([id, c]) => ({ id, name: c.name, created: c.created }));
        return json({ deviceId: a.id, name: dev.name, ntfyTopic: dev.ntfyTopic, away: !!dev.away,
          presets: dev.presets || DEFAULT_PRESETS, clients });
      }
      if (m === 'POST' && p === '/api/device/pair-code') return json(newPairCode(a.id));
      // The PC showed a code (wristgate pair with no code); the watch or phone enters it here.
      if (m === 'POST' && p === '/api/device/claim') {
        const b = await body(req);
        const code = str(b.code, 6);
        const pp = [...pcPairs.values()].find((x) => x.code === code && !x.result && now() < x.expires);
        if (!pp) return err(404, 'code invalid or expired');
        const id = 'cli_' + rand(9);
        const token = rand();
        state.clients[id] = { tokenHash: hash(token), deviceId: a.id, name: pp.name, created: now() };
        await save('client', id);
        pp.result = { clientId: id, clientToken: token, deviceId: a.id };
        const ws = waiters.get('pair:' + pp.id);
        if (ws) { for (const fn of ws) fn(); waiters.delete('pair:' + pp.id); }
        return json({ ok: true, name: pp.name });
      }
      // Link another device (e.g. the watch) into this one: it shows a pair code, you enter it here.
      // Its token now opens this device's queue, and anything paired to it moves across.
      if (m === 'POST' && p === '/api/device/link') {
        const b = await body(req);
        const pc = pairCodes.get(str(b.code, 6));
        if (!pc || now() > pc.expires) return err(404, 'code invalid or expired');
        if (pc.deviceId === a.id) return err(400, 'that code is from this device');
        const other = state.devices[pc.deviceId];
        if (!other) return err(404, 'code invalid or expired');
        pairCodes.delete(str(b.code, 6));
        dev.extraTokens = [...(dev.extraTokens || []), other.tokenHash, ...(other.extraTokens || [])];
        delete state.devices[pc.deviceId];
        const moved = [];
        for (const [cid, c] of Object.entries(state.clients)) if (c.deviceId === pc.deviceId) { c.deviceId = a.id; moved.push(cid); }
        for (const r of requests.values()) if (r.deviceId === pc.deviceId) r.deviceId = a.id;
        await save('device', pc.deviceId);
        await save('device', a.id);
        for (const cid of moved) await save('client', cid);
        return json({ ok: true, linked: other.name, movedClients: moved.length });
      }
      if (m === 'POST' && p === '/api/device/settings') {
        const b = await body(req);
        if ('ntfyTopic' in b) dev.ntfyTopic = str(b.ntfyTopic, 64).replace(/[^A-Za-z0-9_-]/g, '') || null;
        if ('name' in b) dev.name = str(b.name, 40) || dev.name;
        if ('away' in b) {
          dev.away = !!b.away;
          // Back at the desk: release anything still waiting on the wrist so the terminal takes over.
          if (!dev.away) for (const r of requests.values())
            if (r.deviceId === a.id && r.status === 'pending') settle(r, 'returned', a.id);
        }
        if (Array.isArray(b.presets)) {
          const ps = b.presets.map((x) => str(x, 60).trim()).filter(Boolean).slice(0, 8);
          dev.presets = ps.length ? ps : [...DEFAULT_PRESETS];
        }
        await save('device', a.id);
        return json({ ok: true, ntfyTopic: dev.ntfyTopic, name: dev.name, away: dev.away, presets: dev.presets });
      }
      if (m === 'GET' && p === '/api/device/pending') {
        const list = [];
        for (const r of requests.values()) {
          expireIfDue(r);
          if (r.deviceId === a.id && r.status === 'pending') list.push(publicReq(r));
        }
        list.sort((x, y) => x.created - y.created);
        const clients = Object.values(state.clients).filter((c) => c.deviceId === a.id).length;
        return json({ pending: list, clients, away: !!dev.away, presets: dev.presets || DEFAULT_PRESETS, serverTime: now() });
      }
      const dm = p.match(/^\/api\/device\/requests\/([\w-]+)\/decision$/);
      if (m === 'POST' && dm) {
        const r = requests.get(dm[1]);
        if (!r || r.deviceId !== a.id) return err(404, 'no such request');
        expireIfDue(r);
        if (r.status !== 'pending') return err(409, 'already ' + r.status);
        const b = await body(req);
        if (r.kind === 'stop') {
          if (b.decision === 'dismiss') settle(r, 'dismissed', a.id);
          else if (b.decision === 'reply') {
            const reply = str(b.reply, MAX_REPLY).trim();
            if (!reply) return err(400, 'reply is empty');
            settle(r, 'replied', a.id, reply);
          } else return err(400, 'decision must be reply or dismiss');
          return json({ ok: true, status: r.status });
        }
        if (b.decision !== 'allow' && b.decision !== 'deny') return err(400, 'decision must be allow or deny');
        if (b.decision === 'allow' && r.locked) return err(403, 'this action cannot be approved remotely');
        settle(r, b.decision, a.id);
        return json({ ok: true, status: r.status });
      }
      if (m === 'POST' && p === '/api/device/unpair') {
        const b = await body(req);
        const c = state.clients[b.clientId];
        if (!c || c.deviceId !== a.id) return err(404, 'no such client');
        delete state.clients[b.clientId];
        await save('client', b.clientId);
        return json({ ok: true });
      }
      return err(404, 'not found');
    }

    // --- PC-initiated pairing: PC gets a code, waits for the watch/phone to claim it ---
    if (m === 'POST' && p === '/api/pair/start') {
      const b = await body(req);
      if (pcPairs.size > 1000) return err(429, 'busy, try again shortly');
      let code;
      do code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      while (pairCodes.has(code) || pcCodeTaken(code));
      const id = 'pp_' + rand(9);
      const pollToken = rand();
      pcPairs.set(id, { id, code, pollHash: hash(pollToken), name: str(b.name, 40) || 'PC',
        expires: now() + PAIR_CODE_TTL_MS, result: null });
      return json({ pairId: id, code, pollToken, expires: now() + PAIR_CODE_TTL_MS }, 201);
    }
    const ppm = p.match(/^\/api\/pair\/start\/([\w-]+)$/);
    if (m === 'GET' && ppm) {
      const pp = pcPairs.get(ppm[1]);
      const h = req.headers.get('authorization') || '';
      if (!pp || !h.startsWith('Bearer ') || hash(h.slice(7)) !== pp.pollHash) return err(404, 'no such pairing');
      const waitS = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_S);
      if (!pp.result && now() < pp.expires && waitS > 0) {
        await new Promise((resolve) => {
          const key = 'pair:' + pp.id;
          const t = setTimeout(done, Math.min(waitS * 1000, Math.max(pp.expires - now(), 0) + 50));
          function done() { clearTimeout(t); waiters.get(key)?.delete(done); resolve(); }
          if (!waiters.has(key)) waiters.set(key, new Set());
          waiters.get(key).add(done);
        });
      }
      if (pp.result) { const r = pp.result; pcPairs.delete(pp.id); return json({ status: 'claimed', ...r }); }
      return json({ status: now() < pp.expires ? 'waiting' : 'expired' });
    }

    // --- Pairing (CLI on the Claude Code machine) ---
    if (m === 'POST' && p === '/api/pair') {
      const b = await body(req);
      const code = str(b.code, 6);
      const pc = pairCodes.get(code);
      if (!pc || now() > pc.expires) return err(404, 'pair code invalid or expired');
      pairCodes.delete(code);
      const id = 'cli_' + rand(9);
      const token = rand();
      state.clients[id] = { tokenHash: hash(token), deviceId: pc.deviceId,
        name: str(b.name, 40) || 'Claude Code', created: now() };
      await save('client', id);
      return json({ clientId: id, clientToken: token, deviceId: pc.deviceId }, 201);
    }

    // --- Clients (hook) ---
    if (p.startsWith('/api/client/')) {
      const a = auth(req, 'client');
      if (!a) return err(401, 'bad client token');
      const cli = a.rec;
      const dev = state.devices[cli.deviceId];
      if (!dev) return err(410, 'paired device no longer exists');

      if (m === 'GET' && p === '/api/client/state') return json({ away: !!dev.away });

      if (m === 'POST' && p === '/api/client/requests') {
        const b = await body(req);
        let pending = 0;
        for (const r of requests.values()) if (r.deviceId === cli.deviceId && r.status === 'pending') pending++;
        if (pending >= MAX_PENDING_PER_DEVICE) return err(429, 'too many pending requests');
        const kind = b.kind === 'stop' ? 'stop' : 'permission';
        const timeout = Math.min(Math.max(Number(b.timeoutSec) || 120, 5), MAX_REQUEST_TIMEOUT_S);
        const r = { id: 'req_' + rand(9), deviceId: cli.deviceId, clientId: a.id, clientName: cli.name,
          agent: ['claude', 'codex'].includes(b.agent) ? b.agent : 'claude', tool: str(b.tool, 40), summary: str(b.summary, 120), detail: str(b.detail, 2000),
          cwd: str(b.cwd, 200), locked: kind === 'permission' && !!b.locked, kind,
          created: now(), expires: now() + timeout * 1000,
          status: 'pending' };
        requests.set(r.id, r);
        if (dev.ntfyTopic) notify(dev.ntfyTopic, r).catch(() => {});
        return json({ id: r.id, expires: r.expires }, 201);
      }
      const wm = p.match(/^\/api\/client\/requests\/([\w-]+)$/);
      if (m === 'GET' && wm) {
        const r = requests.get(wm[1]);
        if (!r || r.clientId !== a.id) return err(404, 'no such request');
        expireIfDue(r);
        const waitS = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_S);
        if (r.status === 'pending' && waitS > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(done, Math.min(waitS * 1000, Math.max(r.expires - now(), 0) + 50));
            function done() { clearTimeout(t); waiters.get(r.id)?.delete(done); resolve(); }
            if (!waiters.has(r.id)) waiters.set(r.id, new Set());
            waiters.get(r.id).add(done);
          });
          expireIfDue(r);
        }
        return json({ id: r.id, status: r.status, ...(r.reply ? { reply: r.reply } : {}) });
      }
      // You typed in the terminal: any "finished" card from this machine is no longer needed.
      if (m === 'POST' && p === '/api/client/cancel-stops') {
        let n = 0;
        for (const r of requests.values())
          if (r.clientId === a.id && r.kind === 'stop' && r.status === 'pending') { settle(r, 'cancelled', a.id); n++; }
        return json({ ok: true, cancelled: n });
      }
      const cm = p.match(/^\/api\/client\/requests\/([\w-]+)\/cancel$/);
      if (m === 'POST' && cm) {
        const r = requests.get(cm[1]);
        if (!r || r.clientId !== a.id) return err(404, 'no such request');
        if (r.status === 'pending') settle(r, 'cancelled', a.id);
        return json({ ok: true, status: r.status });
      }
      return err(404, 'not found');
    }

    if (m === 'GET' && p === '/healthz') return json({ ok: true });
    return null; // let the adapter serve static files
  }

  return { handle, close: () => sweep && clearInterval(sweep), _state: state };
}

// ntfy.sh push (or a self-hosted ntfy). Public ntfy topics are readable by anyone who knows
// the name, so only the tool name and client name are sent, never the command itself.
function ntfyNotifier(base = 'https://ntfy.sh', publicUrl = '') {
  return async (topic, r) => {
    await fetch(`${base.replace(/\/$/, '')}/${topic}`, {
      method: 'POST',
      headers: { Title: r.kind === 'stop' ? 'Agent finished' : 'Approval waiting',
        Tags: r.kind === 'stop' ? 'white_check_mark' : 'warning', ...(publicUrl ? { Click: publicUrl } : {}) },
      body: r.kind === 'stop' ? `${r.agent === 'codex' ? 'Codex' : 'Claude'} on ${r.clientName} is waiting for you`
        : `${r.tool} from ${r.clientName}`,
    });
  };
}

module.exports = { createRelay, ntfyNotifier };
