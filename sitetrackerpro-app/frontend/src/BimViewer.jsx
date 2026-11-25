import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { colourForType, geometryFromPlacedGeometry } from './bim/ifcGeometry';

// ---------------------------------------------------------------------------
// BIM viewer built on three.js (MIT) + web-ifc (MPL-2.0).
//
// Every shape drawn here comes from the file the user opens: IFC geometry from
// web-ifc, glTF geometry from three.js' GLTFLoader. Nothing in this component
// invents walls, slabs or rooms from a footprint — if a file has no geometry for
// an element, that element simply has no mesh.
//
// web-ifc is imported dynamically so the library and its WebAssembly module stay
// out of the main bundle for every other screen.
// ---------------------------------------------------------------------------

const API_URL = process.env.REACT_APP_API_URL || '';
const WASM_PATH = `${process.env.PUBLIC_URL || ''}/`;

const round = (value) => Math.round(value * 100) / 100;

const styles = {
  shell: { background: 'var(--surface)', borderRadius: '14px', border: '1px solid var(--line)', boxShadow: 'var(--shadow-xs)', overflow: 'hidden' },
  topBar: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' },
  toggle: { display: 'flex', gap: '6px', marginLeft: 'auto' },
  tab: { padding: '7px 12px', borderRadius: '7px', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink-2)', fontWeight: 600, fontSize: '11px', cursor: 'pointer' },
  tabOn: { padding: '7px 12px', borderRadius: '7px', border: '1px solid var(--copper)', background: 'var(--copper)', color: '#fffaf3', fontWeight: 600, fontSize: '11px', cursor: 'pointer' },
  body: { display: 'grid', gridTemplateColumns: '232px minmax(0, 1fr) 360px', minHeight: '540px' },
  side: { padding: '14px', borderRight: '1px solid var(--line)', overflow: 'auto', maxHeight: '620px', minWidth: 0 },
  sideRight: { padding: '14px', borderLeft: '1px solid var(--line)', overflow: 'auto', maxHeight: '620px', minWidth: 0 },
  stage: { position: 'relative', minWidth: 0, minHeight: '540px', background: 'var(--surface-2)' },
  canvasHost: { position: 'absolute', inset: 0 },
  toolbar: { position: 'absolute', top: '8px', left: '8px', right: '8px', display: 'flex', gap: '5px', flexWrap: 'wrap' },
  tool: { padding: '6px 9px', fontSize: '10px', fontWeight: 600, border: '1px solid var(--line)', borderRadius: '6px', background: 'rgba(255,253,248,0.95)', color: 'var(--ink-2)', cursor: 'pointer' },
  toolOn: { padding: '6px 9px', fontSize: '10px', fontWeight: 600, border: '1px solid var(--copper)', borderRadius: '6px', background: 'var(--copper)', color: '#fffaf3', cursor: 'pointer' },
  h4: { margin: '0 0 8px', fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '3px 0' },
  name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  count: { color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: '9px' },
  drop: { border: '1px dashed var(--line-strong)', borderRadius: '9px', padding: '14px 10px', textAlign: 'center', fontSize: '11px', color: 'var(--ink-3)', background: 'var(--surface-2)', cursor: 'pointer' },
  hint: { fontSize: '9.5px', color: 'var(--ink-3)', lineHeight: 1.5, margin: '6px 0 0' },
  chip: { fontSize: '9px', background: 'rgba(31,39,35,0.86)', color: '#f6f1e7', padding: '5px 9px', borderRadius: '6px' },
  chipWarn: { fontSize: '9px', background: 'var(--amber)', color: '#fffaf3', padding: '5px 9px', borderRadius: '6px' },
  status: { position: 'absolute', left: '8px', bottom: '8px', right: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap', pointerEvents: 'none' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', tableLayout: 'fixed' },
  th: { textAlign: 'left', color: '#63748a', fontWeight: 600, fontSize: '10.5px', textTransform: 'uppercase', padding: '3px 4px', borderBottom: '1px solid #eef1f5' },
  td: { padding: '3px 4px', borderBottom: '1px solid #f2f5f8', overflowWrap: 'break-word', verticalAlign: 'top' },
  kv: { display: 'grid', gridTemplateColumns: '78px 1fr', gap: '3px 8px', fontSize: '12px', margin: 0 },
  dt: { color: '#63748a' },
  dd: { margin: 0, overflowWrap: 'break-word' },
  measure: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0', borderBottom: '1px solid #f2f5f8' },
  error: { margin: '10px 14px', padding: '10px', borderRadius: '8px', background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '10px', lineHeight: 1.5 }
};

const refId = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value.value === 'number') return value.value;
  if (typeof value.expressID === 'number') return value.expressID;
  return null;
};
const unwrap = (value) => {
  let current = value;
  for (let i = 0; i < 4 && current && typeof current === 'object' && 'value' in current; i++) current = current.value;
  return current;
};
const textOf = (value) => {
  const raw = unwrap(value);
  if (raw == null || typeof raw === 'object') return '';
  return String(raw);
};
const asArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.size === 'function') {
    const out = [];
    for (let i = 0; i < value.size(); i++) out.push(value.get(i));
    return out;
  }
  return [value];
};

// Qto_* sets hold the author's own quantities; nothing is computed here. If a file
// has none, the take-off falls back to a geometry measurement that the UI marks.
const quantitiesFromPsets = (psets) => {
  const result = { volume: null, area: null, length: null, weight: null, source: null };
  const qtoSets = psets.filter((set) => /^Qto_/i.test(set.name));
  const pick = (keys) => {
    for (const set of qtoSets) {
      for (const key of keys) {
        const raw = set.properties[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const value = Number(String(raw).replace(/[^0-9.\-eE]/g, ''));
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return null;
  };
  result.volume = pick(['NetVolume', 'GrossVolume', 'Volume']);
  result.area = pick(['NetArea', 'GrossArea', 'NetSideArea', 'GrossSideArea', 'NetFloorArea']);
  result.length = pick(['Length', 'NetLength']);
  result.weight = pick(['NetWeight', 'GrossWeight', 'Weight']);
  if (result.volume || result.area || result.length || result.weight) result.source = 'qto';
  return result;
};

export default function BimViewer({ token, projects = [], projectId }) {
  const hostRef = useRef(null);
  const engineRef = useRef(null);
  const [status, setStatus] = useState('Open an IFC, GLB or glTF file to view the model');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [storeys, setStoreys] = useState([]);
  const [types, setTypes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [takeoff, setTakeoff] = useState([]);
  const [measures, setMeasures] = useState([]);
  const [mode, setMode] = useState('select');
  const [section, setSection] = useState({ on: false, axis: 'x', value: 50 });
  const [wireframe, setWireframe] = useState(false);
  const [ghost, setGhost] = useState(false);
  const [edges, setEdges] = useState(false);
  const [projectIdInput, setProjectIdInput] = useState(projectId ? String(projectId) : '');
  const [sendResult, setSendResult] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (projectId) setProjectIdInput(String(projectId));
  }, [projectId]);

  // ---------------------------------------------------------------- scene ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1ede5);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.02;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8fa3b8, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 60, 25);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-25, 20, -30);
    scene.add(fill);

    const grid = new THREE.GridHelper(100, 40, 0xd2c9ba, 0xe9e3d8);
    scene.add(grid);

    const modelRoot = new THREE.Group();
    scene.add(modelRoot);
    const measureRoot = new THREE.Group();
    scene.add(measureRoot);
    const measureGroup = new THREE.Group();
    measureRoot.add(measureGroup);

    const engine = {
      scene, camera, renderer, controls, modelRoot, measureRoot, measureGroup,
      elements: [], elementById: new Map(), meshes: [], bbox: null,
      storeys: [], unitScale: 1, api: null, modelID: null,
      visibleStoreys: new Set(), visibleTypes: new Set(),
      selected: null, mode: 'select', wireframe: false, ghost: false, edges: false,
      sectionOn: false, sectionAxis: 'x', sectionValue: 50,
      measurePoints: [], measureCount: 0,
      raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
      clipPlane: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)
    };
    engineRef.current = engine;

    const resize = () => {
      const { clientWidth, clientHeight } = host;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      // Keep the model framed when the panel or window changes size, unless the user
      // has already moved the camera.
      if (engine.frameBox && engine.lastBox && !engine.userMoved) {
        engine.frameBox(engine.lastBox, engine.lastDir);
      }
    };
    controls.addEventListener('start', () => { engine.userMoved = true; });
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const viewDirections = {
      iso: new THREE.Vector3(1, 0.8, 1),
      front: new THREE.Vector3(0, 0.18, 1),
      side: new THREE.Vector3(1, 0.18, 0),
      top: new THREE.Vector3(0, 1, 0.001)
    };

    // Fits the model's eight corners to the canvas in both directions, so wide and
    // narrow models both fill the frame at any aspect ratio.
    const frameBox = (box, direction = viewDirections.iso) => {
      if (!box || box.isEmpty()) return;
      engine.lastBox = box.clone();
      engine.lastDir = direction.clone();
      engine.userMoved = false;
      const { clientWidth, clientHeight } = host;
      const aspect = clientWidth && clientHeight ? clientWidth / clientHeight : 1;
      const centre = box.getCenter(new THREE.Vector3());
      const dir = direction.clone().normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      const up = new THREE.Vector3().crossVectors(dir, right).normalize();
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const tanH = tanV * aspect;
      let depth = 0;
      [box.min.x, box.max.x].forEach((x) => [box.min.y, box.max.y].forEach((y) => [box.min.z, box.max.z].forEach((z) => {
        const offset = new THREE.Vector3(x, y, z).sub(centre);
        const along = offset.dot(dir);
        const across = Math.abs(offset.dot(right));
        const vertical = Math.abs(offset.dot(up));
        depth = Math.max(depth, along + across / tanH, along + vertical / tanV);
      })));
      const distance = Math.max(depth * 1.08, 0.5);
      camera.aspect = aspect;
      camera.near = Math.max(distance / 500, 0.01);
      camera.far = distance + box.getSize(new THREE.Vector3()).length() * 6;
      camera.position.copy(centre).add(dir.multiplyScalar(distance));
      camera.updateProjectionMatrix();
      controls.target.copy(centre);
      controls.update();
    };
    engine.frameBox = frameBox;
    engine.viewDirections = viewDirections;
    engine.views = viewDirections;

    const applyVisibility = () => {
      engine.elements.forEach((element) => {
        const visible = engine.visibleTypes.has(element.type)
          && (engine.visibleStoreys.size === 0 || element.storeyId == null || engine.visibleStoreys.has(element.storeyId));
        element.meshes.forEach((mesh) => { mesh.visible = visible; });
      });
    };
    engine.applyVisibility = applyVisibility;

    const applyGhost = () => {
      engine.elements.forEach((element) => {
        const material = element.material;
        if (!material) return;
        const isSelected = engine.selected && element.expressID === engine.selected.expressID;
        material.transparent = engine.ghost && !isSelected;
        material.opacity = engine.ghost && !isSelected ? 0.16 : 1;
        material.depthWrite = !(engine.ghost && !isSelected);
        material.needsUpdate = true;
      });
    };
    engine.applyGhost = applyGhost;

    const applyClipping = () => {
      const planes = engine.sectionOn ? [engine.clipPlane] : [];
      engine.elements.forEach((element) => {
        if (!element.material) return;
        element.material.clippingPlanes = planes;
        element.material.clipShadows = true;
        element.material.needsUpdate = true;
      });
    };
    engine.applyClipping = applyClipping;

    const selectElement = (element) => {
      if (engine.selected && engine.selected.material && engine.selected.material.emissive) {
        engine.selected.material.emissive.setHex(0x000000);
      }
      engine.selected = element || null;
      if (element && element.material && element.material.emissive) {
        element.material.emissive.setHex(0x12314f);
        element.material.emissiveIntensity = 0.5;
      }
      setSelected(element ? {
        name: element.name,
        type: element.type,
        globalId: element.globalId,
        storey: (engine.storeys.find((storey) => storey.id === element.storeyId) || {}).name || 'not in a storey',
        material: element.materialName,
        meshes: element.meshes.length,
        geometry: element.geometrySource,
        qty: element.qty,
        psets: element.psets
      } : null);
      if (engine.ghost) applyGhost();
    };
    engine.selectElement = selectElement;

    const pick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      engine.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      engine.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      engine.raycaster.setFromCamera(engine.pointer, camera);
      return engine.raycaster.intersectObjects(modelRoot.children, true).find((hit) => hit.object.visible);
    };

    const labelSprite = (label) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = 'rgba(0,78,137,.94)';
      context.beginPath();
      context.roundRect(0, 0, 256, 64, 12);
      context.fill();
      context.fillStyle = '#fff';
      context.font = 'bold 30px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, 128, 34);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }));
      sprite.scale.set(0.16, 0.04, 1);
      return sprite;
    };

    const addMeasurePoint = (hit) => {
      if (!hit) return;
      const point = hit.point.clone();
      engine.measurePoints.push(point);
      const size = Math.max(0.025 * (engine.bbox ? engine.bbox.getSize(new THREE.Vector3()).length() / 10 : 1), 0.02);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(size, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff6b35, depthTest: false })
      );
      dot.renderOrder = 10;
      dot.position.copy(point);
      measureGroup.add(dot);

      if (engine.measurePoints.length === 2) {
        const [a, b] = engine.measurePoints;
        const distance = a.distanceTo(b) * engine.unitScale;
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([a, b]),
          new THREE.LineBasicMaterial({ color: 0xff6b35, depthTest: false })
        );
        line.renderOrder = 10;
        measureGroup.add(line);
        const sprite = labelSprite(`${distance.toFixed(3)} m`);
        sprite.position.copy(a.clone().lerp(b, 0.5));
        measureGroup.add(sprite);
        engine.measureCount += 1;
        setMeasures((list) => [...list, { id: engine.measureCount, text: `${distance.toFixed(3)} m` }]);
        engine.measurePoints.length = 0;
      }
      setStatus(engine.measurePoints.length === 0 ? 'Measure: pick the first point' : 'Measure: pick the second point');
    };
    engine.addMeasurePoint = addMeasurePoint;

    renderer.domElement.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const hit = pick(event);
      if (engine.mode === 'measure') { addMeasurePoint(hit); return; }
      if (!hit) { selectElement(null); return; }
      selectElement(engine.elementById.get(hit.object.userData.expressID) || null);
    });

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(animate);

    engine.dispose = () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      if (engine.api && engine.modelID != null) {
        try { engine.api.CloseModel(engine.modelID); } catch (e) { /* already closed */ }
      }
    };

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // --------------------------------------------------------------- loading ---
  const resetEngine = () => {
    const engine = engineRef.current;
    if (!engine) return null;
    if (engine.api && engine.modelID != null) {
      try { engine.api.CloseModel(engine.modelID); } catch (e) { /* already closed */ }
      engine.modelID = null;
      engine.api = null;
    }
    engine.elements = [];
    engine.elementById.clear();
    engine.storeys = [];
    engine.visibleStoreys.clear();
    engine.visibleTypes.clear();
    engine.selected = null;
    engine.bbox = null;
    engine.meshes = [];
    engine.modelRoot.clear();
    engine.measureGroup.clear();
    engine.measurePoints = [];
    engine.measureCount = 0;
    setSelected(null);
    setMeasures([]);
    setStoreys([]);
    setTypes([]);
    setTakeoff([]);
    setSendResult('');
    return engine;
  };

  const finishModel = (engine, info) => {
    setSummary(info);
    setStoreys(engine.storeys.map((storey) => ({
      id: storey.id,
      name: storey.name,
      visible: engine.visibleStoreys.has(storey.id),
      count: engine.elements.filter((element) => element.storeyId === storey.id).length
    })));
    const typeCounts = new Map();
    engine.elements.forEach((element) => typeCounts.set(element.type, (typeCounts.get(element.type) || 0) + 1));
    setTypes([...typeCounts.entries()].map(([type, count]) => ({ type, count, visible: true })).sort((a, b) => b.count - a.count));
    setTakeoff(buildTakeoff(engine));
  };

  const buildTakeoff = (engine) => {
    const byKey = new Map();
    engine.elements.forEach((element) => {
      if (!element.hasGeometry) return;
      const storey = engine.storeys.find((item) => item.id === element.storeyId);
      const material = element.materialName || element.type;
      let unit = 'no.';
      let quantity = 1;
      let source = 'count';
      if (element.qty.volume) { unit = 'm3'; quantity = element.qty.volume; source = 'qto'; }
      else if (element.qty.area) { unit = 'm2'; quantity = element.qty.area; source = 'qto'; }
      else if (element.qty.length) { unit = 'm'; quantity = element.qty.length; source = 'qto'; }
      else if (element.qty.weight) { unit = 'kg'; quantity = element.qty.weight; source = 'qto'; }
      else if (element.qty.estimatedVolume) { unit = 'm3'; quantity = element.qty.estimatedVolume; source = 'estimate'; }
      const phase = storey ? storey.name : 'Unassigned';
      const key = `${element.type}|${material}|${unit}|${phase}`;
      if (!byKey.has(key)) {
        const shortType = element.type.replace(/^Ifc/, '');
        byKey.set(key, {
          component: material && material !== element.type ? `${shortType} — ${element.type && element.materialName ? element.materialName : material}` : shortType,
          material,
          unit,
          phase,
          quantity: 0,
          count: 0,
          source
        });
      }
      const row = byKey.get(key);
      row.quantity += quantity;
      row.count += 1;
      if (source === 'estimate' || source === 'count') row.source = source;
    });
    return [...byKey.values()]
      .map((row) => ({ ...row, quantity: round(row.quantity) }))
      .sort((a, b) => a.phase.localeCompare(b.phase) || a.component.localeCompare(b.component));
  };

  const loadIfc = async (arrayBuffer, fileName) => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    setError('');
    setStatus('Reading IFC…');
    try {
      const { IfcAPI } = await import('web-ifc');
      const api = new IfcAPI();
      // Absolute: the wasm lives in public/ at the site root, and web-ifc otherwise
      // resolves it relative to this JS chunk (/static/js/…).
      api.SetWasmPath(WASM_PATH, true);
      await api.Init();
      engine.api = api;
      engine.unitScale = 1;

      const modelID = api.OpenModel(new Uint8Array(arrayBuffer), { COORDINATE_TO_ORIGIN: true });
      engine.modelID = modelID;

      const header = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer).slice(0, 8192));
      const schema = (header.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/) || [])[1] || 'IFC';

      // IFC classes are identified by their numeric type code, never by the JS class
      // name. A production build minifies class names (IfcWall became "F7"), which
      // silently emptied this whole index when it relied on constructor.name — the
      // storeys, property sets and materials all disappeared with it.
      const code = (schemaName) => api.GetTypeCodeFromName(schemaName);
      const CODES = {
        storey: code('IFCBUILDINGSTOREY'),
        containment: code('IFCRELCONTAINEDINSPATIALSTRUCTURE'),
        defines: code('IFCRELDEFINESBYPROPERTIES'),
        associatesMaterial: code('IFCRELASSOCIATESMATERIAL'),
        material: code('IFCMATERIAL'),
        siUnit: code('IFCSIUNIT'),
        opening: code('IFCOPENINGELEMENT'),
        space: code('IFCSPACE')
      };

      const allIds = api.GetAllLines(modelID);
      const lines = new Map();
      const typeById = new Map();
      const byCode = new Map();
      for (let i = 0; i < allIds.size(); i++) {
        const id = allIds.get(i);
        const line = api.GetLine(modelID, id);
        if (!line) continue;
        const typeCode = api.GetLineType(modelID, id);
        lines.set(id, line);
        typeById.set(id, typeCode);
        if (!byCode.has(typeCode)) byCode.set(typeCode, []);
        byCode.get(typeCode).push(id);
      }
      const typeName = (id) => {
        const typeCode = typeById.get(id);
        if (typeCode === undefined) return 'Unknown';
        return api.GetNameFromTypeCode(typeCode) || 'Unknown';
      };

      (byCode.get(CODES.siUnit) || []).forEach((id) => {
        const unit = lines.get(id);
        if (textOf(unit.UnitType).toUpperCase() !== 'LENGTHUNIT') return;
        const prefix = textOf(unit.Prefix).toUpperCase();
        engine.unitScale = prefix === 'MILLI' ? 0.001 : prefix === 'CENTI' ? 0.01 : 1;
      });

      engine.storeys = (byCode.get(CODES.storey) || []).map((id) => {
        const line = lines.get(id);
        return { id, name: textOf(line.Name) || `Storey #${id}`, elevation: Number(unwrap(line.Elevation)) || 0 };
      }).sort((a, b) => a.elevation - b.elevation);

      const storeyOf = new Map();
      (byCode.get(CODES.containment) || []).forEach((id) => {
        const rel = lines.get(id);
        const parent = refId(rel.RelatingStructure);
        asArray(rel.RelatedElements).forEach((ref) => {
          const child = refId(ref);
          if (child) storeyOf.set(child, parent);
        });
      });

      const psetsByElement = new Map();
      (byCode.get(CODES.defines) || []).forEach((id) => {
        const rel = lines.get(id);
        const defId = refId(rel.RelatingPropertyDefinition);
        const pset = defId ? lines.get(defId) : null;
        if (!pset) return;
        const psetName = textOf(pset.Name) || 'Property set';
        const properties = {};
        asArray(pset.HasProperties).forEach((propRef) => {
          const prop = lines.get(refId(propRef));
          if (!prop) return;
          const key = textOf(prop.Name);
          if (key) properties[key] = textOf(prop.NominalValue) || textOf(prop.Description);
        });
        asArray(rel.RelatedObjects).forEach((objRef) => {
          const elementId = refId(objRef);
          if (!elementId) return;
          if (!psetsByElement.has(elementId)) psetsByElement.set(elementId, []);
          psetsByElement.get(elementId).push({ name: psetName, properties });
        });
      });

      const materialByElement = new Map();
      (byCode.get(CODES.associatesMaterial) || []).forEach((id) => {
        const rel = lines.get(id);
        const materialId = refId(rel.RelatingMaterial);
        const material = materialId ? lines.get(materialId) : null;
        let name = '';
        if (material) {
          if (typeById.get(materialId) === CODES.material) name = textOf(material.Name);
          else if (material.ForLayerSet) {
            const layerSet = lines.get(refId(material.ForLayerSet));
            const firstLayer = layerSet ? asArray(layerSet.MaterialLayers)[0] : null;
            const layer = firstLayer ? lines.get(refId(firstLayer)) : null;
            const base = layer ? lines.get(refId(layer.Material)) : null;
            name = base ? textOf(base.Name) : '';
          } else if (material.Materials) {
            const first = lines.get(refId(asArray(material.Materials)[0]));
            name = first ? textOf(first.Name) : '';
          }
        }
        if (!name) return;
        asArray(rel.RelatedObjects).forEach((objRef) => {
          const elementId = refId(objRef);
          if (elementId) materialByElement.set(elementId, name);
        });
      });

      const elementMeshes = new Map();
      api.StreamAllMeshes(modelID, (flatMesh) => {
        const expressID = flatMesh.expressID;
        const line = lines.get(expressID);
        if (!line) return;
        const typeCode = typeById.get(expressID);
        if (typeCode === CODES.opening || typeCode === CODES.space) return;
        const type = typeName(expressID);

        let material = elementMeshes.has(expressID) ? elementMeshes.get(expressID).material : null;
        if (!material) {
          material = new THREE.MeshStandardMaterial({ color: colourForType(type), roughness: 0.62, metalness: 0.04 });
          elementMeshes.set(expressID, { material, meshes: [] });
        }
        const record = elementMeshes.get(expressID);

        for (let i = 0; i < flatMesh.geometries.size(); i++) {
          const placed = flatMesh.geometries.get(i);
          // Shared with the map layer (src/bim/ifcGeometry.js): same triangles, either screen.
          const mesh = new THREE.Mesh(geometryFromPlacedGeometry(api, modelID, placed), material);
          mesh.userData.expressID = expressID;
          mesh.userData.type = type;
          engine.modelRoot.add(mesh);
          engine.meshes.push(mesh);
          record.meshes.push(mesh);
        }
      });

      engine.elements = [...elementMeshes.entries()].map(([expressID, record]) => {
        const line = lines.get(expressID);
        const type = typeName(expressID);
        const psets = psetsByElement.get(expressID) || [];
        return {
          expressID,
          type,
          name: textOf(line.Name) || textOf(line.ObjectType) || `${type} #${expressID}`,
          globalId: textOf(line.GlobalId),
          hasGeometry: record.meshes.length > 0,
          storeyId: storeyOf.get(expressID) || null,
          meshes: record.meshes,
          material: record.material,
          psets,
          qty: quantitiesFromPsets(psets),
          materialName: materialByElement.get(expressID) || '',
          geometrySource: 'ifc'
        };
      });
      engine.elements.forEach((element) => engine.elementById.set(element.expressID, element));

      engine.modelRoot.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      engine.elements.forEach((element) => {
        const box = new THREE.Box3();
        element.meshes.forEach((mesh) => box.expandByObject(mesh));
        element.bbox = box;
        if (!element.qty.volume && !element.qty.area) {
          const size = box.getSize(new THREE.Vector3());
          element.qty.estimatedVolume = size.x * size.y * size.z;
        }
        bounds.union(box);
      });

      // Centre on the origin and rest on the ground plane.
      const centre = bounds.getCenter(new THREE.Vector3());
      engine.modelRoot.position.set(-centre.x, -bounds.min.y, -centre.z);
      engine.modelRoot.updateMatrixWorld(true);
      const centred = new THREE.Box3().setFromObject(engine.modelRoot);
      engine.bbox = centred;

      engine.storeys.forEach((storey) => {
        const box = new THREE.Box3();
        engine.elements.filter((element) => element.storeyId === storey.id).forEach((element) => { if (element.bbox) box.union(element.bbox); });
        storey.bbox = box;
      });

      engine.visibleStoreys = new Set(engine.storeys.map((storey) => storey.id));
      engine.visibleTypes = new Set(engine.elements.map((element) => element.type));
      engine.applyVisibility();
      engine.applyClipping();

      // Frame only what is actually rendered. IFC files often carry reference
      // geometry (site extents, geo-reference markers, gross-volume zones) that is
      // hidden by the storey filter; including it in the framing box made a small
      // building appear as a speck in a very large empty scene.
      const visibleBounds = new THREE.Box3();
      engine.meshes.forEach((mesh) => { if (mesh.visible) visibleBounds.expandByObject(mesh); });
      engine.bbox = visibleBounds.isEmpty() ? centred : visibleBounds;
      engine.frameBox(engine.bbox);

      const size = centred.getSize(new THREE.Vector3());
      finishModel(engine, {
        fileName,
        schema,
        kilobytes: Math.round(arrayBuffer.byteLength / 1024),
        elements: engine.elements.length,
        meshes: engine.meshes.length,
        storeys: engine.storeys.length,
        unit: engine.unitScale === 1 ? 'metre' : engine.unitScale === 0.001 ? 'millimetre' : 'centimetre',
        size: `${(size.x * engine.unitScale).toFixed(1)} × ${(size.y * engine.unitScale).toFixed(1)} × ${(size.z * engine.unitScale).toFixed(1)} m`,
        source: 'ifc'
      });
      setStatus(`${engine.meshes.length} meshes · ${engine.elements.length} elements · ${engine.storeys.length} storeys`);
    } catch (loadError) {
      setError(`Could not read ${fileName}: ${loadError.message}`);
      setStatus('Load failed');
    } finally {
      setBusy(false);
    }
  };

  const loadGltf = async (arrayBuffer, fileName) => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    setError('');
    setStatus('Reading glTF…');
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader');
      const gltf = await new GLTFLoader().parseAsync(arrayBuffer, '');
      const root = gltf.scene;
      engine.modelRoot.add(root);
      engine.modelRoot.position.set(0, 0, 0);
      engine.modelRoot.updateMatrixWorld(true);

      const meshes = [];
      root.traverse((child) => {
        if (!child.isMesh) return;
        child.userData.type = child.name || 'Mesh';
        meshes.push(child);
      });
      engine.meshes = meshes;

      const box = new THREE.Box3().setFromObject(root);
      const centre = box.getCenter(new THREE.Vector3());
      root.position.set(-centre.x, -box.min.y, -centre.z);
      root.updateMatrixWorld(true);
      const centred = new THREE.Box3().setFromObject(root);

      engine.elements = meshes.map((mesh, index) => ({
        expressID: index,
        type: mesh.name || 'glTF mesh',
        name: mesh.name || `Mesh ${index + 1}`,
        globalId: mesh.uuid.slice(0, 8),
        hasGeometry: true,
        storeyId: null,
        meshes: [mesh],
        material: mesh.material,
        psets: [],
        qty: { volume: null, area: null, length: null, weight: null, source: null },
        materialName: '',
        bbox: new THREE.Box3().setFromObject(mesh),
        geometrySource: 'gltf'
      }));
      engine.bbox = centred;
      engine.frameBox(centred);

      const size = centred.getSize(new THREE.Vector3());
      finishModel(engine, {
        fileName,
        schema: /\.gltf$/i.test(fileName) ? 'glTF' : 'GLB',
        kilobytes: Math.round(arrayBuffer.byteLength / 1024),
        elements: meshes.length,
        meshes: meshes.length,
        storeys: 0,
        unit: 'metre',
        size: `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m`,
        source: 'gltf'
      });
      setTakeoff([]);
      setStatus(`${meshes.length} meshes · glTF (no BIM metadata)`);
    } catch (loadError) {
      setError(`Could not read ${fileName}: ${loadError.message}`);
      setStatus('Load failed');
    } finally {
      setBusy(false);
    }
  };

  const openFile = (file) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.ifc') && !lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
      setError(lower.endsWith('.dwg') || lower.endsWith('.dxf')
        ? 'DWG and DXF are CAD drawings, not BIM models. Ask for an IFC export, or import a CSV take-off on the BIM Import screen.'
        : 'Unsupported file type. Open an IFC, GLB or glTF file.');
      return;
    }
    setError('');
    if (!resetEngine()) return;
    engineRef.current.measureGroup.clear();
    const reader = new FileReader();
    reader.onload = () => {
      if (lower.endsWith('.ifc')) loadIfc(reader.result, file.name);
      else loadGltf(reader.result, file.name);
    };
    reader.readAsArrayBuffer(file);
  };

  // ------------------------------------------------------------- actions -----
  const toggleStorey = (id) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.visibleStoreys.has(id)) engine.visibleStoreys.delete(id);
    else engine.visibleStoreys.add(id);
    engine.applyVisibility();
    setStoreys((list) => list.map((storey) => (storey.id === id ? { ...storey, visible: !storey.visible } : storey)));
  };

  const toggleType = (type) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.visibleTypes.has(type)) engine.visibleTypes.delete(type);
    else engine.visibleTypes.add(type);
    engine.applyVisibility();
    setTypes((list) => list.map((item) => (item.type === type ? { ...item, visible: !item.visible } : item)));
  };

  const isolateGround = () => {
    const engine = engineRef.current;
    if (!engine || engine.storeys.length === 0) return;
    const ground = engine.storeys[0];
    engine.visibleStoreys = new Set([ground.id]);
    engine.applyVisibility();
    setStoreys((list) => list.map((storey) => ({ ...storey, visible: storey.id === ground.id })));
    engine.frameBox(ground.bbox && !ground.bbox.isEmpty() ? ground.bbox : engine.bbox);
  };

  const showAll = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.visibleStoreys = new Set(engine.storeys.map((storey) => storey.id));
    engine.applyVisibility();
    setStoreys((list) => list.map((storey) => ({ ...storey, visible: true })));
    engine.frameBox(engine.bbox);
  };

  const setViewerMode = (next) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.mode = next;
    setMode(next);
    engine.measurePoints = [];
    setStatus(next === 'measure' ? 'Measure: pick the first point' : 'Ready');
  };

  const setView = (direction) => {
    const engine = engineRef.current;
    if (!engine || !engine.bbox) return;
    engine.frameBox(engine.bbox, engine.viewDirections[direction]);
  };

  const applySection = (next) => {
    const engine = engineRef.current;
    setSection(next);
    if (!engine) return;
    engine.sectionOn = next.on;
    engine.sectionAxis = next.axis;
    if (engine.bbox) {
      const axis = next.axis;
      const low = engine.bbox.min[axis];
      const high = engine.bbox.max[axis];
      const position = low + (high - low) * (next.value / 100);
      engine.clipPlane.normal.set(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0);
      engine.clipPlane.constant = position;
    }
    engine.applyClipping();
  };

  const toggleWireframe = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.wireframe = !engine.wireframe;
    setWireframe(engine.wireframe);
    engine.elements.forEach((element) => {
      if (element.material) { element.material.wireframe = engine.wireframe; element.material.needsUpdate = true; }
    });
  };

  const toggleGhost = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.ghost = !engine.ghost;
    setGhost(engine.ghost);
    engine.applyGhost();
  };

  const toggleEdges = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.edges = !engine.edges;
    setEdges(engine.edges);
    if (engine.edges) {
      if (engine.meshes.length > 4000) { setError('Too many meshes for the edge overlay.'); setEdges(false); engine.edges = false; return; }
      engine.meshes.forEach((mesh) => {
        if (mesh.userData.edges) return;
        const lines = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry, 32),
          new THREE.LineBasicMaterial({ color: 0x1c2b3a, transparent: true, opacity: 0.35 })
        );
        mesh.add(lines);
        mesh.userData.edges = lines;
      });
    } else {
      engine.meshes.forEach((mesh) => {
        if (mesh.userData.edges) {
          mesh.remove(mesh.userData.edges);
          mesh.userData.edges.geometry.dispose();
          mesh.userData.edges = null;
        }
      });
    }
  };

  const clearMeasures = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.measureGroup.clear();
    engine.measurePoints = [];
    engine.measureCount = 0;
    setMeasures([]);
    if (engine.mode === 'measure') setStatus('Measure: pick the first point');
  };

  const toCsv = () => {
    const header = 'Component,Material Type,Quantity,Unit,Phase';
    const lines = takeoff.map((row) => [row.component, row.material, row.quantity, row.unit, row.phase]
      .map((cell) => {
        const value = String(cell);
        return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      })
      .join(','));
    return [header, ...lines].join('\r\n');
  };

  const downloadCsv = () => {
    if (takeoff.length === 0) { setError('Open a model with quantities first.'); return; }
    const blob = new Blob([toCsv()], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(summary && summary.fileName ? summary.fileName : 'model').replace(/\.[^.]+$/, '')}-takeoff.csv`;
    link.click();
  };

  const sendToApp = async () => {
    if (!projectIdInput) { setSendResult('Enter the project ID first.'); return; }
    if (!token) { setSendResult('You need to be signed in.'); return; }
    if (takeoff.length === 0) { setSendResult('Nothing to send.'); return; }
    setSending(true);
    setSendResult('');
    try {
      const form = new FormData();
      form.append('projectId', projectIdInput);
      form.append('file', new Blob([toCsv()], { type: 'text/csv' }), 'bim-takeoff.csv');
      const response = await fetch(`${API_URL}/api/bim/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const data = await response.json();
      const saved = data.parsed ? data.parsed.rowsFound : null;
      setSendResult(response.ok ? `Saved${saved != null ? ` ${saved}` : ''} take-off rows to project ${projectIdInput}.` : `Failed: ${data.error || response.status}`);
    } catch (sendError) {
      setSendResult(`Failed: ${sendError.message}`);
    } finally {
      setSending(false);
    }
  };

  // ------------------------------------------------------------------ UI -----
  return (
    <div className="bim-viewer" style={styles.shell}>
      <div style={styles.topBar}>
        <label style={{ ...styles.tab, display: 'inline-block' }}>
          Open IFC / GLB / glTF
          <input
            id="bim-file"
            type="file"
            accept=".ifc,.glb,.gltf"
            style={{ display: 'none' }}
            onChange={(event) => { openFile(event.target.files && event.target.files[0]); event.target.value = ''; }}
          />
        </label>
        {summary && (
          <span style={{ fontSize: '12px', color: '#63748a' }}>
            {summary.fileName} · {summary.schema} · {summary.elements} elements
          </span>
        )}
        <span style={{ fontSize: '11px', color: '#8794a5' }}>
          geometry: {summary ? (summary.source === 'ifc' ? 'imported from IFC' : 'imported from glTF') : 'nothing loaded'}
        </span>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div className="bim-body" style={styles.body}>
        <div className="bim-side" style={styles.side}>
          <h4 style={styles.h4}>Levels</h4>
          {storeys.length === 0 ? (
            <p style={styles.hint}>Load an IFC model to see its storeys.</p>
          ) : (
            <>
              <div id="bim-levels">
                {storeys.map((storey) => (
                  <label key={storey.id} style={styles.row}>
                    <input type="checkbox" checked={storey.visible} onChange={() => toggleStorey(storey.id)} />
                    <span style={styles.name} title={storey.name}>{storey.name}</span>
                    <span style={styles.count}>{storey.count}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                <button type="button" className="btn-small" style={styles.tool} onClick={showAll}>Show all</button>
                <button type="button" style={styles.tool} onClick={isolateGround}>Ground only</button>
              </div>
            </>
          )}

          <h4 style={{ ...styles.h4, marginTop: '16px' }}>Element types</h4>
          {types.length === 0 ? (
            <p style={styles.hint}>—</p>
          ) : (
            <div id="bim-types">
              {types.slice(0, 24).map((item) => (
                <label key={item.type} style={styles.row}>
                  <input type="checkbox" checked={item.visible} onChange={() => toggleType(item.type)} />
                  <span style={styles.name} title={item.type}>{item.type.replace(/^Ifc/, '')}</span>
                  <span style={styles.count}>{item.count}</span>
                </label>
              ))}
            </div>
          )}

          <h4 style={{ ...styles.h4, marginTop: '16px' }}>Section</h4>
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            {['x', 'y', 'z'].map((axis) => (
              <button
                key={axis}
                type="button"
                style={section.axis === axis ? styles.toolOn : styles.tool}
                onClick={() => applySection({ ...section, axis })}
              >
                {axis.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              id="bim-section-toggle"
              style={section.on ? styles.toolOn : styles.tool}
              onClick={() => applySection({ ...section, on: !section.on })}
            >
              {section.on ? 'On' : 'Off'}
            </button>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={section.value}
            onChange={(event) => applySection({ ...section, value: Number(event.target.value) })}
            style={{ width: '100%', marginTop: '8px', accentColor: '#ff6b35' }}
          />
          <p style={styles.hint}>A real clipping plane on every material — only geometry in front of it is drawn.</p>
        </div>

        <div className="bim-stage" style={styles.stage}>
          <div ref={hostRef} id="bim-canvas" style={styles.canvasHost} />
          <div style={styles.toolbar}>
            <button type="button" style={styles.tool} onClick={() => setView('iso')}>Fit</button>
            <button type="button" style={styles.tool} onClick={() => setView('front')}>Front</button>
            <button type="button" style={styles.tool} onClick={() => setView('side')}>Side</button>
            <button type="button" style={styles.tool} onClick={() => setView('top')}>Top</button>
            <button type="button" style={mode === 'select' ? styles.toolOn : styles.tool} onClick={() => setViewerMode('select')}>Select</button>
            <button type="button" style={mode === 'measure' ? styles.toolOn : styles.tool} onClick={() => setViewerMode('measure')}>Measure</button>
            <button type="button" style={styles.tool} onClick={clearMeasures}>Clear</button>
            <button type="button" style={wireframe ? styles.toolOn : styles.tool} onClick={toggleWireframe}>Wireframe</button>
            <button type="button" style={edges ? styles.toolOn : styles.tool} onClick={toggleEdges}>Edges</button>
            <button type="button" style={ghost ? styles.toolOn : styles.tool} onClick={toggleGhost}>Ghost</button>
          </div>
          <div style={styles.status}>
            <span id="bim-status" style={busy ? styles.chipWarn : styles.chip}>{busy ? 'Working…' : status}</span>
            {selected && (
              <span style={styles.chip}>{selected.type.replace(/^Ifc/, '')}: {selected.name}</span>
            )}
          </div>
        </div>

        <div className="bim-side-right" style={styles.sideRight}>
          <h4 style={styles.h4}>Model</h4>
          {!summary ? (
            <p style={styles.hint}>No model loaded.</p>
          ) : (
            <dl style={styles.kv}>
              <dt style={styles.dt}>File</dt><dd style={styles.dd}>{summary.fileName}</dd>
              <dt style={styles.dt}>Schema</dt><dd style={styles.dd}>{summary.schema}</dd>
              <dt style={styles.dt}>Size</dt><dd style={styles.dd}>{summary.kilobytes} KB</dd>
              <dt style={styles.dt}>Elements</dt><dd style={styles.dd}>{summary.elements}</dd>
              <dt style={styles.dt}>Meshes</dt><dd style={styles.dd}>{summary.meshes}</dd>
              <dt style={styles.dt}>Storeys</dt><dd style={styles.dd}>{summary.storeys}</dd>
              <dt style={styles.dt}>Unit</dt><dd style={styles.dd}>{summary.unit}</dd>
              <dt style={styles.dt}>Extent</dt><dd style={styles.dd}>{summary.size}</dd>
            </dl>
          )}

          <h4 style={{ ...styles.h4, marginTop: '16px' }}>Properties</h4>
          <div id="bim-props">
            {!selected ? (
              <p style={styles.hint}>Click an element in the 3D view.</p>
            ) : (
              <>
                <dl style={styles.kv}>
                  <dt style={styles.dt}>Name</dt><dd style={styles.dd}>{selected.name}</dd>
                  <dt style={styles.dt}>IFC type</dt><dd style={styles.dd}>{selected.type}</dd>
                  <dt style={styles.dt}>GlobalId</dt><dd style={styles.dd}>{selected.globalId || '—'}</dd>
                  <dt style={styles.dt}>Storey</dt><dd style={styles.dd}>{selected.storey}</dd>
                  <dt style={styles.dt}>Material</dt><dd style={styles.dd}>{selected.material || '—'}</dd>
                  <dt style={styles.dt}>Meshes</dt><dd style={styles.dd}>{selected.meshes}</dd>
                  <dt style={styles.dt}>Geometry</dt><dd style={styles.dd}>{selected.geometry === 'ifc' ? 'imported from IFC' : 'imported from glTF'}</dd>
                </dl>
                {(selected.qty.volume || selected.qty.area || selected.qty.length || selected.qty.weight) && (
                  <table style={{ ...styles.table, marginTop: '8px' }}>
                    <tbody>
                      <tr><td style={styles.th} colSpan={2}>Quantities {selected.qty.source === 'qto' ? '(from Qto)' : ''}</td></tr>
                      {selected.qty.volume ? <tr><td style={styles.td}>Volume</td><td style={styles.td}>{selected.qty.volume.toFixed(2)} m³</td></tr> : null}
                      {selected.qty.area ? <tr><td style={styles.td}>Area</td><td style={styles.td}>{selected.qty.area.toFixed(2)} m²</td></tr> : null}
                      {selected.qty.length ? <tr><td style={styles.td}>Length</td><td style={styles.td}>{selected.qty.length.toFixed(2)} m</td></tr> : null}
                      {selected.qty.weight ? <tr><td style={styles.td}>Weight</td><td style={styles.td}>{selected.qty.weight.toFixed(1)} kg</td></tr> : null}
                    </tbody>
                  </table>
                )}
                {selected.psets.length === 0 ? (
                  <p style={styles.hint}>No property sets on this element.</p>
                ) : selected.psets.map((set) => (
                  <table key={set.name} style={{ ...styles.table, marginTop: '8px' }}>
                    <tbody>
                      <tr><td style={styles.th} colSpan={2}>{set.name}</td></tr>
                      {Object.entries(set.properties).slice(0, 12).map(([key, value]) => (
                        <tr key={key}><td style={styles.td}>{key}</td><td style={styles.td}>{value}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ))}
              </>
            )}
          </div>

          <h4 style={{ ...styles.h4, marginTop: '16px' }}>Quantities → Quantity Survey</h4>
          <p style={styles.hint}>
            Read from the model's own <code>Qto_*</code> sets; anything measured from geometry is marked ≈.
            Nothing is invented.
          </p>
          <div id="bim-qty">
            {takeoff.length === 0 ? (
              <p style={styles.hint}>Load an IFC model to build a take-off.</p>
            ) : (
              <table style={styles.table}>
                <colgroup><col style={{ width: '45%' }} /><col style={{ width: '23%' }} /><col style={{ width: '18%' }} /><col style={{ width: '14%' }} /></colgroup>
                <thead>
                  <tr><th style={styles.th}>Item</th><th style={styles.th}>Phase</th><th style={styles.th}>Qty</th><th style={styles.th}>Unit</th></tr>
                </thead>
                <tbody>
                  {takeoff.slice(0, 10).map((row) => (
                    <tr key={`${row.component}|${row.phase}|${row.unit}`}>
                      <td style={styles.td}>{row.component}</td>
                      <td style={styles.td}>{row.phase}</td>
                      <td style={styles.td}>{row.quantity.toFixed(2)}</td>
                      <td style={styles.td}>{row.unit}{row.source === 'estimate' ? ' ≈' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {takeoff.length > 10 && <p style={styles.hint}>+ {takeoff.length - 10} more lines in the CSV.</p>}
          </div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
            <button type="button" style={styles.tool} onClick={downloadCsv}>Download take-off CSV</button>
            <button type="button" style={styles.tool} onClick={sendToApp} disabled={sending}>{sending ? 'Sending…' : 'Send to app'}</button>
          </div>
          {projects && projects.length > 0 ? (
            <select
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              style={{ width: '100%', marginTop: '6px', padding: '6px', border: '1px solid #d7dee7', borderRadius: '5px', fontSize: '12px' }}
            >
              <option value="">-- Project for the take-off --</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          ) : (
            <input
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              placeholder="Project ID"
              style={{ width: '100%', marginTop: '6px', padding: '6px', border: '1px solid #d7dee7', borderRadius: '5px', fontSize: '12px' }}
            />
          )}
          {sendResult && <p style={styles.hint}>{sendResult}</p>}

          <h4 style={{ ...styles.h4, marginTop: '16px' }}>Measurements</h4>
          {measures.length === 0 ? (
            <p style={styles.hint}>None yet. Use Measure, then click two points.</p>
          ) : (
            measures.map((measure) => (
              <div key={measure.id} style={styles.measure}><span>{measure.id}. {measure.text}</span><span style={styles.hint}>point to point</span></div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
