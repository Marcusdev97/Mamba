-- =============================================================================
-- Mamba 本机数据库 Schema(SQLite)—— systematic full design
-- 版本: v3 (target)   生成: 2026-07-17
--
-- 设计原则(对应 docs/MAMBA_ARCHITECTURE_ADR.md):
--   1. SQLite 是本机"运行真相源",Notion 是异步镜像 + 人看的面板。
--   2. 双键策略(见 docs/MAMBA_DATABASE_KEYS.md「Most Important Decision」):
--        contact_key      = 归一化电话           → 回答"这是谁"(全局身份、STOP)
--        project_lead_key = project_code:phone   → 回答"这个人在哪个盘"(flow 状态)
--   3. 路由用稳定 key,不用会变的东西:
--        project_code(gen_starz)、device_key(cici_macbook_pro)
--        connection_key = device_key::真实号码(跨电脑唯一)
--        Evolution instance 名(wa_01)只作本机路由/display,不当唯一键。
--   4. Notion 里驱动业务的字段(next_flow / follow_up_due / stop_flag …)都提升为
--      一等列,不再塞进 payload_json;payload_json 只留"其它不常查的原始字段"。
--
-- 用法(对空库):  sqlite3 mamba.sqlite < docs/mamba-schema.sql
-- 全部 CREATE 都是 IF NOT EXISTS,可安全重复执行(幂等)。
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;      -- 读写不互相阻塞,面板刷新更顺
PRAGMA synchronous  = NORMAL;

-- =============================================================================
-- A. 身份与配置层
-- =============================================================================

-- A1. 项目/楼盘。真相源:code,不随 display name 改变。
CREATE TABLE IF NOT EXISTS projects (
  project_code   TEXT PRIMARY KEY,            -- gen_starz / binastra …
  project_name   TEXT NOT NULL DEFAULT '',    -- 人看的名字 Gen Starz
  aliases_json   TEXT NOT NULL DEFAULT '[]',  -- 导入/模板匹配用的别名 ["Gen Starz","GenStarz"]
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- A2. 设备/电脑。稳定 device_key,用于送锁与审计。改电脑名不改 key。
CREATE TABLE IF NOT EXISTS devices (
  device_key     TEXT PRIMARY KEY,            -- cici_macbook_pro
  device_name    TEXT NOT NULL DEFAULT '',    -- Cici's MacBook Pro
  owner          TEXT NOT NULL DEFAULT '',
  hostname       TEXT NOT NULL DEFAULT '',
  last_online_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- A3. WhatsApp 连接。两台电脑都可能有 wa_01,所以 instance_name 不是唯一键。
--     connection_key = device_key::whatsapp_number,与现有 Device Ownership 一致。
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  connection_key   TEXT PRIMARY KEY,          -- cici_macbook_pro::601133698121
  instance_name    TEXT NOT NULL DEFAULT '',  -- wa_01(本机 Evolution 名称,可重复)
  whatsapp_number  TEXT NOT NULL DEFAULT '',  -- 601133698121
  owner            TEXT NOT NULL DEFAULT '',
  team             TEXT NOT NULL DEFAULT '',
  device_key       TEXT,                      -- 当前挂在哪台电脑
  status           TEXT NOT NULL DEFAULT 'UNKNOWN'
                     CHECK (status IN ('OPEN','CLOSED','BLOCKED','UNKNOWN')),
  last_health_check TEXT,
  last_seen_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (device_key, whatsapp_number),
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_device_instance
  ON whatsapp_connections(device_key, instance_name)
  WHERE device_key IS NOT NULL AND instance_name <> '';

-- =============================================================================
-- B. 客户身份与线索(双键的核心)
-- =============================================================================

-- B1. 联系人 = 全局的人(按电话去重)。STOP / 退订是"人"级别,记在这里。
CREATE TABLE IF NOT EXISTS contacts (
  contact_key      TEXT PRIMARY KEY,          -- = phone(归一化数字)
  phone            TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL DEFAULT '',
  stop_flag        INTEGER NOT NULL DEFAULT 0 CHECK (stop_flag IN (0,1)),
  stop_reason      TEXT NOT NULL DEFAULT '',
  stop_at          TEXT,
  reply_count      INTEGER NOT NULL DEFAULT 0,-- 该号码累计回复(跨项目)
  last_reply_text  TEXT NOT NULL DEFAULT '',
  last_reply_at    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_stop ON contacts(stop_flag);

-- B2. 项目线索 = "一个人 × 一个项目"的一行,承载 flow 序列状态。
--     业务唯一键 project_lead_key = project_code:phone(同一人可同时在多个盘)。
CREATE TABLE IF NOT EXISTS project_leads (
  project_lead_key  TEXT PRIMARY KEY,         -- gen_starz:601133698121
  notion_page_id    TEXT UNIQUE,              -- Notion 镜像页 ID
  contact_key       TEXT NOT NULL,            -- → contacts
  project_code      TEXT NOT NULL,            -- → projects
  phone             TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',

  -- flow 序列状态(决定"谁该发下一轮"的三件套 + 队列)
  sequence_status   TEXT NOT NULL DEFAULT '',  -- ACTIVE / PAUSED / EXITED …
  status            TEXT NOT NULL DEFAULT '',  -- 业务状态(WARM / STOP / …)
  last_flow_sent    TEXT NOT NULL DEFAULT '',  -- Flow 1 - Project Template
  next_flow         TEXT NOT NULL DEFAULT '',  -- Flow 2 - Layout
  cohort_day        INTEGER,                   -- 进序列第几天
  follow_up_due     TEXT,                      -- 下一轮到期日(选人页按它筛)
  first_blast_at    TEXT,
  last_blast_at     TEXT,

  -- 发送归属与审计(多号码/多电脑可追溯)
  assigned_sender_key TEXT,                    -- 首选 device::phone → whatsapp_connections
  last_sender_key     TEXT,                    -- 实际用过的 device::phone
  last_sender_phone   TEXT NOT NULL DEFAULT '',
  last_sent_by_device TEXT,                    -- → devices
  campaign_run_id     TEXT,                    -- → campaign_runs

  -- 并发送锁(两台电脑不会同时发同一个人;崩溃后靠 lock_until 自动过期)
  send_lock         INTEGER NOT NULL DEFAULT 0 CHECK (send_lock IN (0,1)),
  locked_by_device  TEXT,
  lock_until        TEXT,

  -- 分类与跟进
  ai_category       TEXT NOT NULL DEFAULT '',  -- 分类器结果
  ai_summary        TEXT NOT NULL DEFAULT '',
  priority          TEXT NOT NULL DEFAULT '' CHECK (priority IN ('','HIGH','MED','LOW')),
  follow_up_at      TEXT,                      -- 人工跟进时间
  assigned_sales    TEXT NOT NULL DEFAULT '',
  sales_notes       TEXT NOT NULL DEFAULT '',

  -- 约看/预约
  appointment_date   TEXT,
  appointment_time   TEXT NOT NULL DEFAULT '',
  appointment_place  TEXT NOT NULL DEFAULT '',
  appointment_status TEXT NOT NULL DEFAULT ''
                       CHECK (appointment_status IN ('','Pending','Confirmed','Done','No Show')),

  payload_json      TEXT NOT NULL DEFAULT '{}',-- 其它不常查的原始 Notion 字段
  source_updated_at TEXT,                      -- Notion 端最后修改时间(同步对账用)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (project_code, phone),
  FOREIGN KEY (contact_key)         REFERENCES contacts(contact_key) ON DELETE RESTRICT,
  FOREIGN KEY (project_code)        REFERENCES projects(project_code) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_sender_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  FOREIGN KEY (last_sender_key)     REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  FOREIGN KEY (last_sent_by_device) REFERENCES devices(device_key) ON DELETE SET NULL,
  FOREIGN KEY (campaign_run_id)     REFERENCES campaign_runs(run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_contact     ON project_leads(contact_key);
CREATE INDEX IF NOT EXISTS idx_leads_project      ON project_leads(project_code);
CREATE INDEX IF NOT EXISTS idx_leads_due          ON project_leads(sequence_status, follow_up_due);
CREATE INDEX IF NOT EXISTS idx_leads_run          ON project_leads(campaign_run_id);
CREATE INDEX IF NOT EXISTS idx_leads_lock         ON project_leads(send_lock, lock_until);

-- B3. 广告来源线索(click-to-WhatsApp)。ad_lead_key = ads:phone 或 source:phone。
CREATE TABLE IF NOT EXISTS ads_leads (
  ad_lead_key     TEXT PRIMARY KEY,
  notion_page_id  TEXT UNIQUE,
  contact_key     TEXT NOT NULL,
  phone           TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  source_code     TEXT NOT NULL DEFAULT 'ads',
  lead_received_at TEXT,
  last_touch_at   TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT
);

-- B4. 回收/旧名单线索。recycle_lead_key = recycle:phone。
CREATE TABLE IF NOT EXISTS recycle_leads (
  recycle_lead_key TEXT PRIMARY KEY,
  notion_page_id   TEXT UNIQUE,
  contact_key      TEXT NOT NULL,
  phone            TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  source_batch     TEXT NOT NULL DEFAULT '',   -- expo_july_2026
  payload_json     TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE RESTRICT
);

-- B5. Flow 1 客户群。Excel/CSV 只是其中一种导入来源；名单导入后长期保留在本机，
--     操作者可直接选择、改名和再次预览，不需要每次重新上传文件。
--     客户群严格绑定 device_key + sender_phone，避免两台电脑都叫 wa_01 时混用名单。
CREATE TABLE IF NOT EXISTS lead_groups (
  group_id        TEXT PRIMARY KEY,
  project_code    TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  source_type     TEXT NOT NULL DEFAULT 'file'
                    CHECK (source_type IN ('file','manual','database')),
  source_name     TEXT NOT NULL DEFAULT '',
  device_key      TEXT NOT NULL,
  sender_phone    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_groups_scope_name
  ON lead_groups(device_key, sender_phone, project_code, lower(group_name))
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_lead_groups_scope
  ON lead_groups(device_key, sender_phone, project_code, status, updated_at);

CREATE TABLE IF NOT EXISTS lead_group_members (
  group_id        TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  language        TEXT NOT NULL DEFAULT '',
  source_row      INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id),
  UNIQUE (group_id, phone),
  FOREIGN KEY (group_id) REFERENCES lead_groups(group_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lead_group_members_phone
  ON lead_group_members(phone);

-- =============================================================================
-- C. 对话与消息(按"人"归档,不按项目)
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  contact_key     TEXT NOT NULL,
  connection_key  TEXT,                        -- 由哪个 device::phone 连接承载
  customer_phone  TEXT NOT NULL,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (contact_key, connection_key),
  FOREIGN KEY (contact_key)    REFERENCES contacts(contact_key) ON DELETE CASCADE,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,            -- 优先用 Evolution message id
  conversation_id TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text            TEXT NOT NULL DEFAULT '',
  message_type    TEXT NOT NULL DEFAULT 'text',
  source          TEXT NOT NULL DEFAULT 'evolution',
  flow_topic      TEXT NOT NULL DEFAULT '',    -- 出站时是哪一轮
  template_key    TEXT,                        -- 出站用了哪个模板
  sent_at         TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (template_key)    REFERENCES templates(template_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, sent_at);

-- =============================================================================
-- D. 模板与素材(出站话术真相源 = Notion,SQLite 是本机缓存)
-- =============================================================================

-- template_key = project_code:f<flow>:p<part>:<lang>:v<version>  (e.g. gen_starz:f01:p1:en:v2)
-- 同一 project/flow/part/lang 有多条 Active = 变体轮换(防 spam)。
CREATE TABLE IF NOT EXISTS templates (
  template_key    TEXT PRIMARY KEY,
  notion_page_id  TEXT UNIQUE,
  template_name   TEXT NOT NULL DEFAULT '',    -- [Gen Starz][F01 Project][EN][P1][v2]
  project_code    TEXT NOT NULL,
  flow_topic      TEXT NOT NULL DEFAULT '',    -- Project Template / Layout …
  flow_no         INTEGER,                     -- 1..10
  part_no         INTEGER NOT NULL DEFAULT 1,
  language        TEXT NOT NULL DEFAULT 'en',
  version         TEXT NOT NULL DEFAULT 'v1',
  status          TEXT NOT NULL DEFAULT 'Testing' CHECK (status IN ('Active','Testing','Retired')),
  message_text    TEXT NOT NULL DEFAULT '',
  image_name      TEXT,                        -- → images.asset_key
  -- 效果计数(话术 review 用)
  sent_count      INTEGER NOT NULL DEFAULT 0,
  response_count  INTEGER NOT NULL DEFAULT 0,
  warm_count      INTEGER NOT NULL DEFAULT 0,
  stop_count      INTEGER NOT NULL DEFAULT 0,
  viewing_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT,
  FOREIGN KEY (image_name)   REFERENCES images(asset_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_match
  ON templates(project_code, flow_topic, part_no, language, status);

-- asset_key = image_name(稳定命名,如 gs_f03_location_en_v1)。
CREATE TABLE IF NOT EXISTS images (
  asset_key      TEXT PRIMARY KEY,
  notion_page_id TEXT UNIQUE,
  project_code   TEXT,
  flow_topic     TEXT NOT NULL DEFAULT '',
  language       TEXT NOT NULL DEFAULT 'en',
  local_file     TEXT NOT NULL DEFAULT '',     -- campaign-assets/images/xxx.jpg
  cloud_url      TEXT NOT NULL DEFAULT '',     -- Cloudflare R2 manifest URL
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE SET NULL
);

-- =============================================================================
-- E. 运行与发送
-- =============================================================================

-- 一次群发/cohort 一行。run_id 唯一键(比 Name 安全,便于重传/回链)。
CREATE TABLE IF NOT EXISTS campaign_runs (
  run_id         TEXT PRIMARY KEY,             -- run_20260710_131500_gen_starz_flow01
  notion_page_id TEXT UNIQUE,
  name           TEXT NOT NULL DEFAULT '',
  project_code   TEXT NOT NULL,
  flow_topic     TEXT NOT NULL DEFAULT '',
  flow_no        INTEGER,
  sender_set     TEXT NOT NULL DEFAULT '',     -- wa_01,wa_02
  mode           TEXT NOT NULL DEFAULT 'TEST' CHECK (mode IN ('TEST','LIVE')),
  status         TEXT NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','STOPPED')),
  requested_count INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  device_key      TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT,
  FOREIGN KEY (device_key)   REFERENCES devices(device_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON campaign_runs(project_code, started_at);

-- 单条发送任务(排程/多段/重试的最小单元)。
CREATE TABLE IF NOT EXISTS send_jobs (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  project_lead_key TEXT NOT NULL,
  connection_key   TEXT,
  flow_topic       TEXT NOT NULL DEFAULT '',
  part_no          INTEGER NOT NULL DEFAULT 1,
  template_key     TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','SENDING','SENT','SKIPPED','FAILED','CANCELLED')),
  scheduled_at     TEXT,
  sent_at          TEXT,
  error_code       TEXT NOT NULL DEFAULT '',
  error_message    TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (run_id)           REFERENCES campaign_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE CASCADE,
  FOREIGN KEY (connection_key)   REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  FOREIGN KEY (template_key)     REFERENCES templates(template_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sendjobs_queue ON send_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sendjobs_run   ON send_jobs(run_id);

-- =============================================================================
-- F. AI 大脑(供入站自动回复;真相源 = Notion,SQLite 缓存)
-- =============================================================================

-- fact_key = project_code:category_slug:fact_slug。AI 只能引用 verified=1。
CREATE TABLE IF NOT EXISTS project_knowledge (
  fact_key       TEXT PRIMARY KEY,
  notion_page_id TEXT UNIQUE,
  project_code   TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT '',
  fact           TEXT NOT NULL DEFAULT '',
  verified       INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  source         TEXT NOT NULL DEFAULT '',
  valid_until    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project ON project_knowledge(project_code, verified);

-- Golden Conversation Ledger。这里保存的是「如何判断和推进约看」，不是楼盘事实。
-- 一行 = 一个匿名 lead 的完整对话；PII 必须在写入前清洗。
CREATE TABLE IF NOT EXISTS golden_conversations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_code            TEXT NOT NULL UNIQUE,
  project_code         TEXT NOT NULL,
  origin_project_code  TEXT,
  source_channel       TEXT,
  blast_version        TEXT,
  language             TEXT,
  customer_role        TEXT,
  primary_purpose      TEXT,
  first_reply_type     TEXT,
  outcome              TEXT NOT NULL
                         CHECK (outcome IN ('Viewing Booked','Active','Dormant','Dead')),
  outcome_updated_at   TEXT NOT NULL,
  death_turn           INTEGER,
  death_message_type   TEXT
                         CHECK (death_message_type IS NULL OR death_message_type IN (
                           'ab_slot_template','price_probe','budget_probe','bulk_info_dump',
                           'reassurance_push','festival_greeting','open_question','other'
                         )),
  death_note           TEXT,
  trigger_message      TEXT,
  customer_next_move   TEXT,
  friction_removers    TEXT NOT NULL DEFAULT '[]',
  reconfirmed          INTEGER NOT NULL DEFAULT 0 CHECK (reconfirmed IN (0,1)),
  decision_trace       TEXT NOT NULL DEFAULT '[]',
  conversation_text    TEXT NOT NULL,
  do_not_copy          TEXT NOT NULL DEFAULT '[]',
  pk_conflicts         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  source_hash          TEXT NOT NULL UNIQUE,

  -- GC v1 的安全延伸：只用客户最后回复时间判断 Active → Dormant。
  -- 不用 created_at/outcome_updated_at，避免把新导入的旧对话误当成刚回复。
  last_customer_reply_at TEXT
);

-- followup_log 与 GC indexes 由 golden-conversation-ledger-service 安装。
-- 原因：旧 v3 也有同名 golden_conversations，但没有 lead_code/outcome；必须先
-- 识别并无损搬迁旧表，才能建立外键与新索引，否则旧电脑会在启动时失败。

-- objection_key = scenario_slug:customer_says_slug
CREATE TABLE IF NOT EXISTS objection_bank (
  objection_key   TEXT PRIMARY KEY,
  notion_page_id  TEXT UNIQUE,
  scenario        TEXT NOT NULL DEFAULT '',
  customer_says   TEXT NOT NULL DEFAULT '',
  handling        TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- reply_log_key = message_id || phone:timestamp。存 robot 草稿 + 人工最终版。
CREATE TABLE IF NOT EXISTS ai_reply_log (
  reply_log_key   TEXT PRIMARY KEY,
  contact_key     TEXT NOT NULL,
  project_code    TEXT,
  route           TEXT NOT NULL DEFAULT '',    -- 分类路由 PRICE_REQUEST …
  message_id      TEXT,
  robot_draft     TEXT NOT NULL DEFAULT '',
  final_reply     TEXT NOT NULL DEFAULT '',
  decision        TEXT NOT NULL DEFAULT '' CHECK (decision IN ('','AUTO_SENT','HUMAN_SENT','SKIPPED')),
  created_at      TEXT NOT NULL,
  FOREIGN KEY (contact_key)  REFERENCES contacts(contact_key) ON DELETE CASCADE,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_replylog_contact ON ai_reply_log(contact_key, created_at);

-- =============================================================================
-- G. 同步、审计与运行元数据(与现有 v2 壳一致,保留)
-- =============================================================================

-- 后台 Sync Worker 的任务队列(方向按数据类型定,见 ADR 第四节)。
CREATE TABLE IF NOT EXISTS sync_jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  direction          TEXT NOT NULL CHECK (direction IN ('NOTION_TO_LOCAL','LOCAL_TO_NOTION')),
  entity_type        TEXT NOT NULL,            -- project_lead / template / campaign_run …
  entity_id          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED')),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  available_at       TEXT NOT NULL,
  last_error_code    TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  payload_json       TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue ON sync_jobs(status, available_at);

-- 每次批处理操作(发送/归属修复等)的审计头。
CREATE TABLE IF NOT EXISTS operations (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  device_key      TEXT NOT NULL,
  connection_key  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('PREVIEW','RUNNING','PARTIAL','COMPLETED','FAILED','ROLLED_BACK')),
  requested_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE RESTRICT
);

-- 归属/字段变更明细(before/after + 重试),支持按 operation_id 精确回滚。
CREATE TABLE IF NOT EXISTS ownership_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id   TEXT NOT NULL,
  project_lead_key TEXT,
  notion_page_id TEXT NOT NULL,
  before_json    TEXT NOT NULL,
  after_json     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED','FAILED','ROLLED_BACK','SKIPPED_CHANGED')),
  error_code     TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  UNIQUE (operation_id, notion_page_id),
  FOREIGN KEY (operation_id)     REFERENCES operations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ownership_retry ON ownership_changes(operation_id, status, retry_count);

-- 导入批次(Excel / Notion dry-run / apply)。
CREATE TABLE IF NOT EXISTS import_runs (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,               -- notion:blast_leads / excel …
  mode           TEXT NOT NULL CHECK (mode IN ('DRY_RUN','APPLY')),
  status         TEXT NOT NULL CHECK (status IN ('RUNNING','PARTIAL','COMPLETED','FAILED')),
  scanned_count  INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  report_json    TEXT NOT NULL DEFAULT '{}',
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

-- append-only 系统日志(带结构化错误码)。
CREATE TABLE IF NOT EXISTS system_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  area        TEXT NOT NULL DEFAULT '',        -- campaign / conversations / api / system
  event       TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',        -- NOTION_RATE_LIMITED …
  message     TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_syslogs_time ON system_logs(at, level);

-- Sync Worker 单例状态。
CREATE TABLE IF NOT EXISTS sync_worker_state (
  id               TEXT PRIMARY KEY CHECK (id = 'singleton'),
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  mode             TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','ACTIVE')),
  status           TEXT NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE','RUNNING','PAUSED','ERROR')),
  last_started_at  TEXT,
  last_finished_at TEXT,
  last_error_code    TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL
);

-- 键值元数据 + 迁移记录。
CREATE TABLE IF NOT EXISTS metadata (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- =============================================================================
-- 种子(幂等)
-- =============================================================================
INSERT INTO sync_worker_state(id, enabled, mode, status, updated_at)
VALUES ('singleton', 0, 'SHADOW', 'IDLE', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(id) DO NOTHING;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (3, 'systematic-business-schema', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(version) DO NOTHING;

INSERT INTO metadata(key, value, updated_at) VALUES
  ('schema_version', '3', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('storage_mode',  'shadow', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO NOTHING;

PRAGMA user_version = 3;
