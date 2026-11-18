#!/usr/bin/env node
/**
 * Sets a new password for an existing account — the "I'm locked out" rescue.
 *
 *   npm run user:password -- --email sam@example.com
 *   npm run user:password -- --email sam@example.com --password 'Their-New-Passw0rd'
 *
 * Without --password it generates a strong one and prints it once. The app stores
 * bcrypt hashes, so the new password is hashed the same way and checked against
 * the stored value before this reports success.
 *
 * Nothing is emailed: you pass the password to the person yourself.
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

const email = (flag('email') || '').trim().toLowerCase();
const chosenPassword = flag('password');

if (!email) {
  console.error('Usage: npm run user:password -- --email sam@example.com [--password "New-Passw0rd-12"]');
  console.error('       npm run user:list      # see who has an account');
  process.exit(1);
}

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

  const found = await client.query(
    'SELECT id, email, full_name FROM users WHERE LOWER(email) = $1',
    [email]
  );

  if (found.rows.length === 0) {
    console.error(`❌ No account for ${email}.`);
    console.error('   If this is a new team member, create the account instead:');
    console.error(`   npm run user:add -- --email ${email} --name "Their Name"`);
    await client.end();
    process.exit(1);
  }

  const user = found.rows[0];
  const password = chosenPassword || generatePassword();
  const problems = validatePassword(password, user.email);

  if (problems.length > 0) {
    console.error('❌ The password would be rejected by the app:\n   - ' + problems.join('\n   - '));
    await client.end();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  // Refuse a "reset" to the password they already have: it looks like it worked,
  // but whatever made them unable to sign in is still there.
  const current = await client.query('SELECT password FROM users WHERE id = $1', [user.id]);
  if (await bcrypt.compare(password, current.rows[0].password)) {
    console.error(`❌ That is already ${user.email}'s current password. Choose a different one.`);
    await client.end();
    process.exit(1);
  }

  await client.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);

  // Read it back and compare, exactly as the login endpoint will.
  const stored = await client.query('SELECT password FROM users WHERE id = $1', [user.id]);
  const verified = await bcrypt.compare(password, stored.rows[0].password);

  await client.end();

  if (!verified) {
    console.error('❌ The new password did not verify against the stored hash. Do not use it.');
    process.exit(1);
  }

  console.log(`\n✅ Password reset for ${user.email}${user.full_name ? ' (' + user.full_name + ')' : ''}`);
  console.log('   Verified against the stored hash — they can sign in with it now.');
  if (!chosenPassword) {
    console.log(`\n   New password: ${password}`);
    console.log('   Send it to them privately; they can change it inside the app after signing in.');
  }
  console.log('\n   If they were blocked by repeated failed attempts, the app also holds a');
  console.log('   temporary lock per account: it clears by itself within 15 minutes (or on');
  console.log('   restart). A correct password is accepted again after that.');
}

main().catch(err => {
  console.error('\n❌ Could not reset the password:', err.message);
  process.exit(1);
});
