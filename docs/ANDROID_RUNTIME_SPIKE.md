# Android local runtime spike — execution checklist

Date: 2026-11-02
Branch: local-phone-bot

## Purpose
Establish whether a Node.js-based WhatsApp Web adapter can run inside the Android APK without an external bot server, before modifying the merchant ledger.

## Candidate A: Capawesome Capacitor Node.js plugin
- Current documented Android runtime binary: Node.js 18.20.4.
- Current plugin package requires Capacitor 8; this app's generated Android project currently uses Capacitor 7.4.3.
- The current Baileys package and Baileys 6.7.18 both declare Node >=20.
- Result: **BLOCKED for the current pairing**. Do not suppress npm engine checks or assume compatibility.
- A Capacitor 8 migration would still not solve the Node 18 vs Node >=20 mismatch.

## Candidate B: native Android service plus custom Node >=20 runtime
This is a research candidate, not yet selected. Before implementation, verify:
- a maintained Android-compatible Node >=20 runtime distribution exists for supported ABIs;
- its license permits bundling and redistribution;
- required native dependencies and cryptographic primitives compile and run on Android;
- the runtime can be supervised by a foreground service and shut down cleanly;
- memory, battery, and thermal behavior are acceptable on a representative phone.

Do not claim this candidate is feasible until a minimal APK is built and exercised on a real Android device.

## Required isolated proof
1. Create a separate test module/branch path; do not alter the production ledger.
2. Build a minimal APK that starts and stops the candidate runtime.
3. Display runtime version and a self-test result in the app UI.
4. Verify request/response messaging between Android and runtime.
5. Verify a small test file persists across app restart in private app storage.
6. Verify notification-backed foreground service behavior with screen off.
7. Record Android version, device model, ABI, runtime version, app package ID, APK SHA-256, and test logs with secrets removed.
8. Only after the runtime gate passes, test the WhatsApp adapter and QR pairing.

## Explicit non-goals for this spike
- No QR or WhatsApp account pairing.
- No access to real merchant conversations.
- No changes to IndexedDB, transactions, statements, or backups.
- No external relay fallback.
- No production readiness claim.

## Decision
Current Capawesome Node 18 + Baileys >=20 pairing is not compatible based on declared requirements. Continue evaluating a separately bundled Node >=20 runtime or a different Android-native architecture. Do not ship a fake QR screen.
