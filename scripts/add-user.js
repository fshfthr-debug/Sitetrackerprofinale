#!/usr/bin/env node
/**
 * Creates an account directly in the database, bypassing the closed public
 * sign-up. This is the "administrator hands out accounts" side of
 * DISABLE_REGISTRATION=1.
 *
 *   npm run user:add -- --email sam@example.com --name "Sam Tesfaye"
 *   npm run user:add -- --email sam@example.com --name "Sam" --company "Timona" --password 'Their-Chosen-Passw0rd'
 *   npm run user:list
 *
 * Without --password a strong one is generated and printed once, to be passed to
 * the person, who can then change it inside the app.
 *
 * Passwords are hashed with bcrypt exactly as the app does, so the same login
 * endpoint accepts them, and the app's own rules are enforced here — see
 * scripts/lib/passwords.js, which mirrors validatePassword() in
 * backend-v3-enhanced.js.
 */
const fs = require('fs');
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
const bcrypt = require('bcryptjs');
const { validatePassword, generatePassword } = require('./lib/passwords');

const ARGS = process.argv.slice(2);

function flag(name) {
  const index = ARGS.findIndex(arg => arg === `--${name}`);
  if (index === -1) return undefined;
  const value = ARGS[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

const LIST = ARGS.includes('--list');
const email = (flag('email') || '').trim().toLowerCase();
const fullName = (flag('name') || '').trim();
const company = (flag('company') || '').trim();
const chosenPassword = flag('password');

const connectionString = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('❌ No database URL found. Run `neon deploy` first, or set DATABASE_URL.');
  process.exit(1);
}

async function main() {
  const client = new Client({
    connectionString,
    ssl: /sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined
  });
  await client.connect();

  if (LIST) {
    const users = await client.query(
      'SELECT id, email, full_name, company, created_at FROM users ORDER BY id'
    );
    if (users.rows.length === 0) {
      console.log('No accounts yet.');
    } else {
      console.log(`${users.rows.length} account(s):\n`);
      users.rows.forEach(user => {
        const created = new Date(user.created_at).toISOString().slice(0, 10);
        console.log(`  #${user.id}  ${user.email.padEnd(34)} ${(user.full_name || '—').padEnd(28)} joined ${created}`);
      });
    }
    await client.end();
    return;
  }

  if (!email) {
    console.error('Usage: npm run user:add -- --email sam@example.com --name "Sam Tesfaye" [--company "..."] [--password "..."]');
    console.error('       npm run user:list');
    process.exit(1);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`❌ "${email}" does not look like an email address.`);
    process.exit(1);
  }

  const password = chosenPassword || generatePassword();
  const problems = validatePassword(password, email);
  if (problems.length > 0) {
    console.error('❌ The password would be rejected by the app:\n   - ' + problems.join('\n   - '));
    process.exit(1);
  }

  const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rows.length > 0) {
    console.error(`❌ ${email} already has an account (id ${existing.rows[0].id}). Nothing was changed.`);
    console.error('   To give them a new password instead:');
    console.error(`   npm run user:password -- --email ${email}`);
    await client.end();
    process.exit(1);
  }

  const created = await client.query(
    `INSERT INTO users (email, password, full_name, company)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, full_name, created_at`,
    [email, await bcrypt.hash(password, 10), fullName || null, company || null]
  );

  // Proves the stored hash really matches, the same comparison the login endpoint makes.
  const verify = await bcrypt.compare(password, (await client.query('SELECT password FROM users WHERE id = $1', [created.rows[0].id])).rows[0].password);

  await client.end();

  const user = created.rows[0];
  console.log(`\n✅ Account created for ${user.email} (id ${user.id})`);
  if (user.full_name) console.log(`   Name:    ${user.full_name}`);
  console.log(`   Sign-in check: ${verify ? 'password verified against the stored hash' : 'FAILED — do not use this account'}`);
  if (!chosenPassword) {
    console.log(`\n   Password: ${password}`);
    console.log('   Send this to them privately. They can change it inside the app after signing in.');
  }
  console.log('\n   Public sign-up stays closed; only this command adds accounts.');
}

main().catch(err => {
  console.error('\n❌ Could not create the account:', err.message);
  process.exit(1);
});
