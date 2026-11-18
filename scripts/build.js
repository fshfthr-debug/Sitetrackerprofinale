#!/usr/bin/env node
/**
 * Production build for SiteTrackerPro.
 *
 * The backend serves the React app from sitetrackerpro-app/backend/public, so a
 * build is: compile the frontend, then copy its output over that folder. Both
 * dependency trees are installed first when they are missing, which is what a
 * fresh checkout (or CI) needs.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'sitetrackerpro-app', 'frontend');
const BACKEND = path.join(ROOT, 'sitetrackerpro-app', 'backend');
const FRONTEND_BUILD = path.join(FRONTEND, 'build');
const PUBLIC = path.join(BACKEND, 'public');

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}   (${path.relative(ROOT, cwd) || '.'})`);
  // CI is deliberately not forced: react-scripts promotes its lint warnings (a few
  // existing exhaustive-deps notes in App.jsx) to build errors when CI is set, and
  // this build has always shipped with those warnings. A CI system that sets the
  // variable itself still gets its stricter behaviour.
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' }
  });
}

function ensureDependencies(directory) {
  const lockfile = path.join(directory, 'package-lock.json');
  if (fs.existsSync(path.join(directory, 'node_modules'))) return;

  const args = fs.existsSync(lockfile)
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];

  run('npm', args, directory);
}

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(source, target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

function main() {
  ensureDependencies(FRONTEND);
  ensureDependencies(BACKEND);

  run('npm', ['run', 'build'], FRONTEND);

  if (!fs.existsSync(path.join(FRONTEND_BUILD, 'index.html'))) {
    throw new Error('Frontend build produced no index.html in ' + FRONTEND_BUILD);
  }

  // Replace the served build, so stale hashed bundles cannot linger.
  fs.rmSync(PUBLIC, { recursive: true, force: true });
  copyDirectory(FRONTEND_BUILD, PUBLIC);

  console.log('\n✅ Build complete. The backend will serve ' + path.relative(ROOT, PUBLIC));
}

try {
  main();
} catch (err) {
  console.error('\n❌ Build failed:', err.message);
  process.exit(1);
}
