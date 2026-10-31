# Almasar Meta Relay

Minimal WhatsApp Business Cloud API webhook relay. It does not store merchant/accounting records.

## Routes
- `GET /health` health check
- `GET /webhook` Meta webhook verification
- `POST /webhook` validates Meta signature (when META_APP_SECRET is configured), receives complete inbound message objects, and waits for device acknowledgement.
- `GET /api/next` authenticated long-poll for the Android app
- `POST /api/ack/:messageId` acknowledge only after the Android app has committed the message to its local database.

## Environment
- `META_VERIFY_TOKEN` required for Meta webhook verification
- `META_APP_SECRET` recommended; validates X-Hub-Signature-256
- `APP_DEVICE_TOKEN` required shared secret for the Android client
- `PORT` optional, defaults to 10000

## Delivery semantics and limitations
The relay keeps messages in memory only while waiting for the phone to commit and acknowledge them. If the phone is offline or does not acknowledge within 18 seconds, it returns HTTP 503 so Meta can retry the webhook. This is not a durable queue: a relay restart loses in-flight messages. Do not use for live financial operations until a durable delivery design, Android foreground connectivity, Meta webhook retries, idempotency, and real-device tests are verified.
