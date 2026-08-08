-- Migration 307: canonical sales stage, qualified opportunities, follow-up tasks,
-- and an append-only sales activity timeline. Imported phone numbers remain
-- project leads; this migration does not create opportunities for them.

ALTER TABLE project_leads ADD COLUMN sales_stage TEXT NOT NULL DEFAULT 'NEW'
  CHECK (sales_stage IN ('NEW','CONTACTED','REPLIED','QUALIFIED','WARM','APPOINTMENT','VIEWED','LOAN_PROCESSING','BOOKING','SPA_SIGNED','WON','LOST'));
ALTER TABLE project_leads ADD COLUMN temperature TEXT NOT NULL DEFAULT 'COLD'
  CHECK (temperature IN ('HOT','WARM','COLD','NURTURE','STOP'));
ALTER TABLE project_leads ADD COLUMN buying_purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN budget_min REAL;
ALTER TABLE project_leads ADD COLUMN budget_max REAL;
ALTER TABLE project_leads ADD COLUMN preferred_area TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN preferred_property_type TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN room_requirement TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN tenure_preference TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN transport_requirement TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN buying_timeline TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN main_objection TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN decision_maker TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN loan_readiness TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN current_property_ownership TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN next_action TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN next_follow_up_at TEXT;
ALTER TABLE project_leads ADD COLUMN assigned_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN lost_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN stage_changed_at TEXT;
ALTER TABLE project_leads ADD COLUMN last_meaningful_contact_at TEXT;
ALTER TABLE project_leads ADD COLUMN appointment_at TEXT;
ALTER TABLE project_leads ADD COLUMN viewing_completed_at TEXT;
ALTER TABLE project_leads ADD COLUMN loan_updated_at TEXT;

UPDATE project_leads SET sales_stage=CASE upper(replace(status,' ','_'))
  WHEN 'CONTACTED' THEN 'CONTACTED'
  WHEN 'REPLIED' THEN 'REPLIED'
  WHEN 'QUALIFIED' THEN 'QUALIFIED'
  WHEN 'WARM' THEN 'WARM'
  WHEN 'APPOINTMENT' THEN 'APPOINTMENT'
  WHEN 'VIEWED' THEN 'VIEWED'
  WHEN 'VIEWING' THEN 'VIEWED'
  WHEN 'LOAN' THEN 'LOAN_PROCESSING'
  WHEN 'LOAN_PROCESSING' THEN 'LOAN_PROCESSING'
  WHEN 'BOOKING' THEN 'BOOKING'
  WHEN 'SPA' THEN 'SPA_SIGNED'
  WHEN 'SPA_SIGNED' THEN 'SPA_SIGNED'
  WHEN 'WON' THEN 'WON'
  WHEN 'LOST' THEN 'LOST'
  ELSE 'NEW' END,
  temperature=CASE upper(status)
    WHEN 'STOP' THEN 'STOP'
    WHEN 'WARM' THEN 'WARM'
    ELSE 'COLD' END,
  next_follow_up_at=COALESCE(follow_up_at,follow_up_due),
  assigned_agent=assigned_sales,
  appointment_at=CASE
    WHEN appointment_date IS NULL OR appointment_date='' THEN NULL
    WHEN appointment_time='' THEN appointment_date || 'T00:00:00+08:00'
    ELSE appointment_date || 'T' || appointment_time || '+08:00' END,
  stage_changed_at=updated_at,
  last_meaningful_contact_at=COALESCE(last_blast_at,first_blast_at,updated_at);

CREATE INDEX idx_project_leads_sales_stage
  ON project_leads(sales_stage, temperature, next_follow_up_at);
CREATE INDEX idx_project_leads_assigned_agent
  ON project_leads(assigned_agent, sales_stage);

CREATE TABLE sales_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  project_lead_key TEXT NOT NULL UNIQUE,
  project_code TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('REPLIED','QUALIFIED','WARM','APPOINTMENT','VIEWED','LOAN_PROCESSING','BOOKING','SPA_SIGNED','WON','LOST')),
  probability_percent REAL NOT NULL DEFAULT 10 CHECK (probability_percent BETWEEN 0 AND 100),
  property_value REAL NOT NULL DEFAULT 0 CHECK (property_value >= 0),
  commission_rate_percent REAL NOT NULL DEFAULT 0 CHECK (commission_rate_percent >= 0),
  gross_commission REAL NOT NULL DEFAULT 0 CHECK (gross_commission >= 0),
  team_split_percent REAL NOT NULL DEFAULT 100 CHECK (team_split_percent BETWEEN 0 AND 100),
  expected_commission REAL NOT NULL DEFAULT 0 CHECK (expected_commission >= 0),
  actual_commission REAL,
  commission_status TEXT NOT NULL DEFAULT 'EXPECTED'
    CHECK (commission_status IN ('NOT_EXPECTED','EXPECTED','INVOICED','PARTIAL','PAID','CANCELLED')),
  expected_payment_date TEXT,
  paid_at TEXT,
  target_close_date TEXT,
  trigger_type TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  won_at TEXT,
  lost_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE RESTRICT,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT
);

CREATE INDEX idx_sales_opportunities_stage
  ON sales_opportunities(stage, expected_commission, updated_at);
CREATE INDEX idx_sales_opportunities_customer
  ON sales_opportunities(customer_id, updated_at DESC);

CREATE TRIGGER sales_opportunities_row_version_after_update
AFTER UPDATE ON sales_opportunities
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE sales_opportunities SET row_version=OLD.row_version+1 WHERE opportunity_id=OLD.opportunity_id;
END;

-- Migration 306 introduced the initial task table with four eligibility task
-- types. Rebuild it once so the sales task engine has one canonical task source.
ALTER TABLE customer_follow_up_tasks RENAME TO customer_follow_up_tasks_pre_307;
DROP INDEX idx_customer_follow_up_due;

CREATE TABLE customer_follow_up_tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  project_lead_key TEXT,
  opportunity_id TEXT,
  task_type TEXT NOT NULL
    CHECK (task_type IN ('REPLY_CUSTOMER','WARM_LEAD_FOLLOW_UP','SNOOZE_DUE','CONFIRM_APPOINTMENT','POST_VIEWING_FOLLOW_UP','CHECK_LOAN','CHECK_BOOKING','UPDATE_SPA','TRANSACTION','MANUAL')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','SNOOZED','COMPLETED','CANCELLED')),
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  priority_score INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  source_event TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'System'
    CHECK (created_by IN ('System','Agent','AI')),
  owner TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completed_by TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES sales_opportunities(opportunity_id) ON DELETE SET NULL
);

INSERT INTO customer_follow_up_tasks(
  task_id,idempotency_key,customer_id,project_lead_key,task_type,status,due_at,
  priority,priority_score,reason,next_action,source,created_by,payload_json,
  created_at,updated_at,completed_at
)
SELECT task_id,idempotency_key,customer_id,project_lead_key,
  CASE task_type
    WHEN 'REPLY_HANDOFF' THEN 'REPLY_CUSTOMER'
    WHEN 'SNOOZE_DUE' THEN 'SNOOZE_DUE'
    WHEN 'APPOINTMENT' THEN 'CONFIRM_APPOINTMENT'
    ELSE 'TRANSACTION' END,
  status,due_at,'MEDIUM',0,'Migrated from Send Eligibility','',source,'System',payload_json,
  created_at,updated_at,completed_at
FROM customer_follow_up_tasks_pre_307;

DROP TABLE customer_follow_up_tasks_pre_307;

CREATE INDEX idx_customer_follow_up_due
  ON customer_follow_up_tasks(status, due_at, priority_score DESC);
CREATE INDEX idx_customer_follow_up_customer
  ON customer_follow_up_tasks(customer_id, status, updated_at DESC);
CREATE INDEX idx_customer_follow_up_owner
  ON customer_follow_up_tasks(owner, status, due_at);

CREATE TABLE sales_activities (
  activity_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  project_lead_key TEXT,
  opportunity_id TEXT,
  activity_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'SYSTEM'
    CHECK (actor_type IN ('SYSTEM','AGENT','CUSTOMER','AI','NOTION')),
  actor_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  source_event TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES sales_opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE INDEX idx_sales_activities_customer
  ON sales_activities(customer_id, occurred_at DESC);
CREATE INDEX idx_sales_activities_lead
  ON sales_activities(project_lead_key, occurred_at DESC);
