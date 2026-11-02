# Android runtime compatibility gate

Reviewed: 2026-11-02
Branch: local-phone-bot

## Decision

Do not treat 'the SDK declares a foreground service' as proof that an always-on WhatsApp connection will survive Android background execution. The current Tether candidate declares FOREGROUND_SERVICE_DATA_SYNC; Android platform rules impose version-specific limits on this service type.

This document defines a mandatory compatibility gate before any runtime is integrated into Almasar.

## Platform constraints verified against Android Developers documentation

- Android 12 / API 31+: apps targeting API 31+ generally cannot start a foreground service while already in the background, except for defined exemptions. Pairing must start from an eligible visible/user-initiated state.
- Android 14 / API 34+: foreground services must declare a valid service type and its corresponding permission. Inspect the final merged manifest and runtime behavior.
- Android 15 / API 35+: dataSync foreground services have a total six-hour allowance per 24-hour period while the app is in the background, and are subject to additional start restrictions. A dataSync service cannot be represented as an unrestricted 24/7 connection.
- Android 16 / API 36+: jobs started from a foreground service must still respect their own runtime quotas. WorkManager/JobScheduler is not an assumed loophole for an always-on socket.

References:
- https://developer.android.com/develop/background-work/services/fgs
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/develop/background-work/services/fgs/changes
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start

## Tether-specific findings from upstream README and Gradle configuration

- Tether says it provides a foreground service and contributes FOREGROUND_SERVICE_DATA_SYNC through manifest merging.
- Tether requires JDK 21 and Android SDK platform 37 to build its sample project.
- Its core module has minSdk = 26 and compileSdk = 37.
- Its README states GPL-3.0 obligations for applications linking the SDK because of linked Signal protocol dependencies.
- Its upstream release is described as 0.1.0 / early-stage.
- These are source-review findings only. No Almasar integration or device test has occurred.

## Mandatory device test matrix

A candidate is not approved until all applicable cases pass on physical devices and results (Android version, device model, logs, duration, and observed state transitions) are recorded.

| Test | Required evidence | Pass condition |
|---|---|---|
| First pairing | QR lifecycle, pairing result, sanitized logs | Pairing completes and session is persisted |
| User exits app UI | Foreground notification and socket state | Behavior matches documented Android limits; UI is not required to remain open |
| Screen off / Doze | Timestamped connection and reconnect logs | No false 'connected' status; reconnect is reliable when permitted |
| Network loss / restore | Wi-Fi/mobile transitions | Backoff and recovery work; no duplicate message ingestion |
| Process killed by OS | Relaunch and session state | Session recovery is deterministic and data-safe |
| User force-stops app | Explicitly document platform behavior | App does not claim it can self-restart after force-stop |
| Reboot | Startup restrictions and notification | Start only through permitted Android flows; no policy bypass |
| Android 12, 13, 14, 15, 16 | Per-version test report | No unsupported service type, permission, or quota assumptions |
| High message volume | CPU, memory, battery, storage | Bounded resource use; backpressure and durable queue |
| Session revoked / logged out | State transitions | Stop retry loop and require a fresh user pairing |
| Duplicate delivery | Replayed event fixtures | Idempotent ingestion; one ledger entry per source event |

## Product architecture constraints

1. Keep WhatsApp transport isolated behind a MessageSource interface.
2. Transport callbacks must never write directly to merchant balances.
3. Persist each inbound event to a durable inbox before parsing or matching.
4. Use a stable source event key plus a unique database constraint for deduplication.
5. Parse into a reviewable transfer candidate; never silently post uncertain financial data.
6. Commit the transfer, merchant association, and audit event in one database transaction.
7. Preserve the existing IndexedDB schema and ledger semantics until migration is separately designed and tested.
8. Redact message bodies, phone numbers, tokens, pairing secrets, and session material from logs.
9. Make connection state explicit: disconnected, pairing, connected, reconnecting, paused by OS, logged out, and error.
10. The app must not claim 'always online' or '24/7' unless the chosen transport and supported Android versions demonstrably meet that service level.

## Architecture decision status

- **APPROVED** — isolate transport from the accounting domain and use a durable inbox boundary.
- **APPROVED** — do not post uncertain parsed transfers automatically; use review/confirmation.
- **BLOCKED** — adopt Tether in a closed-source/commercial build until GPL-3.0 obligations are resolved.
- **BLOCKED** — claim unrestricted background operation while Tether uses dataSync on Android 15+.
- **NOT TESTED** — compile Tether as an AAR against the generated Capacitor host.
- **NOT TESTED** — physical-device pairing, long-running socket, reconnect, Doze, process death, and reboot.
- **NOT IMPLEMENTED** — Almasar MessageSource, durable inbox adapter, transfer candidate review, or Tether bridge.

## Exit criteria for the next engineering milestone

The spike is complete only when:
- exact dependency coordinates and checksums are pinned;
- licence and transitive dependency notices are reviewed;
- a minimal host APK compiles reproducibly in CI;
- the final merged manifest and target SDK are archived;
- unit tests cover state transitions, parser fixtures, deduplication, and persistence;
- physical-device results cover the matrix above;
- no existing accounting data or schema is modified by the spike.

A green APK build of the existing app does not satisfy this gate.