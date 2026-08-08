import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { backupSqliteDatabase, clean, recentActiveRunState, sqlText } from "./sqlite-maintenance.mjs";

function sqlite(binary,databasePath,sql,{json=true,readOnly=true}={}){const output=execFileSync(binary,[...(readOnly?["-readonly"]:[]),"-batch",...(json?["-json"]:[]),databasePath,`PRAGMA foreign_keys=ON;\n${sql}`],{encoding:"utf8",maxBuffer:50*1024*1024});return json?(clean(output)?JSON.parse(output):[]):output;}
const checksum=(value)=>crypto.createHash("sha256").update(value).digest("hex");

export function featureMigrationPlan({rootDir,databasePath,binary="/usr/bin/sqlite3",migrationPath,version,name,prerequisite,requiredTables=[]}={}){
  if(!fs.existsSync(binary))throw new Error(`找不到 sqlite3：${binary}`);if(!fs.existsSync(databasePath))throw new Error(`找不到数据库：${databasePath}`);
  const sql=fs.readFileSync(migrationPath,"utf8"),hash=checksum(sql),migrations=sqlite(binary,databasePath,"SELECT version,name,checksum,applied_at AS appliedAt FROM schema_migrations ORDER BY version;"),applied=migrations.find(item=>Number(item.version)===version)||null;
  if(applied?.checksum&&applied.checksum!==hash)throw Object.assign(new Error(`${name} migration checksum mismatch.`),{code:"FEATURE_MIGRATION_CHECKSUM_MISMATCH"});
  const tables=new Set(sqlite(binary,databasePath,`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(sqlText).join(",")||"''"});`).map(row=>row.name));
  const fileRuns=recentActiveRunState(rootDir).activeRuns.map(item=>({source:"run_state",...item}));
  const hasRuns=sqlite(binary,databasePath,"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='campaign_runs';")[0]?.count;
  const dbRuns=hasRuns?sqlite(binary,databasePath,"SELECT run_id AS runId,status,mode,started_at AS startedAt FROM campaign_runs WHERE status IN ('RUNNING','SENDING','QUEUED','QUEUED_BATCH') ORDER BY started_at DESC;").map(item=>({source:"sqlite",...item})):[];
  const partial=!applied&&requiredTables.some(table=>tables.has(table)),blockers=[];
  if(!migrations.some(item=>Number(item.version)===prerequisite))blockers.push(`migration_${prerequisite}_required`);if(partial)blockers.push("partial_feature_schema");if(fileRuns.length||dbRuns.length)blockers.push("active_campaigns");
  return{version,name,checksum:hash,applied:Boolean(applied),blockers,activeRuns:[...fileRuns,...dbRuns],tables:{required:requiredTables,present:[...tables],missing:requiredTables.filter(table=>!tables.has(table))},sql};
}

export function migrateFeature(options={}){
  const plan=featureMigrationPlan(options),{sql,...publicPlan}=plan,report={mode:options.apply?"apply":"dry-run",databasePath:options.databasePath,plan:publicPlan};if(!options.apply||plan.applied)return report;
  if(options.confirmation!==options.confirmationToken)throw Object.assign(new Error(`Apply 需要 --confirm ${options.confirmationToken}。`),{code:"FEATURE_MIGRATION_CONFIRMATION_REQUIRED",report});
  if(plan.blockers.length)throw Object.assign(new Error(`${options.name} migration 已暂停：${plan.blockers.join(", ")}。`),{code:plan.blockers.includes("active_campaigns")?"ACTIVE_CAMPAIGN_BLOCKS_SCHEMA_MIGRATION":"FEATURE_MIGRATION_BLOCKED",report});
  const backupPath=backupSqliteDatabase({binary:options.binary||"/usr/bin/sqlite3",rootDir:options.rootDir,databasePath:options.databasePath,prefix:`before-${options.name}`}),at=new Date().toISOString(),started=Date.now();
  sqlite(options.binary||"/usr/bin/sqlite3",options.databasePath,`BEGIN IMMEDIATE;\n${sql}\nINSERT INTO schema_migrations(version,name,checksum,applied_at,duration_ms,result) VALUES(${options.version},${sqlText(options.name)},${sqlText(plan.checksum)},${sqlText(at)},0,'APPLIED');\nINSERT INTO metadata(key,value,updated_at) VALUES(${sqlText(options.metadataKey)},${sqlText(String(options.version))},${sqlText(at)}),('last_backup_at',${sqlText(at)},${sqlText(at)}),('last_migrated_at',${sqlText(at)},${sqlText(at)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;\nCOMMIT;`,{json:false,readOnly:false});
  sqlite(options.binary||"/usr/bin/sqlite3",options.databasePath,`UPDATE schema_migrations SET duration_ms=${Date.now()-started} WHERE version=${options.version};`,{json:false,readOnly:false});
  const quick=sqlite(options.binary||"/usr/bin/sqlite3",options.databasePath,"PRAGMA quick_check;"),foreign=sqlite(options.binary||"/usr/bin/sqlite3",options.databasePath,"PRAGMA foreign_key_check;"),after=featureMigrationPlan(options);
  if(quick[0]?.quick_check!=="ok"||foreign.length||after.tables.missing.length)throw Object.assign(new Error(`Migration 验证失败；请使用备份恢复：${backupPath}`),{code:"FEATURE_MIGRATION_VERIFICATION_FAILED",report:{...report,backupPath,quick,foreign,missing:after.tables.missing}});
  return{...report,backupPath,verification:{quickCheck:"ok",foreignKeyErrors:0,missingTables:[]},appliedPlan:{...after,sql:undefined}};
}
