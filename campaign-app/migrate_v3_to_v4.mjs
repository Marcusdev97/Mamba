#!/usr/bin/env node

// Mamba SQLite v3 -> v4 candidate migration.
// Default is DRY RUN. --apply creates a NEW mamba.v4.sqlite and never edits v3.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSendIdemKey, mytDate } from "./lib/account-device-binding-service.mjs";
import { createSqliteCli, findSqliteCli, runSqliteProcess, sqlValue } from "./lib/sqlite-cli.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, "..");

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseArgs(argv) {
  const args = {
    source: path.join(ROOT, "campaign-data", "mamba.sqlite"),
    output: path.join(ROOT, "campaign-data", "mamba.v4.sqlite"),
    schema: path.join(ROOT, "docs", "mamba-schema-v4.sql"),
    runsDir: path.join(ROOT, "campaign-data", "runs"),
    apply: false,
    force: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--force") args.force = true;
    else if (arg === "--db" || arg === "--source") args.source = path.resolve(argv[++index]);
    else if (arg === "--out") args.output = path.resolve(argv[++index]);
    else if (arg === "--schema") args.schema = path.resolve(argv[++index]);
    else if (arg === "--runs") args.runsDir = path.resolve(argv[++index]);
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function readRuns(runsDir) {
  let names = [];
  try { names = await fs.readdir(runsDir); } catch { return []; }
  const runs = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(runsDir, name), "utf8"));
      if (run?.runId && Array.isArray(run?.assignments)) runs.push(run);
    } catch {}
  }
  return runs;
}

function projectCodeForRun(run) {
  return slug(run?.project?.id || run?.campaignId || run?.project?.name || run?.project);
}

function evidenceFromRuns(runs, { connectionByInstancePhone, onlyAccountByInstance, validLeadKeys }) {
  const rows = new Map();
  const report = { runFiles: runs.length, sent: 0, unverified: 0, unknown: 0, skippedNoAccount: 0, skippedNoLead: 0, collisions: 0 };
  for (const run of runs) {
    const projectCode = projectCodeForRun(run);
    const instanceOwners = new Map((run.instances || []).map((item) => [clean(item?.name), normalizePhone(item?.owner)]));
    const flowTopic = clean(run.flowLabel || run?.templateFlow?.label || run?.templateFlow?.topic || run.campaignId || "campaign");
    for (const job of run.assignments) {
      const contactKey = normalizePhone(job?.lead?.phone);
      const projectLeadKey = projectCode && contactKey ? `${projectCode}:${contactKey}` : "";
      if (!projectLeadKey || !validLeadKeys.has(projectLeadKey)) {
        report.skippedNoLead += 1;
        continue;
      }
      const instanceName = clean(job.instanceName);
      const owner = instanceOwners.get(instanceName) || "";
      const connection = connectionByInstancePhone.get(`${instanceName}\0${owner}`)
        || onlyAccountByInstance.get(instanceName)
        || null;
      if (!connection?.accountKey) {
        report.skippedNoAccount += 1;
        continue;
      }
      const candidates = [
        { partNo: 1, sentInfo: job.part1, sending: job.status === "SENDING_PART1" },
        { partNo: 2, sentInfo: job.part2, sending: job.status === "SENDING_PART2" },
        ...(Array.isArray(job.extraParts) ? job.extraParts.map((part, index) => ({
          partNo: index + 3,
          sentInfo: part?.sentInfo,
          sending: job.status === `SENDING_PART${index + 3}`,
        })) : []),
      ];
      for (const candidate of candidates) {
        const sentAt = clean(candidate.sentInfo?.sentAt);
        const providerMessageId = clean(candidate.sentInfo?.messageId);
        let state = "";
        if (sentAt && providerMessageId) state = "SENT";
        else if (sentAt) state = "LEGACY_UNVERIFIED";
        else if (candidate.sending) state = "UNKNOWN";
        if (!state) continue;
        const idemKey = buildSendIdemKey({ campaignRunId: run.runId, projectLeadKey, flowTopic, partNo: candidate.partNo });
        const row = {
          idemKey,
          campaignRunId: run.runId,
          projectLeadKey,
          flowTopic,
          partNo: candidate.partNo,
          accountKey: connection.accountKey,
          contactKey,
          recipientPhone: contactKey,
          deviceKey: connection.deviceKey,
          bindingKey: connection.bindingKey,
          bindingGeneration: connection.generation,
          state,
          providerMessageId: providerMessageId || null,
          at: sentAt || clean(run.updatedAt) || new Date().toISOString(),
        };
        const previous = rows.get(idemKey);
        if (previous) {
          report.collisions += 1;
          const rank = { UNKNOWN: 1, LEGACY_UNVERIFIED: 2, SENT: 3 };
          if (rank[state] > rank[previous.state]) rows.set(idemKey, row);
        } else rows.set(idemKey, row);
      }
    }
  }
  for (const row of rows.values()) {
    if (row.state === "SENT") report.sent += 1;
    else if (row.state === "UNKNOWN") report.unknown += 1;
    else report.unverified += 1;
  }
  return { rows: [...rows.values()], report };
}

async function inspectSource(db, runs) {
  const [versionRow] = await db.query("PRAGMA user_version;");
  const schemaVersion = Number(versionRow?.user_version || 0);
  if (schemaVersion !== 3) {
    const error = new Error(`来源数据库必须是 v3，当前是 v${schemaVersion || 0}。`);
    error.code = "V3_V4_SOURCE_VERSION_INVALID";
    throw error;
  }
  const connections = await db.query(`
SELECT connection_key AS bindingKey, instance_name AS instanceName,
       whatsapp_number AS accountKey, device_key AS deviceKey, status
FROM whatsapp_connections
WHERE whatsapp_number <> '' AND device_key IS NOT NULL
ORDER BY whatsapp_number, connection_key;
`);
  const [metadata] = await db.query(`
SELECT
  COALESCE((SELECT value FROM metadata WHERE key='expected_sender_key'),'') AS expectedSenderKey,
  COALESCE((SELECT value FROM metadata WHERE key='expected_sender_phone'),'') AS expectedSenderPhone;
`);
  const leadRows = await db.query("SELECT project_lead_key AS projectLeadKey FROM project_leads;");
  const validLeadKeys = new Set(leadRows.map((row) => clean(row.projectLeadKey)));
  const byAccount = new Map();
  for (const raw of connections) {
    const accountKey = normalizePhone(raw.accountKey);
    if (!accountKey) continue;
    const row = { ...raw, accountKey };
    if (!byAccount.has(accountKey)) byAccount.set(accountKey, []);
    byAccount.get(accountKey).push(row);
  }
  const bindingPlans = [];
  const accounts = [];
  const ambiguousAccounts = [];
  for (const [accountKey, items] of byAccount) {
    const expected = items.find((item) => item.bindingKey === clean(metadata?.expectedSenderKey));
    const active = expected || (items.length === 1 ? items[0] : null);
    if (!active) ambiguousAccounts.push(accountKey);
    const ordered = items.filter((item) => item !== active);
    if (active) ordered.push(active);
    ordered.forEach((item, index) => bindingPlans.push({
      ...item,
      generation: index + 1,
      bindingStatus: item === active ? "ACTIVE" : "REVOKED",
    }));
    accounts.push({
      accountKey,
      currentGeneration: active ? ordered.length : ordered.length + 1,
      activeBindingKey: active?.bindingKey || null,
    });
  }
  const plannedByBinding = new Map(bindingPlans.map((row) => [row.bindingKey, row]));
  const connectionByInstancePhone = new Map();
  const candidatesByInstance = new Map();
  for (const row of bindingPlans) {
    connectionByInstancePhone.set(`${clean(row.instanceName)}\0${row.accountKey}`, row);
    const key = clean(row.instanceName);
    if (!candidatesByInstance.has(key)) candidatesByInstance.set(key, []);
    candidatesByInstance.get(key).push(row);
  }
  const onlyAccountByInstance = new Map([...candidatesByInstance].flatMap(([key, values]) => values.length === 1 ? [[key, values[0]]] : []));
  const evidence = evidenceFromRuns(runs, { connectionByInstancePhone, onlyAccountByInstance, validLeadKeys });
  return {
    schemaVersion,
    metadata,
    connections,
    accounts,
    bindingPlans,
    plannedByBinding,
    ambiguousAccounts,
    evidence,
    counts: {
      accounts: accounts.length,
      bindings: bindingPlans.length,
      activeBindings: bindingPlans.filter((row) => row.bindingStatus === "ACTIVE").length,
      leads: validLeadKeys.size,
    },
  };
}

async function seedV4(db, plan) {
  const now = new Date().toISOString();
  const accountSql = [];
  for (const account of plan.accounts) {
    const [warmup] = await db.query(`
SELECT MIN(first_blast_at) AS firstBlastAt
FROM project_leads
WHERE last_sender_phone=${sqlValue(account.accountKey)}
   OR assigned_sender_key LIKE ${sqlValue(`%::${account.accountKey}`)};
`);
    const warmupStartedAt = clean(warmup?.firstBlastAt) || null;
    accountSql.push(`INSERT INTO whatsapp_accounts(
      account_key, warmth, warmup_started_at, allowed_max_mode,
      daily_cap_contacts, daily_cap_messages, health, current_generation,
      active_binding_key, created_at, updated_at
    ) VALUES (
      ${sqlValue(account.accountKey)}, ${sqlValue(warmupStartedAt ? "WARMING" : "NEW")},
      ${sqlValue(warmupStartedAt)}, 'conservative', 0, 0, 'OK', ${account.currentGeneration},
      ${sqlValue(account.activeBindingKey)}, ${sqlValue(now)}, ${sqlValue(now)}
    );`);
  }
  const bindingSql = plan.bindingPlans.map((row) => `INSERT INTO device_bindings(
    binding_key, account_key, device_key, instance_name, status, generation,
    bound_at, released_at, created_at, updated_at
  ) VALUES (
    ${sqlValue(row.bindingKey)}, ${sqlValue(row.accountKey)}, ${sqlValue(row.deviceKey)},
    ${sqlValue(row.instanceName)}, ${sqlValue(row.bindingStatus)}, ${row.generation},
    ${row.bindingStatus === "ACTIVE" ? sqlValue(now) : "NULL"},
    ${row.bindingStatus === "REVOKED" ? sqlValue(now) : "NULL"}, ${sqlValue(now)}, ${sqlValue(now)}
  );`);
  await db.exec(`BEGIN IMMEDIATE;\n${accountSql.join("\n")}\n${bindingSql.join("\n")}\nCOMMIT;`);

  const columns = await db.query("PRAGMA table_info(project_leads);");
  if (!columns.some((column) => column.name === "assigned_account_key")) {
    await db.exec("ALTER TABLE project_leads ADD COLUMN assigned_account_key TEXT REFERENCES whatsapp_accounts(account_key) ON DELETE SET NULL;");
    await db.exec("CREATE INDEX IF NOT EXISTS idx_leads_account ON project_leads(assigned_account_key);");
  }
  const leadRows = await db.query("SELECT project_lead_key AS projectLeadKey, last_sender_phone AS lastSenderPhone, assigned_sender_key AS assignedSenderKey FROM project_leads;");
  const soleAccount = plan.accounts.length === 1 ? plan.accounts[0].accountKey : "";
  const updates = [];
  for (const lead of leadRows) {
    const fromPhone = normalizePhone(lead.lastSenderPhone);
    const assignedBinding = plan.plannedByBinding.get(clean(lead.assignedSenderKey));
    const accountKey = plan.accounts.some((item) => item.accountKey === fromPhone)
      ? fromPhone
      : assignedBinding?.accountKey || soleAccount;
    if (accountKey) updates.push(`UPDATE project_leads SET assigned_account_key=${sqlValue(accountKey)} WHERE project_lead_key=${sqlValue(lead.projectLeadKey)};`);
  }
  if (updates.length) await db.exec(`BEGIN IMMEDIATE;\n${updates.join("\n")}\nCOMMIT;`);

  const evidenceSql = [];
  for (const row of plan.evidence.rows) {
    const token = `legacy_${cryptoRandomId(row.idemKey)}`;
    evidenceSql.push(`INSERT OR IGNORE INTO send_claims(
      idem_key, campaign_run_id, project_lead_key, flow_topic, part_no,
      account_key, contact_key, recipient_phone, device_key, binding_key,
      binding_generation, state, claim_token, provider_msg_id, attempt_count,
      claimed_at, sent_at, updated_at, last_error_code, last_error_message
    ) VALUES (
      ${sqlValue(row.idemKey)}, ${sqlValue(row.campaignRunId)}, ${sqlValue(row.projectLeadKey)},
      ${sqlValue(row.flowTopic)}, ${row.partNo}, ${sqlValue(row.accountKey)},
      ${sqlValue(row.contactKey)}, ${sqlValue(row.recipientPhone)}, ${sqlValue(row.deviceKey)},
      ${sqlValue(row.bindingKey)}, ${row.bindingGeneration}, ${sqlValue(row.state)}, ${sqlValue(token)},
      ${sqlValue(row.providerMessageId)}, 0, ${sqlValue(row.at)},
      ${row.state === "SENT" ? sqlValue(row.at) : "NULL"}, ${sqlValue(row.at)},
      ${row.state === "SENT" ? "''" : sqlValue(`MIGRATED_${row.state}`)},
      ${row.state === "SENT" ? "''" : sqlValue("Historical part evidence is incomplete; manual review required.")}
    );`);
    evidenceSql.push(`INSERT OR IGNORE INTO send_events(
      idem_key, account_key, contact_key, recipient_phone, device_key,
      binding_generation, event_type, provider_msg_id, at_utc, myt_date, error_code, detail
    ) VALUES (
      ${sqlValue(row.idemKey)}, ${sqlValue(row.accountKey)}, ${sqlValue(row.contactKey)},
      ${sqlValue(row.recipientPhone)}, ${sqlValue(row.deviceKey)}, ${row.bindingGeneration},
      ${sqlValue(row.state)}, ${sqlValue(row.providerMessageId)}, ${sqlValue(row.at)},
      ${sqlValue(mytDate(row.at))}, ${row.state === "SENT" ? "''" : sqlValue(`MIGRATED_${row.state}`)},
      ${sqlValue(row.state === "SENT" ? "Migrated from run JSON with part timestamp and provider message id." : "Historical evidence is incomplete; do not auto-send.")}
    );`);
  }
  if (evidenceSql.length) await db.exec(`BEGIN IMMEDIATE;\n${evidenceSql.join("\n")}\nCOMMIT;`, 300000);
}

function cryptoRandomId(value) {
  return Buffer.from(String(value)).toString("base64url").slice(0, 24);
}

async function validateTarget(db) {
  const [quick] = await db.query("PRAGMA quick_check;");
  const foreignKeys = await db.query("PRAGMA foreign_key_check;");
  const [version] = await db.query("PRAGMA user_version;");
  const [counts] = await db.query(`
SELECT
  (SELECT COUNT(*) FROM whatsapp_accounts) AS accounts,
  (SELECT COUNT(*) FROM device_bindings WHERE status='ACTIVE') AS activeBindings,
  (SELECT COUNT(*) FROM send_claims) AS claims,
  (SELECT COUNT(*) FROM send_events WHERE event_type='SENT') AS sentEvents,
  (SELECT COUNT(*) FROM send_events WHERE event_type IN ('UNKNOWN','LEGACY_UNVERIFIED')) AS manualReview;
`);
  return {
    quickCheck: quick?.quick_check || "unknown",
    foreignKeyErrors: foreignKeys.length,
    schemaVersion: Number(version?.user_version || 0),
    counts,
    ok: quick?.quick_check === "ok" && foreignKeys.length === 0 && Number(version?.user_version) === 4,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!(await exists(args.source))) throw new Error(`找不到 v3 数据库：${args.source}`);
  const binary = await findSqliteCli();
  if (!binary) throw new Error("找不到 sqlite3。");
  const sourceDb = await createSqliteCli({ databasePath: args.source, sqliteBinary: binary });
  const runs = await readRuns(args.runsDir);
  const plan = await inspectSource(sourceDb, runs);
  const report = {
    mode: args.apply ? "APPLY" : "DRY_RUN",
    source: args.source,
    output: args.output,
    sourceSchemaVersion: plan.schemaVersion,
    ...plan.counts,
    ambiguousAccounts: plan.ambiguousAccounts,
    historicalEvidence: plan.evidence.report,
    safeToCutover: false,
    notes: [
      "This migration only creates a v4 SHADOW candidate.",
      "send_claims enforcement and handoff UI stay disabled.",
      ...(plan.ambiguousAccounts.length ? ["Some accounts have no unambiguous ACTIVE binding and require manual selection."] : []),
    ],
  };
  if (!args.apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (await exists(args.output)) {
    if (!args.force) throw new Error(`输出文件已经存在：${args.output}。请换 --out，或明确使用 --force 重建候选库。`);
    await fs.unlink(args.output);
  }
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await runSqliteProcess(binary, [args.source, `.backup '${args.output.replaceAll("'", "''")}'`], "", 300000);
  const targetDb = await createSqliteCli({ databasePath: args.output, sqliteBinary: binary });
  const extension = await fs.readFile(args.schema, "utf8");
  try {
    await targetDb.exec(extension, 300000);
    await seedV4(targetDb, plan);
    const validation = await validateTarget(targetDb);
    if (!validation.ok) throw new Error(`v4 validation failed: ${JSON.stringify(validation)}`);
    console.log(JSON.stringify({ ...report, validation }, null, 2));
  } catch (error) {
    await fs.unlink(args.output).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(`[migrate-v3-v4] ${error.code || "FAILED"}: ${error.message}`);
  process.exitCode = 1;
});
