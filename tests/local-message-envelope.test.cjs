'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEventKey, validateEnvelope } = require('../local-message-envelope.cjs');

function fixture(overrides = {}) {
  return {
    schemaVersion: 1, transport: 'adapter-test', accountScope: 'local-account-1',
    sourceMessageId: 'message-100', chatId: 'chat-7', chatType: 'DIRECT',
    sentAt: '2026-11-02T14:00:00+02:00', receivedAt: '2026-11-02T12:00:03Z',
    text: 'تم استلام حوالة 100 دولار', ...overrides,
  };
}

test('accepts a valid immutable inbound envelope', () => {
  const item = fixture();
  assert.equal(validateEnvelope(item), item);
  assert.match(makeEventKey(item), /^v1\|/);
});

test('same source identity produces the same key despite changed text', () => {
  assert.equal(makeEventKey(fixture()), makeEventKey(fixture({ text: 'edited display text' })));
});

test('different source message IDs produce different keys for identical text', () => {
  assert.notEqual(makeEventKey(fixture()), makeEventKey(fixture({ sourceMessageId: 'message-101' })));
});

test('different chats produce different keys for same source message ID', () => {
  assert.notEqual(makeEventKey(fixture()), makeEventKey(fixture({ chatId: 'chat-8' })));
});

test('length-prefixing prevents delimiter-based identity collisions', () => {
  const a = fixture({ accountScope: 'a|2:b', chatId: 'c', sourceMessageId: 'd' });
  const b = fixture({ accountScope: 'a', chatId: '2:b|c', sourceMessageId: 'd' });
  assert.notEqual(makeEventKey(a), makeEventKey(b));
});

test('rejects missing identity and unknown chat type', () => {
  assert.throws(() => validateEnvelope(fixture({ sourceMessageId: '' })), /sourceMessageId/);
  assert.throws(() => validateEnvelope(fixture({ chatType: 'UNKNOWN' })), /chatType/);
});

test('rejects timestamps without explicit timezone', () => {
  assert.throws(() => validateEnvelope(fixture({ sentAt: '2026-11-02T14:00:00' })), /explicit timezone/);
});

test('rejects oversized text and sensitive metadata keys', () => {
  assert.throws(() => validateEnvelope(fixture({ text: 'x'.repeat(65537) })), /exceeds/);
  assert.throws(() => validateEnvelope(fixture({ sourceMetadata: { sessionToken: 'do-not-store' } })), /prohibited/);
});

test('does not accept missing or unsupported schema versions', () => {
  assert.throws(() => validateEnvelope(fixture({ schemaVersion: 2 })), /schemaVersion/);
});