-- Migration 306: one audited send-eligibility state and a cross-lane customer lock.
-- SQLite remains the operational truth. This migration does not start, resume,
-- cancel, or rewrite any existing campaign run.

ALTER TABLE project_leads ADD COLUMN snooze_until TEXT;

CREATE TABLE campaign_memberships (
  membership_id TEXT PRIMARY KEY,
  customer_id TEXT,
  project_lead_key TEXT,
  campaign_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE','EXIT_STOP','EXIT_APPOINTMENT','EXIT_BOOKED','COMPLETED','FAILED')),
  reason_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  exited_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL,
  UNIQUE (run_id, customer_id)
);

CREATE INDEX idx_campaign_membership_customer
  ON campaign_memberships(customer_id, status, updated_at);
CREATE INDEX idx_campaign_membership_run
  ON campaign_memberships(run_id, status);

CREATE TABLE send_eligibility_decisions (
  decision_id TEXT PRIMARY KEY,
  customer_id TEXT,
  project_lead_key TEXT,
  campaign_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  requested_action TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  retry_at TEXT,
  required_action TEXT,
  evaluated_state_json TEXT NOT NULL DEFAULT '{}',
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL
);

CREATE INDEX idx_eligibility_decisions_customer
  ON send_eligibility_decisions(customer_id, evaluated_at DESC);
CREATE INDEX idx_eligibility_decisions_run
  ON send_eligibility_decisions(run_id, reason_code, evaluated_at DESC);

CREATE TABLE send_eligibility_locks (
  lock_id TEXT PRIMARY KEY,
  recipient_key TEXT NOT NULL,
  customer_id TEXT,
  connection_key TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  lock_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL
);

-- One physical customer/recipient can be owned by only one lane at a time,
-- even when two runners selected different WhatsApp connections or campaigns.
CREATE UNIQUE INDEX idx_send_eligibility_one_active_recipient
  ON send_eligibility_locks(recipient_key) WHERE state='ACTIVE';
CREATE INDEX idx_send_eligibility_lock_expiry
  ON send_eligibility_locks(state, expires_at);

CREATE TABLE global_suppressions (
  suppression_id TEXT PRIMARY KEY,
  customer_id TEXT,
  phone TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_global_suppressions_customer_active
  ON global_suppressions(customer_id) WHERE customer_id IS NOT NULL AND status='ACTIVE';
CREATE UNIQUE INDEX idx_global_suppressions_phone_active
  ON global_suppressions(phone) WHERE phone<>'' AND status='ACTIVE';

CREATE TABLE customer_follow_up_tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT,
  project_lead_key TEXT,
  task_type TEXT NOT NULL CHECK (task_type IN ('REPLY_HANDOFF','SNOOZE_DUE','APPOINTMENT','TRANSACTION')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  due_at TEXT,
  source TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL
);

CREATE INDEX idx_customer_follow_up_due
  ON customer_follow_up_tasks(status, due_at);

CREATE TABLE customer_state_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT,
  project_lead_key TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL
);

CREATE INDEX idx_customer_state_events_customer
  ON customer_state_events(customer_id, created_at DESC);
