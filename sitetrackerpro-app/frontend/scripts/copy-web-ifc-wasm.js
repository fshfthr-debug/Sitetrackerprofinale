// Create React App cannot import a .wasm binary, so the web-ifc WebAssembly module
// is copied into public/ before the dev server or a production build starts. The
// viewer then points web-ifc at '/web-ifc.wasm' (see BimViewer.jsx).
const fs = require('fs');
const path = require('path');

const source = require.resolve('web-ifc/web-ifc.wasm');
const targetDirectory = path.join(__dirname, '..', 'public');
const target = path.join(targetDirectory, 'web-ifc.wasm');

fs.mkdirSync(targetDirectory, { recursive: true });

// Avoid a pointless copy when the binary is already up to date.
if (fs.existsSync(target)) {
  const sourceStat = fs.statSync(source);
  const targetStat = fs.statSync(target);
  if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
    process.exit(0);
  }
}

fs.copyFileSync(source, target);
console.log(`copy-web-ifc-wasm: ${path.relative(process.cwd(), target)} (${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB)`);
