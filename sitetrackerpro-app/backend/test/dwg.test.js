const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { convertDwg, DwgError, DEFAULTS } = require('../dwg');

const MINIMAL_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'WALLS', '10', '0', '20', '0', '11', '10', '21', '10',
  '0', 'ENDSEC', '0', 'EOF', ''
].join('\n');

// A stand-in for dwg2dxf: whatever it is asked to convert, it writes a fixed DXF to the -o path.
// This tests the wrapper's contract (arguments, limits, cleanup) without the GPL binary.
async function makeFakeConverter(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-dwg2dxf-'));
  const file = path.join(dir, 'dwg2dxf');
  // `--version` must succeed, otherwise the wrapper treats the host as having no converter.
  const preamble = '#!/bin/sh\ncase "$1" in --version) echo "dwg2dxf test"; exit 0;; esac\n';
  await fs.writeFile(file, `${preamble}${body}\n`, { mode: 0o755 });
  return file;
}

const WRITE_DXF = `out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
cat > "$out" <<'DXF'
${MINIMAL_DXF}DXF
exit 0`;

test('convertDwg runs the converter as a separate process and returns its DXF', async () => {
  const binary = await makeFakeConverter(WRITE_DXF);
  const result = await convertDwg(Buffer.from('AC1032 fake dwg bytes'), { binary });

  assert.match(result.dxf, /ENTITIES/);
  assert.match(result.dxf, /LINE/);
  assert.equal(result.bytes, 21);
  assert.ok(result.durationMs >= 0);
});

test('convertDwg reports "disabled" with 503 when the binary is missing', async () => {
  await assert.rejects(
    () => convertDwg(Buffer.from('dwg'), { binary: '/nonexistent/dwg2dxf-does-not-exist' }),
    err => err instanceof DwgError && err.code === 'disabled' && err.status === 503
  );
});

test('convertDwg kills a converter that overruns the timeout', async () => {
  const binary = await makeFakeConverter('sleep 30');
  const started = Date.now();
  await assert.rejects(
    () => convertDwg(Buffer.from('dwg'), { binary, timeoutMs: 400 }),
    err => err instanceof DwgError && err.code === 'timeout'
  );
  assert.ok(Date.now() - started < 5000, 'the wrapper returns promptly instead of waiting for the child');
});

test('convertDwg surfaces converter stderr as a 422 when the file is unreadable', async () => {
  const binary = await makeFakeConverter('echo "ERROR: failed to decode DWG" >&2; exit 2');
  await assert.rejects(
    () => convertDwg(Buffer.from('dwg'), { binary }),
    err => err instanceof DwgError && err.code === 'failed' && /failed to decode DWG/.test(err.message) && err.status === 422
  );
});

test('convertDwg refuses oversized input before spawning anything', async () => {
  const binary = await makeFakeConverter(WRITE_DXF);
  await assert.rejects(
    () => convertDwg(Buffer.alloc(2048), { binary, maxInputBytes: 1024 }),
    err => err instanceof DwgError && err.code === 'too-large'
  );
});

test('convertDwg refuses empty input', async () => {
  await assert.rejects(
    () => convertDwg(Buffer.alloc(0), { binary: '/nonexistent' }),
    err => err instanceof DwgError && err.code === 'empty'
  );
});

test('convertDwg treats a converter that writes nothing as a failure', async () => {
  const binary = await makeFakeConverter('exit 0');
  await assert.rejects(
    () => convertDwg(Buffer.from('dwg'), { binary }),
    err => err instanceof DwgError && err.code === 'failed'
  );
});

test('the configured limits are bounded by default', () => {
  assert.ok(DEFAULTS.timeoutMs >= 5000 && DEFAULTS.timeoutMs <= 120000);
  assert.ok(DEFAULTS.maxInputBytes <= 50 * 1024 * 1024);
  assert.ok(DEFAULTS.memoryLimitKb > 0);
});
