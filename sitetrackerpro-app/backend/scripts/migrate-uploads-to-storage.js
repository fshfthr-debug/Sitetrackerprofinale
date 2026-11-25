#!/usr/bin/env node
'use strict';
/**
 * Copies BIM models that still live on the uploads volume into object storage (Supabase Storage,
 * S3, R2, MinIO) and repoints their database rows at the new keys.
 *
 * Run it once after enabling S3_BUCKET:
 *
 *   node scripts/migrate-uploads-to-storage.js              # dry run: lists what would move
 *   node scripts/migrate-uploads-to-storage.js --apply      # copies and repoints
 *   node scripts/migrate-uploads-to-storage.js --apply --keep-local
 *   node scripts/migrate-uploads-to-storage.js --apply --project 7
 *
 * It uses the same environment the server does (DATABASE_URL or DB_*, UPLOAD_DIR, S3_*), so on
 * Render it can be run from the service shell without extra setup.
 */

require('dotenv').config();

const path = require('path');
const { Pool } = require('pg');
const { createStorage } = require('../storage');
const { migrateLocalModels } = require('../upload-migration');

const HELP = `Copy legacy BIM models into object storage.

Usage: node scripts/migrate-uploads-to-storage.js [options]

  --apply          Copy the files and repoint the database rows (default: dry run).
  --keep-local     Leave the file on the uploads volume after a successful move.
  --project <id>   Only migrate one project.
  --help           Show this text.

Environment: DATABASE_URL (or DB_USER/DB_PASSWORD/DB_HOST/DB_PORT/DB_NAME, DB_SSL),
UPLOAD_DIR, and S3_BUCKET + S3_ENDPOINT + S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY.
`;

function parseArgs(argv) {
  const options = { apply: false, keepLocal: false, projectId: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--keep-local') options.keepLocal = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project' || arg.startsWith('--project=')) {
      const value = arg.startsWith('--project=') ? arg.slice('--project='.length) : argv[++i];
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`--project needs a project id, got "${value}".`);
      options.projectId = id;
    } else {
      throw new Error(`Unknown option "${arg}". Run with --help to see the options.`);
    }
  }
  return options;
}

function createPool() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  const wantsSsl = process.env.DB_SSL === 'true' ||
    /[?&]sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl);

  return new Pool({
    ...(databaseUrl
      ? { connectionString: databaseUrl }
      : {
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          database: process.env.DB_NAME
        }),
    ssl: wantsSsl && process.env.DB_SSL !== 'false' ? { rejectUnauthorized: false } : undefined
  });
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  const storage = createStorage({ rootDir: uploadRoot });
  console.log(`Storage: ${storage.describe()}`);
  console.log(`Uploads: ${uploadRoot}`);

  if (!storage.isRemote) {
    console.error(
      '\nNothing to do: files are already stored on the uploads volume. Set S3_BUCKET and the ' +
      'S3 credentials (and redeploy) before running this, otherwise the copy has no destination.'
    );
    return 1;
  }

  if (!options.apply) {
    console.log('\nDRY RUN — nothing is copied or changed. Re-run with --apply to do it.\n');
  } else {
    console.log(
      `\nApplying${options.keepLocal ? ' (local files are kept)' : ' (local files are deleted after each move)'}.\n`
    );
  }

  const pool = createPool();
  let summary;
  try {
    summary = await migrateLocalModels({
      pool,
      storage,
      uploadRoot,
      apply: options.apply,
      keepLocal: options.keepLocal,
      projectId: options.projectId,
      log: line => console.log(line)
    });
  } finally {
    await pool.end().catch(() => {});
  }

  console.log('');
  if (summary.scanned === 0) {
    console.log('No BIM models are stored on the local volume. Nothing to migrate.');
    return 0;
  }

  const parts = [];
  if (summary.apply) parts.push(`${summary.moved} moved (${summary.bytes ? (summary.bytes / 1024 / 1024).toFixed(1) + ' MB' : '0 B'})`);
  else parts.push(`${summary.planned} would move (${summary.bytes ? (summary.bytes / 1024 / 1024).toFixed(1) + ' MB' : '0 B'})`);
  if (summary.missing) parts.push(`${summary.missing} missing on disk`);
  if (summary.outside) parts.push(`${summary.outside} outside the uploads volume`);
  if (summary.changed) parts.push(`${summary.changed} changed while copying`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  console.log(`${summary.scanned} local model(s): ${parts.join(', ')}.`);

  if (summary.failed) {
    console.error('\nSome models could not be migrated; their records still point at the local files,');
    console.error('which were not deleted. Fix the reported error and run the command again.');
    return 1;
  }
  if (!summary.apply && summary.planned) {
    console.log('Run again with --apply to copy them.');
  }
  return 0;
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    err => {
      console.error(`\nMigration stopped: ${err.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, parseArgs };
