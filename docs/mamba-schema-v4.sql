-- =============================================================================
-- Mamba SQLite v4 additive extension
--
-- IMPORTANT:
--   Apply this only to a COPY of a healthy v3 database. The supported tool is:
--     node campaign-app/migrate_v3_to_v4.mjs --dry-run
--     node campaign-app/migrate_v3_to_v4.mjs --apply
--
-- The migration tool adds project_leads.assigned_account_key separately because
-- SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  account_key             TEXT PRIMARY KEY,
  label                   TEXT NOT NULL DEFAULT '',
  warmth                  TEXT NOT NULL DEFAULT 'NEW'
                            CHECK (warmth IN ('NEW','WARMING','ESTABLISHED')),
  warmup_started_at       TEXT,
  allowed_max_mode        TEXT NOT NULL DEFAULT 'conservative'
                            CHECK (allowed_max_mode IN ('conservative','standard')),
  daily_cap_contacts      INTEGER NOT NULL DEFAULT 0 CHECK (daily_cap_contacts >= 0),
  daily_cap_messages      INTEGER NOT NULL DEFAULT 0 CHECK (daily_cap_messages >= 0),
  health                  TEXT NOT NULL DEFAULT 'OK'
                            CHECK (health IN ('OK','THROTTLED','PAUSED')),
  account_risk_note       TEXT NOT NULL DEFAULT '',
  current_generation      INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1),
  active_binding_key      TEXT,
  lifetime_sent_messages  INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_sent_messages >= 0),
  lifetime_failed         INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_failed >= 0),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_bindings (
  binding_key       TEXT PRIMARY KEY,
  account_key       TEXT NOT NULL,
  device_key        TEXT NOT NULL,
  instance_name     TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL
                      CHECK (status IN ('PENDING_CLAIM','ACTIVE','TRANSFERRING','RELEASED','REVOKED')),
  generation        INTEGER NOT NULL CHECK (generation >= 1),
  bound_at          TEXT,
  released_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_bindings_one_active_account
  ON device_bindings(account_key)
  WHERE status IN ('ACTIVE','TRANSFERRING');
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_bindings_account_generation
  ON device_bindings(account_key, generation);
CREATE INDEX IF NOT EXISTS idx_device_bindings_device
  ON device_bindings(device_key, status);

-- Mutable current state. The PRIMARY KEY is the atomic send gate.
CREATE TABLE IF NOT EXISTS send_claims (
  idem_key             TEXT PRIMARY KEY,
  campaign_run_id      TEXT NOT NULL,
  project_lead_key     TEXT NOT NULL,
  flow_topic           TEXT NOT NULL DEFAULT '',
  part_no              INTEGER NOT NULL CHECK (part_no >= 1),
  account_key          TEXT NOT NULL,
  contact_key          TEXT NOT NULL,
  recipient_phone      TEXT NOT NULL,
  device_key           TEXT NOT NULL,
  binding_key          TEXT NOT NULL,
  binding_generation   INTEGER NOT NULL CHECK (binding_generation >= 1),
  state                TEXT NOT NULL
                         CHECK (state IN (
                           'CLAIMED','SENT','FAILED_RETRYABLE','FAILED_FINAL',
                           'UNKNOWN','LEGACY_UNVERIFIED','SKIPPED'
                         )),
  claim_token          TEXT NOT NULL,
  provider_msg_id      TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
  claimed_at           TEXT NOT NULL,
  sent_at              TEXT,
  updated_at           TEXT NOT NULL,
  last_error_code      TEXT NOT NULL DEFAULT '',
  last_error_message   TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT,
  FOREIGN KEY (binding_key) REFERENCES device_bindings(binding_key) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_send_claims_account_state
  ON send_claims(account_key, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_send_claims_run
  ON send_claims(campaign_run_id, project_lead_key, part_no);

-- Append-only audit log. Application code may INSERT only.
CREATE TABLE IF NOT EXISTS send_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key              TEXT NOT NULL,
  account_key           TEXT NOT NULL,
  contact_key           TEXT NOT NULL,
  recipient_phone       TEXT NOT NULL,
  device_key            TEXT NOT NULL,
  binding_generation    INTEGER NOT NULL,
  event_type            TEXT NOT NULL
                          CHECK (event_type IN (
                            'CLAIMED','SENT','FAILED_RETRYABLE','FAILED_FINAL',
                            'TIMEOUT','UNKNOWN','SKIPPED','LEGACY_UNVERIFIED','MANUAL_REVIEW'
                          )),
  provider_msg_id       TEXT,
  at_utc                TEXT NOT NULL,
  myt_date              TEXT NOT NULL,
  error_code            TEXT NOT NULL DEFAULT '',
  detail                TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT
);

-- A duplicated SENT event must never inflate the message cap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_events_one_sent_per_idem
  ON send_events(idem_key)
  WHERE event_type = 'SENT';
CREATE INDEX IF NOT EXISTS idx_send_events_daily_cap
  ON send_events(account_key, myt_date, event_type, contact_key);
CREATE INDEX IF NOT EXISTS idx_send_events_idem_time
  ON send_events(idem_key, at_utc);

-- Crash-recoverable cooperative transfer state machine.
CREATE TABLE IF NOT EXISTS handoff_transfers (
  transfer_id           TEXT PRIMARY KEY,
  bundle_id             TEXT UNIQUE,
  account_key           TEXT NOT NULL,
  source_binding_key    TEXT NOT NULL,
  source_generation     INTEGER NOT NULL,
  target_device_key     TEXT,
  target_binding_key    TEXT,
  target_generation     INTEGER,
  state                 TEXT NOT NULL
                          CHECK (state IN ('PREPARING','EXPORTED','IMPORTED','COMPLETED','ABORTED')),
  snapshot_hash         TEXT NOT NULL DEFAULT '',
  bundle_expires_at     TEXT,
  error_code            TEXT NOT NULL DEFAULT '',
  error_message         TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT,
  FOREIGN KEY (source_binding_key) REFERENCES device_bindings(binding_key) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_one_open_per_account
  ON handoff_transfers(account_key)
  WHERE state IN ('PREPARING','EXPORTED','IMPORTED');

CREATE TABLE IF NOT EXISTS handoff_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id           TEXT NOT NULL,
  account_key           TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  from_binding_key      TEXT,
  to_binding_key        TEXT,
  from_generation       INTEGER,
  to_generation         INTEGER,
  bundle_checksum       TEXT NOT NULL DEFAULT '',
  reason                TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  FOREIGN KEY (transfer_id) REFERENCES handoff_transfers(transfer_id) ON DELETE CASCADE,
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_handoff_log_account_time
  ON handoff_log(account_key, created_at);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (4, 'account-device-binding-and-send-ledger', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(version) DO NOTHING;

INSERT INTO metadata(key, value, updated_at) VALUES
  ('schema_version', '4', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('account_binding_mode', 'shadow', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('send_claims_enforced', 'false', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('handoff_enabled', 'false', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

PRAGMA user_version = 4;
