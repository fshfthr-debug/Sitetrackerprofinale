import * as THREE from 'three';
import { buildModelMatrix } from './placementMath.js';

/**
 * A GLB model drawn at its georeferenced anchor on the main GIS map.
 *
 * The camera is MapLibre's: the layer takes `defaultProjectionData.mainMatrix` (confirmed in the
 * stage-0 spike on 5.24.1) and renders the scene with no camera transform of its own, so the
 * building stays glued to the ground while the map pans, pitches and rotates. MapLibre's depth
 * buffer is left untouched, so a model behind a hill is hidden by the DEM.
 *
 * Geometry is rebased to its own centre (horizontally) and base (vertically) before it reaches
 * the GPU: float32 cannot hold UTM-scale coordinates with millimetre precision, and the matrix
 * carries the world position instead.
 */

export const MODEL_LAYER_ID = 'georef-bim-model';

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

const beforeId = (map) => {
  const layers = (map.getStyle() && map.getStyle().layers) || [];
  const symbol = layers.find((layer) => layer.type === 'symbol' && layer.id !== MODEL_LAYER_ID);
  return symbol ? symbol.id : undefined;
};

export async function attachGeoreferencedModel(map, { placement, url, authHeaders, onStatus }) {
  const status = (state, message) => { if (onStatus) onStatus({ state, message }); };

  if (!placement || placement.configured === false) throw new Error('No georeferenced placement is available.');
  if (!placement.model || !placement.model.fileUrl) throw new Error('No GLB model is attached to this project.');
  if (!url) throw new Error('The model has no download URL.');

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
  // the saved transform says the anchor is the *model origin*, so shifting the geometry to its own
  // centre (or its bounding-box base) would move the building by half its footprint against the
  // survey control points. Whatever offset a file needs is expressed by the model origin and the
  // height offset in the Georeferencing panel, and checked against the control points there.
  const oriented = new THREE.Group();
  oriented.add(gltf.scene);
  oriented.rotation.x = Math.PI / 2;
  oriented.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = box.getSize(new THREE.Vector3());

  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(modelMatrix(placement));
  holder.add(oriented);

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
    if (scene) {
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose && material.dispose());
        }
      });
    }
    if (renderer) renderer.dispose();
    renderer = null;
    scene = null;
    holder.clear();
  };

  const sizeMetres = {
    width: Math.round(size.x * 100) / 100,
    depth: Math.round(size.y * 100) / 100,
    height: Math.round(size.z * 100) / 100
  };
  status('ready', `${placement.model.fileName || 'Model'} placed at its anchor — ${sizeMetres.width} × ${sizeMetres.depth} × ${sizeMetres.height} m.`);

  return { remove, sizeMetres, layerId: MODEL_LAYER_ID };
}
