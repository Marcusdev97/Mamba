// 从 Global Postgres 读出面板要的那份 payload —— 也就是「两台合起来」的全貌。
//
// 刻意不装 pg 套件:直接叫 psql 用 JSON 输出,跟 sync-agent 一样的做法,
// 不给这个仓库多添一个 npm 依赖。
//
// 表结构从 information_schema 读(以 Postgres 里真正的样子为准),
// 中文注释从 docs/mamba-schema*.sql 贴回去。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchema } from './parse-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function psqlJson(url, sql) {
  const r = spawnSync('psql', [url, '-tAc', sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new Error(`psql 起不来:${r.error.message}`);
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(-3).join(' '));
  const text = (r.stdout || '').trim();
  if (!text || text === 'null') return [];
  return JSON.parse(text);
}

export function buildPgSnapshot({ url, maxRows = Infinity }) {
  // 文档里的注释和分层,拿来贴回去
  const docTables = parseSchema([
    { path: join(ROOT, 'docs/mamba-schema.sql'), version: 'v3' },
    { path: join(ROOT, 'docs/mamba-schema-v4.sql'), version: 'v4' },
  ]);
  const docByName = Object.fromEntries(docTables.map((t) => [t.name, t]));

  const cols = psqlJson(url, `
    select json_agg(row_to_json(t)) from (
      select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, c.ordinal_position,
             coalesce(pk.is_pk, false) as is_pk
      from information_schema.columns c
      left join (
        select kcu.table_name, kcu.column_name, true as is_pk
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
      ) pk on pk.table_name = c.table_name and pk.column_name = c.column_name
      where c.table_schema = 'public'
      order by c.table_name, c.ordinal_position
    ) t`);

  const counts = Object.fromEntries(
    psqlJson(url, `
      select json_agg(row_to_json(t)) from (
        select relname as table_name, n_live_tup as n
        from pg_stat_user_tables
      ) t`).map((r) => [r.table_name, Number(r.n)])
  );

  const typeMap = (t) => (
    /int|numeric|double|real/.test(t) ? 'INTEGER' : /bytea/.test(t) ? 'BLOB' : 'TEXT'
  );

  const byTable = {};
  for (const c of cols) (byTable[c.table_name] ||= []).push(c);

  const tables = [];
  const data = {};
  let rowsTotal = 0;

  for (const name of Object.keys(byTable).sort()) {
    const doc = docByName[name];
    const columns = byTable[name].map((c) => {
      const dc = doc?.columns.find((x) => x.name === c.column_name);
      return {
        name: c.column_name,
        type: typeMap(c.data_type),
        pk: c.is_pk,
        autoincrement: /nextval|identity/i.test(c.column_default || ''),
        notnull: c.is_nullable === 'NO',
        unique: false,
        default: c.column_default,
        check: dc?.check ?? null,
        enum: dc?.enum ?? null,
        ref: dc?.ref ?? null,
        note: c.column_name === 'source_device_key' ? '这一行是哪台电脑同步上来的'
          : c.column_name === 'synced_at' ? '什么时候同步上来的'
          : (dc?.note || ''),
      };
    });

    // 真的把资料捞出来。json_agg 一次一张表,messages 一万五千行也就几 MB。
    const limit = maxRows === Infinity ? '' : ` limit ${maxRows}`;
    const rows = psqlJson(url, `select json_agg(row_to_json(t)) from (select * from "${name}"${limit}) t`);
    data[name] = rows;
    rowsTotal += rows.length;

    tables.push({
      name,
      version: doc?.version || 'pg',
      section: name === 'sync_runs' ? '同步台账(Postgres 独有)' : (doc?.section || '附加表(库里有,文档 schema 未收录)'),
      desc: doc?.desc || '',
      columns,
      constraints: doc?.constraints || [],
      indexes: doc?.indexes || [],
      totalRows: counts[name] ?? rows.length,
      truncated: rows.length < (counts[name] ?? 0) && maxRows !== Infinity,
    });
  }

  const dbName = url.split('/').pop().split('?')[0];
  return {
    payload: {
      generated: new Date().toISOString(),
      db: {
        path: `Global Postgres · ${dbName}`,
        size: 0,
        at: new Date().toISOString(),
        rows: rowsTotal,
      },
      tables,
    },
    data,
  };
}
