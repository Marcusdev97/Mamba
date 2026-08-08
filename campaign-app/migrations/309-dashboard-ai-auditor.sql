-- Migration 309: SQLite-only action dashboard and advisory lead-audit ledger.
-- AI analyses never change stage, STOP, booking, identity, commission or sends.

CREATE TABLE lead_audit_analyses (
  analysis_id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  project_lead_key TEXT NOT NULL,
  conversation_last_message_id TEXT NOT NULL DEFAULT '',
  analysis_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  interest_level TEXT,
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  closing_probability REAL CHECK (closing_probability BETWEEN 0 AND 1),
  forgotten_followup INTEGER CHECK (forgotten_followup IN (0,1)),
  recommended_action TEXT,
  recommended_due_at TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  output_json TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL DEFAULT 'rules',
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  human_decision TEXT NOT NULL DEFAULT '' CHECK (human_decision IN ('','ACCEPTED','CORRECTED','REJECTED')),
  human_correction_json TEXT NOT NULL DEFAULT '{}',
  action_taken TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  was_useful INTEGER CHECK (was_useful IN (0,1)),
  classification_correct INTEGER CHECK (classification_correct IN (0,1)),
  feedback_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_lead_key) REFERENCES project_leads(project_lead_key) ON DELETE RESTRICT
);

CREATE INDEX idx_lead_audit_project_score ON lead_audit_analyses(project_lead_key,status,score DESC,created_at DESC);
CREATE INDEX idx_lead_audit_quality ON lead_audit_analyses(human_decision,was_useful,classification_correct,feedback_at);

CREATE TABLE lead_audit_events (
  event_id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ANALYSED','CACHE_HIT','FAILED','HUMAN_FEEDBACK','OUTCOME_RECORDED')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (analysis_id) REFERENCES lead_audit_analyses(analysis_id) ON DELETE CASCADE
);

CREATE INDEX idx_lead_audit_events_analysis ON lead_audit_events(analysis_id,created_at);
