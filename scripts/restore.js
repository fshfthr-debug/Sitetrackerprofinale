#!/usr/bin/env node
/**
 * Loads a backup made by `npm run backup:download` back into a database.
 *
 *   npm run db:restore -- backups/sitetrackerpro-2026-11-17-2200.sql
 *   npm run db:restore -- backups/old.sql --yes        # no confirmation prompt
 *   DATABASE_URL_UNPOOLED=postgres://... npm run db:restore -- file.sql
 *
 * WARNING: this REPLACES the contents of the target database. That is what a
 * restore means, but it is not undoable — which is why it asks first, and why the
 * connection string it will use is printed before anything happens.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
for (const file of [
  path.join(ROOT, '.env.local'),
  path.join(ROOT, '.env'),
  path.join(ROOT, 'sitetrackerpro-app', 'backend', '.env')
]) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}

const { Client } = require('pg');

const ARGS = process.argv.slice(2).filter(arg => arg !== '--yes');
const ASSUME_YES = process.argv.includes('--yes');
const file = ARGS[0];

if (!file) {
  console.error('Usage: npm run db:restore -- <backup.sql> [--yes]');
  process.exit(1);
}

const filePath = path.resolve(process.cwd(), file);
if (!fs.existsSync(filePath)) {
  console.error(`❌ No such file: ${filePath}`);
  process.exit(1);
}

const connectionString = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('❌ No database URL. Set DATABASE_URL (or DATABASE_URL_UNPOOLED) first.');
  process.exit(1);
}

const target = connectionString.replace(/:\/\/[^@]*@/, '://').replace(/\?.*$/, '');
const sql = fs.readFileSync(filePath, 'utf8');

async function confirm() {
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) {
    console.error('❌ Refusing to run unattended without --yes.');
    return false;
  }

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`This will REPLACE all data in ${target}. Type "restore" to continue: `, reply => {
      rl.close();
      resolve(reply.trim().toLowerCase());
    });
  });

  return answer === 'restore';
}

async function main() {
  console.log(`Backup file : ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`);
  console.log(`Target      : ${target}`);

  if (!(await confirm())) {
    console.log('Nothing was changed.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: /sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined
  });

  await client.connect();

  // One transaction: a dump that fails halfway leaves the database as it was.
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  const summary = await client.query(`
    SELECT (SELECT COUNT(*)::int FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
           (SELECT COUNT(*)::int FROM users) AS users,
           (SELECT COUNT(*)::int FROM projects) AS projects,
           (SELECT COUNT(*)::int FROM materials_ethiopian_standards) AS materials`);

  await client.end();

  console.log('\n✅ Restore complete.');
  console.log(`   tables=${summary.rows[0].tables} users=${summary.rows[0].users} projects=${summary.rows[0].projects} materials=${summary.rows[0].materials}`);
}

main().catch(err => {
  console.error('\n❌ Restore failed (the database was left unchanged):', err.message);
  process.exit(1);
});
