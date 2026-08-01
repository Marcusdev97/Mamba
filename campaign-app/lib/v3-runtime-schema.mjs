export const RUNTIME_SCHEMA_PATCH_VERSION = 302;
export const RUNTIME_SCHEMA_PATCH_NAME = "p0-campaign-safety";

export const INSTANCE_IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS instance_identity (
  instance_name    TEXT PRIMARY KEY,
  whatsapp_number TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'evolution',
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instance_identity_number ON instance_identity(whatsapp_number);
`;

export const LID_MAP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lid_map (
  lid        TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  source     TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  evidence   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lid_map_phone ON lid_map(phone);
`;

export const GOLDEN_CONVERSATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS golden_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_code TEXT NOT NULL UNIQUE,
  project_code TEXT NOT NULL,
  origin_project_code TEXT,
  source_channel TEXT,
  blast_version TEXT,
  language TEXT,
  customer_role TEXT,
  primary_purpose TEXT,
  first_reply_type TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('Viewing Booked','Active','Dormant','Dead')),
  outcome_updated_at TEXT NOT NULL,
  death_turn INTEGER,
  death_message_type TEXT,
  death_note TEXT,
  trigger_message TEXT,
  customer_next_move TEXT,
  friction_removers TEXT NOT NULL DEFAULT '[]',
  reconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (reconfirmed IN (0,1)),
  decision_trace TEXT NOT NULL DEFAULT '[]',
  conversation_text TEXT NOT NULL,
  do_not_copy TEXT NOT NULL DEFAULT '[]',
  pk_conflicts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  last_customer_reply_at TEXT
);
`;

export const GOLDEN_FOLLOWUP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS followup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_code TEXT NOT NULL REFERENCES golden_conversations(lead_code) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  silence_gap_days INTEGER NOT NULL,
  followup_type TEXT NOT NULL CHECK (followup_type IN ('ab_slot_template','festival_greeting','new_info','price_update','personalized_question')),
  content_summary TEXT,
  revival INTEGER NOT NULL CHECK (revival IN (0,1)),
  revival_gap_hours INTEGER,
  UNIQUE(lead_code, seq)
);
CREATE INDEX IF NOT EXISTS idx_gc_outcome ON golden_conversations(outcome);
CREATE INDEX IF NOT EXISTS idx_gc_project ON golden_conversations(project_code);
CREATE INDEX IF NOT EXISTS idx_fl_type ON followup_log(followup_type, revival);
`;

export const CAMPAIGN_SAFETY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contact_permission_events (
  event_id TEXT PRIMARY KEY,
  contact_key TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('GRANTED','REVOKED')),
  source_type TEXT NOT NULL,
  source_reference TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  expires_at TEXT,
  recorded_by TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_permission_contact_category
  ON contact_permission_events(contact_key, category, occurred_at DESC, recorded_at DESC);

CREATE TABLE IF NOT EXISTS sender_safety_state (
  instance_name TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (state IN ('HEALTHY','WARNING','PAUSED')),
  reason_code TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  paused_at TEXT,
  resumed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_safety_checks (
  check_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  contact_key TEXT NOT NULL DEFAULT '',
  instance_name TEXT NOT NULL DEFAULT '',
  check_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW','WARN','BLOCK')),
  code TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_safety_scope
  ON campaign_safety_checks(scope_id, check_type, outcome);
CREATE INDEX IF NOT EXISTS idx_campaign_safety_contact
  ON campaign_safety_checks(contact_key, checked_at DESC);
`;

export const RUNTIME_ADDITIVE_SCHEMA_SQL = `
${INSTANCE_IDENTITY_SCHEMA_SQL}
${LID_MAP_SCHEMA_SQL}
${GOLDEN_CONVERSATION_SCHEMA_SQL}
${GOLDEN_FOLLOWUP_SCHEMA_SQL}
${CAMPAIGN_SAFETY_SCHEMA_SQL}
`;

export const RUNTIME_REQUIRED_COLUMNS = Object.freeze({
  instance_identity: Object.freeze(["instance_name", "whatsapp_number", "source", "first_seen_at", "last_seen_at"]),
  lid_map: Object.freeze(["lid", "phone", "source", "confidence", "evidence", "created_at", "updated_at"]),
  golden_conversations: Object.freeze(["lead_code", "project_code", "outcome", "source_hash", "last_customer_reply_at"]),
  followup_log: Object.freeze(["lead_code", "seq", "sent_at", "followup_type", "revival"]),
  contact_permission_events: Object.freeze([
    "event_id", "contact_key", "category", "action", "source_type", "occurred_at", "recorded_at",
  ]),
  sender_safety_state: Object.freeze(["instance_name", "state", "reason_code", "metrics_json", "updated_at"]),
  campaign_safety_checks: Object.freeze([
    "check_id", "scope_id", "contact_key", "instance_name", "check_type", "outcome", "code", "checked_at",
  ]),
});
