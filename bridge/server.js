const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const APP_TOKEN = process.env.APP_DEVICE_TOKEN || '';
const GRAPH_APP_SECRET = process.env.META_APP_SECRET || '';
const MAX_PENDING = 250;
const LEASE_MS = 30000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TEST_MODE = process.env.NODE_ENV === 'test';
let pool = null;
const testPending = new Map();
const testAcknowledged = new Set();

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
  return safeEqualText((req.headers.authorization || '').replace(/^Bearer\\s+/i, ''), APP_TOKEN);
}
function verifySignature(raw, signature) {
  if (!GRAPH_APP_SECRET || !signature || !signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GRAPH_APP_SECRET).update(raw).digest('hex');
  return safeEqualText(signature, expected);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', err => { if (!failed) reject(err); });
  });
}
function extractMessages(payload) {
  const out = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    if (change.field !== 'messages') continue;
    const value = change.value || {};
    for (const msg of value.messages || []) out.push({
      id: String(msg.id || ''), from: String(msg.from || ''), timestamp: String(msg.timestamp || ''),
      type: String(msg.type || ''), text: msg.text && typeof msg.text.body === 'string' ? msg.text.body : '',
      contacts: value.contacts || null, metadata: value.metadata || null, rawMessage: msg
    });
  }
  return out;
}
async function initStore() {
  if (TEST_MODE) return;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; refusing to start with volatile message storage');
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_messages (
      message_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS relay_messages_delivery_idx ON relay_messages (lease_until, created_at);
    CREATE TABLE IF NOT EXISTS relay_acknowledged (
      message_id TEXT PRIMARY KEY,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('SELECT 1');
}
async function enqueue(message) {
  const id = message.id || crypto.randomUUID();
  const payload = { ...message, id };
  if (TEST_MODE) {
    if (testAcknowledged.has(id) || testPending.has(id)) return;
    if (testPending.size >= MAX_PENDING) throw new Error('queue_full');
    testPending.set(id, payload); return;
  }
  await pool.query(
    'INSERT INTO relay_messages (message_id, payload) SELECT $1, $2::jsonb WHERE NOT EXISTS (SELECT 1 FROM relay_acknowledged WHERE message_id=$1) ON CONFLICT (message_id) DO NOTHING',
    [id, JSON.stringify(payload)]
  );
}
async function takeNext() {
  if (TEST_MODE) {
    const first = testPending.entries().next();
    if (first.done) return null;
    return { id: first.value[0], message: first.value[1], attempts: 1 };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT message_id, payload, attempts FROM relay_messages WHERE lease_until IS NULL OR lease_until < NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1'
    );
    if (!found.rowCount) { await client.query('COMMIT'); return null; }
    const row = found.rows[0];
    const updated = await client.query(
      'UPDATE relay_messages SET lease_until=NOW()+($2::text || \' milliseconds\')::interval, attempts=attempts+1 WHERE message_id=$1 RETURNING attempts',
      [row.message_id, LEASE_MS]
    );
    await client.query('COMMIT');
    return { id: row.message_id, message: row.payload, attempts: updated.rows[0].attempts };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function acknowledge(id) {
  if (TEST_MODE) {
    if (testAcknowledged.has(id)) return true;
    if (!testPending.has(id)) return false;
    testPending.delete(id); testAcknowledged.add(id); return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO relay_acknowledged (message_id) SELECT message_id FROM relay_messages WHERE message_id=$1 ON CONFLICT DO NOTHING', [id]);
    const removed = await client.query('DELETE FROM relay_messages WHERE message_id=$1 RETURNING message_id', [id]);
    await client.query('COMMIT');
    return removed.rowCount > 0;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function counts() {
  if (TEST_MODE) return { pending: testPending.size, acknowledged: testAcknowledged.size };
  const r = await pool.query('SELECT (SELECT COUNT(*) FROM relay_messages)::int AS pending, (SELECT COUNT(*) FROM relay_acknowledged)::int AS acknowledged');
  return r.rows[0];
}
const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      const c = await counts();
      return json(res, 200, { ok: true, service: 'almasar-meta-relay', ...c, storage: TEST_MODE ? 'test-memory' : 'postgres-durable', configured: { verifyToken: Boolean(VERIFY_TOKEN), appToken: Boolean(APP_TOKEN), appSecret: Boolean(GRAPH_APP_SECRET), database: TEST_MODE || Boolean(pool) } });
    }
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode'), token = url.searchParams.get('hub.verify_token'), challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && VERIFY_TOKEN && safeEqualText(token, VERIFY_TOKEN)) {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(challenge || '');
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
      for (const message of messages) await enqueue(message);
      // HTTP 200 is sent only after every message has committed to durable storage.
      return json(res, 200, { ok: true, received: messages.length, durably_queued: !TEST_MODE });
    }
    if (url.pathname === '/api/next' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const item = await takeNext();
      return item ? json(res, 200, item) : json(res, 204, {});
    }
    if (url.pathname.startsWith('/api/ack/') && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const id = decodeURIComponent(url.pathname.slice('/api/ack/'.length));
      const ok = await acknowledge(id);
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not_found' });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    process.stderr.write('relay request failed: ' + String(error && error.message || error) + '\\n');
    return json(res, 503, { error: 'temporarily_unavailable', retry: true });
  }
});
if (require.main === module) {
  initStore().then(() => app.listen(PORT, '0.0.0.0', () => process.stdout.write('Almasar durable relay listening on ' + PORT + '\\n')))
    .catch(error => { process.stderr.write('FATAL: ' + error.message + '\\n'); process.exit(1); });
}
module.exports = { app, extractMessages, verifySignature, initStore };
