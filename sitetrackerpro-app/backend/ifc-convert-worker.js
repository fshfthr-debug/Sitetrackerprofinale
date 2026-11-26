'use strict';
/**
 * Worker thread that turns one IFC into a GLB.
 *
 * It runs off the API's event loop so a long conversion cannot stall other requests, and it is
 * given its own heap limit so a model that needs more memory than the service has fails as a
 * worker error instead of taking the server down with it.
 *
 * The file is read and written here; the main thread only passes paths, so a large model is never
 * held twice in memory.
 */

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { convertIfcBuffer } = require('./ifc-glb');

async function run() {
  const { inputPath, outputPath } = workerData || {};
  if (!inputPath || !outputPath) throw new Error('The converter was started without a file to read.');

  const stats = await fs.promises.stat(inputPath);
  if (!stats.isFile() || stats.size === 0) throw new Error('The stored IFC file is empty.');

  const buffer = await fs.promises.readFile(inputPath);
  const result = await convertIfcBuffer(buffer);
  await fs.promises.writeFile(outputPath, result.glb);

  return {
    bytes: result.glb.length,
    elements: result.elements,
    meshes: result.meshes,
    triangles: result.triangles
  };
}

run()
  .then((result) => parentPort.postMessage({ ok: true, ...result }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) }));
