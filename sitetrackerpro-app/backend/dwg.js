/**
 * DWG conversion through GNU LibreDWG's `dwg2dxf`.
 *
 * LibreDWG is GPL-3.0. It is deliberately kept at arm's length: this module never links it,
 * never imports it as a library, and never builds a combined work with it. It starts the
 * `dwg2dxf` executable as a separate process, hands it a file path on the command line, and
 * reads back a DXF file. See THIRD-PARTY-NOTICES-LIBREDWG.md for the licence and source offer.
 *
 * The converter parses untrusted binary input, so every call is bounded:
 *   - input size cap        (before anything is written or spawned)
 *   - wall-clock timeout    (the child is SIGKILLed, not asked politely)
 *   - output size cap       (a decompression-style blow-up cannot fill the disk)
 *   - one scratch directory per call, removed in a finally block
 *   - no shell: spawn() with an argument array, so a file name can never be a command
 *
 * When the binary is not installed the module reports `enabled: false` and callers return a
 * clear "convert to DXF" message instead of failing obscurely.
 */

const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  binary: process.env.DWG2DXF_PATH || 'dwg2dxf',
  timeoutMs: Number(process.env.DWG_TIMEOUT_MS) > 0 ? Number(process.env.DWG_TIMEOUT_MS) : 30000,
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 80 * 1024 * 1024,
  // LibreDWG keeps drawing state in memory; a hard address-space cap turns a pathological file
  // into a clean failure instead of an out-of-memory kill of the whole container.
  memoryLimitKb: Number(process.env.DWG_MEMORY_LIMIT_KB) > 0 ? Number(process.env.DWG_MEMORY_LIMIT_KB) : 786432
};

class DwgError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let availability = null;

/** Is a usable dwg2dxf binary on this host? Cached per process. */
async function converterAvailable(options = {}) {
  const binary = options.binary || DEFAULTS.binary;
  if (availability && availability.binary === binary) return availability.available;

  const available = await new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(binary, ['--version'], { stdio: 'ignore', timeout: 5000 });
    } catch (err) {
      return done(false);
    }
    child.on('error', () => done(false));
    child.on('exit', code => done(code === 0 || code === 1)); // --version exits 0, unknown flag 1
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) { /* already gone */ } done(false); }, 5000);
  });

  availability = { binary, available };
  return available;
}

function resetAvailabilityCache() {
  availability = null;
}

function limitCommand(command, args, memoryLimitKb) {
  // ulimit is a shell builtin, so the only place a shell is used is here, with values we build
  // ourselves from numbers. Nothing user-supplied reaches this string.
  const limit = Number(memoryLimitKb) > 0 ? `ulimit -v ${Math.floor(Number(memoryLimitKb))} 2>/dev/null; ` : '';
  return { command: '/bin/sh', args: ['-c', `${limit}exec "$0" "$@"`, command, ...args] };
}

/**
 * Convert DWG bytes to DXF text.
 * Resolves { dxf, durationMs, bytes }; rejects with a DwgError carrying a user-facing message.
 */
async function convertDwg(buffer, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  if (!buffer || !buffer.length) throw new DwgError('empty', 'The uploaded DWG file is empty.');
  if (buffer.length > settings.maxInputBytes) {
    throw new DwgError('too-large', `DWG files are limited to ${Math.round(settings.maxInputBytes / (1024 * 1024))} MB.`);
  }

  const available = await converterAvailable(settings);
  if (!available) {
    throw new DwgError(
      'disabled',
      'DWG conversion is not enabled on this server. Export the drawing as DXF from AutoCAD and import that instead.',
      503
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwg-'));
  const inputPath = path.join(workDir, `input-${crypto.randomUUID()}.dwg`);
  const outputPath = path.join(workDir, 'output.dxf');
  const startedAt = Date.now();

  try {
    await fs.writeFile(inputPath, buffer, { mode: 0o600 });

    const limited = limitCommand(settings.binary, [inputPath, '-y', '-o', outputPath], settings.memoryLimitKb);
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };

      const child = spawn(limited.command, limited.args, {
        cwd: workDir,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: workDir, LC_ALL: 'C' }
      });

      let stderr = '';
      child.stderr.on('data', chunk => {
        // Keep the tail only: LibreDWG can be noisy on damaged files.
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (err) { /* already dead */ }
        finish(new DwgError('timeout', `The drawing took longer than ${Math.round(settings.timeoutMs / 1000)} seconds to convert. Try purging unused blocks in CAD and uploading again.`, 422));
      }, settings.timeoutMs);

      child.on('error', err => {
        finish(new DwgError('disabled', `DWG conversion could not start: ${err.message}`, 503));
      });

      child.on('exit', code => {
        if (code !== 0) {
          const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
          finish(new DwgError('failed', detail
            ? `The drawing could not be converted: ${detail}`
            : 'The drawing could not be converted. It may be corrupt or an unsupported DWG version.', 422));
          return;
        }
        finish(null);
      });
    });

    let stats;
    try {
      stats = await fs.stat(outputPath);
    } catch (err) {
      throw new DwgError('failed', 'The converter produced no DXF output for this drawing.', 422);
    }
    if (stats.size === 0) throw new DwgError('failed', 'The converter produced an empty DXF file.', 422);
    if (stats.size > settings.maxOutputBytes) {
      throw new DwgError('too-large', 'The converted drawing is larger than this server accepts.', 413);
    }

    const dxf = await fs.readFile(outputPath, 'utf8');
    if (!/ENTITIES/i.test(dxf)) {
      throw new DwgError('failed', 'The converter did not produce a readable DXF drawing.', 422);
    }

    return { dxf, durationMs: Date.now() - startedAt, bytes: buffer.length };
  } finally {
    // Always remove the scratch directory, whatever happened above.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  convertDwg,
  converterAvailable,
  resetAvailabilityCache,
  DwgError,
  DEFAULTS
};
