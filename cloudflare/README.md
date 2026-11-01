# Almasar WhatsApp Relay — Cloudflare D1

Cloudflare Worker replacement for the Render/PostgreSQL relay. Routes stay compatible with the current client: GET /health, GET and POST /webhook, GET /api/next, POST /api/ack/:messageId.

## Setup
1. Apply schema.sql to the D1 database bound as DB.
2. Add Worker secrets META_VERIFY_TOKEN, META_APP_SECRET, and APP_DEVICE_TOKEN. Never commit secret values.
3. Deploy this directory as a Worker using wrangler.toml.

## Delivery
A webhook receives HTTP 200 only after D1 batch insertion succeeds. Messages remain in D1 across Worker restarts and are delivered at least once until device ACK. After ACK the payload row is deleted; only message ID and ACK timestamp remain. The client must save locally before ACK and must be idempotent.

The current client polls only while its UI is active. This Worker does not provide Android background receiving. Do not use live financial traffic until Meta credentials, device persistence, duplicate handling, and offline/restart cases are tested end-to-end.
