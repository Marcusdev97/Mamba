// Shared SQLite-schema parser: turns the CREATE TABLE / CREATE INDEX blocks of
// docs/mamba-schema*.sql into a structured description (columns, keys, CHECK
// enums, foreign keys, indexes, and the Chinese comments attached to each).
//
// Used by tools/sql-html/build.mjs and tools/pg/build-postgres.mjs.
import { readFileSync } from 'node:fs';

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '', inLineComment = false, inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inLineComment) { cur += c; if (c === '\n') inLineComment = false; continue; }
    if (inStr) { cur += c; if (c === "'") inStr = false; continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '-' && body[i + 1] === '-') { inLineComment = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function stripComment(s) {
  // remove -- comment (naive but fine: no -- inside our string literals)
  const out = [];
  for (const line of s.split('\n')) {
    const idx = line.indexOf('--');
    out.push(idx >= 0 ? line.slice(0, idx) : line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Only comments on/after the line the column actually starts on belong to it;
// anything before that is a trailing comment of the previous column.
function collectComments(s, colName) {
  const lines = s.split('\n');
  let start = 0;
  if (colName) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*${colName}\\s`).test(l));
    if (at >= 0) start = at;
  }
  const notes = [];
  for (const line of lines.slice(start)) {
    const idx = line.indexOf('--');
    if (idx >= 0) notes.push(line.slice(idx + 2).trim());
  }
  return notes.join(' ').trim();
}

// 从一段 DDL 文本解析(用于 sqlite_master 里的真实建表语句)。
export function parseSchemaText(sql, version = 'live') {
  return parseSchema([{ sql, version }]);
}

export function parseSchema(files) {
  const tables = [];

  for (const { path, sql: rawSql, version } of files) {
  const sql = rawSql ?? readFileSync(path, 'utf8');
  const lines = sql.split('\n');

  // section headers: -- ===== blocks with a title line
  let section = '';
  const sectionAtLine = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^--\s*={5,}/.test(l)) {
      const next = lines[i + 1] || '';
      const m = next.match(/^--\s*([A-G]\.\s*.+)$/);
      if (m) section = m[1].trim();
    }
    sectionAtLine[i] = section;
  }

  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    const startIdx = m.index + m[0].length;
    let depth = 1, i = startIdx, inStr = false, inLine = false;
    while (i < sql.length && depth > 0) {
      const c = sql[i];
      if (inLine) { if (c === '\n') inLine = false; i++; continue; }
      if (inStr) { if (c === "'") inStr = false; i++; continue; }
      if (c === "'") inStr = true;
      else if (c === '-' && sql[i + 1] === '-') inLine = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const body = sql.slice(startIdx, i - 1);
    const lineNo = sql.slice(0, m.index).split('\n').length - 1;

    // leading comment block above the CREATE
    const desc = [];
    for (let k = lineNo - 1; k >= 0; k--) {
      const l = lines[k].trim();
      if (l.startsWith('--') && !/^--\s*={5,}/.test(l)) desc.unshift(l.replace(/^--\s*/, ''));
      else break;
    }

    const columns = [];
    const constraints = [];
    for (const rawPart of splitTopLevel(body)) {
      const clean = stripComment(rawPart);
      if (!clean) continue;
      const upper = clean.toUpperCase();
      if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/.test(upper)) {
        constraints.push(clean);
        continue;
      }
      const cm = clean.match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b(.*)$/i);
      if (!cm) continue;
      const [, colName, type, restRaw] = cm;
      const rest = restRaw.trim();
      const def = rest.match(/DEFAULT\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|\(.*?\))/i);
      const check = rest.match(/CHECK\s*\((.*)\)\s*$/i) || rest.match(/CHECK\s*\(([^]*?)\)(?=\s*(?:REFERENCES|$))/i);
      const refs = rest.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      let enumVals = null;
      const inMatch = rest.match(/IN\s*\(([^)]*)\)/i);
      if (inMatch && /CHECK/i.test(rest)) {
        enumVals = inMatch[1]
          .split(',')
          .map((v) => v.trim())
          .filter((v) => /^'.*'$/.test(v) || /^-?\d+$/.test(v))
          .map((v) => (v.startsWith("'") ? v.slice(1, -1) : v));
        if (!enumVals.length) enumVals = null;
      }
      columns.push({
        name: colName,
        type: type.toUpperCase(),
        pk: /PRIMARY KEY/i.test(rest),
        autoincrement: /AUTOINCREMENT/i.test(rest),
        notnull: /NOT NULL/i.test(rest),
        unique: /\bUNIQUE\b/i.test(rest),
        default: def ? def[1] : null,
        check: check ? check[1].replace(/\s+/g, ' ').trim() : null,
        enum: enumVals,
        ref: refs ? { table: refs[1], column: refs[2] } : null,
        note: collectComments(rawPart, colName),
      });
    }

    // table-level PK (e.g. PRIMARY KEY (group_id, member_id))
    const pkCols = [];
    for (const c of constraints) {
      const pk = c.match(/^PRIMARY KEY\s*\(([^)]*)\)/i);
      if (pk) pkCols.push(...pk[1].split(',').map((s) => s.trim()));
    }
    for (const col of columns) if (pkCols.includes(col.name)) col.pk = true;

    // table-level FKs → hang them on the column so the UI can show the link
    for (const c of constraints) {
      const fk = c.match(/^FOREIGN KEY\s*\((\w+)\)\s*REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (!fk) continue;
      const col = columns.find((x) => x.name === fk[1]);
      if (col && !col.ref) col.ref = { table: fk[2], column: fk[3] };
    }

    tables.push({
      name,
      version,
      section: sectionAtLine[lineNo] || '',
      desc: desc.join(' '),
      columns,
      constraints,
    });
  }

  // indexes
  const idxRe = /CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)\s*\n?\s*ON (\w+)\(([^;]*?)\)([^;]*);/g;
  let im;
  while ((im = idxRe.exec(sql))) {
    const t = tables.find((x) => x.name === im[3]);
    if (!t) continue;
    (t.indexes ||= []).push({
      name: im[2],
      unique: Boolean(im[1]),
      cols: im[4].replace(/\s+/g, ' ').trim(),
      where: (im[5] || '').replace(/\s+/g, ' ').trim(),
    });
  }
}

  return tables;
}
