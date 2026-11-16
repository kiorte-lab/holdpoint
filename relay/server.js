#!/usr/bin/env node
// Node adapter for the relay. Self-host: `node relay/server.js` or the Dockerfile.
// Env: PORT (8787), DATA_FILE (./holdpoint-data.json), NTFY_BASE (https://ntfy.sh), PUBLIC_URL
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRelay, ntfyNotifier } = require('./core');

function startServer({ port = 0, dataFile = null, notify, host = '0.0.0.0' } = {}) {
  let initialState = null;
  if (dataFile && fs.existsSync(dataFile)) initialState = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const persist = (state) => {
    if (!dataFile) return;
    fs.writeFileSync(dataFile + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(dataFile + '.tmp', dataFile);
  };
  const relay = createRelay({ initialState, persist, notify });
  const page = fs.readFileSync(path.join(__dirname, 'page.html'));

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 32 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : buf,
      });
      const out = await relay.handle(request);
      if (out) {
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        res.end(page);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('server error');
    }
  });
  server.requestTimeout = 0;      // long-polls
  server.headersTimeout = 15000;
  return new Promise((resolve) => server.listen(port, host, () => {
    resolve({ server, relay, port: server.address().port,
      close: () => new Promise((r) => { relay.close(); server.closeAllConnections?.(); server.close(r); }) });
  }));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  const dataFile = process.env.DATA_FILE || path.resolve('holdpoint-data.json');
  const notify = ntfyNotifier(process.env.NTFY_BASE || 'https://ntfy.sh', process.env.PUBLIC_URL || '');
  startServer({ port, dataFile, notify }).then(({ port }) =>
    console.log(`holdpoint relay on :${port} (data: ${dataFile})`));
}

module.exports = { startServer };
