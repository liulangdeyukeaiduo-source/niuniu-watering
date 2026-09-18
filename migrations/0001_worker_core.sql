CREATE TABLE IF NOT EXISTS watering_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'UNKNOWN',
  started_at INTEGER,
  stopped_at INTEGER,
  verified_at INTEGER,
  planned_seconds INTEGER,
  actual_seconds INTEGER,
  before_moisture INTEGER,
  before_raw INTEGER,
  after_moisture INTEGER,
  after_raw INTEGER,
  daily INTEGER,
  max_daily INTEGER,
  pump_on_confirmed INTEGER NOT NULL DEFAULT 0,
  pump_off_confirmed INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  last_phase TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watering_events_started_at
  ON watering_events(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_watering_events_device_started
  ON watering_events(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS device_state (
  device_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  moisture INTEGER,
  raw INTEGER,
  sensor_valid INTEGER,
  state TEXT,
  daily INTEGER,
  max_daily INTEGER,
  auto_mode INTEGER,
  pump INTEGER,
  source TEXT,
  event_id TEXT,
  interval_remaining INTEGER,
  countdown INTEGER,
  ip TEXT,
  test INTEGER,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  command TEXT NOT NULL,
  actor TEXT,
  access_authenticated INTEGER NOT NULL DEFAULT 0,
  emqx_http_status INTEGER,
  emqx_response TEXT
);

CREATE INDEX IF NOT EXISTS idx_command_audit_ts
  ON command_audit(ts DESC);
