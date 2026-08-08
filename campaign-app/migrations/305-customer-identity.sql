-- Migration 305: stable customer identity and alias/conflict/merge ledgers.
-- This is additive. Legacy contacts remain as compatibility rows and are linked
-- to one stable customer_id. No customer is deleted by this migration.

CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  primary_phone TEXT,
  global_status TEXT NOT NULL DEFAULT 'Active'
    CHECK (global_status IN ('Active','Stop','Invalid','Won','Lost','Merged')),
  merged_into_customer_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (merged_into_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_customers_primary_phone
  ON customers(primary_phone) WHERE primary_phone IS NOT NULL AND primary_phone <> '';
CREATE INDEX idx_customers_status ON customers(global_status, updated_at);

CREATE TABLE customer_identities (
  identity_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  identity_type TEXT NOT NULL
    CHECK (identity_type IN ('PHONE_E164','WHATSAPP_JID','WHATSAPP_LID','EVOLUTION_REMOTE_JID','CONTACT_IMPORT_ID','NOTION_PAGE_ID','LEGACY_CONTACT_KEY')),
  identity_value TEXT NOT NULL,
  connection_key TEXT,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONFLICT','RETIRED')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  verified_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  UNIQUE (identity_type, identity_value)
);

CREATE INDEX idx_customer_identities_customer ON customer_identities(customer_id, status);
CREATE INDEX idx_customer_identities_connection ON customer_identities(connection_key, last_seen_at);

CREATE TABLE identity_conflicts (
  conflict_id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  existing_customer_id TEXT,
  candidate_customer_id TEXT,
  connection_key TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  resolution TEXT NOT NULL DEFAULT '',
  resolved_customer_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (existing_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  UNIQUE (identity_type, identity_value, existing_customer_id, candidate_customer_id)
);

CREATE INDEX idx_identity_conflicts_open ON identity_conflicts(status, last_seen_at DESC);

CREATE TABLE identity_unresolved_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_message_id TEXT NOT NULL DEFAULT '',
  connection_key TEXT,
  remote_jid TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  conflict_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','DISMISSED')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL,
  FOREIGN KEY (conflict_id) REFERENCES identity_conflicts(conflict_id) ON DELETE SET NULL
);

CREATE TABLE customer_merge_events (
  merge_id TEXT PRIMARY KEY,
  surviving_customer_id TEXT NOT NULL,
  duplicate_customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED','REVERSED')),
  snapshot_json TEXT NOT NULL,
  moved_counts_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reversed_at TEXT,
  FOREIGN KEY (surviving_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (duplicate_customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_customer_merge_one_active_duplicate
  ON customer_merge_events(duplicate_customer_id) WHERE status='APPLIED';

CREATE TABLE identity_backfill_state (
  source_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','PAUSED')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  processed_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT ''
);

ALTER TABLE contacts ADD COLUMN customer_id TEXT REFERENCES customers(customer_id);
ALTER TABLE conversations ADD COLUMN customer_id TEXT REFERENCES customers(customer_id);
ALTER TABLE messages ADD COLUMN customer_id TEXT REFERENCES customers(customer_id);
ALTER TABLE messages ADD COLUMN remote_jid TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN raw_payload_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE project_leads ADD COLUMN customer_id TEXT REFERENCES customers(customer_id);
ALTER TABLE crm_customer_profiles ADD COLUMN customer_id TEXT REFERENCES customers(customer_id);

INSERT INTO customers(customer_id,display_name,primary_phone,global_status,created_at,updated_at)
SELECT 'CUS-' || upper(hex(randomblob(12))), display_name, phone,
  CASE WHEN stop_flag=1 THEN 'Stop' ELSE 'Active' END, created_at, updated_at
FROM contacts;

UPDATE contacts SET customer_id=(SELECT customer_id FROM customers WHERE primary_phone=contacts.phone);
UPDATE conversations SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=conversations.contact_key);
UPDATE messages SET customer_id=(SELECT customer_id FROM conversations WHERE id=messages.conversation_id);
UPDATE project_leads SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=project_leads.contact_key);
UPDATE crm_customer_profiles SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=crm_customer_profiles.contact_key);

-- Migration 304 initially keyed CRM customer sync by contact_key. Switch the
-- mapping and queued work to the stable customer_id without creating new Notion pages.
UPDATE notion_entity_map SET
  stable_notion_id=(SELECT customer_id FROM contacts WHERE contact_key=notion_entity_map.sqlite_entity_id),
  sqlite_entity_id=(SELECT customer_id FROM contacts WHERE contact_key=notion_entity_map.sqlite_entity_id)
WHERE entity_type='crm_customer'
  AND EXISTS (SELECT 1 FROM contacts WHERE contact_key=notion_entity_map.sqlite_entity_id);
UPDATE sync_jobs SET entity_id=(SELECT customer_id FROM contacts WHERE contact_key=sync_jobs.entity_id)
WHERE entity_type='crm_customer' AND EXISTS (SELECT 1 FROM contacts WHERE contact_key=sync_jobs.entity_id);
UPDATE sync_inbox SET entity_id=(SELECT customer_id FROM contacts WHERE contact_key=sync_inbox.entity_id)
WHERE entity_type='crm_customer' AND EXISTS (SELECT 1 FROM contacts WHERE contact_key=sync_inbox.entity_id);
UPDATE sync_conflicts SET entity_id=(SELECT customer_id FROM contacts WHERE contact_key=sync_conflicts.entity_id)
WHERE entity_type='crm_customer' AND EXISTS (SELECT 1 FROM contacts WHERE contact_key=sync_conflicts.entity_id);
UPDATE sync_audit_events SET entity_id=(SELECT customer_id FROM contacts WHERE contact_key=sync_audit_events.entity_id)
WHERE entity_type='crm_customer' AND EXISTS (SELECT 1 FROM contacts WHERE contact_key=sync_audit_events.entity_id);

INSERT INTO customer_identities(identity_id,customer_id,identity_type,identity_value,confidence,source,first_seen_at,last_seen_at,verified_at)
SELECT 'identity_' || lower(hex(randomblob(12))), customer_id, 'PHONE_E164', phone, 90, 'migration_305', created_at, updated_at, updated_at
FROM contacts WHERE customer_id IS NOT NULL AND phone <> '';

INSERT INTO customer_identities(identity_id,customer_id,identity_type,identity_value,confidence,source,first_seen_at,last_seen_at,verified_at)
SELECT 'identity_' || lower(hex(randomblob(12))), customer_id, 'LEGACY_CONTACT_KEY', contact_key, 80, 'migration_305', created_at, updated_at, updated_at
FROM contacts WHERE customer_id IS NOT NULL AND contact_key <> '';

INSERT OR IGNORE INTO customer_identities(identity_id,customer_id,identity_type,identity_value,confidence,source,first_seen_at,last_seen_at,verified_at)
SELECT 'identity_' || lower(hex(randomblob(12))), c.customer_id, 'WHATSAPP_LID', l.lid, l.confidence,
  'legacy_lid_map:' || l.source, l.created_at, l.updated_at,
  CASE WHEN l.confidence >= 90 THEN l.updated_at ELSE NULL END
FROM lid_map l JOIN contacts c ON c.phone=l.phone
WHERE c.customer_id IS NOT NULL AND l.lid <> '' AND l.source <> 'profile_name';

CREATE INDEX idx_contacts_customer_id ON contacts(customer_id);
CREATE INDEX idx_conversations_customer_connection ON conversations(customer_id, connection_key);
CREATE INDEX idx_messages_customer_time ON messages(customer_id, sent_at);
CREATE UNIQUE INDEX idx_messages_connection_external
  ON messages(connection_key, external_message_id)
  WHERE connection_key IS NOT NULL AND connection_key <> '' AND external_message_id <> '';
CREATE INDEX idx_project_leads_customer_id ON project_leads(customer_id);

CREATE TRIGGER customers_row_version_after_update
AFTER UPDATE ON customers
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE customers SET row_version = OLD.row_version + 1 WHERE customer_id = OLD.customer_id;
END;

-- Legacy writers still create contacts/project leads through the v3 repository.
-- These compatibility triggers attach stable identity without duplicating business
-- decisions; message-time conflict handling remains in CustomerIdentityRepository.
CREATE TRIGGER contacts_customer_identity_after_insert
AFTER INSERT ON contacts
WHEN NEW.customer_id IS NULL
BEGIN
  INSERT OR IGNORE INTO customers(customer_id,display_name,primary_phone,global_status,created_at,updated_at)
  VALUES ('CUS-' || upper(hex(randomblob(12))),NEW.display_name,NEW.phone,
    CASE WHEN NEW.stop_flag=1 THEN 'Stop' ELSE 'Active' END,NEW.created_at,NEW.updated_at);
  UPDATE contacts SET customer_id=(SELECT customer_id FROM customers WHERE primary_phone=NEW.phone)
  WHERE contact_key=NEW.contact_key;
  INSERT OR IGNORE INTO customer_identities(identity_id,customer_id,identity_type,identity_value,confidence,source,first_seen_at,last_seen_at,verified_at)
  SELECT 'identity_' || lower(hex(randomblob(12))),customer_id,'PHONE_E164',NEW.phone,60,'legacy_contact_insert',NEW.created_at,NEW.updated_at,NULL
  FROM contacts WHERE contact_key=NEW.contact_key AND customer_id IS NOT NULL AND NEW.phone<>'';
  INSERT OR IGNORE INTO customer_identities(identity_id,customer_id,identity_type,identity_value,confidence,source,first_seen_at,last_seen_at,verified_at)
  SELECT 'identity_' || lower(hex(randomblob(12))),customer_id,'LEGACY_CONTACT_KEY',NEW.contact_key,80,'legacy_contact_insert',NEW.created_at,NEW.updated_at,NULL
  FROM contacts WHERE contact_key=NEW.contact_key AND customer_id IS NOT NULL AND NEW.contact_key<>'';
END;

CREATE TRIGGER conversations_customer_identity_after_insert
AFTER INSERT ON conversations
WHEN NEW.customer_id IS NULL
BEGIN
  UPDATE conversations SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=NEW.contact_key)
  WHERE id=NEW.id;
END;

CREATE TRIGGER messages_customer_identity_after_insert
AFTER INSERT ON messages
WHEN NEW.customer_id IS NULL
BEGIN
  UPDATE messages SET customer_id=(SELECT customer_id FROM conversations WHERE id=NEW.conversation_id)
  WHERE row_id=NEW.row_id;
END;

CREATE TRIGGER project_leads_customer_identity_after_insert
AFTER INSERT ON project_leads
WHEN NEW.customer_id IS NULL
BEGIN
  UPDATE project_leads SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=NEW.contact_key)
  WHERE project_lead_key=NEW.project_lead_key;
END;

CREATE TRIGGER crm_profiles_customer_identity_after_insert
AFTER INSERT ON crm_customer_profiles
WHEN NEW.customer_id IS NULL
BEGIN
  UPDATE crm_customer_profiles SET customer_id=(SELECT customer_id FROM contacts WHERE contact_key=NEW.contact_key)
  WHERE contact_key=NEW.contact_key;
END;
