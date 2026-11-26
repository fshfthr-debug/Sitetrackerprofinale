// Create React App cannot import the Draco WebAssembly decoder, so the glTF
// decoder files are copied from three.js into public/draco/ before the dev
// server or a production build starts. src/bim/gltfLoader.js points DRACOLoader
// at '/draco/', so Draco-compressed GLBs load from the app's own origin (no CDN).
const fs = require('fs');
const path = require('path');

// three's package.json is not an exported subpath, but the jsm addons are.
const sourceDirectory = path.dirname(require.resolve('three/examples/jsm/libs/draco/gltf/draco_decoder.js'));
const targetDirectory = path.join(__dirname, '..', 'public', 'draco');

// The wasm decoder plus its wrapper, and the pure JavaScript decoder that
// browsers without WebAssembly fall back to.
const files = ['draco_decoder.wasm', 'draco_wasm_wrapper.js', 'draco_decoder.js'];

fs.mkdirSync(targetDirectory, { recursive: true });

let copied = 0;
for (const name of files) {
  const source = path.join(sourceDirectory, name);
  const target = path.join(targetDirectory, name);
  if (!fs.existsSync(source)) {
    throw new Error(`copy-draco-decoders: ${name} is missing from three.js (${sourceDirectory}).`);
  }
  // Avoid a pointless copy when the file is already up to date.
  if (fs.existsSync(target)) {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) continue;
  }
  fs.copyFileSync(source, target);
  copied += 1;
}

if (copied > 0) {
  console.log(`copy-draco-decoders: ${copied} file(s) in ${path.relative(process.cwd(), targetDirectory)}`);
}
