const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const COMMANDS = new Set([
  "water",
  "stop",
  "auto_on",
  "auto_off",
  "status",
  "reset_daily",
  "test_reset",
]);

const WEATHER = {
  latitude: 22.2707,
  longitude: 113.5665,
  location: "珠海市香洲区",
  source: "open-meteo",
  minRefreshMs: 14 * 60 * 1000,
  vpdAssistThresholdKpa: 1.60,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "niuniu-watering-v3",
          db: Boolean(env.DB),
          emqxConfigured: Boolean(env.EMQX_API_BASE && env.EMQX_APP_ID && env.EMQX_APP_SECRET),
          webhookConfigured: Boolean(env.EMQX_WEBHOOK_TOKEN),
          accessAuthenticated: hasAccessIdentity(request),
          commandProtected: env.REQUIRE_ACCESS !== "true" || hasAccessIdentity(request),
          build: "2026-09-19-vpd-zoom-density-v3.3",
          weatherSource: WEATHER.source,
          weatherLocation: WEATHER.location,
          ts: Math.floor(Date.now() / 1000),
        });
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        return await getStatus(env);
      }

      if (url.pathname === "/api/watering-events" && request.method === "GET") {
        return await getWateringEvents(url, env);
      }

      if (url.pathname === "/api/history" && request.method === "GET") {
        return await getHistory(url, env);
      }

      if (url.pathname === "/api/command" && request.method === "POST") {
        return await sendCommand(request, env);
      }

      if (url.pathname === "/ingest/emqx" && request.method === "POST") {
        return await ingestEmqx(request, env);
      }

      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ingest/")) {
        return json({ ok: false, error: "not_found" }, 404);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("request_failed", {
        pathname: url.pathname,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return json({
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshWeather(env).catch((error) => {
        console.error("scheduled_weather_refresh_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
    );
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function hasAccessIdentity(request) {
  return Boolean(
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    request.headers.get("Cf-Access-Authenticated-User-Email")
  );
}

async function getStatus(env) {
  let row = null;
  let latestPayload = {};
  try {
    row = await env.DB.prepare(
      `SELECT device_id, ts, moisture, raw, sensor_valid, state, daily, max_daily,
              auto_mode, pump, source, event_id, interval_remaining, countdown, ip, test, payload_json
       FROM device_state
       WHERE device_id = ?1
       LIMIT 1`
    ).bind("niuniu-main").first();
  } catch (error) {
    if (!isMissingTableError(error, "device_state")) throw error;
    console.warn("device_state_missing_fallback_to_soil_history");
  }

  if (row) {
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(row.ts || 0));
    let reportedOnline = true;
    try {
      latestPayload = JSON.parse(row.payload_json || "{}");
      if (typeof latestPayload.online === "boolean") {
        reportedOnline = latestPayload.online;
      }
    } catch {
      latestPayload = {};
    }
    return json({
      ok: true,
      source: "device_state",
      ageSeconds,
      stale: ageSeconds > 90,
      data: {
        deviceId: row.device_id,
        timestamp: row.ts,
        moisture: row.moisture,
        raw: row.raw,
        sensorValid: Boolean(row.sensor_valid),
        state: row.state,
        daily: row.daily,
        maxDaily: row.max_daily,
        auto: Boolean(row.auto_mode),
        pump: Boolean(row.pump),
        source: row.source,
        eventId: row.event_id,
        intervalRemaining: row.interval_remaining,
        countdown: row.countdown,
        ip: row.ip,
        test: Boolean(row.test),
        temperature: finiteOrNull(latestPayload.temperature),
        humidity: finiteOrNull(latestPayload.humidity),
        vpd: finiteOrNull(latestPayload.vpd),
        environmentValid: Boolean(latestPayload.environmentValid),
        environmentAge: nullableInt(latestPayload.environmentAge),
        vpdAssistReady: Boolean(latestPayload.vpdAssistReady),
        autoReason: nullableText(latestPayload.autoReason),
        online: reportedOnline && ageSeconds <= 90,
      },
    });
  }

  const fallback = await env.DB.prepare(
    `SELECT device_id, ts, moisture, raw, sensor_valid, state, pump, auto_mode
     FROM soil_history
     ORDER BY id DESC
     LIMIT 1`
  ).first();

  if (!fallback) {
    return json({ ok: true, source: "none", stale: true, data: null });
  }

  const fallbackTs = normalizeTimestamp(fallback.ts) || 0;
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - fallbackTs);
  return json({
    ok: true,
    source: "soil_history_fallback",
    ageSeconds,
    stale: true,
    data: {
      deviceId: fallback.device_id,
      timestamp: fallbackTs,
      moisture: fallback.moisture,
      raw: fallback.raw,
      sensorValid: Boolean(fallback.sensor_valid),
      state: fallback.state,
      pump: Boolean(fallback.pump),
      auto: Boolean(fallback.auto_mode),
      online: false,
    },
  });
}

async function getWateringEvents(url, env) {
  const days = clampInt(url.searchParams.get("days"), 1, 30, 7);
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const result = await env.DB.prepare(
      `SELECT event_id, device_id, source, started_at, stopped_at, verified_at,
              planned_seconds, actual_seconds, before_moisture, before_raw,
              after_moisture, after_raw, daily, max_daily,
              pump_on_confirmed, pump_off_confirmed, test, result, last_phase, updated_at
       FROM watering_events
       WHERE updated_at >= ?1
       ORDER BY updated_at DESC
       LIMIT ?2`
    ).bind(since, limit).all();

    return json({ ok: true, days, events: result.results || [] });
  } catch (error) {
    if (!isMissingTableError(error, "watering_events")) throw error;
    console.warn("watering_events_missing_return_empty");
    return json({ ok: true, days, events: [], migrationRequired: true });
  }
}

async function getHistory(url, env) {
  let weatherRefresh = null;
  try {
    weatherRefresh = await refreshWeather(env);
  } catch (error) {
    console.warn("history_weather_refresh_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const days = clampInt(url.searchParams.get("days"), 1, 30, 7);
  const sinceSeconds = Math.floor(Date.now() / 1000) - days * 86400;
  const sinceMillis = sinceSeconds * 1000;

  const soilLimit = clampInt(url.searchParams.get("soilLimit"), 100, 30000, 22000);
  const weatherLimit = clampInt(url.searchParams.get("weatherLimit"), 100, 15000, 12000);
  const wateringLimit = clampInt(url.searchParams.get("wateringLimit"), 20, 500, 200);

  const [soilResult, weatherResult, wateringResult] = await Promise.all([
    env.DB.prepare(
      `SELECT ts, device_id, moisture, raw, sensor_valid, state, pump, auto_mode
       FROM soil_history
       WHERE device_id = ?1 AND ts >= ?2
       ORDER BY ts ASC
       LIMIT ?3`
    ).bind("niuniu-main", sinceMillis, soilLimit).all(),
    env.DB.prepare(
      `SELECT ts, temperature_c, humidity_pct, location, source
       FROM weather_history
       WHERE ts >= ?1
       ORDER BY ts ASC
       LIMIT ?2`
    ).bind(sinceMillis, weatherLimit).all(),
    env.DB.prepare(
      `SELECT event_id, source, started_at, stopped_at, verified_at,
              planned_seconds, actual_seconds, before_moisture, after_moisture,
              result, last_phase, test, updated_at
       FROM watering_events
       WHERE updated_at >= ?1
       ORDER BY updated_at ASC
       LIMIT ?2`
    ).bind(sinceSeconds, wateringLimit).all(),
  ]);

  return json({
    ok: true,
    days,
    indexedReads: true,
    soil: soilResult.results || [],
    weather: weatherResult.results || [],
    watering: wateringResult.results || [],
    weatherMeta: {
      source: WEATHER.source,
      location: WEATHER.location,
      refresh: weatherRefresh,
    },
  });
}

async function refreshWeather(env, { force = false } = {}) {
  const now = Date.now();

  let latestTs = 0;
  try {
    const latest = await env.DB.prepare(
      `SELECT ts, temperature_c, humidity_pct
       FROM weather_history
       ORDER BY ts DESC
       LIMIT 1`
    ).first();
    latestTs = Number(latest?.ts || 0);

    if (!force && latestTs > 0 && now - latestTs < WEATHER.minRefreshMs) {
      const temperature = Number(latest?.temperature_c);
      const humidity = Number(latest?.humidity_pct);
      const vpd = calculateVpd(temperature, humidity);
      const mqtt = await publishEnvironmentToEmqx(env, {
        ts: latestTs,
        temperature,
        humidity,
        vpd,
      });

      return {
        ok: true,
        skipped: true,
        reason: "fresh",
        lastTs: latestTs,
        temperature,
        humidity,
        vpd,
        mqtt,
      };
    }
  } catch (error) {
    if (!isMissingTableError(error, "weather_history")) throw error;
    console.warn("weather_history_missing_skip_refresh");
    return {
      ok: false,
      skipped: true,
      reason: "weather_history_missing",
      lastTs: 0,
    };
  }

  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.searchParams.set("latitude", String(WEATHER.latitude));
  endpoint.searchParams.set("longitude", String(WEATHER.longitude));
  endpoint.searchParams.set("current", "temperature_2m,relative_humidity_2m");
  endpoint.searchParams.set("timezone", "Asia/Shanghai");

  const response = await fetch(endpoint.toString(), {
    headers: {
      "accept": "application/json",
      "user-agent": "niuniu-watering-v3/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo HTTP ${response.status}`);
  }

  const payload = await response.json();
  const temperature = Number(payload?.current?.temperature_2m);
  const humidity = Number(payload?.current?.relative_humidity_2m);

  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
    throw new Error("Open-Meteo returned invalid current weather");
  }

  const vpd = calculateVpd(temperature, humidity);
  const sampleTs = Date.now();

  await env.DB.prepare(
    `INSERT INTO weather_history
      (ts, temperature_c, humidity_pct, location, source)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(
    sampleTs,
    temperature,
    humidity,
    WEATHER.location,
    WEATHER.source
  ).run();

  const mqtt = await publishEnvironmentToEmqx(env, {
    ts: sampleTs,
    temperature,
    humidity,
    vpd,
  });

  console.log("weather_sample_stored", {
    ts: sampleTs,
    temperature,
    humidity,
    vpd,
    location: WEATHER.location,
    mqtt,
  });

  return {
    ok: true,
    skipped: false,
    ts: sampleTs,
    temperature,
    humidity,
    vpd,
    location: WEATHER.location,
    source: WEATHER.source,
    mqtt,
  };
}

function calculateVpd(temperature, humidity) {
  const t = Number(temperature);
  const rh = Number(humidity);
  if (!Number.isFinite(t) || !Number.isFinite(rh)) return null;

  const saturationKpa =
    0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  const vpd = saturationKpa * (1 - Math.min(100, Math.max(0, rh)) / 100);
  return Math.round(vpd * 100) / 100;
}

async function publishEnvironmentToEmqx(env, sample) {
  if (!env.EMQX_API_BASE || !env.EMQX_APP_ID || !env.EMQX_APP_SECRET) {
    return { ok: false, skipped: true, reason: "emqx_not_configured" };
  }

  if (!Number.isFinite(sample.temperature) ||
      !Number.isFinite(sample.humidity) ||
      !Number.isFinite(sample.vpd)) {
    return { ok: false, skipped: true, reason: "invalid_environment" };
  }

  const auth = btoa(`${env.EMQX_APP_ID}:${env.EMQX_APP_SECRET}`);
  const payload = JSON.stringify({
    type: "environment",
    timestamp: Math.floor(Number(sample.ts) / 1000),
    temperature: Number(sample.temperature),
    humidity: Number(sample.humidity),
    vpd: Number(sample.vpd),
    vpdAssistThreshold: WEATHER.vpdAssistThresholdKpa,
    location: WEATHER.location,
    source: WEATHER.source,
  });

  try {
    const response = await fetch(
      `${env.EMQX_API_BASE.replace(/\/$/, "")}/publish`,
      {
        method: "POST",
        headers: {
          "authorization": `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // Reuse the existing authorized command subscription. Environment
          // messages are typed JSON, while control commands remain plain text.
          topic: "niuniu/command",
          qos: 0,
          retain: true,
          payload,
          payload_encoding: "plain",
        }),
      }
    );

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      response: text.slice(0, 300),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendCommand(request, env) {
  const accessAuthenticated = hasAccessIdentity(request);
  if (env.REQUIRE_ACCESS === "true" && !accessAuthenticated) {
    return json({
      ok: false,
      error: "access_required",
      message: "Remote control is locked until Cloudflare Access is enabled.",
    }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const command = String(body?.command || "").trim();
  if (!COMMANDS.has(command)) {
    return json({ ok: false, error: "invalid_command" }, 400);
  }

  if (!env.EMQX_API_BASE || !env.EMQX_APP_ID || !env.EMQX_APP_SECRET) {
    return json({ ok: false, error: "emqx_not_configured" }, 503);
  }

  const auth = btoa(`${env.EMQX_APP_ID}:${env.EMQX_APP_SECRET}`);
  const response = await fetch(`${env.EMQX_API_BASE.replace(/\/$/, "")}/publish`, {
    method: "POST",
    headers: {
      "authorization": `Basic ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      topic: "niuniu/command",
      qos: 0,
      retain: false,
      payload: command,
      payload_encoding: "plain",
    }),
  });

  const responseText = await response.text();
  const actor = request.headers.get("Cf-Access-Authenticated-User-Email") || "access-user";

  try {
    await env.DB.prepare(
      `INSERT INTO command_audit
        (ts, command, actor, access_authenticated, emqx_http_status, emqx_response)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      Math.floor(Date.now() / 1000),
      command,
      actor,
      accessAuthenticated ? 1 : 0,
      response.status,
      responseText.slice(0, 2000)
    ).run();
  } catch (error) {
    if (!isMissingTableError(error, "command_audit")) throw error;
    console.warn("command_audit_missing_skip_audit");
  }

  let emqxBody;
  try { emqxBody = JSON.parse(responseText); }
  catch { emqxBody = responseText; }

  if (response.status === 202) {
    return json({
      ok: false,
      acceptedByBroker: true,
      subscriberOnline: false,
      command,
      emqx: emqxBody,
    }, 409);
  }

  if (!response.ok) {
    return json({ ok: false, error: "emqx_publish_failed", command, emqx: emqxBody }, 502);
  }

  return json({ ok: true, command, emqx: emqxBody });
}

async function ingestEmqx(request, env) {
  if (!env.EMQX_WEBHOOK_TOKEN) {
    return json({ ok: false, error: "webhook_not_configured" }, 503);
  }

  const supplied = request.headers.get("X-Webhook-Token") || "";
  if (!timingSafeEqual(supplied, env.EMQX_WEBHOOK_TOKEN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let envelope;
  try {
    envelope = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const topic = String(envelope?.topic || envelope?.client_attrs?.topic || "");
  const payload = extractMqttPayload(envelope);

  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "payload_not_json", topic }, 400);
  }

  if (topic === "niuniu/status" || looksLikeStatus(payload)) {
    await upsertDeviceState(payload, env);
    if (boolInt(payload.historySample) === 1 && boolInt(payload.sensorValid) === 1) {
      await appendSoilHistory(payload, env);
    }
    return json({
      ok: true,
      type: "status",
      deviceId: payload.deviceId || "niuniu-main",
      historyStored: boolInt(payload.historySample) === 1 && boolInt(payload.sensorValid) === 1,
    });
  }

  if (topic === "niuniu/watering/event" || payload.eventId) {
    await upsertWateringEvent(payload, env);
    return json({ ok: true, type: "watering_event", eventId: payload.eventId });
  }

  return json({ ok: false, error: "unsupported_topic", topic }, 422);
}

function extractMqttPayload(envelope) {
  const candidate = envelope?.payload ?? envelope?.message?.payload ?? envelope;
  if (candidate && typeof candidate === "object") return candidate;
  if (typeof candidate !== "string") return null;

  const variants = [candidate];
  try {
    const decoded = atob(candidate);
    if (decoded && decoded !== candidate) variants.push(decoded);
  } catch {}

  for (const value of variants) {
    try { return JSON.parse(value); }
    catch {}
  }
  return null;
}

function looksLikeStatus(payload) {
  return (
    Object.prototype.hasOwnProperty.call(payload, "state") &&
    Object.prototype.hasOwnProperty.call(payload, "online") &&
    !Object.prototype.hasOwnProperty.call(payload, "phase")
  );
}

async function upsertDeviceState(payload, env) {
  const now = normalizeTimestamp(payload.timestamp) || Math.floor(Date.now() / 1000);
  const deviceId = String(payload.deviceId || "niuniu-main");

  await env.DB.prepare(
    `INSERT INTO device_state (
      device_id, ts, moisture, raw, sensor_valid, state, daily, max_daily,
      auto_mode, pump, source, event_id, interval_remaining, countdown, ip, test, payload_json
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
    )
    ON CONFLICT(device_id) DO UPDATE SET
      ts = excluded.ts,
      moisture = COALESCE(excluded.moisture, device_state.moisture),
      raw = COALESCE(excluded.raw, device_state.raw),
      sensor_valid = COALESCE(excluded.sensor_valid, device_state.sensor_valid),
      state = COALESCE(excluded.state, device_state.state),
      daily = COALESCE(excluded.daily, device_state.daily),
      max_daily = COALESCE(excluded.max_daily, device_state.max_daily),
      auto_mode = COALESCE(excluded.auto_mode, device_state.auto_mode),
      pump = COALESCE(excluded.pump, device_state.pump),
      source = COALESCE(excluded.source, device_state.source),
      event_id = COALESCE(excluded.event_id, device_state.event_id),
      interval_remaining = COALESCE(excluded.interval_remaining, device_state.interval_remaining),
      countdown = COALESCE(excluded.countdown, device_state.countdown),
      ip = COALESCE(excluded.ip, device_state.ip),
      test = COALESCE(excluded.test, device_state.test),
      payload_json = excluded.payload_json`
  ).bind(
    deviceId,
    now,
    nullableInt(payload.moisture),
    nullableInt(payload.raw),
    nullableBoolInt(payload.sensorValid),
    nullableText(payload.state),
    nullableInt(payload.daily),
    nullableInt(payload.maxDaily),
    nullableBoolInt(payload.auto),
    nullableBoolInt(payload.pump),
    nullableText(payload.source),
    nullableText(payload.eventId),
    nullableInt(payload.intervalRemaining),
    nullableInt(payload.countdown),
    nullableText(payload.ip),
    nullableBoolInt(payload.test),
    JSON.stringify(payload)
  ).run();
}

async function appendSoilHistory(payload, env) {
  const tsSeconds = normalizeTimestamp(payload.timestamp) || Math.floor(Date.now() / 1000);
  const tsMillis = tsSeconds * 1000;
  const deviceId = String(payload.deviceId || "niuniu-main");

  await env.DB.prepare(
    `INSERT INTO soil_history
      (device_id, ts, moisture, raw, sensor_valid, state, pump, auto_mode)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    deviceId,
    tsMillis,
    nullableInt(payload.moisture),
    nullableInt(payload.raw),
    boolInt(payload.sensorValid),
    nullableText(payload.state),
    boolInt(payload.pump),
    boolInt(payload.auto)
  ).run();
}

async function upsertWateringEvent(payload, env) {
  const eventId = String(payload.eventId || "").trim();
  if (!eventId) throw new Error("eventId is required");

  const phase = String(payload.phase || "UNKNOWN").toUpperCase();
  const ts = normalizeTimestamp(payload.timestamp) || Math.floor(Date.now() / 1000);
  const startedAt = phase === "STARTED" || phase === "START_FAILED" ? ts : null;
  const stoppedAt = phase === "STOPPED" || phase === "STOP_FAILED" ? ts : null;
  const verifiedAt = phase === "VERIFIED" ? ts : null;

  await env.DB.prepare(
    `INSERT INTO watering_events (
      event_id, device_id, source, started_at, stopped_at, verified_at,
      planned_seconds, actual_seconds, before_moisture, before_raw,
      after_moisture, after_raw, daily, max_daily,
      pump_on_confirmed, pump_off_confirmed, test, result, last_phase, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
      ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
    )
    ON CONFLICT(event_id) DO UPDATE SET
      device_id = excluded.device_id,
      source = CASE WHEN excluded.source != 'UNKNOWN' THEN excluded.source ELSE watering_events.source END,
      started_at = COALESCE(excluded.started_at, watering_events.started_at),
      stopped_at = COALESCE(excluded.stopped_at, watering_events.stopped_at),
      verified_at = COALESCE(excluded.verified_at, watering_events.verified_at),
      planned_seconds = COALESCE(excluded.planned_seconds, watering_events.planned_seconds),
      actual_seconds = COALESCE(excluded.actual_seconds, watering_events.actual_seconds),
      before_moisture = COALESCE(excluded.before_moisture, watering_events.before_moisture),
      before_raw = COALESCE(excluded.before_raw, watering_events.before_raw),
      after_moisture = COALESCE(excluded.after_moisture, watering_events.after_moisture),
      after_raw = COALESCE(excluded.after_raw, watering_events.after_raw),
      daily = COALESCE(excluded.daily, watering_events.daily),
      max_daily = COALESCE(excluded.max_daily, watering_events.max_daily),
      pump_on_confirmed = MAX(watering_events.pump_on_confirmed, excluded.pump_on_confirmed),
      pump_off_confirmed = MAX(watering_events.pump_off_confirmed, excluded.pump_off_confirmed),
      test = MAX(watering_events.test, excluded.test),
      result = COALESCE(excluded.result, watering_events.result),
      last_phase = excluded.last_phase,
      updated_at = excluded.updated_at`
  ).bind(
    eventId,
    String(payload.deviceId || "niuniu-main"),
    String(payload.source || "UNKNOWN"),
    startedAt,
    stoppedAt,
    verifiedAt,
    positiveOrNull(payload.plannedSeconds),
    positiveOrNull(payload.actualSeconds),
    measurementOrNull(payload.beforeMoisture),
    measurementOrNull(payload.beforeRaw),
    measurementOrNull(payload.afterMoisture),
    measurementOrNull(payload.afterRaw),
    nullableInt(payload.daily),
    nullableInt(payload.maxDaily),
    boolInt(payload.pumpOnConfirmed),
    boolInt(payload.pumpOffConfirmed),
    boolInt(payload.test),
    nullableText(payload.result),
    phase,
    ts
  ).run();
}

function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function positiveOrNull(value) {
  const n = nullableInt(value);
  return n !== null && n >= 0 ? n : null;
}

function measurementOrNull(value) {
  const n = nullableInt(value);
  return n !== null && n >= 0 ? n : null;
}

function nullableText(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function nullableBoolInt(value) {
  if (value === undefined || value === null || value === "") return null;
  return boolInt(value);
}

function boolInt(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isMissingTableError(error, tableName) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("no such table") && message.includes(tableName);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
