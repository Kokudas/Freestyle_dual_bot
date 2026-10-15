CREATE TABLE IF NOT EXISTS scrims (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(json_valid(state)),
  dirty_at INTEGER, panel_lock TEXT, panel_lock_until INTEGER,
  panel_revision INTEGER NOT NULL DEFAULT -1, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_scrim ON scrims(guild_id) WHERE status != 'ended';
CREATE INDEX IF NOT EXISTS dirty_panels ON scrims(dirty_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER,
  created_at INTEGER NOT NULL, completed_at INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, available_at);
CREATE TABLE IF NOT EXISTS wizards (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, guild_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
