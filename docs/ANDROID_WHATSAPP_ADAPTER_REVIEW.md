# Android-native WhatsApp adapter review

Reviewed: 2026-11-02
Target branch: local-phone-bot

## New candidate discovered

The Node 18 / Baileys >=20 mismatch is not the only possible architecture. An Android-native Kotlin SDK project named **Tether** describes a WhatsApp multi-device companion client designed specifically for Android. Its README documents QR pairing, message observation callbacks, Room-backed session persistence, a foreground service, automatic reconnect, and minSdk 26.

Repository: https://github.com/vijay-kartik/Tether
README: https://github.com/vijay-kartik/Tether/blob/main/README.md
Core Gradle config: https://github.com/vijay-kartik/Tether/blob/main/tether-core/build.gradle.kts

This is a more relevant technical candidate than embedding Node.js because it removes the Node runtime compatibility issue entirely.

## Critical adoption blocker: licence

Tether is GPL-3.0. Its own README explains that the linked Signal protocol dependencies are also GPL-3.0 and that an application linking the SDK must comply with GPL-3.0 distribution obligations.

This may conflict with a closed-source/commercial distribution model for Almasar. Do not copy, vendor, or link Tether into the Almasar APK until the product owner has deliberately accepted the licence obligations after qualified legal review, or a separately licensed implementation is selected.

## Technical maturity and compatibility risks

- The upstream project describes itself as version 0.1.0 / early-stage.
- Its sample app uses JDK 21, Android SDK platform 37, and minSdk 26.
- The current Almasar Android workflow generates a Capacitor 7.4.3 project and does not currently declare a native Kotlin SDK module.
- The current workflow's Android compile SDK / Gradle plugin defaults have not been proven compatible with Tether's build requirements.
- No Almasar integration, APK build with Tether, QR pairing, message reception, or device lifecycle test has been performed.

## Candidate comparison

| Candidate | Fit for on-device Android | Main blocker | Decision |
|---|---|---|---|
| Capawesome Node.js mobile runtime + current Baileys | Potentially possible in principle | Documented Node 18.20.4 vs Baileys Node >=20; plugin's current line also targets Capacitor 8 while Almasar uses Capacitor 7 | Do not use as-is |
| Tether Kotlin SDK | Specifically designed for Android; documents QR, foreground service, Room session storage | GPL-3.0 obligations, early-stage maturity, compatibility with generated Capacitor project untested | Highest-priority isolated evaluation candidate, not approved for product integration |
| Cobalt JVM library | Java/Kotlin API, unofficial linked-device protocol | Project targets Java 25 and does not document Android as a supported packaged target in the reviewed installation instructions | Not selected for Android spike |

Cobalt references:
- https://github.com/Auties00/Cobalt
- https://github.com/Auties00/Cobalt/blob/master/pom.xml

## Required next steps (no production integration yet)

1. Confirm the intended Almasar distribution/licensing model. Do not assume GPL-3.0 is acceptable.
2. Create an isolated Android compatibility spike that leaves the existing Capacitor app, IndexedDB ledger, and merchant statements untouched.
3. Verify whether Tether's published artifact is accessible and inspect its exact transitive licences and release provenance.
4. Build a minimal host APK using the same Android Gradle Plugin / compile SDK / minSdk choices intended for Almasar.
5. Verify the SDK can be called from a foreground service and that its QR/state callbacks can be bridged into the Capacitor UI.
6. Test session persistence, disconnect, process restart, network loss, and screen-off behavior on a physical device.
7. Only after all gates pass, design the durable inbox adapter and merchant-message review flow.

## Current status

- **VERIFIED (source review)** — Tether documents Android-native QR pairing, message callbacks, Room persistence, and a foreground service.
- **VERIFIED (source review)** — Tether is GPL-3.0 and its README describes GPL obligations for consumers.
- **NOT TESTED** — Tether builds against Almasar's generated Android project.
- **NOT IMPLEMENTED** — no Tether code or dependency has been added to Almasar.
- **NOT TESTED** — no QR, WhatsApp account, background operation, or real-message ingestion has been tested.
- **PROTECTED** — no changes to the current IndexedDB database, merchant ledger, or statement logic.

## Operational and account-risk note

Tether and Cobalt are unofficial linked-device protocol implementations, not WhatsApp/Meta-supported SDKs. The protocol can change, the implementation may stop working, and use may carry account-policy or account-restriction risk. Do not promise commercial-grade uptime or zero account risk. For official supported business messaging, evaluate Meta's official WhatsApp Business Platform separately, noting that it is a hosted Cloud API and does not satisfy the strict on-device-only requirement.
