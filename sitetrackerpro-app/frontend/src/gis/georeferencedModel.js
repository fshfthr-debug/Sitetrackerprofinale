import * as THREE from 'three';
import { buildModelMatrix } from './placementMath.js';
import { loadIfcModel, IFC_BROWSER_LIMIT_BYTES, largeIfcMessage } from './ifcModel.js';

/**
 * A model drawn at its georeferenced anchor on the main GIS map.
 *
 * The camera is MapLibre's: the layer takes `defaultProjectionData.mainMatrix` (confirmed in the
 * stage-0 spike on 5.24.1) and renders the scene with no camera transform of its own, so the
 * building stays glued to the ground while the map pans, pitches and rotates. MapLibre's depth
 * buffer is left untouched, so a model behind a hill is hidden by the DEM.
 *
 * Two geometry sources, one placement:
 *   * glTF/GLB is Y-up and is rotated +90° about X into (east, north, up).
 *   * IFC is already Z-up and is read in the browser with the BIM viewer's extraction
 *     (src/bim/ifcGeometry.js), for files up to 25 MB. Larger files are refused here with the
 *     server-conversion path spelled out, rather than freezing the tab.
 */

export const MODEL_LAYER_ID = 'georef-bim-model';

const beforeId = (map) => {
  const layers = (map.getStyle() && map.getStyle().layers) || [];
  const symbol = layers.find((layer) => layer.type === 'symbol' && layer.id !== MODEL_LAYER_ID);
  return symbol ? symbol.id : undefined;
};

/**
 * The model matrix for a placement, with two decisions applied.
 *
 * The model origin is subtracted after rotation and scale, so the anchor lands on the origin's
 * position on the ground: that is the transform the API resolves and checks against the
 * alignment pairs (a model in CRS coordinates carries a large origin; a local model carries 0,0).
 *
 * The anchor's absolute elevation is deliberately *not* used for the vertical placement. MapLibre
 * draws a custom layer relative to the map's coordinate surface, and the surface already carries
 * the map's own height; adding a 2,300 m anchor elevation would float the building kilometres
 * above a flat map (and double-count on a DEM map). The model therefore sits on the surface,
 * lifted only by the saved height offset. Ground-following terrain comes with the DEM stage.
 */
function modelMatrix(placement) {
  const onSurface = {
    ...placement,
    anchor: { ...placement.anchor, height: Number(placement.zOffset) || 0 }
  };
  const origin = placement.modelOrigin;
  const rebase = origin ? { x: Number(origin.east) || 0, y: Number(origin.north) || 0, z: Number(origin.up) || 0 } : null;
  return buildModelMatrix(onSurface, rebase);
}

/** Which renderer the model needs, and whether it may be drawn at all. */
export function rendererForPlacement(placement) {
  const model = placement && placement.model;
  if (!model) return { renderer: null, drawable: false, reason: 'No model is attached to this project.' };
  const support = model.mapSupport;
  if (support) {
    return { renderer: support.renderer, drawable: support.drawable !== false, reason: support.reason || null };
  }
  const name = String(model.fileName || '');
  if (/\.ifc$/i.test(name)) return { renderer: 'ifc', drawable: true, reason: null };
  if (/\.glb$|\.gltf$/i.test(name)) return { renderer: 'gltf', drawable: true, reason: null };
  return { renderer: null, drawable: false, reason: 'The map draws IFC, GLB and glTF models.' };
}

/**
 * Geometry in the model's own frame, in metres, Z-up, plus how to dispose of it.
 * Both branches return { group, sizeMetres, dispose, format }.
 */
async function loadModelGeometry(placement, { url, authHeaders, wasmPath, onStatus }) {
  const status = (state, message) => { if (onStatus) onStatus({ state, message }); };
  const support = rendererForPlacement(placement);
  if (!support.drawable) throw new Error(support.reason);

  if (support.renderer === 'ifc') {
    return loadIfcModel(url, { authHeaders, wasmPath, onStatus });
  }

  status('loading', `Loading ${placement.model.fileName || 'model'}…`);
  const response = await fetch(url, { headers: authHeaders || {} });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error((detail && detail.error) || `The model could not be downloaded (HTTP ${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('The stored model file is empty.');

  status('loading', 'Reading glTF…');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader');
  const gltf = await new GLTFLoader().parseAsync(buffer, '');

  // glTF is Y-up; the layer works in (east, north, up). Geometry is left where the file puts it:
  // the saved transform says the anchor is the *model origin*, so shifting the geometry to its
  // own centre (or its bounding-box base) would move the building by half its footprint against
  // the survey control points.
  const oriented = new THREE.Group();
  oriented.add(gltf.scene);
  oriented.rotation.x = Math.PI / 2;
  oriented.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = box.getSize(new THREE.Vector3());
  const sizeMetres = {
    width: Math.round(size.x * 100) / 100,
    depth: Math.round(size.y * 100) / 100,
    height: Math.round(size.z * 100) / 100
  };

  return {
    group: oriented,
    format: 'gltf',
    sizeMetres,
    bounds: box,
    bytes: buffer.byteLength,
    dispose() {
      oriented.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose && material.dispose());
        }
      });
      oriented.clear();
    }
  };
}

export async function attachGeoreferencedModel(map, { placement, url, authHeaders, wasmPath, onStatus }) {
  const status = (state, message) => { if (onStatus) onStatus({ state, message }); };

  if (!placement || placement.configured === false) throw new Error('No georeferenced placement is available.');
  if (!placement.model || !placement.model.fileUrl) throw new Error('No model is attached to this project.');
  if (!url) throw new Error('The model has no download URL.');

  const model = await loadModelGeometry(placement, { url, authHeaders, wasmPath, onStatus });

  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(modelMatrix(placement));
  holder.add(model.group);

  let renderer = null;
  let scene = null;
  let camera = null;
  let added = false;
  let disposed = false;

  const addLayer = () => {
    if (disposed || added || !map.getStyle()) return;
    if (map.getLayer(MODEL_LAYER_ID)) { added = true; return; }
    try {
      map.addLayer(layer, beforeId(map));
      added = true;
      map.triggerRepaint();
    } catch (err) {
      // A style swap can race the add; the style.load listener retries.
    }
  };

  const removeLayer = () => {
    if (map.getLayer(MODEL_LAYER_ID)) {
      map.removeLayer(MODEL_LAYER_ID);
      map.triggerRepaint();
    }
    added = false;
  };

  const onStyleLoad = () => { added = false; addLayer(); };

  const layer = {
    id: MODEL_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(mapInstance, gl) {
      if (renderer) return;
      camera = new THREE.PerspectiveCamera();
      camera.matrixAutoUpdate = false;
      camera.updateMatrixWorld(true);

      renderer = new THREE.WebGLRenderer({ canvas: mapInstance.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;            // keep MapLibre's colour and depth
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setPixelRatio(1);

      scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-0.4, -0.6, 1);
      scene.add(sun);
      scene.add(holder);
    },
    render(gl, args) {
      if (!renderer || !scene) return;
      const matrix = args.defaultProjectionData && args.defaultProjectionData.mainMatrix;
      if (!matrix) return;
      camera.projectionMatrix.fromArray(matrix);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.resetState();
      renderer.render(scene, camera);
    }
  };

  map.on('style.load', onStyleLoad);
  addLayer();
  map.triggerRepaint();

  const remove = () => {
    disposed = true;
    map.off('style.load', onStyleLoad);
    removeLayer();
    holder.clear();
    model.dispose();
    if (renderer) renderer.dispose();
    renderer = null;
    scene = null;
  };

  if (model.format !== 'ifc') {
    status('ready', `${placement.model.fileName || 'Model'} placed at its anchor — `
      + `${model.sizeMetres.width} × ${model.sizeMetres.depth} × ${model.sizeMetres.height} m.`);
  }

  return {
    remove,
    sizeMetres: model.sizeMetres,
    layerId: MODEL_LAYER_ID,
    format: model.format,
    elements: model.elements || null,
    meshes: model.meshes || null,
    storeys: model.storeys || null,
    schema: model.schema || null,
    bytes: model.bytes || null
  };
}

export { IFC_BROWSER_LIMIT_BYTES, largeIfcMessage };
