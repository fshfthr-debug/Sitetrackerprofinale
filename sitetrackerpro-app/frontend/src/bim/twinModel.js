// ---------------------------------------------------------------------------
// The project's real building, for the Digital Twin viewer.
//
// The twin used to draw one cube per take-off row, which reads as a container
// yard rather than a building. When a project has a linked IFC / GLB / glTF
// model, the twin can draw that geometry instead, from the same extraction the
// BIM viewer and the GIS map layer use — so a model that looks right in one
// screen looks the same in the other.
//
// The model is normalised for display: turned Y-up, centred over the origin,
// rested on the ground plane and scaled to a fixed span. That is presentation
// only; measured sizes are reported in metres so nothing reads as a survey
// quantity.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { IFC_BROWSER_LIMIT_BYTES, loadIfcModel } from '../gis/ifcModel.js';
import { isGltfFileName, GLB_BROWSER_LIMIT_BYTES, tooLargeMessage } from './gltfFile.js';
import { gltfTextureWarning, parseGltfBuffer } from './gltfLoader.js';

// Display units across the model's wider footprint. The twin stage frames the
// camera from the data, so this is only a comfortable size next to the terrain.
export const TWIN_MODEL_SPAN = 18;

/** 'ifc' or 'gltf' for a file the twin can draw, otherwise null. */
export function twinModelKind(fileName) {
  const name = String(fileName || '');
  if (/\.ifc$/i.test(name)) return 'ifc';
  if (isGltfFileName(name)) return 'gltf';
  return null;
}

/** The authenticated URL that serves the stored model file. */
export function twinModelUrl(projectId, modelId) {
  return `${process.env.REACT_APP_API_URL || ''}/api/gis/georeferencing/${projectId}/model/${modelId}/file`;
}

const API_URL = process.env.REACT_APP_API_URL || '';

/** Where the server converts a large IFC to a GLB (POST starts it, GET reads its state). */
export function twinConvertUrl(projectId, modelId) {
  return `${API_URL}/api/bim/${projectId}/models/${modelId}/convert`;
}

/** The converted GLB itself. */
export function twinGlbUrl(projectId, modelId) {
  return `${API_URL}/api/bim/${projectId}/models/${modelId}/glb`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server to convert a model, then wait for it. Resolves when a GLB is ready.
 * Conversion happens once per model and is cached, so a second visit skips this entirely.
 */
export async function ensureTwinModelConverted(projectId, modelId, authHeaders, onStatus) {
  const status = (message) => { if (onStatus) onStatus({ state: 'converting', message }); };
  const headers = authHeaders || {};

  status('Sending the model to the server to be converted…');
  const started = await fetch(twinConvertUrl(projectId, modelId), { method: 'POST', headers });
  let payload = await started.json().catch(() => ({}));

  if (started.status === 413) {
    throw new Error(payload.error || 'This model is too large for the server to convert.');
  }
  if (!started.ok && started.status !== 202) {
    throw new Error(payload.error || `The server could not start the conversion (HTTP ${started.status}).`);
  }
  if (payload.status === 'ready') return;

  // Long enough for a large model on a small instance; the server keeps working if the tab gives up.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (payload.status === 'ready') return;
    if (payload.status === 'failed') {
      throw new Error(payload.error || 'The server could not convert this model.');
    }

    status(payload.status === 'queued'
      ? 'Waiting for another model to finish converting…'
      : 'Converting the model on the server — this happens once, and the first view can take a minute…');

    await sleep(3000);
    const response = await fetch(twinConvertUrl(projectId, modelId), { headers });
    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `The conversion status could not be read (HTTP ${response.status}).`);
    }
  }

  throw new Error('The server is still converting this model. Reload the twin in a minute and it should be ready.');
}

/**
 * Load a model for the twin, falling back to server-side conversion when an IFC is above the
 * size a browser can read. Everything else behaves exactly like loadTwinModel.
 */
export async function loadTwinModelWithConversion(url, { projectId, modelId, fileName, sizeBytes, authHeaders, wasmPath, onStatus } = {}) {
  const isIfc = twinModelKind(fileName) === 'ifc';
  const knownTooLarge = isIfc && Number(sizeBytes) > IFC_BROWSER_LIMIT_BYTES;

  try {
    // A model known to be over the browser limit is not downloaded just to be refused.
    if (knownTooLarge && projectId && modelId) throw Object.assign(new Error('', { code: 'IFC_TOO_LARGE' }));
    return await loadTwinModel(url, { fileName, authHeaders, wasmPath, onStatus });
  } catch (err) {
    if (!err || err.code !== 'IFC_TOO_LARGE' || !projectId || !modelId) throw err;

    await ensureTwinModelConverted(projectId, modelId, authHeaders, onStatus);
    if (onStatus) onStatus({ state: 'converting', message: 'Loading the converted model…' });

    const loaded = await loadTwinModel(twinGlbUrl(projectId, modelId), {
      fileName: `${String(fileName || 'model').replace(/\.ifc$/i, '')}.glb`,
      authHeaders,
      wasmPath,
      onStatus
    });
    loaded.converted = true;
    return loaded;
  }
}

export function unsupportedTwinModelMessage(fileName) {
  return `${fileName || 'This file'} is not building geometry the twin can draw. `
    + 'Link an IFC, GLB or glTF model to this project, or use the quantity blocks view.';
}

function disposeTree(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    const material = object.material;
    if (!material) return;
    (Array.isArray(material) ? material : [material]).forEach((entry) => entry.dispose && entry.dispose());
  });
  root.clear();
}

/**
 * Load a model and return it ready for the twin scene.
 *
 * Returns { group, kind, meshes, warning, sizeMetres, dispose }. `group` is
 * Y-up, centred on its own footprint, resting on y = 0 and scaled to
 * TWIN_MODEL_SPAN; `sizeMetres` is the model's own size, unrounded nowhere.
 */
export async function loadTwinModel(url, { fileName, authHeaders, wasmPath, onStatus } = {}) {
  const status = (state, message) => { if (onStatus) onStatus({ state, message }); };
  const kind = twinModelKind(fileName);
  if (!kind) throw new Error(unsupportedTwinModelMessage(fileName));

  let loaded;
  if (kind === 'ifc') {
    // Shares the map layer's reader: 25 MB ceiling, geometry and colours from
    // src/bim/ifcGeometry.js, and a clear message when a file is too large.
    loaded = await loadIfcModel(url, { authHeaders, wasmPath, onStatus });
  } else {
    status('loading', `Downloading ${fileName || 'the model'}…`);
    const response = await fetch(url, { headers: authHeaders || {} });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error((detail && detail.error) || `The model could not be downloaded (HTTP ${response.status}).`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error('The stored model file is empty.');
    if (buffer.byteLength > GLB_BROWSER_LIMIT_BYTES) {
      throw new Error(tooLargeMessage(fileName, buffer.byteLength));
    }

    status('loading', 'Reading glTF…');
    const gltf = await parseGltfBuffer(buffer, fileName || 'model.glb');
    const warning = await gltfTextureWarning(gltf, fileName || 'model.glb');
    let meshes = 0;
    gltf.scene.traverse((child) => { if (child.isMesh) meshes += 1; });
    loaded = {
      group: gltf.scene,
      format: 'gltf',
      warning,
      meshes,
      dispose() { disposeTree(gltf.scene); }
    };
  }

  // IFC is Z-up (north, east, up); three.js and glTF are Y-up.
  const placed = new THREE.Group();
  placed.add(loaded.group);
  if (loaded.format === 'ifc') placed.rotation.x = -Math.PI / 2;
  placed.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(placed);
  if (bounds.isEmpty()) throw new Error('The model has no drawable geometry, so the twin cannot show it.');

  const centre = bounds.getCenter(new THREE.Vector3());
  const metres = bounds.getSize(new THREE.Vector3());

  // Centre the footprint and rest the lowest point on the ground, then scale the
  // whole holder so translation and scale stay in the right order.
  placed.position.set(-centre.x, -bounds.min.y, -centre.z);
  const holder = new THREE.Group();
  holder.name = 'twin-model';
  holder.add(placed);
  const span = Math.max(metres.x, metres.z);
  holder.scale.setScalar(span > 0 ? TWIN_MODEL_SPAN / span : 1);
  holder.updateMatrixWorld(true);

  return {
    group: holder,
    kind: loaded.format,
    meshes: loaded.meshes || 0,
    warning: loaded.warning || null,
    sizeMetres: { width: metres.x, depth: metres.z, height: metres.y },
    dispose() {
      holder.clear();
      loaded.dispose();
    }
  };
}
