import * as THREE from 'three';

// ---------------------------------------------------------------------------
// IFC geometry extraction, shared by the BIM viewer and the GIS map layer.
//
// Both screens need the same thing from web-ifc: for every element, the triangles with the
// element's placement already applied. The BIM viewer adds property sets, quantities and storey
// filters on top; the map layer only needs geometry. Keeping this here means an IFC that renders
// in one screen cannot render differently in the other.
//
// web-ifc is loaded by the caller (it is a large WebAssembly module and both callers want to
// control when it is fetched), so these functions take an initialised IfcAPI.
// ---------------------------------------------------------------------------

// Stable colour per IFC class. Presentation only.
const typeColours = new Map();
export const colourForType = (type) => {
  if (!typeColours.has(type)) {
    let hash = 0;
    for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) % 360;
    typeColours.set(type, new THREE.Color().setHSL(hash / 360, 0.45, 0.62));
  }
  return typeColours.get(type);
};

/**
 * One placed piece of geometry as a three.js BufferGeometry, with web-ifc's flat transformation
 * baked in. The caller must not keep the web-ifc geometry object: it is released here.
 */
export function geometryFromPlacedGeometry(api, modelID, placed) {
  const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
  try {
    const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
    const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
    const count = vertices.length / 6;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      positions[v * 3] = vertices[v * 6];
      positions[v * 3 + 1] = vertices[v * 6 + 1];
      positions[v * 3 + 2] = vertices[v * 6 + 2];
      normals[v * 3] = vertices[v * 6 + 3];
      normals[v * 3 + 1] = vertices[v * 6 + 4];
      normals[v * 3 + 2] = vertices[v * 6 + 5];
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    buffer.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    buffer.applyMatrix4(new THREE.Matrix4().fromArray(placed.flatTransformation));
    return buffer;
  } finally {
    geometry.delete();
  }
}

/** The schema string from the STEP header, e.g. IFC4 or IFC2X3. */
export function readIfcSchema(arrayBuffer) {
  const header = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer).slice(0, 8192));
  return (header.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/) || [])[1] || 'IFC';
}

/**
 * The length unit of the file: IFC may be authored in metres, millimetres or centimetres, and a
 * millimetre model drawn at 1:1 is a thousand times too big on the map. Taken from IFCSIUNIT
 * lines directly (not by scanning every line), so it is cheap on a 25 MB file.
 */
export function readIfcLengthUnit(api, modelID) {
  const readValue = (value) => {
    let current = value;
    for (let i = 0; i < 4 && current && typeof current === 'object' && 'value' in current; i++) current = current.value;
    return current == null || typeof current === 'object' ? '' : String(current);
  };
  try {
    const unitIds = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName('IFCSIUNIT'));
    for (let i = 0; i < unitIds.size(); i++) {
      const unit = api.GetLine(modelID, unitIds.get(i));
      if (!unit) continue;
      if (readValue(unit.UnitType).toUpperCase() !== 'LENGTHUNIT') continue;
      const prefix = readValue(unit.Prefix).toUpperCase();
      if (prefix === 'MILLI') return { scale: 0.001, prefix: 'millimetre' };
      if (prefix === 'CENTI') return { scale: 0.01, prefix: 'centimetre' };
      if (prefix === 'DECI') return { scale: 0.1, prefix: 'decimetre' };
      if (prefix === 'KILO') return { scale: 1000, prefix: 'kilometre' };
      return { scale: 1, prefix: 'metre' };
    }
  } catch (err) {
    // An older schema or an unusual file: fall back to metres rather than failing the whole load.
  }
  return { scale: 1, prefix: 'metre' };
}

/** Storeys, cheapest possible read (one line id lookup each), for the counts the UI reports. */
export function readIfcStoreys(api, modelID) {
  const storeys = [];
  try {
    const ids = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName('IFCBUILDINGSTOREY'));
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const line = api.GetLine(modelID, id);
      if (!line) continue;
      const rawName = line.Name && typeof line.Name === 'object' ? line.Name.value : line.Name;
      const rawElevation = line.Elevation && typeof line.Elevation === 'object' ? line.Elevation.value : line.Elevation;
      storeys.push({
        id,
        name: rawName ? String(rawName) : `Storey #${id}`,
        elevation: Number(rawElevation) || 0
      });
    }
  } catch (err) {
    // Storeys are reporting detail; a file without them is still drawable.
  }
  return storeys.sort((a, b) => a.elevation - b.elevation);
}

/**
 * Every element's geometry as one THREE group, in the file's own model frame and Z-up (IFC is
 * Z-up, unlike glTF). Spaces and openings are skipped: they are the voids inside the building,
 * not its fabric.
 *
 * Returns { group, meshes, elements, storeys, schema, unit, bounds } where `unit.scale` converts
 * the file's length unit to metres — the caller applies it, so the geometry keeps the file's
 * numbers and the scale is explicit.
 */
export function extractIfcGeometry(api, modelID, { arrayBuffer, onProgress } = {}) {
  const group = new THREE.Group();
  const meshes = [];
  const elements = [];
  const materialByType = new Map();
  const skip = new Set([
    api.GetTypeCodeFromName('IFCOPENINGELEMENT'),
    api.GetTypeCodeFromName('IFCSPACE')
  ]);

  api.StreamAllMeshes(modelID, (flatMesh) => {
    const typeCode = api.GetLineType(modelID, flatMesh.expressID);
    if (skip.has(typeCode)) return;
    const type = api.GetNameFromTypeCode(typeCode) || 'IfcElement';
    let material = materialByType.get(type);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color: colourForType(type), roughness: 0.62, metalness: 0.04 });
      materialByType.set(type, material);
    }
    const element = { expressID: flatMesh.expressID, type, meshes: [] };
    for (let i = 0; i < flatMesh.geometries.size(); i++) {
      const buffer = geometryFromPlacedGeometry(api, modelID, flatMesh.geometries.get(i));
      const mesh = new THREE.Mesh(buffer, material);
      mesh.userData.expressID = flatMesh.expressID;
      mesh.userData.type = type;
      group.add(mesh);
      meshes.push(mesh);
      element.meshes.push(mesh);
    }
    if (element.meshes.length > 0) elements.push(element);
  });

  group.updateMatrixWorld(true);
  // Per-element extents, in the model frame. The map layer uses them for its checks and stage 4
  // needs them for storey/section filtering; computing them here avoids a second pass.
  elements.forEach((element) => {
    const box = new THREE.Box3();
    element.meshes.forEach((mesh) => box.expandByObject(mesh));
    element.bbox = box;
  });

  const bounds = meshes.length > 0 ? new THREE.Box3().setFromObject(group) : null;
  const unit = readIfcLengthUnit(api, modelID);
  const storeys = readIfcStoreys(api, modelID);
  const schema = arrayBuffer ? readIfcSchema(arrayBuffer) : 'IFC';
  if (onProgress) onProgress({ meshes: meshes.length, elements: elements.length, storeys: storeys.length, schema });

  return { group, meshes, elements, storeys, schema, unit, bounds };
}
