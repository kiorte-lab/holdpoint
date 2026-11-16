// Cloudflare Worker adapter. One Durable Object ("global") holds the live queue and
// long-polls; device/client records are stored per key in Durable Object storage.
import { DurableObject } from 'cloudflare:workers';
import core from '../relay/core.js';
import page from '../relay/page.html';

const { createRelay, ntfyNotifier } = core;

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const initialState = { devices: {}, clients: {} };
      for (const [k, v] of await ctx.storage.list({ prefix: 'dev:' })) initialState.devices[k.slice(4)] = v;
      for (const [k, v] of await ctx.storage.list({ prefix: 'cli:' })) initialState.clients[k.slice(4)] = v;
      this.relay = createRelay({
        initialState,
        sweepTimer: false,
        notify: ntfyNotifier(env.NTFY_BASE || 'https://ntfy.sh', env.PUBLIC_URL || ''),
        persist: async (_state, { kind, id, rec }) => {
          const key = (kind === 'device' ? 'dev:' : 'cli:') + id;
          if (rec) await ctx.storage.put(key, rec); else await ctx.storage.delete(key);
        },
      });
    });
  }
  async fetch(request) {
    await this.ready;
    return (await this.relay.handle(request)) || new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      if (request.headers.get('content-length') > 32 * 1024) return new Response('too large', { status: 413 });
      return env.RELAY.get(env.RELAY.idFromName('global')).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
