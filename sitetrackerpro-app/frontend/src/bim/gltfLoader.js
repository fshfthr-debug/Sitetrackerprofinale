// ---------------------------------------------------------------------------
// One glTF loader for the whole app, with the compression decoders attached.
//
// Models exported from Blender ("Draco" compression), Sketchfab and 3D
// Warehouse are frequently Draco- or Meshopt-compressed. A bare GLTFLoader
// refuses those with "No DRACOLoader instance provided", which surfaces as an
// unsupported-format error that says nothing about the real cause.
//
// The Draco WebAssembly decoders are copied from three.js into public/draco/ by
// scripts/copy-draco-decoders.js, so a model loads with no CDN and no network
// round trip beyond the app's own origin. Meshopt is a plain module bundled by
// the app.
// ---------------------------------------------------------------------------

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { assertLoadableGltf } from './gltfFile';

export const DRACO_DECODER_PATH = `${process.env.PUBLIC_URL || ''}/draco/`;

let loaderPromise = null;

function createLoader() {
  const loader = new GLTFLoader();

  // wasm first with the JavaScript decoder as the fallback; both live in
  // public/draco/, so an offline or blocked-CDN browser still opens the model.
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  loader.setDRACOLoader(draco);

  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** The shared loader; created once, and again only if creation failed. */
export function gltfLoader() {
  if (!loaderPromise) {
    loaderPromise = Promise.resolve()
      .then(createLoader)
      .catch((error) => {
        loaderPromise = null;
        throw error;
      });
  }
  return loaderPromise;
}

/**
 * Check the file, then parse it with the decoders attached. `fileName` is used
 * only for the error messages.
 */
export async function parseGltfBuffer(arrayBuffer, fileName) {
  assertLoadableGltf(arrayBuffer, fileName);
  const loader = await gltfLoader();
  return loader.parseAsync(arrayBuffer, DRACO_DECODER_PATH);
}
