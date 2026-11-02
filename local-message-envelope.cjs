'use strict';

const CHAT_TYPES = new Set(['DIRECT', 'GROUP', 'BROADCAST', 'NEWSLETTER', 'OTHER']);
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_ID_LENGTH = 512;
const ISO_WITH_ZONE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
const FORBIDDEN_METADATA_KEY = /(token|secret|password|credential|authorization|session|signal.?key|private.?key|qr|auth)/i;

function requiredString(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new RangeError(`${field} exceeds ${maxLength} characters`);
  return value;
}

function validateTimestamp(value, field) {
  requiredString(value, field, 40);
  if (!ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp with an explicit timezone`);
  }
}

function validateMetadata(value, depth = 0) {
  if (value === undefined) return;
  if (depth > 4 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sourceMetadata must be a shallow plain object');
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) throw new TypeError(`sourceMetadata contains a prohibited field: ${key}`);
    if (item && typeof item === 'object') validateMetadata(item, depth + 1);
    else if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) {
      throw new TypeError(`sourceMetadata.${key} has an unsupported value`);
    }
    if (typeof item === 'string' && item.length > 1024) throw new RangeError(`sourceMetadata.${key} is too long`);
  }
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('envelope must be an object');
  }
  if (envelope.schemaVersion !== 1) throw new TypeError('unsupported schemaVersion');
  requiredString(envelope.transport, 'transport', 80);
  requiredString(envelope.accountScope, 'accountScope');
  requiredString(envelope.sourceMessageId, 'sourceMessageId');
  requiredString(envelope.chatId, 'chatId');
  if (!CHAT_TYPES.has(envelope.chatType)) throw new TypeError('chatType is invalid');
  validateTimestamp(envelope.sentAt, 'sentAt');
  validateTimestamp(envelope.receivedAt, 'receivedAt');
  requiredString(envelope.text, 'text', MAX_TEXT_LENGTH);
  if (envelope.senderId !== undefined) requiredString(envelope.senderId, 'senderId');
  if (envelope.senderDisplayName !== undefined) requiredString(envelope.senderDisplayName, 'senderDisplayName', 256);
  validateMetadata(envelope.sourceMetadata);
  return envelope;
}

// Length-prefix each identity component to prevent delimiter and concatenation collisions.
function makeEventKey(envelope) {
  validateEnvelope(envelope);
  const parts = [envelope.transport, envelope.accountScope, envelope.chatId, envelope.sourceMessageId];
  return 'v1|' + parts.map((part) => `${part.length}:${part}`).join('|');
}

module.exports = { MAX_TEXT_LENGTH, makeEventKey, validateEnvelope };