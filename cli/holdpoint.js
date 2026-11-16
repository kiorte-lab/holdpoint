#!/usr/bin/env node
// Holdpoint CLI + Claude Code hook. Single file, no dependencies.
//   holdpoint pair <code> --relay <url> [--agent claude|codex|both] [--name <machine>] [--timeout 120] [--on-timeout deny|prompt]
//   holdpoint on | off | status | unpair
//   holdpoint hook --agent <a>       (PermissionRequest hook: approve/deny from the wrist when away)
//   holdpoint hook-stop --agent <a>  (Stop hook: "finished" card, reply goes back as the next instruction)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.HOLDPOINT_HOME || path.join(os.homedir(), '.config', 'holdpoint');
const CONFIG = path.join(HOME, 'config.json');
const INSTALLED = path.join(HOME, 'holdpoint.js');
const HOOK_EVENT = 'PermissionRequest';
const DEFAULT_RELAY = process.env.HOLDPOINT_DEFAULT_RELAY || 'https://holdpoint.kiorte.com';
// The public relay's earlier address. Same server, so pairings carry over: just switch to the new name.
const OLD_RELAYS = ['https://holdpoint-relay.kiorte.workers.dev'];
const HOOK_TAG = 'holdpoint.js" hook';
const LEGACY_TAG = 'wristgate.js" hook'; // the app's old name; cleaned up on pair/unpair

// Each agent: where its hooks live, and which hook dialect it speaks.
//   style 'claude'      Claude Code, Codex: PermissionRequest / Stop / UserPromptSubmit, hooks inside a settings file
//   style 'copilot'     GitHub Copilot CLI: our own file in ~/.copilot/hooks/, permissionRequest / Stop / UserPromptSubmit
//   style 'antigravity' Antigravity CLI (Gemini CLI's successor): a named entry in ~/.gemini/config/hooks.json,
//                       PreToolUse (fires for every tool) / Stop, decisions auto_approve | deny | continue
const AGENTS = {
  claude: {
    label: 'Claude Code',
    home: () => path.dirname(process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json')),
    file: () => process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json'),
    matcher: { matcher: '*' },
  },
  codex: {
    label: 'Codex',
    home: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    file: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'),
    matcher: {}, // Codex matchers are regexes; omitting it matches every tool
  },
  copilot: {
    label: 'Copilot CLI',
    style: 'copilot',
    home: () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'),
    file: () => path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'hooks', 'holdpoint.json'),
  },
  antigravity: {
    label: 'Antigravity CLI',
    style: 'antigravity',
    home: () => process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'),
    file: () => path.join(process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'), 'config', 'hooks.json'),
  },
};
const AGENT_ALIASES = { gemini: 'antigravity', agy: 'antigravity', chatgpt: 'codex', openai: 'codex', 'github-copilot': 'copilot' };
const styleOf = (agent) => AGENTS[agent]?.style || 'claude';
// "both" kept for v0.2 users: Claude Code + Codex.
function parseAgents(want) {
  want = String(want || '').toLowerCase();
  if (want === 'both') return ['claude', 'codex'];
  if (want === 'all') return Object.keys(AGENTS);
  if (want === 'detect') return detectAgents();
  return want.split(',').map((x) => x.trim()).filter(Boolean).map((x) => AGENT_ALIASES[x] || x);
}
const AGENT_HELP = 'claude, codex, copilot, antigravity (or gemini), both, all';
const detectAgents = () => Object.keys(AGENTS).filter((a) => fs.existsSync(AGENTS[a].home()));

// Things that are never approvable from the wrist. The watch can still deny them;
// otherwise they fall through to the normal terminal prompt.
const LOCKED_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(mkfs|dd\s+if=|shred)\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bdrop\s+(table|database)\b/i,
];

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, obj, mode) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(f + '.tmp', f);
};
const die = (msg) => { console.error('holdpoint: ' + msg); process.exit(1); };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

async function api(cfg, method, p, body) {
  const r = await fetch(cfg.relay.replace(/\/$/, '') + p, {
    method, headers: { 'content-type': 'application/json',
      ...(cfg.clientToken ? { authorization: 'Bearer ' + cfg.clientToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
  return j;
}

function loadConfig() {
  const cfg = readJson(CONFIG, null);
  if (cfg && OLD_RELAYS.includes(String(cfg.relay).replace(/\/$/, ''))) {
    cfg.relay = DEFAULT_RELAY;
    try { writeJson(CONFIG, cfg, 0o600); } catch {}
  }
  return cfg;
}

// ---------- Claude Code settings ----------
const stripOurs = (list = []) => list
  .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command).includes(HOOK_TAG) && !String(h.command).includes(LEGACY_TAG)) }))
  .filter((m) => m.hooks.length);

// The hooks we install, per agent. Stop takes no matcher in either agent.
const ourHooks = (cfg, agent) => [
  { event: HOOK_EVENT, entry: { ...AGENTS[agent].matcher, hooks: [{ type: 'command',
    command: `node ${JSON.stringify(INSTALLED)} hook --agent ${agent}`, timeout: cfg.timeoutSec + 30 }] } },
  ...(cfg.stopCards === false ? [] : [
    { event: 'Stop', entry: { hooks: [{ type: 'command',
      command: `node ${JSON.stringify(INSTALLED)} hook-stop --agent ${agent}`, timeout: (cfg.replyTimeoutSec || 900) + 30 }] } },
    { event: 'UserPromptSubmit', entry: { hooks: [{ type: 'command',
      command: `node ${JSON.stringify(INSTALLED)} hook-prompt --agent ${agent}`, timeout: 10 }] } },
  ]),
];
const OUR_EVENTS = [HOOK_EVENT, 'Stop', 'UserPromptSubmit'];

const cmdFor = (sub, agent) => `node ${JSON.stringify(INSTALLED)} ${sub} --agent ${agent}`;

function installOther(cfg, agent) {
  const A = AGENTS[agent];
  const stop = cfg.stopCards !== false;
  if (A.style === 'copilot') {
    writeJson(A.file(), { version: 1, hooks: {
      permissionRequest: [{ type: 'command', command: cmdFor('hook', agent), timeoutSec: cfg.timeoutSec + 30 }],
      ...(stop ? {
        Stop: [{ type: 'command', command: cmdFor('hook-stop', agent), timeoutSec: (cfg.replyTimeoutSec || 900) + 30 }],
        UserPromptSubmit: [{ type: 'command', command: cmdFor('hook-prompt', agent), timeoutSec: 10 }],
      } : {}),
    } });
  } else if (A.style === 'antigravity') {
    const all = readJson(A.file(), {});
    all.holdpoint = {
      PreToolUse: [{ matcher: '*', command: cmdFor('hook', agent), timeout: cfg.timeoutSec + 30 }],
      ...(stop ? { Stop: [{ command: cmdFor('hook-stop', agent), timeout: (cfg.replyTimeoutSec || 900) + 30 }] } : {}),
    };
    writeJson(A.file(), all);
  }
}

function removeOther(agent) {
  const A = AGENTS[agent];
  if (A.style === 'copilot') {
    fs.rmSync(A.file(), { force: true });
    fs.rmSync(path.join(path.dirname(A.file()), 'wristgate.json'), { force: true });
  } else if (A.style === 'antigravity') {
    const all = readJson(A.file(), null);
    if (all && (all.holdpoint || all.wristgate)) { delete all.holdpoint; delete all.wristgate; writeJson(A.file(), all); }
  }
}

function installHook(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.copyFileSync(__filename, INSTALLED);
  for (const agent of cfg.agents) {
    const A = AGENTS[agent];
    if (agent === 'claude' && cfg.viaPlugin) { removeHook(['claude']); continue; } // the plugin supplies these
    if (A.style) { installOther(cfg, agent); continue; }
    const settings = readJson(A.file(), {});
    settings.hooks ||= {};
    for (const ev of OUR_EVENTS) {
      settings.hooks[ev] = stripOurs(settings.hooks[ev]);
      if (!settings.hooks[ev].length) delete settings.hooks[ev];
    }
    for (const { event, entry } of ourHooks(cfg, agent)) (settings.hooks[event] ||= []).push(entry);
    writeJson(A.file(), settings);
  }
}

function removeHook(agents = Object.keys(AGENTS)) {
  for (const agent of agents) {
    if (AGENTS[agent].style) { removeOther(agent); continue; }
    const f = AGENTS[agent].file();
    const settings = readJson(f, null);
    if (!settings?.hooks) continue;
    for (const ev of OUR_EVENTS) {
      if (!settings.hooks[ev]) continue;
      settings.hooks[ev] = stripOurs(settings.hooks[ev]);
      if (!settings.hooks[ev].length) delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeJson(f, settings);
  }
}

// ---------- Summaries for a tiny screen ----------
function describe(tool, input = {}, cwd = '') {
  const rel = (f) => (f && cwd && String(f).startsWith(cwd + path.sep) ? String(f).slice(cwd.length + 1) : String(f || ''));
  const clip = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  let summary, detail, text = '';
  switch (tool) {
    case 'Bash':
      text = input.command || '';
      summary = clip(input.description ? `${input.description}: ${text}` : text);
      detail = text;
      break;
    case 'Write':
      summary = `Write ${rel(input.file_path)}`;
      detail = `${input.file_path}\n\n${String(input.content || '').slice(0, 1500)}`;
      break;
    case 'Edit': case 'MultiEdit':
      summary = `Edit ${rel(input.file_path)}`;
      detail = input.edits
        ? input.edits.map((e) => `- ${clip(e.old_string, 200)}\n+ ${clip(e.new_string, 200)}`).join('\n\n')
        : `- ${clip(input.old_string, 600)}\n+ ${clip(input.new_string, 600)}`;
      break;
    case 'NotebookEdit':
      summary = `Edit notebook ${rel(input.notebook_path)}`; detail = String(input.new_source || '');
      break;
    case 'WebFetch':
      summary = `Fetch ${clip(input.url, 70)}`; detail = `${input.url}\n\n${input.prompt || ''}`;
      break;
    case 'apply_patch': { // Codex file edits
      const patch = String(input.patch ?? input.input ?? input.command ?? '');
      const files = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => `${m[1]} ${rel(m[2].trim())}`);
      summary = clip(files.length ? files.join(', ') : 'Apply patch');
      detail = patch;
      break;
    }
    case 'WebSearch':
      summary = `Search: ${clip(input.query, 70)}`; detail = input.query;
      break;
    default:
      summary = clip(`${tool} ${JSON.stringify(input)}`);
      detail = JSON.stringify(input, null, 2);
  }
  const locked = tool === 'Bash' && LOCKED_PATTERNS.some((re) => re.test(text));
  return { summary, detail: String(detail).slice(0, 2000), locked };
}

// ---------- Hooks ----------
// Claude can get our hooks from the plugin or from settings.json; only one set may act.
const fromPlugin = process.argv.includes('--plugin');
function wrongSource(cfg, agent) {
  return agent === 'claude' && !!cfg.viaPlugin !== fromPlugin;
}

// Only route to the wrist when the device is in away mode (or the user chose --always).
async function shouldRoute(cfg) {
  if (cfg.always) return true;
  try { return !!(await api(cfg, 'GET', '/api/client/state')).away; } catch { return false; }
}

// Every tool reports its call differently; reduce them to Claude's names so one describe() fits all.
function normalise(ev) {
  const tool = ev.tool_name || ev.toolName || ev.toolCall?.name || 'Tool';
  let input = ev.tool_input ?? ev.toolArgs ?? ev.toolCall?.args ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
  if (!input || typeof input !== 'object') input = {};
  const cwd = ev.cwd || input.Cwd || input.cwd || (Array.isArray(ev.workspacePaths) && ev.workspacePaths[0]) || '';
  const t = String(tool).toLowerCase();
  const filePath = input.file_path ?? input.path ?? input.TargetFile ?? input.filePath ?? input.AbsolutePath;
  if (/^(bash|shell|powershell|run_command|run_shell_command|run_in_terminal)$/.test(t))
    return { tool: 'Bash', input: { command: input.command ?? input.CommandLine ?? input.cmd ?? '', description: input.description }, cwd, risky: true };
  if (/^(write|create|write_file|write_to_file|create_file)$/.test(t))
    return { tool: 'Write', input: { file_path: filePath, content: input.content ?? input.CodeContent ?? input.file_text ?? '' }, cwd, risky: true };
  if (/(edit|replace|str_replace|apply_patch)/.test(t) && t !== 'apply_patch')
    return { tool: 'Edit', input: { file_path: filePath, old_string: input.old_string ?? input.old_str ?? input.TargetContent ?? '',
      new_string: input.new_string ?? input.new_str ?? input.ReplacementContent ?? '' }, cwd, risky: true };
  const risky = !/^(read|view|list|ls|glob|grep|search|find|codebase_search|read_file|view_file|list_dir|grep_search|find_by_name|todo|think)/.test(t);
  return { tool, input, cwd, risky };
}

// One permission answer, in the dialect of the agent that asked.
let EMITTED = false;
const out = (obj) => { EMITTED = true; process.stdout.write(JSON.stringify(obj)); };
function emit(behavior, message, agent = 'claude') {
  const style = styleOf(agent);
  if (style === 'copilot') {
    return out({ behavior, ...(message ? { message } : {}), permissionDecision: behavior,
      ...(message ? { permissionDecisionReason: message } : {}) });
  }
  if (style === 'antigravity') {
    return out(behavior === 'allow' ? { decision: 'auto_approve' } : { decision: 'deny', reason: message });
  }
  const decision = { behavior };
  if (message) decision.message = message;
  out({ hookSpecificOutput: { hookEventName: HOOK_EVENT, decision } });
}
// Not ours to answer: let the agent carry on as normal. Antigravity wants an explicit decision.
function passThrough(agent) {
  if (!EMITTED && styleOf(agent) === 'antigravity') out({ decision: 'allow' });
}
function emitContinue(agent, reason) {
  out(styleOf(agent) === 'antigravity' ? { decision: 'continue', reason } : { decision: 'block', reason });
}

async function hook(agent = 'claude') {
  let cfgRef, reqRef;
  const cancel = () => (cfgRef && reqRef ? api(cfgRef, 'POST', `/api/client/requests/${reqRef}/cancel`).catch(() => {}) : Promise.resolve());
  // Any failure here must fall through to Claude Code's normal prompt: exit 0, no output.
  let input = '';
  for await (const c of process.stdin) input += c;
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled || !cfg.clientToken) return;
  cfgRef = cfg;
  let ev;
  try { ev = JSON.parse(input); } catch { return; }
  if (!AGENTS[agent]) agent = 'claude';
  const n = normalise(ev);
  const tool = n.tool;
  if (tool === 'ExitPlanMode' || tool === 'AskUserQuestion') return; // need the real UI
  if (wrongSource(cfg, agent)) return;
  // Antigravity's PreToolUse fires for every tool, reads included: only bother the wrist with real changes.
  if (styleOf(agent) === 'antigravity' && !n.risky) return;
  const cwd = n.cwd;
  const { summary, detail, locked } = describe(tool, n.input, cwd);
  if (!(await shouldRoute(cfg))) return; // at the desk: normal terminal prompt

  // Claude Code kills the hook (SIGTERM) when you answer in the terminal or the turn is interrupted.
  // Register first so a kill that lands mid-request still cancels it on the device.
  let reqId, killed = false;
  process.on('SIGTERM', async () => {
    killed = true;
    if (!reqId) return; // request still in flight: cancelled as soon as its id comes back
    await cancel();
    process.exit(0);
  });
  try {
    ({ id: reqId } = await api(cfg, 'POST', '/api/client/requests', {
      agent, tool, summary, detail, cwd: path.basename(cwd), locked, timeoutSec: cfg.timeoutSec }));
    reqRef = reqId;
  } catch (e) {
    process.stderr.write(`holdpoint: relay unavailable (${e.message}), using normal prompt\n`);
    return;
  }

  if (killed) { await cancel(); process.exit(0); }

  const deadline = Date.now() + (cfg.timeoutSec + 10) * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    let st;
    try { st = (await api(cfg, 'GET', `/api/client/requests/${reqId}?wait=25`)).status; failures = 0; }
    catch (e) {
      if (++failures >= 5) { process.stderr.write('holdpoint: lost relay, using normal prompt\n'); return; }
      await new Promise((r) => setTimeout(r, 1000 * failures));
      continue;
    }
    if (st === 'allow') return emit('allow', null, agent);
    if (st === 'deny') return emit('deny', 'Denied from Holdpoint. Do not retry this action; ask the user what to do instead.', agent);
    if (st === 'cancelled' || st === 'returned') return; // answered in the terminal / back at the desk
    if (st === 'expired') break;
  }
  if (locked || cfg.onTimeout === 'prompt') return; // fall through to the terminal prompt
  emit('deny', `No answer from Holdpoint within ${cfg.timeoutSec}s, so this was not run. Carry on with anything that doesn't need it, then tell the user it is waiting for approval.`, agent);
}

// Last thing the agent said, for the "finished" card. Codex passes it in; Claude has a transcript.
function lastAssistantText(ev) {
  if (typeof ev.last_assistant_message === 'string') return ev.last_assistant_message;
  if (typeof ev.prompt_response === 'string') return ev.prompt_response;
  const f = ev.transcript_path || ev.transcriptPath;
  if (!f) return '';
  try {
    const fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const msg = j.message || j;
      if ((j.type === 'assistant' || msg.role === 'assistant') && msg.content) {
        const text = typeof msg.content === 'string' ? msg.content
          : msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (text.trim()) return text;
      }
    }
  } catch {}
  return '';
}

// The last thing the user typed (Claude transcripts), so turns that were only a /holdpoint command stay quiet.
function lastUserText(ev) {
  const f = ev.transcript_path || ev.transcriptPath;
  if (!f) return '';
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').slice(-400).reverse();
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const msg = j.message || j;
      if (j.type === 'user' || msg.role === 'user') {
        const c = msg.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c) && c.some((x) => x.type === 'text')) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      }
    }
  } catch {}
  return '';
}

async function hookStop(agent = 'claude') {
  // Exit 0 with no output = the agent stops normally. Only a reply from the wrist keeps it going.
  let input = '';
  for await (const c of process.stdin) input += c;
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled || !cfg.clientToken || cfg.stopCards === false) return;
  let ev;
  try { ev = JSON.parse(input); } catch { return; }
  if (!AGENTS[agent]) agent = 'claude';
  if (wrongSource(cfg, agent)) return;
  if (/(^|[\s>])\/(holdpoint|wristgate)(:|\b)/.test(lastUserText(ev))) return; // a Holdpoint command, not real work
  if (!(await shouldRoute(cfg))) return;

  const raw = lastAssistantText(ev).trim();
  const said = raw.replace(/\s+/g, ' ');
  const summary = said ? (said.length > 120 ? said.slice(0, 119) + '…' : said) : 'Finished and waiting for you';
  const cwd = normalise(ev).cwd;
  const timeoutSec = cfg.replyTimeoutSec || 900;

  let reqId, killed = false;
  const cancel = () => (reqId ? api(cfg, 'POST', `/api/client/requests/${reqId}/cancel`).catch(() => {}) : Promise.resolve());
  process.on('SIGTERM', async () => { killed = true; if (reqId) { await cancel(); process.exit(0); } });
  try {
    ({ id: reqId } = await api(cfg, 'POST', '/api/client/requests', {
      kind: 'stop', agent, tool: 'Finished', summary, detail: raw.replace(/\n{3,}/g, '\n\n').slice(0, 2000),
      cwd: path.basename(cwd), timeoutSec }));
  } catch { return; }
  if (killed) { await cancel(); process.exit(0); }

  const deadline = Date.now() + (timeoutSec + 10) * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    let res;
    try { res = await api(cfg, 'GET', `/api/client/requests/${reqId}?wait=25`); failures = 0; }
    catch { if (++failures >= 5) return; await new Promise((r) => setTimeout(r, 1000 * failures)); continue; }
    if (res.status === 'replied' && res.reply) {
      emitContinue(agent, `The user replied from Holdpoint (their watch/phone): "${res.reply}". Treat this as their next message and carry on.`);
      return;
    }
    if (res.status !== 'pending') return; // dismissed, expired, cancelled, back at desk
  }
}

// UserPromptSubmit: you typed in the terminal, so clear any "finished" card still waiting on the wrist.
// Must never block or print anything (stdout here would be added to Claude's context).
async function hookPrompt(agent = 'claude') {
  let input = '';
  for await (const c of process.stdin) input += c;
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled || !cfg.clientToken) return;
  if (wrongSource(cfg, AGENTS[agent] ? agent : 'claude')) return;
  try {
    await fetch(cfg.relay.replace(/\/$/, '') + '/api/client/cancel-stops', {
      method: 'POST', headers: { authorization: 'Bearer ' + cfg.clientToken }, signal: AbortSignal.timeout(4000) });
  } catch {}
}

// ---------- Pairing helpers ----------
async function waitForClaim(relay, st) {
  const poll = { relay, clientToken: st.pollToken };
  const until = st.expires + 5000;
  while (Date.now() < until) {
    let r;
    try { r = await api(poll, 'GET', `/api/pair/start/${st.pairId}?wait=25`); }
    catch { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
    if (r.status === 'claimed') return r;
    if (r.status === 'expired') return null;
  }
  return null;
}

function finishPair(res, o) {
  const next = { relay: o.relay, clientId: res.clientId, clientToken: res.clientToken, deviceId: res.deviceId,
    name: o.name, timeoutSec: o.timeoutSec, onTimeout: o.onTimeout, replyTimeoutSec: o.replyTimeoutSec,
    always: o.always, stopCards: o.stopCards, agents: o.agents, viaPlugin: !!o.viaPlugin, enabled: true };
  writeJson(CONFIG, next, 0o600);
  installHook(next);
  return next;
}

// Background half of `pair --detach`.
async function pairWait() {
  const f = path.join(HOME, 'pending-pair.json');
  const p = readJson(f, null);
  if (!p) return;
  const res = await waitForClaim(p.relay, p);
  fs.rmSync(f, { force: true });
  if (res) finishPair(res, p);
  else writeJson(path.join(HOME, 'last-pair-error.json'), { error: 'code expired', at: Date.now() });
}

// ---------- Commands ----------
async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const cfg = loadConfig();

  if (cmd === 'hook') { const ag = AGENT_ALIASES[a.agent] || a.agent; await hook(ag); return passThrough(ag); }
  if (cmd === 'hook-stop') return hookStop(AGENT_ALIASES[a.agent] || a.agent);
  if (cmd === 'hook-prompt') return hookPrompt(a.agent);
  if (cmd === 'pair-wait') return pairWait(a);

  if (cmd === 'pair') {
    const code = a._[1];
    if (code && !/^\d{6}$/.test(code)) die('usage: holdpoint pair [6-digit code from the watch] [--relay <url>]');
    const relay = a.relay || cfg?.relay || process.env.HOLDPOINT_RELAY || DEFAULT_RELAY;
    if (!/^https:\/\//.test(relay) && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(relay))
      die('relay must use https (plain http is only allowed on local networks)');
    const timeoutSec = Math.min(Math.max(Number(a.timeout) || cfg?.timeoutSec || 120, 10), 600);
    const onTimeout = a['on-timeout'] === 'prompt' ? 'prompt' : (cfg?.onTimeout || 'deny');
    const replyTimeoutSec = Math.min(Math.max(Number(a['reply-timeout']) || cfg?.replyTimeoutSec || 900, 30), 3600);
    const always = a.always === true || (a.always === undefined && !!cfg?.always);
    const stopCards = a['no-stop'] ? false : (cfg?.stopCards ?? true);
    const name = a.name || os.hostname();
    let agents = a.agent ? parseAgents(a.agent) : (cfg?.agents || detectAgents());
    if (!agents.length) agents = ['claude'];
    for (const ag of agents) if (!AGENTS[ag]) die(`unknown agent "${ag}" (use ${AGENT_HELP})`);
    let res;
    if (code) {
      // Code read off the watch.
      try { res = await api({ relay }, 'POST', '/api/pair', { code, name }); }
      catch (e) { die('pairing failed: ' + e.message); }
    } else {
      // No code: this PC shows one, and you enter it on the watch side.
      let st;
      try { st = await api({ relay }, 'POST', '/api/pair/start', { name }); }
      catch (e) { die('could not reach the relay: ' + e.message); }
      const pretty = st.code.slice(0, 3) + ' ' + st.code.slice(3);
      console.log(`\n  Pairing code:  ${pretty}\n`);
      console.log('  Enter it in Garmin Connect: your watch > Connect IQ apps > Holdpoint > Settings > Pairing code');
      console.log('  (or on the phone page under "Pair a machine").');
      const opts = { relay, name, timeoutSec, onTimeout, replyTimeoutSec, always, stopCards, agents, viaPlugin: !!a.plugin };
      if (a.detach) {
        // Inside Claude Code: hand the waiting to a background process so the code shows now.
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(path.join(HOME, 'pending-pair.json'), JSON.stringify({ ...opts, pairId: st.pairId, pollToken: st.pollToken, expires: st.expires }), { mode: 0o600 });
        const child = require('node:child_process').spawn(process.execPath, [__filename, 'pair-wait'],
          { detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
        child.unref();
        console.log('  Pairing finishes by itself within 10 minutes. Check with: /holdpoint:status');
        return;
      }
      console.log('  Waiting up to 10 minutes...\n');
      res = await waitForClaim(relay, st);
      if (!res) die('the code expired before it was entered. Run "holdpoint pair" again.');
    }
    finishPair(res, { relay, name, timeoutSec, onTimeout, replyTimeoutSec, always, stopCards, agents, viaPlugin: !!a.plugin });
    console.log(`Paired "${name}" with ${relay === DEFAULT_RELAY ? 'Holdpoint' : relay}.`);
    for (const ag of agents) console.log(ag === 'claude' && a.plugin
      ? 'Claude Code: using the Holdpoint plugin\'s hooks.'
      : `Hook installed for ${AGENTS[ag].label}: ${AGENTS[ag].file()}`);
    if (agents.includes('codex')) console.log('Codex: open Codex and run /hooks once to trust the Holdpoint hook. Until then Codex skips it.');
    console.log(always
      ? 'Permission prompts now always go to your device. Turn off with: holdpoint off'
      : 'Turn on "Away" on your device and prompts and "finished" cards go to your wrist. At the desk, nothing changes.');
    return;
  }

  if (!cfg) {
    const pend = readJson(path.join(HOME, 'pending-pair.json'), null);
    if (cmd === 'status' && pend && Date.now() < pend.expires) {
      console.log('Waiting for the pairing code to be entered on the watch or phone.');
      return;
    }
    die('not paired yet. Run: holdpoint pair');
  }
  cfg.agents ||= ['claude']; // configs from v0.1

  if (cmd === 'on' || cmd === 'off') {
    cfg.enabled = cmd === 'on';
    writeJson(CONFIG, cfg, 0o600);
    if (cfg.enabled) installHook(cfg); // when off the hook stays installed but exits at once (no Codex re-trust)
    console.log(cfg.enabled ? 'Holdpoint on: prompts go to your device.' : 'Holdpoint off: prompts stay in the terminal.');
    return;
  }
  // Change which agents are hooked up without pairing again: `holdpoint agents claude,codex`
  if (cmd === 'agents') {
    const list = parseAgents(a._[1]);
    if (!list.length) die(`usage: holdpoint agents <list> (${AGENT_HELP}, or detect)`);
    for (const ag of list) if (!AGENTS[ag]) die(`unknown agent "${ag}" (use ${AGENT_HELP})`);
    removeHook(cfg.agents.filter((g) => !list.includes(g)));
    cfg.agents = list;
    writeJson(CONFIG, cfg, 0o600);
    installHook(cfg);
    for (const ag of list) console.log(ag === 'claude' && cfg.viaPlugin ? 'Hooked up: Claude Code (plugin)' : `Hooked up: ${AGENTS[ag].label} (${AGENTS[ag].file()})`);
    if (list.includes('codex')) console.log('Codex: open Codex and run /hooks once to trust the Holdpoint hooks.');
    return;
  }
  if (cmd === 'status') {
    let reach = 'unreachable', away = '?';
    try { await api(cfg, 'GET', '/healthz'); reach = 'ok'; away = (await api(cfg, 'GET', '/api/client/state')).away ? 'away' : 'at desk'; } catch {}
    console.log(`${cfg.viaPlugin ? 'mode:       Claude Code plugin\n' : ''}machine:    ${cfg.name}\nrelay:      ${cfg.relay} (${reach})\nenabled:    ${cfg.enabled}\nrouting:    ${cfg.always ? 'always' : 'when away'} (device: ${away})\ntimeout:    ${cfg.timeoutSec}s, then ${cfg.onTimeout}; finished cards wait ${cfg.replyTimeoutSec || 900}s${cfg.stopCards === false ? ' (off)' : ''}\nagents:     ${cfg.agents.map((g) => g === 'claude' && cfg.viaPlugin ? 'Claude Code (plugin)' : `${AGENTS[g].label} (${AGENTS[g].file()})`).join(', ')}`);
    return;
  }
  if (cmd === 'unpair') {
    removeHook();
    fs.rmSync(CONFIG, { force: true });
    fs.rmSync(INSTALLED, { force: true });
    console.log('Unpaired and hook removed. (Remove the machine on your device too.)');
    return;
  }
  console.log('usage: holdpoint pair <code> --relay <url> [--agent claude|codex|both] [--always] [--no-stop] [--reply-timeout 900] | agents claude,codex | on | off | status | unpair');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(String(cmd()).startsWith('hook') ? 0 : 1); });
function cmd() { return process.argv[2]; }

module.exports = { describe, LOCKED_PATTERNS, lastAssistantText };
