/**
 * DXF reader for SiteTrackerPro.
 *
 * Converts the ENTITIES section of an ASCII DXF drawing into a GeoJSON FeatureCollection, so a
 * DWG that LibreDWG has converted to DXF (or a DXF someone exports from AutoCAD) can be imported
 * as a normal dataset. Pure JavaScript, no dependency, so it runs in the same container.
 *
 * What is read, and how:
 *
 *   LINE                 LineString of two points
 *   LWPOLYLINE, POLYLINE LineString, or a closed Polygon when the closed flag is set
 *   CIRCLE               Polygon approximated by CIRCLE_SEGMENTS vertices
 *   ARC                  LineString along the arc
 *   POINT                Point
 *   TEXT, MTEXT          Point carrying the text in `properties.text`
 *   INSERT               Block geometry expanded into world coordinates (translate, rotate,
 *                        scale), depth-limited; entities on block layer 0 inherit the INSERT layer
 *
 * Every feature keeps its CAD layer in `properties.layer`, and its entity type in
 * `properties.entity`, which is what the workspace layer list and the DXF export round trip use.
 * Elevation (Z) is read but not stored: the map is 2D, and inventing a Z would be worse than
 * dropping it, so `properties.elevation` keeps it when it is not zero.
 */

const CIRCLE_SEGMENTS = 72;
const MAX_INSERT_DEPTH = 5;
const MAX_ENTITIES = 20000;

// Group codes with a numeric value. Everything else is a string in DXF.
const FLOAT_CODES = new Set([
  10, 20, 30, 11, 21, 31, 12, 22, 32, 13, 23, 33, 14, 24, 34, 15, 25, 35, 16, 26, 36,
  39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  59, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149
]);
const INT_CODES = new Set([60, 61, 62, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 289, 290]);

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Split DXF text into { code, value } pairs. Malformed trailing lines are ignored. */
function readPairs(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (!Number.isFinite(code)) {
      // A broken pair shifts everything after it; stop rather than emit nonsense geometry.
      break;
    }
    pairs.push({ code, value: lines[index + 1] });
  }
  return pairs;
}

/** Group the pairs of one entity (from a 0-code up to the next 0-code) into a typed object. */
function entityFromPairs(pairs) {
  const entity = { type: String(pairs[0].value || '').trim().toUpperCase(), values: [], vertices: [] };
  let pending = null;
  // Index of the point whose Y the next 20 code belongs to. A repeated 10 starts a new point;
  // an 11 starts the LINE end point. Without this, the Y of vertex 1 would overwrite vertex 0.
  let pendingIndex = 0;
  pairs.slice(1).forEach(pair => {
    // 10/20, 11/21, 12/22 ... are the X/Y pairs of an entity's points: a LINE has 10,20 and
    // 11,21; a LWPOLYLINE repeats 10,20 for every vertex. Index by the group code so both forms
    // land in `vertices` in order.
    if (pair.code === 10) {
      // Repeated 10s are consecutive polyline vertices; each one starts a new point.
      pending = { x: toNumber(pair.value), y: 0, z: 0 };
      entity.vertices.push(pending);
      pendingIndex = entity.vertices.length - 1;
      entity.values.push({ code: pair.code, value: pending.x });
      return;
    }
    if (pair.code >= 11 && pair.code <= 19) {
      // 11/21 is the LINE end point; 12..18 are further named points (TEXT alignment, MINSERT).
      pendingIndex = pair.code - 10;
      pending = { x: toNumber(pair.value), y: 0, z: 0 };
      entity.vertices[pendingIndex] = pending;
      entity.values.push({ code: pair.code, value: pending.x });
      return;
    }
    if (pair.code === 20) {
      const vertex = entity.vertices[pendingIndex] || (entity.vertices[pendingIndex] = { x: 0, y: 0, z: 0 });
      vertex.y = toNumber(pair.value);
      pending = vertex;
      entity.values.push({ code: pair.code, value: vertex.y });
      return;
    }
    if (pair.code >= 21 && pair.code <= 29) {
      const index = pair.code - 20;
      const vertex = entity.vertices[index] || (entity.vertices[index] = { x: 0, y: 0, z: 0 });
      vertex.y = toNumber(pair.value);
      pending = vertex;
      entity.values.push({ code: pair.code, value: vertex.y });
      return;
    }
    if (pair.code >= 30 && pair.code <= 39 && pending) {
      pending.z = toNumber(pair.value);
      entity.values.push({ code: pair.code, value: pending.z });
      return;
    }
    if (FLOAT_CODES.has(pair.code)) {
      entity.values.push({ code: pair.code, value: toNumber(pair.value) });
      return;
    }
    if (INT_CODES.has(pair.code)) {
      entity.values.push({ code: pair.code, value: Math.trunc(toNumber(pair.value)) });
      return;
    }
    entity.values.push({ code: pair.code, value: String(pair.value === undefined ? '' : pair.value).trim() });
  });
  return entity;
}

function firstValue(entity, code, fallback) {
  const found = entity.values.find(value => value.code === code);
  return found ? found.value : fallback;
}

function layerOf(entity, inheritedLayer) {
  const layer = String(firstValue(entity, 8, '') || '').trim();
  if (!layer || layer === '0') return inheritedLayer || layer || '0';
  return layer;
}

/** Walk the ENTITIES (or a BLOCKS entry) pair list and split it into entities. */
function splitEntities(pairs) {
  const entities = [];
  let current = null;
  pairs.forEach(pair => {
    if (pair.code === 0) {
      if (current) entities.push(current);
      current = [pair];
    } else if (current) {
      current.push(pair);
    }
  });
  if (current) entities.push(current);
  return entities.map(entityFromPairs).filter(entity => entity.type && entity.type !== 'ENDBLK' && entity.type !== 'SEQEND');
}

function sectionPairs(pairs, name) {
  let start = -1;
  for (let index = 0; index + 1 < pairs.length; index += 1) {
    if (pairs[index].code === 0
      && String(pairs[index].value).trim().toUpperCase() === 'SECTION'
      && String(pairs[index + 1].value).trim().toUpperCase() === name) {
      start = index + 2;
      break;
    }
  }
  if (start < 0) return [];
  for (let index = start; index < pairs.length; index += 1) {
    if (pairs[index].code === 0 && String(pairs[index].value).trim().toUpperCase() === 'ENDSEC') {
      return pairs.slice(start, index);
    }
  }
  return pairs.slice(start);
}

function trianglesFromVertices(vertices, closed) {
  const points = vertices.filter(Boolean).map(vertex => [vertex.x, vertex.y]);
  if (points.length < 2) return null;
  // Many CAD writers already repeat the first point to close the ring; do not double it.
  const first = points[0];
  const last = points[points.length - 1];
  const alreadyClosed = first[0] === last[0] && first[1] === last[1];
  const ring = closed && !alreadyClosed ? [...points, [first[0], first[1]]] : points;
  return {
    type: closed ? 'Polygon' : 'LineString',
    coordinates: closed ? [ring] : ring
  };
}

function circleGeometry(center, radius) {
  const ring = [];
  for (let step = 0; step <= CIRCLE_SEGMENTS; step += 1) {
    const angle = (step / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push([center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function arcGeometry(center, radius, startDegrees, endDegrees) {
  let start = ((startDegrees % 360) + 360) % 360;
  let end = ((endDegrees % 360) + 360) % 360;
  if (end <= start) end += 360;
  const sweep = (end - start) * (Math.PI / 180);
  const steps = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SEGMENTS));
  const coordinates = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = start * (Math.PI / 180) + (sweep * step) / steps;
    coordinates.push([center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle)]);
  }
  return { type: 'LineString', coordinates };
}

function applyInsert(geometry, insert) {
  const rotation = (toNumber(insert.rotation) * Math.PI) / 180;
  const scaleX = insert.scaleX || 1;
  const scaleY = insert.scaleY || 1;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const map = ([x, y]) => {
    const sx = x * scaleX;
    const sy = y * scaleY;
    return [insert.x + sx * cos - sy * sin, insert.y + sx * sin + sy * cos];
  };
  if (!geometry) return null;
  if (geometry.type === 'Point') return { type: 'Point', coordinates: map(geometry.coordinates) };
  if (geometry.type === 'LineString') return { type: 'LineString', coordinates: geometry.coordinates.map(map) };
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(map)) };
  return null;
}

function geometryForEntity(entity, blocks, inheritedLayer, depth = 0) {
  switch (entity.type) {
    case 'POINT':
      return { geometry: { type: 'Point', coordinates: [entity.vertices[0]?.x || 0, entity.vertices[0]?.y || 0] }, properties: {} };

    case 'LINE': {
      const start = entity.vertices[0] || { x: 0, y: 0 };
      const end = entity.vertices[1] || { x: 0, y: 0 };
      return { geometry: { type: 'LineString', coordinates: [[start.x, start.y], [end.x, end.y]] }, properties: {} };
    }

    case 'LWPOLYLINE': {
      const closed = (toNumber(firstValue(entity, 70, 0)) & 1) === 1;
      const geometry = trianglesFromVertices(entity.vertices, closed);
      return geometry ? { geometry, properties: {} } : null;
    }

    case 'POLYLINE': {
      // Vertices follow as separate VERTEX entities; the geometry is assembled by the caller.
      const closed = (toNumber(firstValue(entity, 70, 0)) & 1) === 1;
      const geometry = trianglesFromVertices(entity.vertices, closed);
      return geometry ? { geometry, properties: {} } : null;
    }

    case 'CIRCLE':
      return {
        geometry: circleGeometry(
          { x: toNumber(firstValue(entity, 10, 0)), y: toNumber(firstValue(entity, 20, 0)) },
          Math.abs(toNumber(firstValue(entity, 40, 0)))
        ),
        properties: {}
      };

    case 'ARC':
      return {
        geometry: arcGeometry(
          { x: toNumber(firstValue(entity, 10, 0)), y: toNumber(firstValue(entity, 20, 0)) },
          Math.abs(toNumber(firstValue(entity, 40, 0))),
          toNumber(firstValue(entity, 50, 0)),
          toNumber(firstValue(entity, 51, 360))
        ),
        properties: {}
      };

    case 'TEXT':
    case 'MTEXT':
      return {
        geometry: {
          type: 'Point',
          coordinates: [toNumber(firstValue(entity, 10, 0)), toNumber(firstValue(entity, 20, 0))]
        },
        properties: { text: String(firstValue(entity, 1, '') || ''), textHeight: toNumber(firstValue(entity, 40, 0)) || undefined }
      };

    case 'INSERT': {
      if (depth >= MAX_INSERT_DEPTH) return null;
      const blockName = String(firstValue(entity, 2, '') || '').trim();
      const blockEntities = blocks.get(blockName);
      if (!blockEntities) return null;
      const insert = {
        x: toNumber(firstValue(entity, 10, 0)),
        y: toNumber(firstValue(entity, 20, 0)),
        scaleX: toNumber(firstValue(entity, 41, 1)) || 1,
        scaleY: toNumber(firstValue(entity, 42, 1)) || 1,
        rotation: toNumber(firstValue(entity, 50, 0))
      };
      const layer = layerOf(entity, inheritedLayer);
      const features = [];
      blockEntities.forEach(blockEntity => {
        const built = geometryForEntity(blockEntity, blocks, layer, depth + 1);
        if (!built) return;
        const geometry = applyInsert(built.geometry, insert);
        if (!geometry) return;
        features.push({
          geometry,
          properties: { ...built.properties, layer: layerOf(blockEntity, layer), entity: blockEntity.type, block: blockName }
        });
      });
      return { nested: features };
    }

    default:
      return null;
  }
}

/**
 * Parse DXF text into a FeatureCollection.
 * Returns { featureCollection, layers, entityCounts, entityCount, skipped }.
 */
function parseDxf(text) {
  const pairs = readPairs(text);
  if (!pairs.length) return { featureCollection: { type: 'FeatureCollection', features: [] }, layers: [], entityCounts: {}, entityCount: 0, skipped: 0 };

  // BLOCKS: each BLOCK starts a named group that INSERT entities expand.
  const blocks = new Map();
  const blockPairs = sectionPairs(pairs, 'BLOCKS');
  let blockName = null;
  let blockBody = [];
  const flushBlock = () => {
    if (blockName) blocks.set(blockName, splitEntities(blockBody).filter(item => item.type !== 'BLOCK'));
    blockName = null;
    blockBody = [];
  };
  for (let index = 0; index < blockPairs.length; index += 1) {
    const pair = blockPairs[index];
    const marker = pair.code === 0 ? String(pair.value).trim().toUpperCase() : '';
    if (marker === 'BLOCK') {
      flushBlock();
      // The block name is the first group-2 value after the BLOCK marker.
      for (let ahead = index + 1; ahead < Math.min(index + 6, blockPairs.length); ahead += 1) {
        if (blockPairs[ahead].code === 2) { blockName = String(blockPairs[ahead].value).trim(); break; }
        if (blockPairs[ahead].code === 0) break;
      }
      continue;
    }
    if (marker === 'ENDBLK') { flushBlock(); continue; }
    if (blockName !== null) blockBody.push(pair);
  }
  flushBlock();

  const entityPairs = sectionPairs(pairs, 'ENTITIES');
  const entities = splitEntities(entityPairs);

  const features = [];
  const entityCounts = {};
  let skipped = 0;
  let pendingPolyline = null;

  const push = (entity, layer, geometry, properties) => {
    features.push({
      type: 'Feature',
      geometry,
      properties: { layer, entity: entity.type, ...properties }
    });
  };

  entities.forEach(entity => {
    if (features.length >= MAX_ENTITIES) { skipped += 1; return; }
    entityCounts[entity.type] = (entityCounts[entity.type] || 0) + 1;

    if (entity.type === 'VERTEX') {
      if (pendingPolyline) pendingPolyline.vertices.push(...entity.vertices);
      return;
    }
    if (entity.type === 'SEQEND') {
      if (pendingPolyline) {
        const closed = (toNumber(firstValue(pendingPolyline, 70, 0)) & 1) === 1;
        const geometry = trianglesFromVertices(pendingPolyline.vertices, closed);
        if (geometry) {
          push(pendingPolyline, layerOf(pendingPolyline, null), geometry, {});
        } else {
          skipped += 1;
        }
        pendingPolyline = null;
      }
      return;
    }
    if (entity.type === 'POLYLINE') {
      if (pendingPolyline) skipped += 1;
      pendingPolyline = entity;
      return;
    }

    const layer = layerOf(entity, null);
    const built = geometryForEntity(entity, blocks, layer);
    if (!built) { skipped += 1; return; }
    if (built.nested) {
      built.nested.forEach(item => {
        features.push({ type: 'Feature', geometry: item.geometry, properties: item.properties });
      });
      return;
    }
    push(entity, layer, built.geometry, built.properties);
  });

  if (pendingPolyline) {
    const closed = (toNumber(firstValue(pendingPolyline, 70, 0)) & 1) === 1;
    const geometry = trianglesFromVertices(pendingPolyline.vertices, closed);
    if (geometry) push(pendingPolyline, layerOf(pendingPolyline, null), geometry, {});
  }

  const layers = [...new Set(features.map(feature => feature.properties.layer).filter(Boolean))].sort();

  return {
    featureCollection: { type: 'FeatureCollection', features },
    layers,
    entityCounts,
    entityCount: features.length,
    skipped
  };
}

/** The unit a DXF declares, from $INSUNITS. Used only to suggest a CRS, never to assume one. */
function dxfUnits(text) {
  const pairs = readPairs(text);
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index].code === 9 && String(pairs[index].value).trim().toUpperCase() === '$INSUNITS') {
      const next = pairs[index + 1];
      if (next) return toNumber(next.value);
    }
  }
  return 0;
}

module.exports = { parseDxf, dxfUnits, readPairs, CIRCLE_SEGMENTS };
