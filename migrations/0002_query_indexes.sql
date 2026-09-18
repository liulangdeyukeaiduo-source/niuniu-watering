-- D1 read optimization indexes.
-- Apply once to the production D1 database after confirming the daily quota has reset.
-- These statements are additive and do not delete or rewrite application data.

CREATE INDEX IF NOT EXISTS idx_soil_history_ts
  ON soil_history(ts DESC);

CREATE INDEX IF NOT EXISTS idx_weather_history_ts
  ON weather_history(ts DESC);

CREATE INDEX IF NOT EXISTS idx_watering_events_updated_at
  ON watering_events(updated_at DESC);
