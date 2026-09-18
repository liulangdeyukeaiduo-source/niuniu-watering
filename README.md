# niuniu-watering

妞妞自动浇花系统 V3。

## Architecture

- ESP32-S3 publishes MQTT status and watering events to EMQX Cloud Global (Asia-Pacific).
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


## Global EMQX deployment (2026-09-18)

- MQTT host: `h1730b1a.ala.asia-southeast1.emqxsl.com`
- MQTT TLS port: `8883`
- WSS port: `8084`
- REST API base: `https://h1730b1a.ala.asia-southeast1.emqxsl.com:8443/api/v5`
- Deployment App ID: `z8668161`
- `EMQX_APP_SECRET` remains a Cloudflare Worker Secret and must be updated in the Cloudflare dashboard; it is never committed to Git.
- The previous Shenzhen deployment is retained only as a rollback path until the ESP32 cutover is fully verified.

## Runtime bootstrap note

Worker runtime schema bootstrap never stores D1 I/O promises in module-global state. Only a plain boolean is cached per isolate after successful idempotent DDL, avoiding cross-request I/O reuse.


## D1 read-budget optimization (2026-09-18)

The dashboard is designed to stay within the D1 free-tier read budget:

- Current device state is fetched by `device_state.device_id` primary key.
- Legacy fallback reads the newest `soil_history` row by integer primary key `id`, not by an unindexed timestamp sort.
- History endpoints use bounded recent-row reads (default 2,000 soil + 2,000 weather + 200 watering rows maximum per request) and filter the requested time window in the Worker.
- Browser polling pauses while the tab is hidden.
- Status polling is 15 seconds; watering-event polling is 5 minutes, with immediate refresh after a command.
- Timestamp indexes are provided in migration `0002_query_indexes.sql` for production application after quota reset/approval.
