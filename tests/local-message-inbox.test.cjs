'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEventKey, validateEnvelope } = require('../local-message-envelope.js');
const { createRepository } = require('../local-message-inbox.js');

class FakeRequest {}
class FakeStore {
  constructor(tx, rows) { this.tx = tx; this.rows = rows; }
  request(work) {
    const request = new FakeRequest();
    this.tx.pending += 1;
    queueMicrotask(() => {
      try { request.result = work(); request.onsuccess?.(); }
      catch (error) { request.error = error; request.onerror?.(); this.tx.error = error; }
      this.tx.pending -= 1;
      this.tx.maybeComplete();
    });
    return request;
  }
  get(key) { return this.request(() => this.rows.get(key)); }
  add(record) {
    return this.request(() => {
      if (this.rows.has(record.eventKey)) throw new Error('ConstraintError');
      this.rows.set(record.eventKey, structuredClone(record));
      return record.eventKey;
    });
  }
  put(record) { return this.request(() => { this.rows.set(record.eventKey, structuredClone(record)); return record.eventKey; }); }
  getAll() { return this.request(() => Array.from(this.rows.values()).map((row) => structuredClone(row))); }
}
class FakeDatabase {
  constructor() { this.rows = new Map(); }
  transaction(storeName, mode) {
    assert.equal(storeName, 'inboundEvents');
    const tx = {
      pending: 0, error: null,
      objectStore: () => new FakeStore(tx, this.rows),
      maybeComplete() { if (this.pending === 0) queueMicrotask(() => { if (this.pending === 0) this.oncomplete?.(); }); }
    };
    return tx;
  }
}
function event(overrides = {}) {
  return {
    schemaVersion: 1, transport: 'local-adapter', accountScope: 'phone-account',
    sourceMessageId: 'wamid-001', chatId: 'chat-merchant-1', chatType: 'DIRECT',
    sentAt: '2026-11-02T14:00:00+02:00', receivedAt: '2026-11-02T12:00:03Z',
    text: 'تم استلام حوالة 100 دولار', ...overrides
  };
}

test('stores the first event durably and treats a repeated source identity as a duplicate', async () => {
  const repository = createRepository(new FakeDatabase(), { validateEnvelope, makeEventKey });
  const first = await repository.put(event());
  const duplicate = await repository.put(event({ text: 'تعديل نص العرض لا يغير هوية الرسالة' }));
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(first.eventKey, duplicate.eventKey);
  assert.equal((await repository.list()).length, 1);
});

test('keeps different chats and source message IDs separate', async () => {
  const repository = createRepository(new FakeDatabase(), { validateEnvelope, makeEventKey });
  await repository.put(event());
  await repository.put(event({ chatId: 'chat-merchant-2' }));
  await repository.put(event({ sourceMessageId: 'wamid-002' }));
  assert.equal((await repository.list()).length, 3);
});

test('tracks review state and bounded error text without deleting the original event', async () => {
  const repository = createRepository(new FakeDatabase(), { validateEnvelope, makeEventKey });
  const saved = await repository.put(event());
  const updated = await repository.updateStatus(saved.eventKey, 'review', 'needs merchant mapping');
  assert.equal(updated.status, 'review');
  assert.equal(updated.attemptCount, 1);
  assert.equal(updated.lastError, 'needs merchant mapping');
  assert.equal((await repository.get(saved.eventKey)).envelope.text, event().text);
  assert.equal(await repository.updateStatus('missing', 'processed'), null);
});

test('rejects invalid states and invalid message envelopes', async () => {
  const repository = createRepository(new FakeDatabase(), { validateEnvelope, makeEventKey });
  await assert.rejects(repository.put(event({ sourceMessageId: '' })), /sourceMessageId/);
  await assert.rejects(repository.updateStatus('x', 'unknown'), /Invalid inbound event status/);
});
