-- Migration 304: controlled SQLite <-> Notion CRM sync state.
-- SQLite remains the operational truth. Raw conversations never enter these tables.

ALTER TABLE contacts ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_leads ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE crm_customer_profiles (
  contact_key TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  global_status TEXT NOT NULL DEFAULT 'Active',
  next_follow_up_at TEXT,
  current_sales_stage TEXT NOT NULL DEFAULT 'New',
  main_objection TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE
);

CREATE TABLE notion_entity_map (
  entity_type TEXT NOT NULL,
  sqlite_entity_id TEXT NOT NULL,
  stable_notion_id TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  notion_database_id TEXT NOT NULL,
  last_sqlite_version INTEGER NOT NULL DEFAULT 0,
  last_sqlite_snapshot_json TEXT NOT NULL DEFAULT '{}',
  last_notion_edited_at TEXT,
  last_synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (sync_status IN ('PENDING','SYNCED','CONFLICT','ERROR','ARCHIVED')),
  PRIMARY KEY (entity_type, sqlite_entity_id),
  UNIQUE (notion_page_id),
  UNIQUE (entity_type, stable_notion_id)
);

CREATE TABLE sync_inbox (
  inbox_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  notion_page_id TEXT NOT NULL,
  notion_database_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  notion_edited_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','APPLIED','CONFLICT','FAILED','CANCELLED')),
  conflict_id TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE sync_conflicts (
  conflict_id TEXT PRIMARY KEY,
  inbox_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  base_value_json TEXT NOT NULL DEFAULT 'null',
  sqlite_value_json TEXT NOT NULL DEFAULT 'null',
  notion_value_json TEXT NOT NULL DEFAULT 'null',
  detected_at TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (resolution IN ('PENDING','USE_SQLITE','USE_NOTION','CUSTOM','CANCELLED')),
  resolved_value_json TEXT,
  resolved_by TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  UNIQUE (inbox_id, field_name),
  FOREIGN KEY (inbox_id) REFERENCES sync_inbox(inbox_id) ON DELETE SET NULL
);

CREATE TABLE sync_audit_events (
  event_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('LOCAL_TO_NOTION','NOTION_TO_LOCAL','RECONCILIATION')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE sync_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN','NIGHTLY','MANUAL')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  report_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

ALTER TABLE sync_worker_state ADD COLUMN last_push_at TEXT;
ALTER TABLE sync_worker_state ADD COLUMN last_pull_at TEXT;
ALTER TABLE sync_worker_state ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE sync_worker_state ADD COLUMN paused_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_sync_inbox_queue ON sync_inbox(status, received_at);
CREATE INDEX idx_sync_inbox_page ON sync_inbox(notion_page_id, notion_edited_at);
CREATE INDEX idx_notion_entity_status ON notion_entity_map(sync_status, entity_type);
CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(resolution, detected_at);
CREATE INDEX idx_sync_audit_entity ON sync_audit_events(entity_type, entity_id, created_at);
CREATE INDEX idx_sync_reconciliation_time ON sync_reconciliation_runs(started_at DESC);

CREATE TRIGGER contacts_row_version_after_update
AFTER UPDATE ON contacts
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE contacts SET row_version = OLD.row_version + 1 WHERE contact_key = OLD.contact_key;
END;

CREATE TRIGGER project_leads_row_version_after_update
AFTER UPDATE ON project_leads
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE project_leads SET row_version = OLD.row_version + 1 WHERE project_lead_key = OLD.project_lead_key;
END;

CREATE TRIGGER crm_customer_profiles_row_version_after_update
AFTER UPDATE ON crm_customer_profiles
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE crm_customer_profiles SET row_version = OLD.row_version + 1 WHERE contact_key = OLD.contact_key;
END;
