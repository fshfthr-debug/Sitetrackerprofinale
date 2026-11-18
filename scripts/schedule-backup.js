#!/usr/bin/env node
/**
 * Turns on Neon's own daily snapshot schedule for this project's database.
 *
 *   npm run backup:schedule
 *   npm run backup:schedule -- --hour 23 --retention 1209600
 *
 * Neon runs schedules only on paid plans, so this checks the organisation's plan
 * first and explains itself instead of failing with a raw API error. Times are
 * UTC: --hour 23 is 02:00 in Addis Ababa (EAT, UTC+3).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')]) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}

const ARGS = process.argv.slice(2);
function flag(name, fallback) {
  const index = ARGS.findIndex(arg => arg === `--${name}`);
  if (index === -1) return fallback;
  const value = ARGS[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const HOUR = Number(flag('hour', 23));                 // UTC
const RETENTION = Number(flag('retention', 14 * 24 * 3600));  // seconds
const BRANCH = flag('branch', 'production');

function neon(args) {
  return execFileSync('npx', ['--yes', 'neon@latest', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
}

function attempt(args) {
  try {
    return { ok: true, output: neon(args) };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.trim() };
  }
}

function context() {
  const file = path.join(ROOT, '.neon');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {};
  }
}

function main() {
  if (!process.env.NEON_API_KEY) {
    console.warn('Note: NEON_API_KEY is not set. Using the Neon CLI session if one is signed in.');
  }

  const { orgId } = context();
  let plan = null;

  const orgs = attempt(['api', '/users/me/organizations', '-o', 'json']);
  if (orgs.ok) {
    try {
      const parsed = JSON.parse(orgs.output);
      const match = (parsed.organizations || []).find(org => org.id === orgId) || (parsed.organizations || [])[0];
      if (match) {
        plan = match.plan;
        console.log(`Organisation: ${match.name} (${match.id})`);
        console.log(`Plan:         ${match.plan}`);
      }
    } catch (err) {
      // Fall through: the schedule call below is the real test anyway.
    }
  }

  if (plan === 'free' || plan === 'agent') {
    console.error('\n❌ Scheduled snapshots are not enabled for this organisation yet.');
    console.error(`   Neon reports the plan as "${plan}". Schedules need Launch, Scale or Business.`);
    console.error('\n   In the Neon console: Organisation settings → Billing → Change plan.');
    console.error('   Check it is the organisation that owns this project, then re-run:');
    console.error('     npm run backup:schedule');
    console.error('\n   Until then: `npm run backup` rotates one snapshot by hand, and Neon keeps');
    console.error('   6 hours of point-in-time history on the free plan.');
    process.exit(1);
  }

  console.log(`\nSetting a daily snapshot at ${String(HOUR).padStart(2, '0')}:00 UTC` +
    ` (${String((HOUR + 3) % 24).padStart(2, '0')}:00 Addis Ababa), kept ${Math.round(RETENTION / 86400)} days…`);

  const set = attempt([
    'snapshots', 'schedule', 'set',
    '--branch', BRANCH,
    '--frequency', 'daily',
    '--hour', String(HOUR),
    '--retention', String(RETENTION)
  ]);

  if (!set.ok) {
    console.error('\n❌ Neon refused the schedule:\n' + set.output);
    process.exit(1);
  }

  console.log(set.output.trim());

  const current = attempt(['snapshots', 'schedule', 'get', '--branch', BRANCH]);
  console.log('\nSchedule now in place:');
  console.log(current.ok ? current.output.trim() : '(could not read it back, check the Neon console)');
  console.log('\nNeon takes the first snapshot at the next scheduled time; nothing else to run.');
}

try {
  main();
} catch (err) {
  console.error('\n❌ Could not set the schedule:', err.message);
  process.exit(1);
}
