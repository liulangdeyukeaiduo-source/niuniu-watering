# niuniu-watering

妞妞自动浇花系统 V3。

## Architecture

- ESP32-S3 publishes MQTT status and watering events to EMQX Cloud.
- EMQX forwards status/events to the Worker webhook endpoint.
- The Worker stores state and history in Cloudflare D1.
- The browser talks only to the Worker over HTTPS; MQTT credentials are never exposed to the browser.
- Remote commands are published to `niuniu/command` through the EMQX Deployment REST API.
- Remote control is locked until Cloudflare Access is enabled (`REQUIRE_ACCESS=true`).

## MQTT topics

- `niuniu/status`: ESP32 -> cloud, current device state.
- `niuniu/command`: cloud -> ESP32, control commands.
- `niuniu/watering/event`: ESP32 -> cloud, watering lifecycle events.

## Worker endpoints

- `GET /api/health`
- `GET /api/status`
- `GET /api/history?days=7`
- `GET /api/watering-events?days=7`
- `POST /api/command`
- `POST /ingest/emqx`

## D1

Existing tables are preserved:

- `soil_history`
- `weather_history`

V3 adds:

- `device_state`
- `watering_events`
- `command_audit`

The SQL source of truth is `migrations/0001_worker_core.sql`. The Worker also runs idempotent `CREATE TABLE IF NOT EXISTS` statements on API bootstrap so a first deployment cannot fail only because a migration has not yet been applied.

## Secrets

Configure these in Cloudflare, never commit their values:

- `EMQX_APP_SECRET`
- `EMQX_WEBHOOK_TOKEN`

Non-secret deployment configuration lives in `wrangler.jsonc`.
