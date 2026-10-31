const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const APP_TOKEN = process.env.APP_DEVICE_TOKEN || '';
const GRAPH_APP_SECRET = process.env.META_APP_SECRET || '';
const pending = new Map();
const waiters = [];
const acknowledged = new Map();
const MAX_PENDING = 250;
const ACK_TIMEOUT_MS = 18000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEqualText(token, APP_TOKEN);
}
function verifySignature(raw, signature) {
  if (!GRAPH_APP_SECRET || !signature || !signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GRAPH_APP_SECRET).update(raw).digest('hex');
  return safeEqualText(signature, expected);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
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
        contacts: value.contacts || null,
        metadata: value.metadata || null,
        rawMessage: msg
      });
    }
  }
  return out;
}
function wakeWaiter() {
  const waiter = waiters.shift();
  if (waiter) waiter();
}
function enqueue(message) {
  const id = message.id || crypto.randomUUID();
  if (acknowledged.has(id) || pending.has(id)) return { ok: true, duplicate: true };
  if (pending.size >= MAX_PENDING) return { ok: false, reason: 'queue_full' };
  const item = { id, message: { ...message, id }, createdAt: Date.now(), leaseUntil: 0, attempts: 0, timer: null, resolve: null };
  item.promise = new Promise(resolve => { item.resolve = resolve; });
  item.timer = setTimeout(() => {
    if (!pending.has(id)) return;
    pending.delete(id);
    item.resolve(false);
  }, ACK_TIMEOUT_MS);
  pending.set(id, item);
  wakeWaiter();
  return { ok: true, duplicate: false, item };
}
function nextMessage() {
  const now = Date.now();
  for (const item of pending.values()) {
    if (item.leaseUntil <= now) {
      item.leaseUntil = now + 5000;
      item.attempts += 1;
      return item;
    }
  }
  return null;
}
function waitForMessage(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    waiters.push(() => { clearTimeout(timer); resolve(); });
  });
}
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'almasar-meta-relay', pending: pending.size, acknowledged: acknowledged.size, configured: { verifyToken: Boolean(VERIFY_TOKEN), appToken: Boolean(APP_TOKEN), appSecret: Boolean(GRAPH_APP_SECRET) } });
  }
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && VERIFY_TOKEN && safeEqualText(token, VERIFY_TOKEN)) {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end(challenge || '');
    }
    return json(res, 403, { error: 'verification_failed' });
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let raw;
    try { raw = await readBody(req); } catch { return json(res, 413, { error: 'payload_too_large' }); }
    if (!GRAPH_APP_SECRET) return json(res, 503, { error: 'webhook_signature_secret_not_configured' });
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return json(res, 401, { error: 'invalid_signature' });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const messages = extractMessages(payload);
    if (!messages.length) return json(res, 200, { ok: true, received: 0 });
    const enqueued = messages.map(enqueue);
    if (enqueued.some(x => !x.ok)) return json(res, 503, { error: 'queue_full', retry: true });
    const fresh = enqueued.filter(x => x.item);
    const results = await Promise.all(fresh.map(x => x.item.promise));
    if (results.some(ok => !ok)) return json(res, 503, { error: 'device_not_confirmed', retry: true });
    return json(res, 200, { ok: true, received: messages.length, device_confirmed: true });
  }
  if (url.pathname === '/api/next' && req.method === 'GET') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    let item = nextMessage();
    if (!item) {
      await waitForMessage(12000);
      item = nextMessage();
    }
    return item ? json(res, 200, { id: item.id, message: item.message, attempts: item.attempts }) : json(res, 204, {});
  }
  if (url.pathname.startsWith('/api/ack/') && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const id = decodeURIComponent(url.pathname.slice('/api/ack/'.length));
    if (acknowledged.has(id)) return json(res, 200, { ok: true, duplicate: true });
    const item = pending.get(id);
    if (!item) return json(res, 404, { error: 'not_found' });
    clearTimeout(item.timer);
    pending.delete(id);
    acknowledged.set(id, Date.now());
    while (acknowledged.size > 20000) acknowledged.delete(acknowledged.keys().next().value);
    item.resolve(true);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not_found' });
});
app.listen(PORT, '0.0.0.0', () => process.stdout.write('Almasar relay listening on ' + PORT + '\n'));
