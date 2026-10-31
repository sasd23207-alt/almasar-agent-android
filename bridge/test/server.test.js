const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.META_VERIFY_TOKEN = 'verify-test-token';
process.env.APP_DEVICE_TOKEN = 'device-test-token';
process.env.META_APP_SECRET = 'meta-test-secret';
const { app, extractMessages } = require('../server');

let base;
before(async () => {
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.address().port;
});
after(async () => {
  await new Promise(resolve => app.close(resolve));
});

function signed(body) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
}
function payload(id, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '123' },
      contacts: [{ profile: { name: 'Test Merchant' }, wa_id: '218900000000' }],
      messages: [{ id, from: '218900000000', timestamp: '1793440000', type: 'text', text: { body: text } }]
    } }] }]
  };
}

test('health exposes no message contents', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.pending, 0);
  assert.equal(JSON.stringify(j).includes('Test Merchant'), false);
});

test('Meta verification requires configured verify token', async () => {
  const ok = await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=verify-test-token&hub.challenge=abc123');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'abc123');
  const bad = await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123');
  assert.equal(bad.status, 403);
});

test('webhook waits for device ACK after full message delivery', async () => {
  const body = JSON.stringify(payload('wamid.test.001', 'حوالة 1000 دولار للتاجر أحمد'));
  const webhookPromise = fetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signed(body) }, body });
  const next = await fetch(base + '/api/next', { headers: { authorization: 'Bearer device-test-token' } });
  assert.equal(next.status, 200);
  const item = await next.json();
  assert.equal(item.message.text, 'حوالة 1000 دولار للتاجر أحمد');
  assert.equal(item.message.rawMessage.text.body, item.message.text);
  assert.equal(item.message.contacts[0].profile.name, 'Test Merchant');
  const ack = await fetch(base + '/api/ack/' + encodeURIComponent(item.id), { method: 'POST', headers: { authorization: 'Bearer device-test-token' } });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).ok, true);
  const webhook = await webhookPromise;
  assert.equal(webhook.status, 200);
  assert.equal((await webhook.json()).device_confirmed, true);
});

test('invalid Meta signature is rejected', async () => {
  const body = JSON.stringify(payload('wamid.test.002', 'test'));
  const r = await fetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body });
  assert.equal(r.status, 401);
});

test('device endpoints reject missing or wrong token', async () => {
  const r = await fetch(base + '/api/next', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
});

test('message extractor preserves the complete original message object', () => {
  const p = payload('wamid.test.003', 'full text');
  const m = extractMessages(p)[0];
  assert.equal(m.id, 'wamid.test.003');
  assert.deepEqual(m.rawMessage, p.entry[0].changes[0].value.messages[0]);
  assert.equal(m.contacts[0].profile.name, 'Test Merchant');
});
