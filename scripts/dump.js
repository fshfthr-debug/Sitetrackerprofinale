#!/usr/bin/env node
/**
 * Downloads a full copy of the database to a file on this computer.
 *
 *   npm run backup:download
 *   npm run backup:download -- --out ~/Desktop/timona.sql
 *
 * The result is one plain .sql file you can keep anywhere — a USB stick, cloud
 * drive, email — and load back with `npm run db:restore -- <file>`, with psql,
 * or by pasting it into Neon's SQL editor. It contains the complete schema, every
 * row of every table, and the sequence resets so new records get the right ids.
 *
 * Why not pg_dump: it is not installed everywhere, and this runs without extra
 * tooling. Everything is read inside one repeatable-read transaction, so the
 * file is a consistent snapshot even if people are using the app meanwhile.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const file of [
  path.join(ROOT, '.env.local'),
  path.join(ROOT, '.env'),
  path.join(ROOT, 'sitetrackerpro-app', 'backend', '.env')
]) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}

const { Client } = require('pg');

const ARGS = process.argv.slice(2);
const outIndex = ARGS.findIndex(arg => arg === '--out' || arg === '-o');
const requested = outIndex >= 0 ? ARGS[outIndex + 1] : null;

const connectionString = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('❌ No database URL found. Run `neon deploy` first, or set DATABASE_URL.');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const outPath = path.resolve(requested || path.join(ROOT, 'backups', `sitetrackerpro-${stamp}.sql`));

const ROWS_PER_STATEMENT = 200;   // keeps each INSERT a readable size
const FETCH_BATCH = 1000;

// A SQL literal. Numeric columns arrive as strings from pg, which is why strings
// are the common case: quoting them is always valid, whatever the column type.
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'`;
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

const quote = (identifier) => '"' + String(identifier).replace(/"/g, '""') + '"';

/** The schema, minus its seed rows: this dump carries the live rows itself. */
function schemaWithoutSeed() {
  const file = path.join(ROOT, 'sitetrackerpro-app', 'database', 'schema.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const start = sql.indexOf('-- ==================== SEED DATA');
  const end = sql.indexOf('-- ==================== VIEWS');
  if (start === -1 || end === -1) return sql;
  return sql.slice(0, start) + '-- (seed rows omitted here: they are in the data below)\n\n' + sql.slice(end);
}

/**
 * Parents before children, so the INSERTs never break a foreign key. Tables are
 * sorted by their foreign-key depth rather than a hard-coded list, so a new
 * table is handled automatically.
 */
async function orderTables(client) {
  const tables = (await client.query(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`
  )).rows.map(row => row.name);

  const links = (await client.query(
    `SELECT (SELECT relname FROM pg_class WHERE oid = con.conrelid) AS child,
            (SELECT relname FROM pg_class WHERE oid = con.confrelid) AS parent
       FROM pg_constraint con
      WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`
  )).rows.filter(row => row.parent && row.child && row.parent !== row.child);

  const ordered = [];
  const remaining = new Set(tables);

  while (remaining.size > 0) {
    const ready = [...remaining].filter(name =>
      !links.some(link => link.child === name && remaining.has(link.parent) && link.parent !== name)
    );
    if (ready.length === 0) {
      // A cycle (not present in this schema): fall back to alphabetical so the
      // dump still completes, and say so in the file.
      ordered.push(...[...remaining].sort());
      break;
    }
    ordered.push(...ready.sort());
    ready.forEach(name => remaining.delete(name));
  }

  return ordered;
}

async function main() {
  const client = new Client({
    connectionString,
    ssl: /sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined
  });

  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const identity = await client.query('SELECT current_database() AS db, current_user AS who, now() AS at');
  const host = connectionString.replace(/:\/\/[^@]*@/, '://').replace(/\?.*$/, '');
  const tables = await orderTables(client);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { mode: 0o600 });

  out.write(
`-- SiteTrackerPro database backup
-- Taken ${identity.rows[0].at.toISOString()} by ${identity.rows[0].who}
-- Source ${host}  (database: ${identity.rows[0].db})
--
-- Restore it with:   npm run db:restore -- ${path.basename(outPath)}
-- or paste the whole file into the Neon SQL editor.
-- Restoring REPLACES the contents of every table listed below.

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

-- ==================== SCHEMA ====================
${schemaWithoutSeed()}

-- ==================== CLEAR OLD DATA ====================
TRUNCATE TABLE ${tables.map(quote).join(', ')} RESTART IDENTITY CASCADE;

-- ==================== DATA ====================
`);

  let totalRows = 0;
  const empty = [];

  for (const table of tables) {
    const columns = (await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    )).rows;
    const names = columns.map(column => column.column_name);
    const orderBy = names.includes('id') ? ' ORDER BY id' : '';

    out.write(`\n-- ${table}\n`);
    let offset = 0;
    let written = 0;

    for (;;) {
      const rows = (await client.query(
        `SELECT * FROM ${quote(table)}${orderBy} LIMIT ${FETCH_BATCH} OFFSET ${offset}`
      )).rows;
      if (rows.length === 0) break;

      for (let index = 0; index < rows.length; index += ROWS_PER_STATEMENT) {
        const chunk = rows.slice(index, index + ROWS_PER_STATEMENT);
        const values = chunk.map(row => '(' + names.map(name => literal(row[name])).join(', ') + ')');
        out.write(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES\n${values.join(',\n')};\n`);
      }

      written += rows.length;
      offset += rows.length;
      if (rows.length < FETCH_BATCH) break;
    }

    totalRows += written;
    if (written === 0) empty.push(table);
    out.write(written === 0 ? '-- (no rows)\n' : `-- ${written} row(s)\n`);
  }

  out.write('\n-- ==================== SEQUENCES ====================\n');
  for (const table of tables) {
    const hasId = (await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
      [table]
    )).rowCount > 0;
    if (!hasId) continue;

    out.write(
`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
  COALESCE((SELECT MAX(id) FROM ${quote(table)}), 1),
  (SELECT MAX(id) FROM ${quote(table)}) IS NOT NULL);
`);
  }

  out.write('\n-- ==================== END OF BACKUP ====================\n');
  await new Promise(resolve => out.end(resolve));

  await client.query('COMMIT');
  await client.end();

  const bytes = fs.statSync(outPath).size;
  console.log(`\n✅ Backup written to ${outPath}`);
  console.log(`   ${tables.length} tables, ${totalRows} rows, ${(bytes / 1024).toFixed(1)} KB`);
  if (empty.length) console.log(`   Tables with no rows: ${empty.join(', ')}`);
  console.log('\n   Keep a copy off this machine — that is the point of this file.');
  console.log(`   Reload it with: npm run db:restore -- "${outPath}"`);
}

main().catch(err => {
  console.error('\n❌ Backup failed:', err.message);
  process.exit(1);
});
