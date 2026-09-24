import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8191);
const UPSTREAM = (process.env.UPSTREAM_URL || 'http://flaresolverr-core:8191').replace(/\/$/, '');
const SESSION_ID = process.env.FLARESOLVERR_SESSION || 'torrent-studio-search';
const requestTimeoutMs = 120000;

let sessionReady = false;
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function callUpstream(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(UPSTREAM + '/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    return { response, text, data };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSession() {
  if (sessionReady) return;

  const result = await callUpstream({
    cmd: 'sessions.create',
    session: SESSION_ID,
  });

  // FlareSolverr returns an error if the named session already exists.
  // In that case it is still usable, so only fail when the response is
  // neither a success nor an "already exists" condition.
  if (!result.response.ok) {
    const body = String(result.text || '');
    if (!/already exists|session/i.test(body)) {
      throw new Error('Unable to create FlareSolverr session: ' + body.slice(0, 1000));
    }
  }

  sessionReady = true;
  console.log('[FS-PROXY] Persistent FlareSolverr session ready:', SESSION_ID);
}

async function processRequest(payload) {
  await ensureSession();

  const requestPayload = {
    ...(payload || {}),
    session: SESSION_ID,
  };

  let result = await callUpstream(requestPayload);

  // If the upstream session has disappeared, recreate it once and retry.
  if (
    result.data &&
    (
      result.data.status === 'error' ||
      /session/i.test(String(result.data.message || ''))
    )
  ) {
    sessionReady = false;
    await ensureSession();
    result = await callUpstream(requestPayload);
  }

  return result;
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(json));
  res.end(json);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'torrent-studio-flaresolverr-session-proxy',
      session: SESSION_ID,
    });
  }

  if (req.method !== 'POST' || req.url !== '/v1') {
    res.statusCode = 404;
    return res.end('Not found');
  }

  let raw = '';
  req.setEncoding('utf8');

  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 2_000_000) req.destroy();
  });

  req.on('end', () => {
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { status: 'error', message: 'Invalid JSON' });
    }

    enqueue(() => processRequest(payload))
      .then(result => {
        res.statusCode = result.response.status;
        res.setHeader(
          'Content-Type',
          result.response.headers.get('content-type') || 'application/json'
        );
        res.end(result.text);
      })
      .catch(error => {
        console.error('[FS-PROXY]', error);
        sendJson(res, 502, {
          status: 'error',
          message: error?.message || 'FlareSolverr proxy error',
        });
      });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[FS-PROXY] Listening on 0.0.0.0:${PORT}, upstream ${UPSTREAM}`);
});

async function shutdown() {
  try {
    await callUpstream({
      cmd: 'sessions.destroy',
      session: SESSION_ID,
    });
  } catch {}

  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
