'use strict';

(function exposeLocalInbox(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AlmasarLocalMessageInbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalInboxApi() {
  const STATUSES = new Set(['received', 'review', 'processed', 'failed']);

  function transactionResult(db, mode, action) {
    return new Promise((resolve, reject) => {
      let result;
      let settled = false;
      let tx;
      try {
        tx = db.transaction('inboundEvents', mode);
        const store = tx.objectStore('inboundEvents');
        action(store, (value) => { result = value; });
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
      tx.onerror = () => { if (!settled) { settled = true; reject(tx.error || new Error('IndexedDB transaction failed')); } };
      tx.onabort = () => { if (!settled) { settled = true; reject(tx.error || new Error('IndexedDB transaction aborted')); } };
    });
  }

  function createRepository(db, envelopeApi) {
    if (!db || typeof db.transaction !== 'function') throw new TypeError('A valid IndexedDB database is required');
    const codec = envelopeApi || (typeof globalThis !== 'undefined' && globalThis.AlmasarLocalMessageEnvelope);
    if (!codec || typeof codec.validateEnvelope !== 'function' || typeof codec.makeEventKey !== 'function') {
      throw new TypeError('The local message envelope validator is required');
    }

    return {
      async put(envelope) {
        codec.validateEnvelope(envelope);
        const eventKey = codec.makeEventKey(envelope);
        return transactionResult(db, 'readwrite', (store, setResult) => {
          const lookup = store.get(eventKey);
          lookup.onsuccess = () => {
            if (lookup.result) {
              setResult({ inserted: false, eventKey, record: lookup.result });
              return;
            }
            const now = new Date().toISOString();
            const record = {
              eventKey,
              envelope,
              status: 'received',
              attemptCount: 0,
              receivedAt: envelope.receivedAt,
              firstStoredAt: now,
              updatedAt: now,
              lastError: null
            };
            const insert = store.add(record);
            insert.onsuccess = () => setResult({ inserted: true, eventKey, record });
          };
        });
      },

      async get(eventKey) {
        return transactionResult(db, 'readonly', (store, setResult) => {
          const request = store.get(eventKey);
          request.onsuccess = () => setResult(request.result || null);
        });
      },

      async list() {
        const records = await transactionResult(db, 'readonly', (store, setResult) => {
          const request = store.getAll();
          request.onsuccess = () => setResult(request.result || []);
        });
        return records.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
      },

      async updateStatus(eventKey, status, lastError = null) {
        if (!STATUSES.has(status)) throw new TypeError('Invalid inbound event status');
        return transactionResult(db, 'readwrite', (store, setResult) => {
          const lookup = store.get(eventKey);
          lookup.onsuccess = () => {
            if (!lookup.result) {
              setResult(null);
              return;
            }
            const record = lookup.result;
            record.status = status;
            record.updatedAt = new Date().toISOString();
            record.attemptCount += 1;
            record.lastError = lastError === null ? null : String(lastError).slice(0, 500);
            const update = store.put(record);
            update.onsuccess = () => setResult(record);
          };
        });
      }
    };
  }

  return { createRepository, STATUSES: Array.from(STATUSES) };
});
