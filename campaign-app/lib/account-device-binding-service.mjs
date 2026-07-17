import crypto from "node:crypto";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const MYT_TIME_ZONE = "Asia/Kuala_Lumpur";
const TERMINAL_UNCERTAIN_STATES = new Set(["UNKNOWN", "LEGACY_UNVERIFIED"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

function required(name, value) {
  const result = clean(value);
  if (!result) {
    const error = new Error(`${name} 不能为空。`);
    error.code = "ACCOUNT_LEDGER_INVALID_INPUT";
    throw error;
  }
  return result;
}

function positivePart(value) {
  const part = Number(value);
  if (!Number.isInteger(part) || part < 1) {
    const error = new Error("partNo 必须是大于 0 的整数。");
    error.code = "ACCOUNT_LEDGER_INVALID_PART";
    throw error;
  }
  return part;
}

export function mytDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MYT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function buildSendIdemKey({ campaignRunId, projectLeadKey, flowTopic, partNo } = {}) {
  const fields = [
    required("campaignRunId", campaignRunId),
    required("projectLeadKey", projectLeadKey),
    required("flowTopic", flowTopic),
    String(positivePart(partNo)),
  ];
  return fields.map((value) => encodeURIComponent(value)).join(":");
}

export function createAccountDeviceBindingService({ databasePath, sqliteBinary = "", clock = () => new Date() } = {}) {
  let dbPromise;
  const database = () => (dbPromise ??= createSqliteCli({ databasePath, sqliteBinary }));

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  async function assertReady() {
    const db = await database();
    const [row] = await db.query(`
SELECT
  (SELECT user_version FROM pragma_user_version) AS schemaVersion,
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_accounts') AS hasAccounts,
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='send_claims') AS hasClaims,
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='send_events') AS hasEvents,
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_transfers') AS hasTransfers;
`);
    const ready = Number(row?.schemaVersion) === 4
      && Number(row?.hasAccounts) === 1
      && Number(row?.hasClaims) === 1
      && Number(row?.hasEvents) === 1
      && Number(row?.hasTransfers) === 1;
    if (!ready) {
      const error = new Error(`SQLite v4 尚未准备好（当前 v${Number(row?.schemaVersion || 0)}）。`);
      error.code = "SQLITE_V4_NOT_READY";
      throw error;
    }
    return { ready: true, schemaVersion: 4 };
  }

  async function accountStatus(accountKey) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`
SELECT
  a.account_key AS accountKey,
  a.warmth,
  a.allowed_max_mode AS allowedMaxMode,
  a.daily_cap_contacts AS dailyCapContacts,
  a.daily_cap_messages AS dailyCapMessages,
  a.health,
  a.current_generation AS currentGeneration,
  a.active_binding_key AS activeBindingKey,
  b.device_key AS activeDeviceKey,
  b.instance_name AS activeInstanceName,
  b.status AS bindingStatus,
  b.generation AS bindingGeneration
FROM whatsapp_accounts a
LEFT JOIN device_bindings b ON b.binding_key = a.active_binding_key
WHERE a.account_key = ${sqlValue(required("accountKey", accountKey))};
`);
    return row || null;
  }

  async function claimPart(input = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const idemKey = clean(input.idemKey) || buildSendIdemKey(input);
    const accountKey = normalizePhone(required("accountKey", input.accountKey));
    const contactKey = normalizePhone(required("contactKey", input.contactKey));
    const recipientPhone = normalizePhone(input.recipientPhone || contactKey);
    if (!accountKey || !contactKey || !recipientPhone) {
      const error = new Error("account/contact/recipient 必须是有效的归一化电话号码。");
      error.code = "ACCOUNT_LEDGER_INVALID_PHONE";
      throw error;
    }
    const values = {
      idemKey,
      campaignRunId: required("campaignRunId", input.campaignRunId),
      projectLeadKey: required("projectLeadKey", input.projectLeadKey),
      flowTopic: required("flowTopic", input.flowTopic),
      partNo: positivePart(input.partNo),
      accountKey,
      contactKey,
      recipientPhone,
      deviceKey: required("deviceKey", input.deviceKey),
      bindingKey: required("bindingKey", input.bindingKey),
      generation: Number(input.bindingGeneration),
      token: crypto.randomUUID(),
    };
    if (!Number.isInteger(values.generation) || values.generation < 1) {
      const error = new Error("bindingGeneration 无效。");
      error.code = "ACCOUNT_LEDGER_INVALID_GENERATION";
      throw error;
    }

    const [result] = await db.query(`
BEGIN IMMEDIATE;
INSERT INTO send_claims(
  idem_key, campaign_run_id, project_lead_key, flow_topic, part_no,
  account_key, contact_key, recipient_phone, device_key, binding_key,
  binding_generation, state, claim_token, attempt_count, claimed_at, updated_at
)
SELECT
  ${sqlValue(values.idemKey)}, ${sqlValue(values.campaignRunId)}, ${sqlValue(values.projectLeadKey)},
  ${sqlValue(values.flowTopic)}, ${values.partNo}, ${sqlValue(values.accountKey)},
  ${sqlValue(values.contactKey)}, ${sqlValue(values.recipientPhone)}, ${sqlValue(values.deviceKey)},
  ${sqlValue(values.bindingKey)}, ${values.generation}, 'CLAIMED', ${sqlValue(values.token)}, 1,
  ${sqlValue(at)}, ${sqlValue(at)}
WHERE EXISTS (
  SELECT 1
  FROM whatsapp_accounts a
  JOIN device_bindings b ON b.binding_key = ${sqlValue(values.bindingKey)}
  WHERE a.account_key = ${sqlValue(values.accountKey)}
    AND a.health <> 'PAUSED'
    AND a.active_binding_key = b.binding_key
    AND a.current_generation = ${values.generation}
    AND b.account_key = a.account_key
    AND b.device_key = ${sqlValue(values.deviceKey)}
    AND b.generation = ${values.generation}
    AND b.status = 'ACTIVE'
)
ON CONFLICT(idem_key) DO NOTHING;

INSERT INTO send_events(
  idem_key, account_key, contact_key, recipient_phone, device_key,
  binding_generation, event_type, at_utc, myt_date, detail
)
SELECT idem_key, account_key, contact_key, recipient_phone, device_key,
       binding_generation, 'CLAIMED', ${sqlValue(at)}, ${sqlValue(mytDate(at))},
       'Atomic claim acquired and committed before provider API call.'
FROM send_claims
WHERE idem_key = ${sqlValue(values.idemKey)} AND claim_token = ${sqlValue(values.token)};
COMMIT;

SELECT
  EXISTS(
    SELECT 1 FROM whatsapp_accounts a JOIN device_bindings b ON b.binding_key = ${sqlValue(values.bindingKey)}
    WHERE a.account_key = ${sqlValue(values.accountKey)} AND a.active_binding_key = b.binding_key
      AND a.current_generation = ${values.generation} AND a.health <> 'PAUSED'
      AND b.device_key = ${sqlValue(values.deviceKey)} AND b.generation = ${values.generation}
      AND b.status = 'ACTIVE'
  ) AS permitted,
  EXISTS(SELECT 1 FROM send_claims WHERE idem_key=${sqlValue(values.idemKey)} AND claim_token=${sqlValue(values.token)}) AS acquired,
  (SELECT state FROM send_claims WHERE idem_key=${sqlValue(values.idemKey)}) AS currentState,
  (SELECT claim_token FROM send_claims WHERE idem_key=${sqlValue(values.idemKey)}) AS currentClaimToken;
`);
    return {
      idemKey: values.idemKey,
      acquired: Number(result?.acquired || 0) === 1,
      permitted: Number(result?.permitted || 0) === 1,
      state: result?.currentState || null,
      claimToken: Number(result?.acquired || 0) === 1 ? values.token : null,
      reason: Number(result?.acquired || 0) === 1
        ? "ACQUIRED"
        : Number(result?.permitted || 0) !== 1 ? "BINDING_NOT_PERMITTED" : "IDEM_ALREADY_CLAIMED",
    };
  }

  async function retryClaim({ idemKey, bindingKey, deviceKey, bindingGeneration } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const token = crypto.randomUUID();
    const generation = Number(bindingGeneration);
    const [result] = await db.query(`
BEGIN IMMEDIATE;
UPDATE send_claims
SET state='CLAIMED', claim_token=${sqlValue(token)}, attempt_count=attempt_count+1,
    claimed_at=${sqlValue(at)}, updated_at=${sqlValue(at)},
    last_error_code='', last_error_message=''
WHERE idem_key=${sqlValue(required("idemKey", idemKey))}
  AND state='FAILED_RETRYABLE'
  AND binding_key=${sqlValue(required("bindingKey", bindingKey))}
  AND device_key=${sqlValue(required("deviceKey", deviceKey))}
  AND binding_generation=${generation}
  AND EXISTS (
    SELECT 1 FROM whatsapp_accounts a JOIN device_bindings b ON b.binding_key=send_claims.binding_key
    WHERE a.account_key=send_claims.account_key AND a.active_binding_key=b.binding_key
      AND a.current_generation=${generation} AND a.health <> 'PAUSED'
      AND b.status='ACTIVE' AND b.generation=${generation}
  );
INSERT INTO send_events(
  idem_key, account_key, contact_key, recipient_phone, device_key,
  binding_generation, event_type, at_utc, myt_date, detail
)
SELECT idem_key, account_key, contact_key, recipient_phone, device_key,
       binding_generation, 'CLAIMED', ${sqlValue(at)}, ${sqlValue(mytDate(at))},
       'Controlled retry after provider confirmed the previous attempt was not sent.'
FROM send_claims WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(token)};
COMMIT;
SELECT EXISTS(SELECT 1 FROM send_claims WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(token)}) AS acquired;
`);
    return { acquired: Number(result?.acquired || 0) === 1, claimToken: Number(result?.acquired || 0) === 1 ? token : null };
  }

  async function markSent({ idemKey, claimToken, providerMessageId, sentAt = nowIso() } = {}) {
    await assertReady();
    const providerId = required("providerMessageId", providerMessageId);
    const db = await database();
    const [result] = await db.query(`
BEGIN IMMEDIATE;
UPDATE send_claims
SET state='SENT', provider_msg_id=${sqlValue(providerId)}, sent_at=${sqlValue(sentAt)},
    updated_at=${sqlValue(sentAt)}, last_error_code='', last_error_message=''
WHERE idem_key=${sqlValue(required("idemKey", idemKey))}
  AND claim_token=${sqlValue(required("claimToken", claimToken))}
  AND state='CLAIMED';
INSERT OR IGNORE INTO send_events(
  idem_key, account_key, contact_key, recipient_phone, device_key,
  binding_generation, event_type, provider_msg_id, at_utc, myt_date, detail
)
SELECT idem_key, account_key, contact_key, recipient_phone, device_key,
       binding_generation, 'SENT', provider_msg_id, ${sqlValue(sentAt)}, ${sqlValue(mytDate(sentAt))},
       'Provider acknowledged this message part.'
FROM send_claims
WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(claimToken)} AND state='SENT';
COMMIT;
SELECT state, provider_msg_id AS providerMessageId, sent_at AS sentAt
FROM send_claims WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(claimToken)};
`);
    if (result?.state !== "SENT") {
      const error = new Error("无法确认 SENT：claim token 不匹配、状态不是 CLAIMED，或记录不存在。");
      error.code = "SEND_CLAIM_FINALIZE_REJECTED";
      throw error;
    }
    return result;
  }

  async function markFailure({ idemKey, claimToken, errorCode = "", errorMessage = "", confirmedNotSent = false, retryable = false } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const state = confirmedNotSent ? (retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL") : "UNKNOWN";
    const eventType = confirmedNotSent ? state : (/timeout/i.test(errorCode) ? "TIMEOUT" : "UNKNOWN");
    const [result] = await db.query(`
BEGIN IMMEDIATE;
UPDATE send_claims
SET state=${sqlValue(state)}, updated_at=${sqlValue(at)},
    last_error_code=${sqlValue(errorCode)}, last_error_message=${sqlValue(errorMessage)}
WHERE idem_key=${sqlValue(required("idemKey", idemKey))}
  AND claim_token=${sqlValue(required("claimToken", claimToken))}
  AND state='CLAIMED';
INSERT INTO send_events(
  idem_key, account_key, contact_key, recipient_phone, device_key,
  binding_generation, event_type, at_utc, myt_date, error_code, detail
)
SELECT idem_key, account_key, contact_key, recipient_phone, device_key,
       binding_generation, ${sqlValue(eventType)}, ${sqlValue(at)}, ${sqlValue(mytDate(at))},
       ${sqlValue(errorCode)}, ${sqlValue(errorMessage)}
FROM send_claims
WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(claimToken)} AND state=${sqlValue(state)};
COMMIT;
SELECT state FROM send_claims WHERE idem_key=${sqlValue(idemKey)} AND claim_token=${sqlValue(claimToken)};
`);
    if (result?.state !== state) {
      const error = new Error("无法结算发送失败：claim token 或当前状态不匹配。");
      error.code = "SEND_CLAIM_FAILURE_REJECTED";
      throw error;
    }
    return { state, automaticRetryAllowed: state === "FAILED_RETRYABLE" };
  }

  async function recoverStaleClaims({ olderThanMs = 5 * 60 * 1000 } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const cutoff = new Date(new Date(at).getTime() - Math.max(0, Number(olderThanMs) || 0)).toISOString();
    const [result] = await db.query(`
BEGIN IMMEDIATE;
INSERT INTO send_events(
  idem_key, account_key, contact_key, recipient_phone, device_key,
  binding_generation, event_type, at_utc, myt_date, error_code, detail
)
SELECT idem_key, account_key, contact_key, recipient_phone, device_key,
       binding_generation, 'UNKNOWN', ${sqlValue(at)}, ${sqlValue(mytDate(at))},
       'STALE_CLAIM_RECOVERED', 'Program restarted or claim expired before a provider acknowledgement.'
FROM send_claims WHERE state='CLAIMED' AND claimed_at < ${sqlValue(cutoff)};
UPDATE send_claims
SET state='UNKNOWN', updated_at=${sqlValue(at)}, last_error_code='STALE_CLAIM_RECOVERED',
    last_error_message='Claim expired without a provider acknowledgement; manual review required.'
WHERE state='CLAIMED' AND claimed_at < ${sqlValue(cutoff)};
COMMIT;
SELECT changes() AS recovered;
`);
    return { recovered: Number(result?.recovered || 0), cutoff };
  }

  async function dailyUsage(accountKey, date = mytDate(clock())) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`
SELECT
  COUNT(DISTINCT contact_key) AS contactsSent,
  COUNT(*) AS messagesSent
FROM send_events
WHERE account_key=${sqlValue(required("accountKey", accountKey))}
  AND myt_date=${sqlValue(required("date", date))}
  AND event_type='SENT';
`);
    return { date, contactsSent: Number(row?.contactsSent || 0), messagesSent: Number(row?.messagesSent || 0) };
  }

  async function beginHandoff({ accountKey, sourceBindingKey, targetDeviceKey = "" } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const transferId = `handoff_${at.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
    const [result] = await db.query(`
BEGIN IMMEDIATE;
INSERT INTO handoff_transfers(
  transfer_id, account_key, source_binding_key, source_generation, target_device_key,
  state, created_at, updated_at
)
SELECT ${sqlValue(transferId)}, a.account_key, b.binding_key, b.generation,
       ${targetDeviceKey ? sqlValue(targetDeviceKey) : "NULL"}, 'PREPARING', ${sqlValue(at)}, ${sqlValue(at)}
FROM whatsapp_accounts a JOIN device_bindings b ON b.binding_key=a.active_binding_key
WHERE a.account_key=${sqlValue(required("accountKey", accountKey))}
  AND b.binding_key=${sqlValue(required("sourceBindingKey", sourceBindingKey))}
  AND b.status='ACTIVE' AND b.generation=a.current_generation
  AND NOT EXISTS(SELECT 1 FROM send_claims c WHERE c.account_key=a.account_key AND c.state='CLAIMED');
UPDATE device_bindings SET status='TRANSFERRING', updated_at=${sqlValue(at)}
WHERE binding_key=${sqlValue(sourceBindingKey)}
  AND EXISTS(SELECT 1 FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)});
INSERT INTO handoff_log(transfer_id, account_key, event_type, from_binding_key, from_generation, reason, created_at)
SELECT transfer_id, account_key, 'PREPARING', source_binding_key, source_generation,
       'Campaign scheduler frozen; waiting for a verified bundle export.', ${sqlValue(at)}
FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)};
COMMIT;
SELECT transfer_id AS transferId, state, source_generation AS sourceGeneration
FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)};
`);
    if (!result) {
      const error = new Error("无法开始交接：号码不是本机 ACTIVE、已有交接进行中，或仍有未结算 CLAIMED 消息。");
      error.code = "HANDOFF_PREPARE_REJECTED";
      throw error;
    }
    return result;
  }

  async function markHandoffExported({ transferId, bundleId, snapshotHash, expiresAt } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const [result] = await db.query(`
BEGIN IMMEDIATE;
UPDATE handoff_transfers
SET state='EXPORTED', bundle_id=${sqlValue(required("bundleId", bundleId))},
    snapshot_hash=${sqlValue(required("snapshotHash", snapshotHash))},
    bundle_expires_at=${sqlValue(required("expiresAt", expiresAt))}, updated_at=${sqlValue(at)}
WHERE transfer_id=${sqlValue(required("transferId", transferId))} AND state='PREPARING';
UPDATE device_bindings
SET status='RELEASED', released_at=${sqlValue(at)}, updated_at=${sqlValue(at)}
WHERE binding_key=(SELECT source_binding_key FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)} AND state='EXPORTED')
  AND status='TRANSFERRING';
UPDATE whatsapp_accounts
SET active_binding_key=NULL, updated_at=${sqlValue(at)}
WHERE account_key=(SELECT account_key FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)} AND state='EXPORTED');
INSERT INTO handoff_log(
  transfer_id, account_key, event_type, from_binding_key, from_generation,
  bundle_checksum, reason, created_at
)
SELECT transfer_id, account_key, 'EXPORTED', source_binding_key, source_generation,
       snapshot_hash, 'Verified encrypted bundle exported; source binding released.', ${sqlValue(at)}
FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)} AND state='EXPORTED';
COMMIT;
SELECT transfer_id AS transferId, state, bundle_id AS bundleId
FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)};
`);
    if (result?.state !== "EXPORTED") {
      const error = new Error("交接导出无法完成：transfer 不在 PREPARING，来源号码不会被释放。");
      error.code = "HANDOFF_EXPORT_REJECTED";
      throw error;
    }
    return result;
  }

  async function abortHandoff({ transferId, reason = "Bundle export failed before source release." } = {}) {
    await assertReady();
    const db = await database();
    const at = nowIso();
    const [result] = await db.query(`
BEGIN IMMEDIATE;
UPDATE handoff_transfers
SET state='ABORTED', error_code='HANDOFF_ABORTED', error_message=${sqlValue(reason)}, updated_at=${sqlValue(at)}
WHERE transfer_id=${sqlValue(required("transferId", transferId))} AND state='PREPARING';
UPDATE device_bindings
SET status='ACTIVE', updated_at=${sqlValue(at)}
WHERE binding_key=(SELECT source_binding_key FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)} AND state='ABORTED')
  AND status='TRANSFERRING';
INSERT INTO handoff_log(transfer_id, account_key, event_type, from_binding_key, from_generation, reason, created_at)
SELECT transfer_id, account_key, 'ABORTED', source_binding_key, source_generation, ${sqlValue(reason)}, ${sqlValue(at)}
FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)} AND state='ABORTED';
COMMIT;
SELECT state FROM handoff_transfers WHERE transfer_id=${sqlValue(transferId)};
`);
    if (result?.state !== "ABORTED") {
      const error = new Error("只有 PREPARING 状态可以安全撤销；Bundle 导出后来源电脑必须保持失权。");
      error.code = "HANDOFF_ABORT_UNSAFE";
      throw error;
    }
    return result;
  }

  async function buildHandoffSnapshot({ accountKey, transferId } = {}) {
    await assertReady();
    const db = await database();
    const account = required("accountKey", accountKey);
    const transfer = required("transferId", transferId);
    const [transferRow] = await db.query(`SELECT * FROM handoff_transfers WHERE transfer_id=${sqlValue(transfer)} AND account_key=${sqlValue(account)} AND state='PREPARING';`);
    if (!transferRow) {
      const error = new Error("只能为 PREPARING 状态建立交接快照。");
      error.code = "HANDOFF_SNAPSHOT_REJECTED";
      throw error;
    }
    const queries = {
      accounts: `SELECT * FROM whatsapp_accounts WHERE account_key=${sqlValue(account)};`,
      bindings: `SELECT * FROM device_bindings WHERE account_key=${sqlValue(account)};`,
      claims: `SELECT * FROM send_claims WHERE account_key=${sqlValue(account)} ORDER BY claimed_at;`,
      events: `SELECT * FROM send_events WHERE account_key=${sqlValue(account)} ORDER BY id;`,
      projectLeads: `SELECT * FROM project_leads WHERE assigned_account_key=${sqlValue(account)};`,
      contacts: `SELECT * FROM contacts WHERE stop_flag=1 OR contact_key IN (SELECT contact_key FROM project_leads WHERE assigned_account_key=${sqlValue(account)});`,
      campaignRuns: `SELECT * FROM campaign_runs WHERE run_id IN (SELECT DISTINCT campaign_run_id FROM send_claims WHERE account_key=${sqlValue(account)}) OR run_id IN (SELECT campaign_run_id FROM project_leads WHERE assigned_account_key=${sqlValue(account)} AND campaign_run_id IS NOT NULL);`,
      conversations: `SELECT * FROM conversations WHERE contact_key IN (SELECT contact_key FROM project_leads WHERE assigned_account_key=${sqlValue(account)});`,
      messages: `SELECT * FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_key IN (SELECT contact_key FROM project_leads WHERE assigned_account_key=${sqlValue(account)}));`,
      pendingSyncJobs: `SELECT * FROM sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY');`,
    };
    const snapshot = {
      format: "mamba-account-snapshot-v1",
      schemaVersion: 4,
      createdAt: nowIso(),
      transfer: transferRow,
      data: {},
    };
    for (const [name, sql] of Object.entries(queries)) snapshot.data[name] = await db.query(sql);
    return snapshot;
  }

  async function listManualReview(accountKey) {
    await assertReady();
    const db = await database();
    return db.query(`
SELECT idem_key AS idemKey, campaign_run_id AS campaignRunId, project_lead_key AS projectLeadKey,
       flow_topic AS flowTopic, part_no AS partNo, contact_key AS contactKey,
       state, provider_msg_id AS providerMessageId, updated_at AS updatedAt,
       last_error_code AS errorCode, last_error_message AS errorMessage
FROM send_claims
WHERE account_key=${sqlValue(required("accountKey", accountKey))}
  AND state IN (${[...TERMINAL_UNCERTAIN_STATES].map(sqlValue).join(",")})
ORDER BY updated_at;
`);
  }

  return {
    databasePath,
    assertReady,
    accountStatus,
    claimPart,
    retryClaim,
    markSent,
    markFailure,
    recoverStaleClaims,
    dailyUsage,
    beginHandoff,
    markHandoffExported,
    abortHandoff,
    buildHandoffSnapshot,
    listManualReview,
  };
}
