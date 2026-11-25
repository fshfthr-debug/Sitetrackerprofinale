import * as THREE from 'three';
import { extractIfcGeometry } from '../bim/ifcGeometry.js';

// ---------------------------------------------------------------------------
// An IFC read in the browser for the GIS map layer.
//
// Stage 2 of the 3D plan: files up to 25 MB are drawn directly, with no server conversion. The
// geometry comes from the same extraction the BIM viewer uses (src/bim/ifcGeometry.js), so an
// IFC that looks right in the viewer looks right on the map.
//
// The limit is not arbitrary: web-ifc parses and tessellates the whole file on the main thread,
// and a 100 MB IFC will freeze the tab for tens of seconds and then run out of memory on a site
// laptop. Above the limit the caller shows the "large model" path instead (server conversion,
// stage 3) rather than starting a load that will not finish.
// ---------------------------------------------------------------------------

export const IFC_BROWSER_LIMIT_BYTES = 25 * 1024 * 1024;

export const megabytes = (bytes) => (bytes === null || bytes === undefined
  ? 'unknown size'
  : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);

export function largeIfcMessage(sizeBytes) {
  return `This IFC is ${megabytes(sizeBytes)}, over the 25 MB the browser can read directly. `
    + 'Large models need the server-side conversion stage, which is not built yet — '
    + 'export a GLB from your BIM tool and import that in the meantime.';
}

// web-ifc's WebAssembly module is expensive to compile, so one API instance is shared by every
// model opened in the session (and every re-attach after a basemap swap).
let sharedApi = null;
let sharedWasmPath = null;

async function ifcApi(wasmPath) {
  if (sharedApi && sharedWasmPath === wasmPath) return sharedApi;
  const { IfcAPI } = await import('web-ifc');
  const api = new IfcAPI();
  api.SetWasmPath(wasmPath, true);
  await api.Init();
  sharedApi = api;
  sharedWasmPath = wasmPath;
  return api;
}

/**
 * Load an IFC and return a THREE group in the model's own frame, in metres, Z-up.
 *
 * The geometry keeps the IFC's own coordinates (web-ifc's COORDINATE_TO_ORIGIN keeps the file's
 * origin instead of the huge site coordinates), and the file's length unit is applied as a scale
 * on the group, so a millimetre IFC is not drawn a thousand times too big.
 */
export async function loadIfcModel(url, { authHeaders, wasmPath, onStatus } = {}) {
  const status = (state, message) => { if (onStatus) onStatus({ state, message }); };

  status('loading', 'Downloading the IFC…');
  const response = await fetch(url, { headers: authHeaders || {} });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error((detail && detail.error) || `The IFC could not be downloaded (HTTP ${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('The stored IFC file is empty.');
  if (buffer.byteLength > IFC_BROWSER_LIMIT_BYTES) throw new Error(largeIfcMessage(buffer.byteLength));

  status('loading', `Reading the IFC in the browser (${megabytes(buffer.byteLength)})…`);
  // web-ifc looks for `${path}web-ifc.wasm`; the build copies it to the site root (see
  // frontend/scripts/copy-web-ifc-wasm.js), the same path the BIM viewer uses.
  const api = await ifcApi(wasmPath || `${process.env.PUBLIC_URL || ''}/`);

  let modelID = null;
  try {
    modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
  } catch (err) {
    throw new Error(`web-ifc could not open this file: ${err.message}`);
  }

  let extracted;
  try {
    extracted = extractIfcGeometry(api, modelID, { arrayBuffer: buffer });
  } catch (err) {
    try { api.CloseModel(modelID); } catch (closeError) { /* already closed */ }
    throw new Error(`web-ifc could not read geometry from this IFC: ${err.message}`);
  }

  if (extracted.meshes.length === 0) {
    try { api.CloseModel(modelID); } catch (closeError) { /* already closed */ }
    throw new Error('This IFC has no drawable geometry. It may be a coordination or property-only model.');
  }

  // No unit scale is applied. web-ifc already converts the file's length unit to metres while it
  // builds the vertex arrays: in a millimetre IFC an extrusion 3195.2 mm long arrives as 3.195,
  // and a 38 m building measures 38. Scaling by the declared unit as well drew every millimetre
  // model a thousand times too small — a 25 m building became 2.5 cm, invisible below zoom 22.
  // The declared unit is still reported, because it is what the file says, not what the
  // geometry is in.
  const group = new THREE.Group();
  group.name = 'ifc-model';
  group.add(extracted.group);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());

  const sizeMetres = {
    width: Math.round(size.x * 100) / 100,
    depth: Math.round(size.y * 100) / 100,
    height: Math.round(size.z * 100) / 100
  };

  status('ready', `IFC read: ${extracted.elements.length} elements, ${extracted.meshes.length} meshes`
    + `${extracted.storeys.length ? `, ${extracted.storeys.length} storeys` : ''}`
    + ` · ${sizeMetres.width} × ${sizeMetres.depth} × ${sizeMetres.height} m (${extracted.schema}, `
    + `declared in ${extracted.unit.prefix}s).`);

  return {
    group,
    format: 'ifc',
    sizeMetres,
    bounds,
    elements: extracted.elements.length,
    meshes: extracted.meshes.length,
    elementBoxes: extracted.elements.map((element) => ({
      type: element.type,
      expressID: element.expressID,
      minE: element.bbox.min.x, maxE: element.bbox.max.x,
      minN: element.bbox.min.y, maxN: element.bbox.max.y,
      minUp: element.bbox.min.z, maxUp: element.bbox.max.z
    })),
    storeys: extracted.storeys,
    schema: extracted.schema,
    unit: extracted.unit,
    bytes: buffer.byteLength,
    dispose() {
      group.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose && material.dispose());
        }
      });
      group.clear();
      if (modelID !== null) {
        try { api.CloseModel(modelID); } catch (err) { /* already closed */ }
        modelID = null;
      }
    }
  };
}
