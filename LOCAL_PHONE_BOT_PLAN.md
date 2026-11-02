# Local Phone Bot — implementation plan

## Product requirement

The merchant installs one Android APK. The APK contains:
- the existing Almasar accounting UI and local ledger;
- a local WhatsApp Web-compatible session adapter, paired only by the account owner using the normal linked-device QR flow;
- a local message normalizer and transfer extraction pipeline;
- one local SQLite database shared by message ingestion and the accounting UI.

No external application server, hosted database, or computer is required for normal operation. Internet is required for WhatsApp connectivity and, only if enabled by the user, optional AI analysis. The local ledger must continue to work offline.

## Current baseline (verified by source inspection)

- `index.html` contains merchant records, messages, transaction ledger, statement rendering, backup/restore, and extraction/review logic.
- `bridge-client.js` currently polls an external relay URL and token. It is not a local WhatsApp session.
- `bridge/server.js` is an external HTTP relay for Meta Cloud API webhooks and PostgreSQL. It is not suitable as the requested on-device bot.
- `.github/workflows/android-build.yml` builds a Capacitor APK and currently adds a share-intent bridge; it does not embed a persistent Node runtime or WhatsApp session.
- Existing external relay/Cloudflare files are retained for reference and future migration, but are not the target runtime for this product.

## Target architecture

```
Android APK
  ├─ Capacitor accounting UI
  │    └─ existing merchant / transaction / statement logic
  ├─ Android foreground service (visible notification + user controls)
  │    └─ embedded local Node-compatible runtime (feasibility gate)
  │         └─ WhatsApp linked-device adapter (QR pairing)
  ├─ local bridge over loopback / native bridge
  └─ SQLite ledger + durable inbound-message queue
```

The WhatsApp adapter must run on the same phone. It must not expose its local control port to the LAN or public internet. Pairing QR and session credentials must never be written to logs, cloud storage, analytics, or chat. Pairing is initiated by the account owner; only chats the owner is authorized to process are in scope.

## Non-negotiable ingestion and accounting rules

1. Persist each inbound message locally before acknowledging it to the adapter.
2. Use the WhatsApp message identifier as a unique idempotency key; repeated delivery must not create a second ledger entry.
3. Preserve the original message and provenance for audit. Never silently rewrite an accepted transaction.
4. Extract proposals first. Amount, currency, direction, counterparty, timestamp, and reference must be validated against the source text.
5. Ambiguous messages remain pending review; never invent a missing amount, currency, or merchant.
6. Match a sender to an existing merchant by an explicitly verified phone/chat mapping. Do not create or merge merchant identities solely from fuzzy name similarity.
7. Keep balances separate by currency. Do not convert currencies unless the user explicitly supplies and confirms an exchange rate.
8. Ledger writes must be transactional and auditable. Reversals/corrections create linked adjustment records.
9. If the phone loses network or the app process is stopped, queued messages must resume safely without duplication after restart.
10. The app must show connection state, last successful message time, queue depth, and any messages awaiting review.

## Critical Android feasibility gate

Do not claim a QR-linked local WhatsApp bot is implemented until a real APK proves all of the following:
- an embedded Node-compatible runtime and the chosen WhatsApp adapter can start on supported Android versions/ABIs;
- QR pairing completes from a second device using the account owner's WhatsApp linked-device screen;
- session state is stored privately and survives process restart without being uploaded;
- a visible Android foreground service keeps the session active under ordinary screen-off conditions, subject to OS battery policies;
- inbound text messages from multiple authorized merchant chats are received and durably queued;
- the service reconnects after network loss and app restart;
- duplicate deliveries produce one message and at most one ledger transaction;
- battery use, memory use, and thermal behavior are acceptable on a real low/mid-range phone.

If the Node runtime or adapter cannot be supported reliably inside the APK, stop and report the measured blocker before choosing a different architecture. Do not silently move the bot to a cloud server or computer.

## Security and user transparency

- Use the standard linked-device QR flow; no OTP, PIN, or account-security bypass.
- Display a persistent notification while the session service is active, with clear Stop/Disconnect controls.
- Require explicit consent before processing a chat; provide pause, disconnect, and local session deletion controls.
- Keep session secrets in Android Keystore-backed encrypted storage where supported.
- Bind any local HTTP listener to loopback only; prefer a native bridge over an exposed port.
- Never upload message contents, merchant details, ledger entries, QR codes, or session credentials by default.
- Warn that unofficial WhatsApp Web-compatible libraries are unsupported by WhatsApp and may break or lead to account restrictions. Do not market the integration as official or guaranteed.

## Implementation sequence

1. Runtime spike: build a minimal Android test APK that starts/stops an embedded Node runtime from a foreground service. No WhatsApp login yet.
2. Adapter spike: verify the selected WhatsApp Web-compatible library can run on that exact Android runtime and complete QR pairing. No message ingestion into the ledger yet.
3. Local queue: add a durable SQLite inbox and idempotent message ingestion.
4. Extraction: connect normalized inbound text to the existing extraction/review engine.
5. Ledger integration: ensure accepted transactions update the existing merchant statement without duplicates or currency mixing.
6. Resilience: test screen-off, Doze/battery optimization, process death, reboot, network loss, reconnect, and session logout.
7. Release: build signed APK, verify package identity and install/update behavior, then deliver a test checklist and explicit VERIFIED / PARTIAL / BLOCKED status.

## Acceptance tests

- Two or more merchants can send test messages while the bot is connected.
- A message for merchant A never appears in merchant B's statement.
- Replaying the same message ID does not change totals twice.
- A message with an unclear currency or direction is held for review.
- A correction does not erase the original audit record.
- Existing ledger entries remain intact after installing an update and after bot pairing.
- With internet disconnected, merchant statements and local accounting remain available.
- With the service stopped, the app clearly reports that live collection is paused.
