const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const APP_TOKEN = process.env.APP_DEVICE_TOKEN || '';
const GRAPH_APP_SECRET = process.env.META_APP_SECRET || '';
const pending = new Map();
const waiters = [];
const seen = new Map();
const MAX_PENDING = 100;
const ACK_TIMEOUT_MS = 18000;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return APP_TOKEN && token && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(APP_TOKEN));
}
function verifySignature(raw, signature) {
  if (!GRAPH_APP_SECRET) return true;
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GRAPH_APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { reject(new Error('payload_too_large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function extractMessages(payload) {
  const out = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    if (change.field !== 'messages') continue;
    const value = change.value || {};
    for (const msg of value.messages || []) {
      out.push({
        id: String(msg.id || ''),
        from: String(msg.from || ''),
        timestamp: String(msg.timestamp || ''),
        type: String(msg.type || ''),
        text: msg.text && typeof msg.text.body === 'string' ? msg.text.body : '',
        contacts: msg.contacts || null,
        location: msg.location || null,
        interactive: msg.interactive || null,
        rawMessage: msg
      });
    }
  }
  return out;
}
function deliver(message) {
  return new Promise(resolve => {
    const id = message.id || crypto.randomUUID();
    if (seen.has(id)) { resolve(true); return; }
    if (pending.size >= MAX_PENDING) { resolve(false); return; }
    const item = { id, message, resolve, timer: setTimeout(() => {
      pending.delete(id); resolve(false);
    }, ACK_TIMEOUT_MS) };
    pending.set(id, item);
    const waiter = waiters.shift();
    if (waiter) waiter();
  });
}
function nextMessage() {
  for (const item of pending.values()) return item;
  return null;
}
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'almasar-meta-relay', pending: pending.size });
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(challenge || ''); }
    return json(res, 403, { error: 'verification_failed' });
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let raw;
    try { raw = await readBody(req); } catch { return json(res, 413, { error: 'payload_too_large' }); }
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return json(res, 401, { error: 'invalid_signature' });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const messages = extractMessages(payload);
    if (!messages.length) return json(res, 200, { ok: true, received: 0 });
    const results = await Promise.all(messages.map(deliver));
    if (results.some(ok => !ok)) return json(res, 503, { error: 'device_not_confirmed', retry: true });
    return json(res, 200, { ok: true, received: messages.length, device_confirmed: true });
  }
  if (url.pathname === '/api/next' && req.method === 'GET') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    let item = nextMessage();
    if (!item) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      item = nextMessage();
    }
    return item ? json(res, 200, { id: item.id, message: item.message }) : json(res, 204, {});
  }
  if (url.pathname.startsWith('/api/ack/') && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const id = decodeURIComponent(url.pathname.slice('/api/ack/'.length));
    const item = pending.get(id);
    if (!item) return json(res, 404, { error: 'not_found' });
    clearTimeout(item.timer); pending.delete(id); seen.set(id, Date.now());
    while (seen.size > 10000) seen.delete(seen.keys().next().value);
    item.resolve(true);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not_found' });
});
app.listen(PORT, '0.0.0.0', () => process.stdout.write('Almasar relay listening on ' + PORT + '\n'));
