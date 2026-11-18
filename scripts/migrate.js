#!/usr/bin/env node
/**
 * Applies sitetrackerpro-app/database/schema.sql to the database in DATABASE_URL.
 *
 * Neon's policy file provisions the database itself (an empty, branchable
 * Postgres); the tables are created here, so the schema is versioned in the repo
 * instead of hand-run in a SQL editor. Safe to run repeatedly:
 *
 *   - every table and index uses IF NOT EXISTS,
 *   - views and the variance function are CREATE OR REPLACE,
 *   - the Ethiopian materials seed is only inserted when that table is still empty
 *     (the seed has no unique key, so re-running it would duplicate 50 rows).
 *
 * Migrations need a direct connection, not the pooled one, because the whole file
 * runs as one session. Neon provides DATABASE_URL_UNPOOLED for exactly this.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILES = [
  path.join(ROOT, '.env.local'),
  path.join(ROOT, '.env'),
  path.join(ROOT, 'sitetrackerpro-app', 'backend', '.env')
];

for (const file of ENV_FILES) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}

const { Client } = require('pg');

const connectionString = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();

if (!connectionString) {
  console.error('❌ No database URL. Run `neon deploy` (it writes .env.local), then try again.');
  process.exit(1);
}

const schemaPath = path.join(ROOT, 'sitetrackerpro-app', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const SEED_START = '-- ==================== SEED DATA: ETHIOPIAN MATERIALS ====================';
const SEED_END = '-- ==================== VIEWS ====================';

const startIndex = schema.indexOf(SEED_START);
const endIndex = schema.indexOf(SEED_END);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  console.error('❌ Could not find the seed section in schema.sql. Aborting rather than guessing.');
  process.exit(1);
}

const beforeSeed = schema.slice(0, startIndex);
const seed = schema.slice(startIndex, endIndex);
const afterSeed = schema.slice(endIndex);

async function main() {
  const client = new Client({
    connectionString,
    ssl: /sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined
  });

  await client.connect();
  const who = await client.query('SELECT current_database() AS db, version() AS version');
  console.log(`→ ${who.rows[0].db}: ${String(who.rows[0].version).split(',')[0]}`);

  console.log('→ Creating tables, indexes and keys…');
  await client.query(beforeSeed);

  const seeded = await client.query('SELECT COUNT(*)::int AS count FROM materials_ethiopian_standards');
  if (seeded.rows[0].count === 0) {
    console.log('→ Seeding the Ethiopian materials price list…');
    await client.query(seed);
  } else {
    console.log(`→ Materials already seeded (${seeded.rows[0].count} rows); leaving them alone.`);
  }

  console.log('→ Creating views and the variance function…');
  await client.query(afterSeed);

  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);
  const materials = await client.query('SELECT COUNT(*)::int AS count FROM materials_ethiopian_standards');

  console.log(`\n✅ ${tables.rows.length} tables ready, ${materials.rows[0].count} materials seeded.`);
  console.log('   ' + tables.rows.map(row => row.table_name).join(', '));

  await client.end();
}

main().catch(async (err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
