-- Migration 310: durable AI development task contracts, scope evidence,
-- test results and resume/rollback records. It never runs Git commands.

CREATE TABLE ai_change_requests (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  allowed_scope_json TEXT NOT NULL DEFAULT '[]',
  protected_scope_json TEXT NOT NULL DEFAULT '[]',
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  current_step_id TEXT,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','APPROVED','IN_PROGRESS','TESTING','BLOCKED','REVIEW','COMPLETED','ROLLED_BACK','CANCELLED')),
  prompt_version TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  human_approved_by TEXT NOT NULL DEFAULT '',
  human_approved_at TEXT,
  blocker_code TEXT NOT NULL DEFAULT '',
  blocker_message TEXT NOT NULL DEFAULT '',
  rollback_plan TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_ai_change_requests_status ON ai_change_requests(status,risk_level,updated_at DESC);

CREATE TABLE ai_change_steps (
  step_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PLANNED','APPROVED','IN_PROGRESS','TESTING','BLOCKED','REVIEW','COMPLETED','ROLLED_BACK','CANCELLED')),
  commit_sha TEXT NOT NULL DEFAULT '',
  rollback_ref TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES ai_change_requests(task_id) ON DELETE CASCADE,
  UNIQUE (task_id,step_order)
);

CREATE UNIQUE INDEX idx_ai_change_one_active_step ON ai_change_steps(task_id) WHERE status='IN_PROGRESS';
CREATE INDEX idx_ai_change_steps_task ON ai_change_steps(task_id,step_order);

CREATE TABLE ai_change_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('PLANNER_AI','BUILDER_AI','REVIEWER_AI','HUMAN','SYSTEM')),
  actor_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES ai_change_requests(task_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES ai_change_steps(step_id) ON DELETE SET NULL
);

CREATE INDEX idx_ai_change_events_task ON ai_change_events(task_id,created_at);

CREATE TABLE ai_change_files (
  file_event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_deleted INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  scope_decision TEXT NOT NULL CHECK (scope_decision IN ('ALLOWED','PROTECTED_APPROVED','SCOPE_DRIFT')),
  commit_sha TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES ai_change_requests(task_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES ai_change_steps(step_id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_change_files_task ON ai_change_files(task_id,step_id,file_path);

CREATE TABLE ai_change_tests (
  test_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASSED','FAILED','SKIPPED')),
  summary TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES ai_change_requests(task_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES ai_change_steps(step_id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_change_tests_task ON ai_change_tests(task_id,step_id,status);
