# Local message ingestion contract

Reviewed: 2026-11-02
Branch: local-phone-bot
Scope: define the boundary between a future Android WhatsApp transport and the existing Almasar ledger. This document does not implement a transport or change application data.

## Existing data path — inspected in source

- The accounting database is IndexedDB `almasar-db`, version 1, with object stores `records` and `inbox`.
- `records` stores the application state object under key `state`. Its state includes `merchants`, `messages`, `transactions`, and `audit` arrays.
- `inbox` is a staging store keyed by `id`; the service worker writes shared chat text there.
- The current share target is a manual conversation-import path. It is not a live WhatsApp listener.
- On manual inbox import, the user selects/enters a merchant name, then `importChat()` parses the text and `saveState()` persists the state. The staging item is deleted after the state write chain completes.
- Existing message deduplication uses a content key based on timestamp, sender, and text (or free-text content), with an occurrence counter for repeated identical lines in one import. This is useful for text exports but is not a stable WhatsApp source-message identity.
- Transactions carry `merchantId`, `sourceMessageId`, status, amount in minor units, currency, direction, timestamp, and audit records. Statements count only confirmed transactions and calculate balances separately per currency.
- `saveState()` serializes writes through `writeChain`. If persistence fails, it blocks further writes and displays a warning.

These observations are source-inspection findings, not device-test results.

## Required transport boundary

The Android transport must not call UI functions, mutate the `state` object, or write transactions directly. It emits immutable inbound envelopes to a local durable inbox. The app's existing import/review path remains responsible for mapping, extraction, validation, and ledger changes.

### Inbound envelope (version 1)

Required fields:
- `schemaVersion`: integer, currently 1.
- `transport`: fixed identifier for the selected adapter.
- `accountScope`: opaque local identifier for the linked account; never a phone number.
- `sourceMessageId`: stable message identifier supplied by the transport.
- `chatId`: stable opaque conversation identifier.
- `chatType`: one of `DIRECT`, `GROUP`, `BROADCAST`, `NEWSLETTER`, `OTHER` where available.
- `sentAt`: source timestamp in ISO-8601 with explicit offset or UTC.
- `receivedAt`: device receipt timestamp in ISO-8601.
- `text`: original decoded text, preserved exactly.

Optional fields:
- `senderId`: opaque source sender identifier.
- `senderDisplayName`: best-effort display name, never a merchant identity.
- `media`: metadata only in the first milestone; binary media download is out of scope.
- `sourceMetadata`: bounded, allow-listed, non-secret metadata only.

Never persist QR payloads, pairing tokens, Signal keys, auth credentials, or raw protocol frames in the inbox.

## Idempotency and durable receipt

1. Construct a deterministic event key from adapter namespace + account scope + chat ID + source message ID. Do not use message text as the primary identity.
2. Enforce uniqueness for that event key in the durable inbox. Re-delivery of the same event must be a no-op and must not create another message or transaction.
3. Persist the complete envelope before reporting successful receipt to the transport.
4. If persistence fails, do not acknowledge successful receipt; surface a recoverable storage error and keep the event eligible for retry.
5. Inbox processing is at-least-once. Every downstream operation must therefore be idempotent.
6. Keep the original envelope until the app confirms that its corresponding message record is safely persisted. Do not delete on parse success alone.
7. If the app crashes between writing a message and marking the envelope processed, replay must detect the existing source event key and finish safely.

## Merchant mapping and accounting boundary

- Chat-to-merchant mapping is an explicit user-confirmed mapping. Sender names, phone numbers, group subjects, and message contents are not sufficient to create or select a merchant automatically.
- An unknown chat remains unassigned and visible for review.
- Each envelope may create at most one source message record for the same source event key.
- Parsing creates a transfer proposal, not a ledger transaction.
- Missing amount, currency, direction, counterparty, or ambiguous date must remain pending review.
- Keep LYD, USD, and other currencies as separate balances. Never infer or invent an exchange rate.
- Only the existing confirmation flow may turn a proposal into a confirmed transaction unless a separately reviewed and tested policy explicitly changes this behavior.
- A confirmed transaction must reference its source message and merchant; the audit trail must record the action.
- Corrections must retain history through the existing audit/adjustment model; never silently rewrite or delete source messages.

## Failure and recovery semantics

| Failure | Required behavior |
|---|---|
| Duplicate delivery | Detect same event key; no duplicate message or ledger entry |
| Database unavailable / quota exceeded | Do not acknowledge receipt; pause intake and show a clear storage warning |
| App process dies after inbox write | Resume processing from durable inbox after restart |
| App process dies during import | Replay safely; source event key prevents duplicate state changes |
| Chat not mapped | Keep envelope pending; do not create a merchant from a display name |
| Parser uncertain | Keep proposal pending review; no balance change |
| Session logged out / revoked | Stop reconnect attempts and request user re-pairing |
| Network unavailable | Existing accounting and statements remain usable offline |

## Minimum automated test fixtures

1. Same envelope delivered twice -> one inbox event, one message, zero duplicate transactions.
2. Same text from two different source message IDs -> two distinct source events.
3. Same source message ID in two different chats -> distinct events because chat ID is part of the key.
4. Two merchants with similar names -> no cross-assignment without confirmed mapping.
5. USD and LYD transfers -> independent totals and statement balances.
6. Missing currency or ambiguous direction -> pending review, no ledger change.
7. Crash after durable inbox write -> event replays and is processed exactly once logically.
8. Crash after message persistence but before inbox acknowledgement -> replay finds the existing message and completes safely.
9. IndexedDB write failure -> no successful transport acknowledgement and no partial ledger mutation.
10. Existing backup export/import -> all pre-existing merchant, message, transaction, and audit records remain unchanged.

## Explicit implementation gates

- **VERIFIED (source inspection)** — current IndexedDB stores, state shape, manual inbox import path, content-based import deduplication, transaction source link, statement calculation, and serialized state persistence were inspected.
- **DESIGN ONLY** — the envelope and durable event-key contract in this document.
- **NOT IMPLEMENTED** — Android live-message adapter, source-event uniqueness index, durable transport acknowledgement, chat mapping UI, and replay worker.
- **NOT TESTED** — any live WhatsApp delivery, Android service lifecycle, process-death recovery, or physical-device behavior.
- **PROTECTED** — no application database schema or existing merchant/transaction records were changed by this document.

A successful build of the current APK does not prove any of the unimplemented ingestion behaviors.