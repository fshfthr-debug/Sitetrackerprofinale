#!/usr/bin/env node
/**
 * Rotating database backups using Neon snapshots.
 *
 * A Neon snapshot is a full, instant-restorable copy of the branch: it needs no
 * compute, and restoring one is a single command (see below). This script takes
 * one and rotates the older ones it created itself.
 *
 * The free plan allows a single manual snapshot, so a normal run keeps exactly
 * one backup: the most recent. Paid plans allow 100, and BACKUP_KEEP raises how
 * many are kept.
 *
 *   npm run backup                 # take a backup, rotate the old ones
 *   npm run backup -- --list       # show what exists and how to restore
 *   npm run backup -- --replace    # make room by deleting the oldest snapshot,
 *                                  # even if it was not created by this script
 *
 * Needs a Neon credential, which is never stored in this repository:
 *   export NEON_API_KEY=...        # or run `neon login` once on this machine
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')]) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}

const ARGS = process.argv.slice(2);
const LIST_ONLY = ARGS.includes('--list');
const REPLACE = ARGS.includes('--replace');
const BRANCH = process.env.NEON_BACKUP_BRANCH || process.env.NEON_BRANCH || 'production';
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 1);
const PREFIX = 'auto-';

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
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}${err.message || ''}` };
  }
}

function listSnapshots() {
  const raw = neon(['snapshots', 'list', '-o', 'json']);
  const parsed = JSON.parse(raw);
  return parsed.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function describe(snapshot) {
  return `${snapshot.name || '(unnamed)'}  ${snapshot.id}  ${snapshot.created_at}`;
}

function restoreHelp() {
  console.log(`
To restore, pick one:

  • Put the database back exactly as the backup was, in place:
        npx neon@latest snapshots restore <snapshot-id>
    (this rewrites the branch — take a snapshot of the current state first if
    anything in it is worth keeping)

  • Inspect the backup first, without touching live data:
        npx neon@latest snapshots restore <snapshot-id> --name restored-check
    then compare or copy rows across from the "restored-check" branch.

  • Point-in-time restore, for the last 6 hours on the free plan (no snapshot
    needed — Neon already keeps this history):
        npx neon@latest branches restore production ^self@<ISO-timestamp>`);
}

function main() {
  if (!process.env.NEON_API_KEY) {
    // The CLI also accepts a stored browser session, so this is a warning, not a
    // hard stop; the calls below will say so if there is no credential at all.
    console.warn('Note: NEON_API_KEY is not set. Using the Neon CLI session if one is signed in.');
  }

  const snapshots = listSnapshots();

  if (LIST_ONLY) {
    if (snapshots.length === 0) {
      console.log('No snapshots yet. Run `npm run backup` to take one.');
    } else {
      console.log(`${snapshots.length} snapshot(s) on branch ${BRANCH}:`);
      snapshots.forEach(snapshot => console.log('  ' + describe(snapshot)));
    }
    restoreHelp();
    return;
  }

  const ours = snapshots.filter(snapshot => String(snapshot.name || '').startsWith(PREFIX));

  // Make room before creating: stop one short of the limit so the new backup fits.
  const surplus = ours.slice(KEEP - 1);
  for (const snapshot of surplus) {
    const removed = attempt(['snapshots', 'delete', snapshot.id]);
    console.log(removed.ok ? `Removed old backup ${describe(snapshot)}` : `Could not remove ${snapshot.id}: ${removed.output.trim()}`);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const name = `${PREFIX}${stamp}`;

  let created = attempt(['snapshots', 'create', '--branch', BRANCH, '--name', name]);

  // Free plan: only one manual snapshot exists at all, so an unrelated snapshot
  // can be what blocks the new one. Rotate the oldest of ours first, and only
  // touch a hand-made snapshot when --replace was asked for.
  if (!created.ok && /limit exceeded/i.test(created.output)) {
    const oldestOurs = ours[ours.length - 1];
    if (oldestOurs) {
      console.log(`Plan limit reached; removing the oldest automatic backup ${oldestOurs.id} first.`);
      attempt(['snapshots', 'delete', oldestOurs.id]);
    } else if (REPLACE && snapshots.length > 0) {
      console.log(`Plan limit reached; --replace given, removing oldest snapshot ${snapshots[0].id}.`);
      attempt(['snapshots', 'delete', snapshots[0].id]);
    } else {
      console.error('\n❌ Backup not taken: the Neon plan allows only one manual snapshot and it is already used.');
      console.error('   Existing: ' + snapshots.map(describe).join(', '));
      console.error('   Re-run with -- --replace to delete it first (the data itself is not affected),');
      console.error('   or keep reading: Neon still gives you 6 hours of point-in-time restore for free.');
      process.exit(1);
    }
    created = attempt(['snapshots', 'create', '--branch', BRANCH, '--name', name]);
  }

  if (!created.ok) {
    console.error('\n❌ Backup failed:\n' + created.output.trim());
    process.exit(1);
  }

  console.log(created.output.trim());
  console.log(`\n✅ Backup taken: ${name}`);
  console.log(`   Retained: ${Math.min(KEEP, 1)} backup(s) on the free plan — each run replaces the previous one.`);
  restoreHelp();
}

try {
  main();
} catch (err) {
  console.error('\n❌ Backup failed:', err.message);
  process.exit(1);
}
