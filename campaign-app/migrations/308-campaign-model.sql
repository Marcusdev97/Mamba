-- Migration 308: separate Campaign planning, membership, steps, runs and outcomes.
-- Existing send jobs and run evidence are preserved. This migration represents
-- legacy Flow 1-10 but deliberately does not change scheduling or send behavior.

CREATE TABLE campaigns (
  campaign_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (objective IN ('REACTIVATE_OLD_LEADS','LAUNCH_NEW_PROJECT','FOLLOW_UP_WARM_LEADS','INVITE_TO_SHOWROOM','RECOVER_MISSED_FOLLOW_UPS','PROMOTE_SPECIFIC_UNIT_TYPE','CALL_LIST_ONLY','MANUAL_FOLLOW_UP_ONLY')),
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'WHATSAPP' CHECK (channel IN ('WHATSAPP','CALL','MANUAL')),
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','TESTING','SCHEDULED','ACTIVE','PAUSED','COMPLETED','CANCELLED')),
  start_at TEXT,
  end_at TEXT,
  target_json TEXT NOT NULL DEFAULT '{}',
  stop_policy_json TEXT NOT NULL DEFAULT '{}',
  audience_json TEXT NOT NULL DEFAULT '{}',
  attribution_window_days INTEGER NOT NULL DEFAULT 30 CHECK (attribution_window_days BETWEEN 1 AND 365),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_code) ON DELETE RESTRICT
);

CREATE INDEX idx_campaigns_status ON campaigns(status,start_at,updated_at);
CREATE INDEX idx_campaigns_project ON campaigns(project_id,status,updated_at);

CREATE TABLE campaign_steps (
  campaign_step_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  step_order INTEGER NOT NULL CHECK (step_order > 0),
  flow_label TEXT NOT NULL,
  delay_rule TEXT NOT NULL DEFAULT '{}',
  template_group TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'WHATSAPP' CHECK (channel IN ('WHATSAPP','CALL','MANUAL')),
  requires_human INTEGER NOT NULL DEFAULT 0 CHECK (requires_human IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
  UNIQUE (campaign_id,step_order)
);

CREATE INDEX idx_campaign_steps_campaign ON campaign_steps(campaign_id,active,step_order);

-- Rebuild the legacy run ledger with explicit Campaign and Step references.
CREATE TABLE campaign_runs_v308 (
  run_id TEXT PRIMARY KEY,
  campaign_id TEXT,
  step_id TEXT,
  notion_page_id TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  project_code TEXT NOT NULL,
  flow_topic TEXT NOT NULL DEFAULT '',
  flow_no INTEGER,
  sender_set TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'TEST' CHECK (mode IN ('TEST','LIVE')),
  connection_id TEXT,
  device_id TEXT,
  device_key TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','TESTING','QUEUED','QUEUED_BATCH','READY','READY_TEST','RUNNING','SENDING','PAUSED','INTERRUPTED','PARTIAL','COMPLETED','SUCCEEDED','FAILED','STOPPED','CANCELLED')),
  requested_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE SET NULL,
  FOREIGN KEY (step_id) REFERENCES campaign_steps(campaign_step_id) ON DELETE SET NULL,
  FOREIGN KEY (project_code) REFERENCES projects(project_code) ON DELETE RESTRICT,
  FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE SET NULL
);

INSERT INTO campaigns(campaign_id,name,objective,project_id,channel,owner,status,start_at,end_at,target_json,stop_policy_json,audience_json,created_at,updated_at)
SELECT 'legacy:'||project_code,'Legacy Flow Sequence · '||project_code,'REACTIVATE_OLD_LEADS',project_code,'WHATSAPP','Migration 308',
  CASE WHEN SUM(CASE WHEN status IN ('RUNNING','SENDING','QUEUED','QUEUED_BATCH') THEN 1 ELSE 0 END)>0 THEN 'ACTIVE' ELSE 'COMPLETED' END,
  MIN(started_at),MAX(finished_at),'{}','{}',json_object('source','legacy_flow'),MIN(started_at),MAX(COALESCE(finished_at,started_at))
FROM campaign_runs GROUP BY project_code;

WITH RECURSIVE flow_numbers(flow_no) AS (SELECT 1 UNION ALL SELECT flow_no+1 FROM flow_numbers WHERE flow_no<10)
INSERT INTO campaign_steps(campaign_step_id,campaign_id,step_order,flow_label,delay_rule,template_group,channel,requires_human,active,created_at,updated_at)
SELECT c.campaign_id||':step:'||flow_no,c.campaign_id,flow_no,'Flow '||flow_no,json_object('source','legacy_flow','flow',flow_no),'Flow '||flow_no,'WHATSAPP',0,1,c.created_at,c.updated_at
FROM campaigns c CROSS JOIN flow_numbers;

INSERT INTO campaign_runs_v308(run_id,campaign_id,step_id,notion_page_id,name,project_code,flow_topic,flow_no,sender_set,mode,device_id,device_key,status,requested_count,sent_count,failed_count,started_at,finished_at,summary_json,payload_json)
SELECT run_id,'legacy:'||project_code,'legacy:'||project_code||':step:'||COALESCE(NULLIF(flow_no,0),1),notion_page_id,name,project_code,flow_topic,flow_no,sender_set,mode,device_key,device_key,status,requested_count,sent_count,failed_count,started_at,finished_at,
  json_object('migratedFrom','legacy_campaign_runs','requested',requested_count,'sent',sent_count,'failed',failed_count),payload_json
FROM campaign_runs;

DROP TABLE campaign_runs;
ALTER TABLE campaign_runs_v308 RENAME TO campaign_runs;
CREATE INDEX idx_runs_project ON campaign_runs(project_code,started_at);
CREATE INDEX idx_campaign_runs_status_mode ON campaign_runs(status,mode,started_at);
CREATE INDEX idx_campaign_runs_campaign ON campaign_runs(campaign_id,step_id,started_at);

CREATE TABLE campaign_members (
  campaign_member_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  project_lead_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','COMPLETED','PAUSED_REPLY','PAUSED_SNOOZE','EXIT_STOP','EXIT_APPOINTMENT','EXIT_BOOKED','FAILED')),
  current_step_id TEXT,
  joined_at TEXT NOT NULL,
  paused_at TEXT,
  exited_at TEXT,
  exit_reason TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_id) REFERENCES project_leads(project_lead_key) ON DELETE SET NULL,
  FOREIGN KEY (current_step_id) REFERENCES campaign_steps(campaign_step_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_campaign_members_one_active
  ON campaign_members(campaign_id,customer_id) WHERE status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE');
CREATE INDEX idx_campaign_members_customer ON campaign_members(customer_id,status,updated_at);
CREATE INDEX idx_campaign_members_campaign ON campaign_members(campaign_id,status,updated_at);

INSERT OR IGNORE INTO campaign_members(campaign_member_id,campaign_id,customer_id,project_lead_id,status,current_step_id,joined_at,paused_at,exited_at,exit_reason,last_activity_at,created_at,updated_at)
SELECT MIN(cm.membership_id),COALESCE(NULLIF(cm.campaign_id,''),cr.campaign_id),cm.customer_id,MIN(cm.project_lead_key),
  CASE WHEN SUM(CASE WHEN cm.status='ACTIVE' THEN 1 ELSE 0 END)>0 THEN 'ACTIVE'
       WHEN SUM(CASE WHEN cm.status='PENDING' THEN 1 ELSE 0 END)>0 THEN 'PENDING'
       WHEN SUM(CASE WHEN cm.status='PAUSED_REPLY' THEN 1 ELSE 0 END)>0 THEN 'PAUSED_REPLY'
       WHEN SUM(CASE WHEN cm.status='PAUSED_SNOOZE' THEN 1 ELSE 0 END)>0 THEN 'PAUSED_SNOOZE'
       ELSE MAX(cm.status) END,
  MAX(cr.step_id),MIN(cm.created_at),MAX(CASE WHEN cm.status LIKE 'PAUSED_%' THEN cm.updated_at END),MAX(cm.exited_at),MAX(cm.reason_code),MAX(cm.updated_at),MIN(cm.created_at),MAX(cm.updated_at)
FROM campaign_memberships cm JOIN campaign_runs cr ON cr.run_id=cm.run_id
WHERE cm.customer_id IS NOT NULL AND COALESCE(NULLIF(cm.campaign_id,''),cr.campaign_id) IS NOT NULL
GROUP BY COALESCE(NULLIF(cm.campaign_id,''),cr.campaign_id),cm.customer_id;

-- campaign_members is now the only membership truth. Runtime code still reads
-- campaign_memberships before migration 308, but never keeps both afterward.
DROP TABLE campaign_memberships;

CREATE TABLE campaign_outcomes (
  outcome_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  campaign_member_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL CHECK (outcome_type IN ('REPLY','WARM','APPOINTMENT','VIEWING','LOAN','BOOKING','SPA','COMMISSION')),
  value REAL,
  occurred_at TEXT NOT NULL,
  attribution_method TEXT NOT NULL CHECK (attribution_method IN ('LAST_CAMPAIGN_ACTIVITY','HUMAN_OVERRIDE')),
  source_event TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_member_id) REFERENCES campaign_members(campaign_member_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT
);

CREATE INDEX idx_campaign_outcomes_campaign ON campaign_outcomes(campaign_id,outcome_type,occurred_at);
CREATE INDEX idx_campaign_outcomes_customer ON campaign_outcomes(customer_id,occurred_at);
