# Local Phone Bot — implementation plan and verified technical decisions

Last reviewed: 2026-11-02
Development branch: `local-phone-bot`
Baseline commit reviewed: `0d2c61b818ad8f04ba6737e97e33d78cbdc2d1d9`

## 1. Product requirement

The merchant installs one Android APK. The target product contains:
- the existing Almasar accounting UI, merchant records, transactions, audit trail, and account statements;
- a WhatsApp linked-device session paired by the account owner using the normal QR flow;
- a local message intake and transfer-extraction pipeline;
- durable, idempotent message handling that feeds the existing ledger without losing or duplicating records.

The requested bot must run on the same Android phone. Do not silently move it to a cloud server, relay host, or computer. Internet is needed for WhatsApp connectivity; the accounting ledger must remain usable offline.

## 2. Verified repository baseline

The following statements were checked against the files on this branch:

| Area | Verified state |
|---|---|
| Android packaging | GitHub Actions generates a Capacitor Android project at build time. The workflow currently uses Capacitor 7.4.3 and Java 21. |
| Android identity | Generated Capacitor config uses app ID `ly.almasar.agent.next` and app name `المسار - نسخة جديدة`. |
| Local accounting storage | The current app uses browser **IndexedDB**, database `almasar-db`, object stores `records` and `inbox`. It has a legacy `localStorage` read path. It does **not** currently use SQLite. |
| Existing accounting logic | Merchant, message, transaction, audit, and statement logic live in `index.html`. |
| Current WhatsApp connection | `bridge-client.js` connects to a user-configured external relay URL and token. It is not a local WhatsApp Web session. |
| Existing relay | `bridge/server.js` is a Meta Cloud API webhook relay using PostgreSQL. Its README says its in-flight queue is memory-only and can be lost on relay restart. |
| Share import | The Android build adds SEND/SEND_MULTIPLE intent filters and a native bridge to import shared text/files. This is conversation import, not continuous WhatsApp listening. |
| Local bot | No embedded WhatsApp session, QR pairing implementation, Android foreground bot service, or real-device bot test is present in this baseline. |

Important correction: the existing ledger must not be described as SQLite. Its current IndexedDB storage and legacy migration path must be preserved unless a separately tested migration is approved.

## 3. Runtime compatibility gate — verified blocker

The obvious Node.js route is not currently compatible as-is:

1. The current Capawesome Capacitor Node.js plugin documentation describes an embedded Node.js for Mobile Apps runtime based on Node **18.20.4** for Android. Its documented limitations include one runtime instance per app launch and no `child_process` support. The plugin's current package line requires Capacitor **8**, while this repository currently generates a Capacitor **7** app.
2. The current Baileys 7 package declares Node **>=20.0.0**.
3. The inspected Baileys 6.7.18 package also declares Node **>=20.0.0**.

Therefore, installing the current Node mobile plugin and current Baileys package together would be an unsupported Node 18/Node 20 mismatch. Upgrading Capacitor alone would not solve the Node engine mismatch. Do not add Baileys to the APK, suppress the engine check, or claim QR pairing works until a compatible runtime/library pair has been demonstrated.

References:
- Capawesome Capacitor Node.js documentation: https://github.com/capawesome-team/capacitor-plugins/tree/main/packages/nodejs
- Baileys current package requirements: https://github.com/WhiskeySockets/Baileys/blob/master/package.json
- Baileys 6.7.18 package requirements: https://github.com/WhiskeySockets/Baileys/blob/v6.7.18/package.json

## 4. Architecture decision

**Decision: keep the existing accounting app intact; do not migrate its database as part of the first bot experiment.**

The first technical spike must compare viable on-device runtimes before selecting a WhatsApp adapter. A candidate is acceptable only if it:
- can be embedded and built for the Android ABIs we intend to support;
- can run the selected adapter with its complete cryptographic/protocol dependencies;
- can be controlled by a native Android foreground service with a persistent notification and clear Stop/Disconnect controls;
- can persist session state privately on the device;
- can communicate with the existing Capacitor app through a loopback-only or native bridge;
- does not require an external relay or upload message/accounting data.

A background JavaScript thread is not, by itself, proof of a durable Android foreground service. Android service lifecycle, process death, battery restrictions, and reboot behavior must be tested separately.

The current IndexedDB ledger remains the accounting source of truth for the first iteration. The bot must first write inbound messages to a durable local inbox, then pass them to the app's existing review/extraction pipeline. Do not replace the ledger with a new database or silently transform existing records. Any future database migration requires export, backup, migration, and round-trip verification against a copy of existing data.

## 5. Message safety, identity, and accounting rules

1. Persist each inbound message locally before acknowledging receipt to the WhatsApp adapter.
2. Use the source message ID as a unique idempotency key. Re-delivery must not create another message or ledger transaction.
3. Preserve original message text and source metadata for audit. Do not silently rewrite accepted transactions.
4. Treat extraction as a proposal. Validate amount, currency, direction, timestamp, reference, and counterparty against the source text.
5. Keep unclear or conflicting messages pending review. Never invent a missing amount, currency, or merchant.
6. Match chats to merchants only through an explicitly confirmed mapping. Do not merge merchants based only on similar names.
7. Keep currencies separate. Do not convert currency unless the user enters and confirms the exchange rate.
8. Ledger updates must be transactional and auditable. Corrections create linked adjustment records rather than erasing history.
9. On network loss, app restart, or service restart, resume queued work without duplication.
10. Show connection state, last successful message time, queue count, and messages awaiting review.
11. Pair only through the account owner's normal linked-device QR flow. Never request or store OTPs or account PINs.
12. Do not log QR codes, session keys, message contents, or financial data. Store session secrets in private app storage with platform-backed protection where available.

## 6. Android service and privacy requirements

- A persistent Android foreground-service notification must be visible while live collection is active.
- Provide explicit Start, Pause, Disconnect, and Delete local session controls.
- Bind any local control listener to loopback only; prefer a native bridge over an exposed network port.
- Request only permissions required by the tested implementation.
- The user must explicitly enable processing for each chat/account scope.
- The ledger and existing statements must remain available when the bot is stopped or the phone is offline.
- Clearly disclose that unofficial WhatsApp Web-compatible libraries are not an official WhatsApp integration and can break or result in account restrictions. Do not promise uninterrupted availability.

## 7. Implementation sequence and gates

### Gate A — runtime feasibility spike
- Build a minimal isolated APK for each viable candidate runtime.
- Record exact Capacitor, Android Gradle Plugin, Node/runtime, Java, ABI, and library versions.
- Prove runtime start, event exchange, private persistent storage, and clean app restart.
- Verify the candidate library's declared engine and native dependency support.
- Do not include WhatsApp credentials or pair an account during this gate.

### Gate B — Android service lifecycle
- Add a foreground service with notification and explicit controls.
- Test screen-off, Doze/battery optimization, process death, force-stop behavior, reboot, and network loss.
- Distinguish what Android guarantees from manufacturer-specific battery behavior.

### Gate C — QR adapter spike
- Only after Gate A and B pass, implement QR pairing using the account owner's normal linked-device flow.
- Verify private session persistence and reconnect after app restart.
- Test with non-financial test messages before touching merchant records.

### Gate D — durable inbox and extraction
- Persist inbound message ID, chat ID, sender, timestamp, and text before acknowledgement.
- Add idempotency and replay tests.
- Connect only to the existing extraction/review pipeline; do not auto-credit unreviewed financial messages by default.

### Gate E — ledger integration
- Map each chat to one confirmed merchant.
- Verify direction, currency separation, account statement totals, and audit history.
- Confirm all existing merchant and transaction data remains unchanged after update and pairing.

### Gate F — release verification
- Build APK from the development branch.
- Verify package ID, signing certificate, install/update behavior, and artifact checksum.
- Publish a test report with VERIFIED / PARTIAL / BLOCKED labels.
- Real-device QR, background, battery, and message-delivery behavior must remain NOT TESTED until tested on a physical phone.

## 8. Acceptance tests

- Two or more authorized test chats can send messages while connected.
- A message mapped to merchant A never appears in merchant B's statement.
- Replaying the same source message ID changes totals zero additional times.
- A message with unclear currency or direction remains pending review.
- A correction retains the original audit record.
- Existing merchant and ledger records survive app update and bot pairing.
- Offline accounting and statements remain available with the bot stopped.
- The UI clearly shows live collection is paused when the service is stopped.
- A service restart does not lose already persisted inbox items.
- No message, session, QR, or financial content is sent to an external relay by the local-bot path.

## 9. Current status

- **VERIFIED** — development branch `local-phone-bot` exists at baseline commit `0d2c61b`.
- **VERIFIED** — repository baseline and current storage/relay/share architecture inspected.
- **VERIFIED** — Node 18.20.4 mobile runtime versus Baileys Node >=20 compatibility blocker identified.
- **NOT IMPLEMENTED** — embedded local WhatsApp session and QR pairing.
- **NOT IMPLEMENTED** — Android foreground bot service.
- **NOT TESTED** — local runtime APK, real-device background behavior, QR pairing, and live message delivery.
- **NOT CLAIMED** — no production-ready local bot or bot-enabled APK is available yet.

Next work item: build and compare isolated Android runtime spikes, without modifying the existing accounting ledger or merging any experimental runtime into the production app until its build and lifecycle tests pass.
