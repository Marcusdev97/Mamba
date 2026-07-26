-- =============================================================================
-- Mamba schema for PostgreSQL
-- 由 tools/pg/build-postgres.mjs 从 docs/mamba-schema.sql (v3) + docs/mamba-schema-v4.sql (v4)
-- 生成于 2026-07-26T13:52:45.917Z。不要手改这个文件,改上面两个源文件再重新生成。
--
-- 用法:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/mamba-schema.postgres.sql
--
-- 说明:
--   · 时间列保持 TEXT(应用写的是 ISO-8601 字符串),不改成 timestamptz。
--   · 0/1 标志位保持 INTEGER + CHECK,和 SQLite 行为一致。
--   · 外键统一放在文件末尾的 ALTER TABLE,避免建表顺序问题。
-- =============================================================================

BEGIN;
SET client_min_messages = warning;   -- 首次执行时 DROP CONSTRAINT IF EXISTS 的 NOTICE 太吵

-- A1. 项目/楼盘。真相源:code,不随 display name 改变。
CREATE TABLE IF NOT EXISTS projects (
  project_code           TEXT PRIMARY KEY,
  project_name           TEXT NOT NULL DEFAULT '',
  aliases_json           TEXT NOT NULL DEFAULT '[]',
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- A2. 设备/电脑。稳定 device_key,用于送锁与审计。改电脑名不改 key。
CREATE TABLE IF NOT EXISTS devices (
  device_key             TEXT PRIMARY KEY,
  device_name            TEXT NOT NULL DEFAULT '',
  owner                  TEXT NOT NULL DEFAULT '',
  hostname               TEXT NOT NULL DEFAULT '',
  last_online_at         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- A3. WhatsApp 连接。两台电脑都可能有 wa_01,所以 instance_name 不是唯一键。 connection_key = device_key::whatsapp_number,与现有 Device Ownership 一致。
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  connection_key         TEXT PRIMARY KEY,
  instance_name          TEXT NOT NULL DEFAULT '',
  whatsapp_number        TEXT NOT NULL DEFAULT '',
  owner                  TEXT NOT NULL DEFAULT '',
  team                   TEXT NOT NULL DEFAULT '',
  device_key             TEXT,
  status                 TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('OPEN','CLOSED','BLOCKED','UNKNOWN')),
  last_health_check      TEXT,
  last_seen_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (device_key, whatsapp_number)
);

-- B1. 联系人 = 全局的人(按电话去重)。STOP / 退订是"人"级别,记在这里。
CREATE TABLE IF NOT EXISTS contacts (
  contact_key            TEXT PRIMARY KEY,
  phone                  TEXT NOT NULL UNIQUE,
  display_name           TEXT NOT NULL DEFAULT '',
  stop_flag              INTEGER NOT NULL DEFAULT 0 CHECK (stop_flag IN (0,1)),
  stop_reason            TEXT NOT NULL DEFAULT '',
  stop_at                TEXT,
  reply_count            INTEGER NOT NULL DEFAULT 0,
  last_reply_text        TEXT NOT NULL DEFAULT '',
  last_reply_at          TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- B2. 项目线索 = "一个人 × 一个项目"的一行,承载 flow 序列状态。 业务唯一键 project_lead_key = project_code:phone(同一人可同时在多个盘)。
CREATE TABLE IF NOT EXISTS project_leads (
  project_lead_key       TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  contact_key            TEXT NOT NULL,
  project_code           TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  sequence_status        TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT '',
  last_flow_sent         TEXT NOT NULL DEFAULT '',
  next_flow              TEXT NOT NULL DEFAULT '',
  cohort_day             INTEGER,
  follow_up_due          TEXT,
  first_blast_at         TEXT,
  last_blast_at          TEXT,
  assigned_sender_key    TEXT,
  last_sender_key        TEXT,
  last_sender_phone      TEXT NOT NULL DEFAULT '',
  last_sent_by_device    TEXT,
  campaign_run_id        TEXT,
  send_lock              INTEGER NOT NULL DEFAULT 0 CHECK (send_lock IN (0,1)),
  locked_by_device       TEXT,
  lock_until             TEXT,
  ai_category            TEXT NOT NULL DEFAULT '',
  ai_summary             TEXT NOT NULL DEFAULT '',
  priority               TEXT NOT NULL DEFAULT '' CHECK (priority IN ('','HIGH','MED','LOW')),
  follow_up_at           TEXT,
  assigned_sales         TEXT NOT NULL DEFAULT '',
  sales_notes            TEXT NOT NULL DEFAULT '',
  appointment_date       TEXT,
  appointment_time       TEXT NOT NULL DEFAULT '',
  appointment_place      TEXT NOT NULL DEFAULT '',
  appointment_status     TEXT NOT NULL DEFAULT '' CHECK (appointment_status IN ('','Pending','Confirmed','Done','No Show')),
  payload_json           TEXT NOT NULL DEFAULT '{}',
  source_updated_at      TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  assigned_account_key   TEXT,
  UNIQUE (project_code, phone)
);

-- B3. 广告来源线索(click-to-WhatsApp)。ad_lead_key = ads:phone 或 source:phone。
CREATE TABLE IF NOT EXISTS ads_leads (
  ad_lead_key            TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  contact_key            TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  source_code            TEXT NOT NULL DEFAULT 'ads',
  lead_received_at       TEXT,
  last_touch_at          TEXT,
  payload_json           TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- B4. 回收/旧名单线索。recycle_lead_key = recycle:phone。
CREATE TABLE IF NOT EXISTS recycle_leads (
  recycle_lead_key       TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  contact_key            TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  source_batch           TEXT NOT NULL DEFAULT '',
  payload_json           TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- B5. Flow 1 客户群。Excel/CSV 只是其中一种导入来源；名单导入后长期保留在本机， 操作者可直接选择、改名和再次预览，不需要每次重新上传文件。 客户群严格绑定 device_key + sender_phone，避免两台电脑都叫 wa_01 时混用名单。
CREATE TABLE IF NOT EXISTS lead_groups (
  group_id               TEXT PRIMARY KEY,
  project_code           TEXT NOT NULL,
  group_name             TEXT NOT NULL,
  source_type            TEXT NOT NULL DEFAULT 'file' CHECK (source_type IN ('file','manual','database')),
  source_name            TEXT NOT NULL DEFAULT '',
  device_key             TEXT NOT NULL,
  sender_phone           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_group_members (
  group_id               TEXT NOT NULL,
  member_id              TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  language               TEXT NOT NULL DEFAULT '',
  source_row             INTEGER,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id),
  UNIQUE (group_id, phone)
);

CREATE TABLE IF NOT EXISTS conversations (
  id                     TEXT PRIMARY KEY,
  contact_key            TEXT NOT NULL,
  connection_key         TEXT,
  customer_phone         TEXT NOT NULL,
  last_message_at        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (contact_key, connection_key)
);

CREATE TABLE IF NOT EXISTS messages (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text                   TEXT NOT NULL DEFAULT '',
  message_type           TEXT NOT NULL DEFAULT 'text',
  source                 TEXT NOT NULL DEFAULT 'evolution',
  flow_topic             TEXT NOT NULL DEFAULT '',
  template_key           TEXT,
  sent_at                TEXT,
  payload_json           TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL
);

-- template_key = project_code:f<flow>:p<part>:<lang>:v<version>  (e.g. gen_starz:f01:p1:en:v2) 同一 project/flow/part/lang 有多条 Active = 变体轮换(防 spam)。
CREATE TABLE IF NOT EXISTS templates (
  template_key           TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  template_name          TEXT NOT NULL DEFAULT '',
  project_code           TEXT NOT NULL,
  flow_topic             TEXT NOT NULL DEFAULT '',
  flow_no                INTEGER,
  part_no                INTEGER NOT NULL DEFAULT 1,
  language               TEXT NOT NULL DEFAULT 'en',
  version                TEXT NOT NULL DEFAULT 'v1',
  status                 TEXT NOT NULL DEFAULT 'Testing' CHECK (status IN ('Active','Testing','Retired')),
  message_text           TEXT NOT NULL DEFAULT '',
  image_name             TEXT,
  sent_count             INTEGER NOT NULL DEFAULT 0,
  response_count         INTEGER NOT NULL DEFAULT 0,
  warm_count             INTEGER NOT NULL DEFAULT 0,
  stop_count             INTEGER NOT NULL DEFAULT 0,
  viewing_count          INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- asset_key = image_name(稳定命名,如 gs_f03_location_en_v1)。
CREATE TABLE IF NOT EXISTS images (
  asset_key              TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  project_code           TEXT,
  flow_topic             TEXT NOT NULL DEFAULT '',
  language               TEXT NOT NULL DEFAULT 'en',
  local_file             TEXT NOT NULL DEFAULT '',
  cloud_url              TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 一次群发/cohort 一行。run_id 唯一键(比 Name 安全,便于重传/回链)。
CREATE TABLE IF NOT EXISTS campaign_runs (
  run_id                 TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  name                   TEXT NOT NULL DEFAULT '',
  project_code           TEXT NOT NULL,
  flow_topic             TEXT NOT NULL DEFAULT '',
  flow_no                INTEGER,
  sender_set             TEXT NOT NULL DEFAULT '',
  mode                   TEXT NOT NULL DEFAULT 'TEST' CHECK (mode IN ('TEST','LIVE')),
  status                 TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','STOPPED')),
  requested_count        INTEGER NOT NULL DEFAULT 0,
  sent_count             INTEGER NOT NULL DEFAULT 0,
  failed_count           INTEGER NOT NULL DEFAULT 0,
  device_key             TEXT,
  started_at             TEXT NOT NULL,
  finished_at            TEXT,
  payload_json           TEXT NOT NULL DEFAULT '{}'
);

-- 单条发送任务(排程/多段/重试的最小单元)。
CREATE TABLE IF NOT EXISTS send_jobs (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,
  project_lead_key       TEXT NOT NULL,
  connection_key         TEXT,
  flow_topic             TEXT NOT NULL DEFAULT '',
  part_no                INTEGER NOT NULL DEFAULT 1,
  template_key           TEXT,
  status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','SKIPPED','FAILED','CANCELLED')),
  scheduled_at           TEXT,
  sent_at                TEXT,
  error_code             TEXT NOT NULL DEFAULT '',
  error_message          TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- fact_key = project_code:category_slug:fact_slug。AI 只能引用 verified=1。
CREATE TABLE IF NOT EXISTS project_knowledge (
  fact_key               TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  project_code           TEXT NOT NULL,
  category               TEXT NOT NULL DEFAULT '',
  fact                   TEXT NOT NULL DEFAULT '',
  verified               INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  source                 TEXT NOT NULL DEFAULT '',
  valid_until            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- Golden Conversation Ledger。这里保存的是「如何判断和推进约看」，不是楼盘事实。 一行 = 一个匿名 lead 的完整对话；PII 必须在写入前清洗。
CREATE TABLE IF NOT EXISTS golden_conversations (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_code              TEXT NOT NULL UNIQUE,
  project_code           TEXT NOT NULL,
  origin_project_code    TEXT,
  source_channel         TEXT,
  blast_version          TEXT,
  language               TEXT,
  customer_role          TEXT,
  primary_purpose        TEXT,
  first_reply_type       TEXT,
  outcome                TEXT NOT NULL CHECK (outcome IN ('Viewing Booked','Active','Dormant','Dead')),
  outcome_updated_at     TEXT NOT NULL,
  death_turn             INTEGER,
  death_message_type     TEXT CHECK (death_message_type IS NULL OR death_message_type IN ( 'ab_slot_template','price_probe','budget_probe','bulk_info_dump', 'reassurance_push','festival_greeting','open_question','other' )),
  death_note             TEXT,
  trigger_message        TEXT,
  customer_next_move     TEXT,
  friction_removers      TEXT NOT NULL DEFAULT '[]',
  reconfirmed            INTEGER NOT NULL DEFAULT 0 CHECK (reconfirmed IN (0,1)),
  decision_trace         TEXT NOT NULL DEFAULT '[]',
  conversation_text      TEXT NOT NULL,
  do_not_copy            TEXT NOT NULL DEFAULT '[]',
  pk_conflicts           TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL,
  source_hash            TEXT NOT NULL UNIQUE,
  last_customer_reply_at TEXT
);

-- objection_key = scenario_slug:customer_says_slug
CREATE TABLE IF NOT EXISTS objection_bank (
  objection_key          TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  scenario               TEXT NOT NULL DEFAULT '',
  customer_says          TEXT NOT NULL DEFAULT '',
  handling               TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- reply_log_key = message_id || phone:timestamp。存 robot 草稿 + 人工最终版。
CREATE TABLE IF NOT EXISTS ai_reply_log (
  reply_log_key          TEXT PRIMARY KEY,
  contact_key            TEXT NOT NULL,
  project_code           TEXT,
  route                  TEXT NOT NULL DEFAULT '',
  message_id             TEXT,
  robot_draft            TEXT NOT NULL DEFAULT '',
  final_reply            TEXT NOT NULL DEFAULT '',
  decision               TEXT NOT NULL DEFAULT '' CHECK (decision IN ('','AUTO_SENT','HUMAN_SENT','SKIPPED')),
  created_at             TEXT NOT NULL
);

-- 后台 Sync Worker 的任务队列(方向按数据类型定,见 ADR 第四节)。
CREATE TABLE IF NOT EXISTS sync_jobs (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  idempotency_key        TEXT NOT NULL UNIQUE,
  direction              TEXT NOT NULL CHECK (direction IN ('NOTION_TO_LOCAL','LOCAL_TO_NOTION')),
  entity_type            TEXT NOT NULL,
  entity_id              TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED')),
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  available_at           TEXT NOT NULL,
  last_error_code        TEXT NOT NULL DEFAULT '',
  last_error_message     TEXT NOT NULL DEFAULT '',
  payload_json           TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 每次批处理操作(发送/归属修复等)的审计头。
CREATE TABLE IF NOT EXISTS operations (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL,
  device_key             TEXT NOT NULL,
  connection_key         TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL CHECK (status IN ('PREVIEW','RUNNING','PARTIAL','COMPLETED','FAILED','ROLLED_BACK')),
  requested_count        INTEGER NOT NULL DEFAULT 0,
  succeeded_count        INTEGER NOT NULL DEFAULT 0,
  failed_count           INTEGER NOT NULL DEFAULT 0,
  payload_json           TEXT NOT NULL DEFAULT '{}',
  started_at             TEXT NOT NULL,
  finished_at            TEXT
);

-- 归属/字段变更明细(before/after + 重试),支持按 operation_id 精确回滚。
CREATE TABLE IF NOT EXISTS ownership_changes (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  operation_id           TEXT NOT NULL,
  project_lead_key       TEXT,
  notion_page_id         TEXT NOT NULL,
  before_json            TEXT NOT NULL,
  after_json             TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED','FAILED','ROLLED_BACK','SKIPPED_CHANGED')),
  error_code             TEXT NOT NULL DEFAULT '',
  error_message          TEXT NOT NULL DEFAULT '',
  retry_count            INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL,
  UNIQUE (operation_id, notion_page_id)
);

-- 导入批次(Excel / Notion dry-run / apply)。
CREATE TABLE IF NOT EXISTS import_runs (
  id                     TEXT PRIMARY KEY,
  source                 TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode IN ('DRY_RUN','APPLY')),
  status                 TEXT NOT NULL CHECK (status IN ('RUNNING','PARTIAL','COMPLETED','FAILED')),
  scanned_count          INTEGER NOT NULL DEFAULT 0,
  imported_count         INTEGER NOT NULL DEFAULT 0,
  skipped_count          INTEGER NOT NULL DEFAULT 0,
  failed_count           INTEGER NOT NULL DEFAULT 0,
  report_json            TEXT NOT NULL DEFAULT '{}',
  started_at             TEXT NOT NULL,
  finished_at            TEXT
);

-- append-only 系统日志(带结构化错误码)。
CREATE TABLE IF NOT EXISTS system_logs (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at                     TEXT NOT NULL,
  level                  TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  area                   TEXT NOT NULL DEFAULT '',
  event                  TEXT NOT NULL DEFAULT '',
  code                   TEXT NOT NULL DEFAULT '',
  message                TEXT NOT NULL DEFAULT '',
  payload_json           TEXT NOT NULL DEFAULT '{}'
);

-- Sync Worker 单例状态。
CREATE TABLE IF NOT EXISTS sync_worker_state (
  id                     TEXT PRIMARY KEY CHECK (id = 'singleton'),
  enabled                INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  mode                   TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','ACTIVE')),
  status                 TEXT NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE','RUNNING','PAUSED','ERROR')),
  last_started_at        TEXT,
  last_finished_at       TEXT,
  last_error_code        TEXT NOT NULL DEFAULT '',
  last_error_message     TEXT NOT NULL DEFAULT '',
  updated_at             TEXT NOT NULL
);

-- 键值元数据 + 迁移记录。
CREATE TABLE IF NOT EXISTS metadata (
  key                    TEXT PRIMARY KEY,
  value                  TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version                INTEGER PRIMARY KEY,
  name                   TEXT NOT NULL,
  applied_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  account_key            TEXT PRIMARY KEY,
  label                  TEXT NOT NULL DEFAULT '',
  warmth                 TEXT NOT NULL DEFAULT 'NEW' CHECK (warmth IN ('NEW','WARMING','ESTABLISHED')),
  warmup_started_at      TEXT,
  allowed_max_mode       TEXT NOT NULL DEFAULT 'conservative' CHECK (allowed_max_mode IN ('conservative','standard')),
  daily_cap_contacts     INTEGER NOT NULL DEFAULT 0 CHECK (daily_cap_contacts >= 0),
  daily_cap_messages     INTEGER NOT NULL DEFAULT 0 CHECK (daily_cap_messages >= 0),
  health                 TEXT NOT NULL DEFAULT 'OK' CHECK (health IN ('OK','THROTTLED','PAUSED')),
  account_risk_note      TEXT NOT NULL DEFAULT '',
  current_generation     INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1),
  active_binding_key     TEXT,
  lifetime_sent_messages INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_sent_messages >= 0),
  lifetime_failed        INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_failed >= 0),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_bindings (
  binding_key            TEXT PRIMARY KEY,
  account_key            TEXT NOT NULL,
  device_key             TEXT NOT NULL,
  instance_name          TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL CHECK (status IN ('PENDING_CLAIM','ACTIVE','TRANSFERRING','RELEASED','REVOKED')),
  generation             INTEGER NOT NULL CHECK (generation >= 1),
  bound_at               TEXT,
  released_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- Mutable current state. The PRIMARY KEY is the atomic send gate.
CREATE TABLE IF NOT EXISTS send_claims (
  idem_key               TEXT PRIMARY KEY,
  campaign_run_id        TEXT NOT NULL,
  project_lead_key       TEXT NOT NULL,
  flow_topic             TEXT NOT NULL DEFAULT '',
  part_no                INTEGER NOT NULL CHECK (part_no >= 1),
  account_key            TEXT NOT NULL,
  contact_key            TEXT NOT NULL,
  recipient_phone        TEXT NOT NULL,
  device_key             TEXT NOT NULL,
  binding_key            TEXT NOT NULL,
  binding_generation     INTEGER NOT NULL CHECK (binding_generation >= 1),
  state                  TEXT NOT NULL CHECK (state IN ( 'CLAIMED','SENT','FAILED_RETRYABLE','FAILED_FINAL', 'UNKNOWN','LEGACY_UNVERIFIED','SKIPPED' )),
  claim_token            TEXT NOT NULL,
  provider_msg_id        TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
  claimed_at             TEXT NOT NULL,
  sent_at                TEXT,
  updated_at             TEXT NOT NULL,
  last_error_code        TEXT NOT NULL DEFAULT '',
  last_error_message     TEXT NOT NULL DEFAULT ''
);

-- Append-only audit log. Application code may INSERT only.
CREATE TABLE IF NOT EXISTS send_events (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  idem_key               TEXT NOT NULL,
  account_key            TEXT NOT NULL,
  contact_key            TEXT NOT NULL,
  recipient_phone        TEXT NOT NULL,
  device_key             TEXT NOT NULL,
  binding_generation     INTEGER NOT NULL,
  event_type             TEXT NOT NULL CHECK (event_type IN ( 'CLAIMED','SENT','FAILED_RETRYABLE','FAILED_FINAL', 'TIMEOUT','UNKNOWN','SKIPPED','LEGACY_UNVERIFIED','MANUAL_REVIEW' )),
  provider_msg_id        TEXT,
  at_utc                 TEXT NOT NULL,
  myt_date               TEXT NOT NULL,
  error_code             TEXT NOT NULL DEFAULT '',
  detail                 TEXT NOT NULL DEFAULT ''
);

-- Crash-recoverable cooperative transfer state machine.
CREATE TABLE IF NOT EXISTS handoff_transfers (
  transfer_id            TEXT PRIMARY KEY,
  bundle_id              TEXT UNIQUE,
  account_key            TEXT NOT NULL,
  source_binding_key     TEXT NOT NULL,
  source_generation      INTEGER NOT NULL,
  target_device_key      TEXT,
  target_binding_key     TEXT,
  target_generation      INTEGER,
  state                  TEXT NOT NULL CHECK (state IN ('PREPARING','EXPORTED','IMPORTED','COMPLETED','ABORTED')),
  snapshot_hash          TEXT NOT NULL DEFAULT '',
  bundle_expires_at      TEXT,
  error_code             TEXT NOT NULL DEFAULT '',
  error_message          TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  completed_at           TEXT
);

CREATE TABLE IF NOT EXISTS handoff_log (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  transfer_id            TEXT NOT NULL,
  account_key            TEXT NOT NULL,
  event_type             TEXT NOT NULL,
  from_binding_key       TEXT,
  to_binding_key         TEXT,
  from_generation        INTEGER,
  to_generation          INTEGER,
  bundle_checksum        TEXT NOT NULL DEFAULT '',
  reason                 TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL
);

-- 真实库里存在、文档 schema 未收录的表
CREATE TABLE IF NOT EXISTS golden_conversations_legacy_v3 (
  golden_key             TEXT PRIMARY KEY,
  notion_page_id         TEXT UNIQUE,
  project_code           TEXT NOT NULL,
  scenario               TEXT NOT NULL DEFAULT '',
  conversation_text      TEXT NOT NULL DEFAULT '',
  conversation_hash      TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 真实库里存在、文档 schema 未收录的表
CREATE TABLE IF NOT EXISTS followup_log (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_code              TEXT NOT NULL,
  seq                    INTEGER NOT NULL,
  sent_at                TEXT NOT NULL,
  silence_gap_days       INTEGER NOT NULL,
  followup_type          TEXT NOT NULL CHECK (followup_type IN ('ab_slot_template','festival_greeting','new_info','price_update','personalized_question')),
  content_summary        TEXT,
  revival                INTEGER NOT NULL CHECK (revival IN (0,1)),
  revival_gap_hours      INTEGER,
  UNIQUE(lead_code, seq)
);

-- 真实库里存在、文档 schema 未收录的表
CREATE TABLE IF NOT EXISTS lid_map (
  lid                    TEXT PRIMARY KEY,
  phone                  TEXT NOT NULL,
  source                 TEXT NOT NULL,
  confidence             INTEGER NOT NULL DEFAULT 0,
  evidence               TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 真实库里存在、文档 schema 未收录的表
CREATE TABLE IF NOT EXISTS instance_identity (
  instance_name          TEXT PRIMARY KEY,
  whatsapp_number        TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'evolution',
  first_seen_at          TEXT NOT NULL,
  last_seen_at           TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_device_instance
  ON whatsapp_connections (device_key, instance_name)
  WHERE device_key IS NOT NULL AND instance_name <> '';
CREATE INDEX IF NOT EXISTS idx_contacts_stop
  ON contacts (stop_flag);
CREATE INDEX IF NOT EXISTS idx_leads_contact
  ON project_leads (contact_key);
CREATE INDEX IF NOT EXISTS idx_leads_project
  ON project_leads (project_code);
CREATE INDEX IF NOT EXISTS idx_leads_due
  ON project_leads (sequence_status, follow_up_due);
CREATE INDEX IF NOT EXISTS idx_leads_run
  ON project_leads (campaign_run_id);
CREATE INDEX IF NOT EXISTS idx_leads_lock
  ON project_leads (send_lock, lock_until);
CREATE INDEX IF NOT EXISTS idx_leads_account
  ON project_leads (assigned_account_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_groups_scope_name
  ON lead_groups (device_key, sender_phone, project_code, lower(group_name)
  ) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_lead_groups_scope
  ON lead_groups (device_key, sender_phone, project_code, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_lead_group_members_phone
  ON lead_group_members (phone);
CREATE INDEX IF NOT EXISTS idx_messages_conv_time
  ON messages (conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_templates_match
  ON templates (project_code, flow_topic, part_no, language, status);
CREATE INDEX IF NOT EXISTS idx_runs_project
  ON campaign_runs (project_code, started_at);
CREATE INDEX IF NOT EXISTS idx_sendjobs_queue
  ON send_jobs (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sendjobs_run
  ON send_jobs (run_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_project
  ON project_knowledge (project_code, verified);
CREATE INDEX IF NOT EXISTS idx_replylog_contact
  ON ai_reply_log (contact_key, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
  ON sync_jobs (status, available_at);
CREATE INDEX IF NOT EXISTS idx_ownership_retry
  ON ownership_changes (operation_id, status, retry_count);
CREATE INDEX IF NOT EXISTS idx_syslogs_time
  ON system_logs (at, level);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_bindings_one_active_account
  ON device_bindings (account_key)
  WHERE status IN ('ACTIVE','TRANSFERRING');
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_bindings_account_generation
  ON device_bindings (account_key, generation);
CREATE INDEX IF NOT EXISTS idx_device_bindings_device
  ON device_bindings (device_key, status);
CREATE INDEX IF NOT EXISTS idx_send_claims_account_state
  ON send_claims (account_key, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_send_claims_run
  ON send_claims (campaign_run_id, project_lead_key, part_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_events_one_sent_per_idem
  ON send_events (idem_key)
  WHERE event_type = 'SENT';
CREATE INDEX IF NOT EXISTS idx_send_events_daily_cap
  ON send_events (account_key, myt_date, event_type, contact_key);
CREATE INDEX IF NOT EXISTS idx_send_events_idem_time
  ON send_events (idem_key, at_utc);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_one_open_per_account
  ON handoff_transfers (account_key)
  WHERE state IN ('PREPARING','EXPORTED','IMPORTED');
CREATE INDEX IF NOT EXISTS idx_handoff_log_account_time
  ON handoff_log (account_key, created_at);

-- ---------------------------------------------------------------------------
-- 外键(放最后,避免 project_leads → campaign_runs 这类前向引用)
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS fk_whatsapp_connections_device_key;
ALTER TABLE whatsapp_connections ADD CONSTRAINT fk_whatsapp_connections_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE SET NULL;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_contact_key;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_project_code;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_assigned_sender_key;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_assigned_sender_key
  FOREIGN KEY (assigned_sender_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_last_sender_key;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_last_sender_key
  FOREIGN KEY (last_sender_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_last_sent_by_device;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_last_sent_by_device
  FOREIGN KEY (last_sent_by_device) REFERENCES devices(device_key) ON DELETE SET NULL;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_campaign_run_id;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_campaign_run_id
  FOREIGN KEY (campaign_run_id) REFERENCES campaign_runs(run_id) ON DELETE SET NULL;
ALTER TABLE project_leads DROP CONSTRAINT IF EXISTS fk_project_leads_assigned_account_key;
ALTER TABLE project_leads ADD CONSTRAINT fk_project_leads_assigned_account_key
  FOREIGN KEY (assigned_account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE SET NULL;
ALTER TABLE ads_leads DROP CONSTRAINT IF EXISTS fk_ads_leads_contact_key;
ALTER TABLE ads_leads ADD CONSTRAINT fk_ads_leads_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT;
ALTER TABLE recycle_leads DROP CONSTRAINT IF EXISTS fk_recycle_leads_contact_key;
ALTER TABLE recycle_leads ADD CONSTRAINT fk_recycle_leads_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT;
ALTER TABLE lead_groups DROP CONSTRAINT IF EXISTS fk_lead_groups_project_code;
ALTER TABLE lead_groups ADD CONSTRAINT fk_lead_groups_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE lead_groups DROP CONSTRAINT IF EXISTS fk_lead_groups_device_key;
ALTER TABLE lead_groups ADD CONSTRAINT fk_lead_groups_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT;
ALTER TABLE lead_group_members DROP CONSTRAINT IF EXISTS fk_lead_group_members_group_id;
ALTER TABLE lead_group_members ADD CONSTRAINT fk_lead_group_members_group_id
  FOREIGN KEY (group_id) REFERENCES lead_groups(group_id) ON DELETE CASCADE;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS fk_conversations_contact_key;
ALTER TABLE conversations ADD CONSTRAINT fk_conversations_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS fk_conversations_connection_key;
ALTER TABLE conversations ADD CONSTRAINT fk_conversations_connection_key
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_messages_conversation_id;
ALTER TABLE messages ADD CONSTRAINT fk_messages_conversation_id
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_messages_template_key;
ALTER TABLE messages ADD CONSTRAINT fk_messages_template_key
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS fk_templates_project_code;
ALTER TABLE templates ADD CONSTRAINT fk_templates_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS fk_templates_image_name;
ALTER TABLE templates ADD CONSTRAINT fk_templates_image_name
  FOREIGN KEY (image_name) REFERENCES images(asset_key) ON DELETE SET NULL;
ALTER TABLE images DROP CONSTRAINT IF EXISTS fk_images_project_code;
ALTER TABLE images ADD CONSTRAINT fk_images_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE SET NULL;
ALTER TABLE campaign_runs DROP CONSTRAINT IF EXISTS fk_campaign_runs_project_code;
ALTER TABLE campaign_runs ADD CONSTRAINT fk_campaign_runs_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE campaign_runs DROP CONSTRAINT IF EXISTS fk_campaign_runs_device_key;
ALTER TABLE campaign_runs ADD CONSTRAINT fk_campaign_runs_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE SET NULL;
ALTER TABLE send_jobs DROP CONSTRAINT IF EXISTS fk_send_jobs_run_id;
ALTER TABLE send_jobs ADD CONSTRAINT fk_send_jobs_run_id
  FOREIGN KEY (run_id) REFERENCES campaign_runs(run_id) ON DELETE CASCADE;
ALTER TABLE send_jobs DROP CONSTRAINT IF EXISTS fk_send_jobs_project_lead_key;
ALTER TABLE send_jobs ADD CONSTRAINT fk_send_jobs_project_lead_key
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE CASCADE;
ALTER TABLE send_jobs DROP CONSTRAINT IF EXISTS fk_send_jobs_connection_key;
ALTER TABLE send_jobs ADD CONSTRAINT fk_send_jobs_connection_key
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL;
ALTER TABLE send_jobs DROP CONSTRAINT IF EXISTS fk_send_jobs_template_key;
ALTER TABLE send_jobs ADD CONSTRAINT fk_send_jobs_template_key
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL;
ALTER TABLE project_knowledge DROP CONSTRAINT IF EXISTS fk_project_knowledge_project_code;
ALTER TABLE project_knowledge ADD CONSTRAINT fk_project_knowledge_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE ai_reply_log DROP CONSTRAINT IF EXISTS fk_ai_reply_log_contact_key;
ALTER TABLE ai_reply_log ADD CONSTRAINT fk_ai_reply_log_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE;
ALTER TABLE ai_reply_log DROP CONSTRAINT IF EXISTS fk_ai_reply_log_project_code;
ALTER TABLE ai_reply_log ADD CONSTRAINT fk_ai_reply_log_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE SET NULL;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS fk_operations_device_key;
ALTER TABLE operations ADD CONSTRAINT fk_operations_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT;
ALTER TABLE ownership_changes DROP CONSTRAINT IF EXISTS fk_ownership_changes_operation_id;
ALTER TABLE ownership_changes ADD CONSTRAINT fk_ownership_changes_operation_id
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE;
ALTER TABLE ownership_changes DROP CONSTRAINT IF EXISTS fk_ownership_changes_project_lead_key;
ALTER TABLE ownership_changes ADD CONSTRAINT fk_ownership_changes_project_lead_key
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL;
ALTER TABLE device_bindings DROP CONSTRAINT IF EXISTS fk_device_bindings_account_key;
ALTER TABLE device_bindings ADD CONSTRAINT fk_device_bindings_account_key
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT;
ALTER TABLE device_bindings DROP CONSTRAINT IF EXISTS fk_device_bindings_device_key;
ALTER TABLE device_bindings ADD CONSTRAINT fk_device_bindings_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT;
ALTER TABLE send_claims DROP CONSTRAINT IF EXISTS fk_send_claims_account_key;
ALTER TABLE send_claims ADD CONSTRAINT fk_send_claims_account_key
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT;
ALTER TABLE send_claims DROP CONSTRAINT IF EXISTS fk_send_claims_contact_key;
ALTER TABLE send_claims ADD CONSTRAINT fk_send_claims_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT;
ALTER TABLE send_claims DROP CONSTRAINT IF EXISTS fk_send_claims_device_key;
ALTER TABLE send_claims ADD CONSTRAINT fk_send_claims_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT;
ALTER TABLE send_claims DROP CONSTRAINT IF EXISTS fk_send_claims_binding_key;
ALTER TABLE send_claims ADD CONSTRAINT fk_send_claims_binding_key
  FOREIGN KEY (binding_key) REFERENCES device_bindings(binding_key) ON DELETE RESTRICT;
ALTER TABLE send_events DROP CONSTRAINT IF EXISTS fk_send_events_account_key;
ALTER TABLE send_events ADD CONSTRAINT fk_send_events_account_key
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT;
ALTER TABLE send_events DROP CONSTRAINT IF EXISTS fk_send_events_contact_key;
ALTER TABLE send_events ADD CONSTRAINT fk_send_events_contact_key
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT;
ALTER TABLE send_events DROP CONSTRAINT IF EXISTS fk_send_events_device_key;
ALTER TABLE send_events ADD CONSTRAINT fk_send_events_device_key
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT;
ALTER TABLE handoff_transfers DROP CONSTRAINT IF EXISTS fk_handoff_transfers_account_key;
ALTER TABLE handoff_transfers ADD CONSTRAINT fk_handoff_transfers_account_key
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT;
ALTER TABLE handoff_transfers DROP CONSTRAINT IF EXISTS fk_handoff_transfers_source_binding_key;
ALTER TABLE handoff_transfers ADD CONSTRAINT fk_handoff_transfers_source_binding_key
  FOREIGN KEY (source_binding_key) REFERENCES device_bindings(binding_key) ON DELETE RESTRICT;
ALTER TABLE handoff_log DROP CONSTRAINT IF EXISTS fk_handoff_log_transfer_id;
ALTER TABLE handoff_log ADD CONSTRAINT fk_handoff_log_transfer_id
  FOREIGN KEY (transfer_id) REFERENCES handoff_transfers(transfer_id) ON DELETE CASCADE;
ALTER TABLE handoff_log DROP CONSTRAINT IF EXISTS fk_handoff_log_account_key;
ALTER TABLE handoff_log ADD CONSTRAINT fk_handoff_log_account_key
  FOREIGN KEY (account_key) REFERENCES whatsapp_accounts(account_key) ON DELETE RESTRICT;
ALTER TABLE golden_conversations_legacy_v3 DROP CONSTRAINT IF EXISTS fk_golden_conversations_legacy_v3_project_code;
ALTER TABLE golden_conversations_legacy_v3 ADD CONSTRAINT fk_golden_conversations_legacy_v3_project_code
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT;
ALTER TABLE followup_log DROP CONSTRAINT IF EXISTS fk_followup_log_lead_code;
ALTER TABLE followup_log ADD CONSTRAINT fk_followup_log_lead_code
  FOREIGN KEY (lead_code) REFERENCES golden_conversations(lead_code);

-- ---------------------------------------------------------------------------
-- 注释(pgAdmin / Supabase 表视图里能直接看到)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE projects IS 'A1. 项目/楼盘。真相源:code,不随 display name 改变。';
COMMENT ON TABLE devices IS 'A2. 设备/电脑。稳定 device_key,用于送锁与审计。改电脑名不改 key。';
COMMENT ON TABLE whatsapp_connections IS 'A3. WhatsApp 连接。两台电脑都可能有 wa_01,所以 instance_name 不是唯一键。 connection_key = device_key::whatsapp_number,与现有 Device Ownership 一致。';
COMMENT ON TABLE contacts IS 'B1. 联系人 = 全局的人(按电话去重)。STOP / 退订是"人"级别,记在这里。';
COMMENT ON TABLE project_leads IS 'B2. 项目线索 = "一个人 × 一个项目"的一行,承载 flow 序列状态。 业务唯一键 project_lead_key = project_code:phone(同一人可同时在多个盘)。';
COMMENT ON COLUMN project_leads.assigned_account_key IS 'v4:该 lead 归哪个 WhatsApp 账号';
COMMENT ON TABLE ads_leads IS 'B3. 广告来源线索(click-to-WhatsApp)。ad_lead_key = ads:phone 或 source:phone。';
COMMENT ON TABLE recycle_leads IS 'B4. 回收/旧名单线索。recycle_lead_key = recycle:phone。';
COMMENT ON TABLE lead_groups IS 'B5. Flow 1 客户群。Excel/CSV 只是其中一种导入来源；名单导入后长期保留在本机， 操作者可直接选择、改名和再次预览，不需要每次重新上传文件。 客户群严格绑定 device_key + sender_phone，避免两台电脑都叫 wa_01 时混用名单。';
COMMENT ON TABLE templates IS 'template_key = project_code:f<flow>:p<part>:<lang>:v<version>  (e.g. gen_starz:f01:p1:en:v2) 同一 project/flow/part/lang 有多条 Active = 变体轮换(防 spam)。';
COMMENT ON TABLE images IS 'asset_key = image_name(稳定命名,如 gs_f03_location_en_v1)。';
COMMENT ON TABLE campaign_runs IS '一次群发/cohort 一行。run_id 唯一键(比 Name 安全,便于重传/回链)。';
COMMENT ON TABLE send_jobs IS '单条发送任务(排程/多段/重试的最小单元)。';
COMMENT ON TABLE project_knowledge IS 'fact_key = project_code:category_slug:fact_slug。AI 只能引用 verified=1。';
COMMENT ON TABLE golden_conversations IS 'Golden Conversation Ledger。这里保存的是「如何判断和推进约看」，不是楼盘事实。 一行 = 一个匿名 lead 的完整对话；PII 必须在写入前清洗。';
COMMENT ON TABLE objection_bank IS 'objection_key = scenario_slug:customer_says_slug';
COMMENT ON TABLE ai_reply_log IS 'reply_log_key = message_id || phone:timestamp。存 robot 草稿 + 人工最终版。';
COMMENT ON TABLE sync_jobs IS '后台 Sync Worker 的任务队列(方向按数据类型定,见 ADR 第四节)。';
COMMENT ON TABLE operations IS '每次批处理操作(发送/归属修复等)的审计头。';
COMMENT ON TABLE ownership_changes IS '归属/字段变更明细(before/after + 重试),支持按 operation_id 精确回滚。';
COMMENT ON TABLE import_runs IS '导入批次(Excel / Notion dry-run / apply)。';
COMMENT ON TABLE system_logs IS 'append-only 系统日志(带结构化错误码)。';
COMMENT ON TABLE sync_worker_state IS 'Sync Worker 单例状态。';
COMMENT ON TABLE metadata IS '键值元数据 + 迁移记录。';
COMMENT ON TABLE send_claims IS 'Mutable current state. The PRIMARY KEY is the atomic send gate.';
COMMENT ON TABLE send_events IS 'Append-only audit log. Application code may INSERT only.';
COMMENT ON TABLE handoff_transfers IS 'Crash-recoverable cooperative transfer state machine.';
COMMENT ON TABLE golden_conversations_legacy_v3 IS '真实库里存在、文档 schema 未收录的表';
COMMENT ON TABLE followup_log IS '真实库里存在、文档 schema 未收录的表';
COMMENT ON TABLE lid_map IS '真实库里存在、文档 schema 未收录的表';
COMMENT ON TABLE instance_identity IS '真实库里存在、文档 schema 未收录的表';

-- ---------------------------------------------------------------------------
-- 种子数据(幂等)
-- ---------------------------------------------------------------------------
INSERT INTO sync_worker_state (id, enabled, mode, status, updated_at)
VALUES ('singleton', 0, 'SHADOW', 'IDLE', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (3, 'systematic-business-schema', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  (4, 'account-device-binding-and-send-ledger', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;

INSERT INTO metadata (key, value, updated_at) VALUES
  ('schema_version', '4', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('storage_mode', 'shadow', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('account_binding_mode', 'shadow', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('send_claims_enforced', 'false', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('handoff_enabled', 'false', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

COMMIT;
