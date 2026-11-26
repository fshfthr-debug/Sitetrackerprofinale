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
import { loadIfcModel } from '../gis/ifcModel.js';
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
