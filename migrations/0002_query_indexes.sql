-- D1 read optimization indexes used by the current Worker query plan.
-- This migration is additive and does not delete or rewrite application data.
--
-- soil_history and weather_history are intentionally NOT indexed on ts here:
-- the current hot paths read a bounded recent window by INTEGER PRIMARY KEY id,
-- so extra timestamp indexes would add write maintenance without reducing current reads.

CREATE INDEX IF NOT EXISTS idx_watering_events_updated_at
  ON watering_events(updated_at DESC);

PRAGMA optimize;
