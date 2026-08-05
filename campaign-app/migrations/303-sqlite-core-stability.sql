-- Migration 303: SQLite core stability metadata, idempotency, and hot-path indexes.
-- The messages table is rebuilt so Evolution IDs are unique per connection,
-- not globally. The migration runner must create and checksum a backup first.

ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT '';
ALTER TABLE schema_migrations ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schema_migrations ADD COLUMN result TEXT NOT NULL DEFAULT 'APPLIED';

ALTER TABLE messages RENAME TO messages_pre_303;

CREATE TABLE messages (
  row_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  connection_key   TEXT,
  external_message_id TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text             TEXT NOT NULL DEFAULT '',
  message_type     TEXT NOT NULL DEFAULT 'text',
  source           TEXT NOT NULL DEFAULT 'evolution',
  flow_topic       TEXT NOT NULL DEFAULT '',
  template_key     TEXT,
  sent_at          TEXT,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL
);

INSERT INTO messages(
  id, conversation_id, connection_key, external_message_id, idempotency_key,
  direction, text, message_type, source, flow_topic, template_key, sent_at, payload_json, created_at
)
SELECT
  m.id, m.conversation_id, v.connection_key, m.id,
  'legacy:' || COALESCE(NULLIF(v.connection_key, ''), 'none') || ':' || m.id,
  m.direction, m.text, m.message_type, m.source, m.flow_topic, m.template_key,
  m.sent_at, m.payload_json, m.created_at
FROM messages_pre_303 m
JOIN conversations v ON v.id = m.conversation_id;

DROP TABLE messages_pre_303;

CREATE INDEX IF NOT EXISTS idx_messages_conv_time
  ON messages(conversation_id, sent_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
  ON messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_messages_external_id
  ON messages(external_message_id);
CREATE INDEX IF NOT EXISTS idx_campaign_runs_status_mode
  ON campaign_runs(status, mode, started_at);
CREATE INDEX IF NOT EXISTS idx_sendjobs_connection_status
  ON send_jobs(connection_key, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_project_leads_followup_queue
  ON project_leads(sequence_status, follow_up_due, project_code);
